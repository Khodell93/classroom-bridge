package uk.classroombridge.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Shares the tablet's screen with the classroom PC: Android's screen capture feeds the tablet's hardware H.264
 * encoder, and each encoded frame goes to the web page (MainActivity), which sends it to the companion over the
 * connection it already has. It runs as a foreground service (Android requires that for screen capture, and it keeps
 * sharing while the teacher is in another app) and stops when the screen turns off, as the iPad disconnects when
 * locked.
 */
public class ScreenShareService extends Service {
    static final String ACTION_START = "uk.classroombridge.app.SHARE_START";
    static final String ACTION_STOP = "uk.classroombridge.app.SHARE_STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";

    private static final String TAG = "ClassroomBridgeShare";
    private static final String CHANNEL = "screen-share";
    private static final int NOTIFICATION = 1;
    // The projector rarely shows more than 1920; tablets whose encoder can't do that (or the optional settings) get
    // 1280, then the plain settings.
    private static final int[] LONG_SIDES = {1920, 1280};
    private static final int BIT_RATE = 8_000_000; // a steady, high rate: what makes the mirror look better than video calls
    private static final int FRAME_RATE = 30;

    /** Where encoded frames and state changes go (MainActivity, while it exists). */
    interface Sink {
        void onShareFrame(byte[] data, boolean keyFrame);

        void onShareState(boolean active, String reason, int width, int height);
    }

    private static volatile Sink sink;
    private static volatile ScreenShareService running;

    static void setSink(Sink value) {
        sink = value;
    }

    static boolean isRunning() {
        return running != null;
    }

    static void requestKeyFrame() {
        ScreenShareService service = running;
        if (service != null) service.handler.post(service::keyFrameNow);
    }

    private HandlerThread thread;
    private Handler handler;
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec encoder;
    private Surface inputSurface;
    private Thread output;
    private volatile boolean encoding;
    private int width;
    private int height;
    private int density;
    private int longSide = LONG_SIDES[0];
    private String stopReason = "stopped";

    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            stopReason = "locked";
            stopSelf();
        }
    };

    private final DisplayManager.DisplayListener rotation = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) {
        }

        @Override
        public void onDisplayRemoved(int displayId) {
        }

        @Override
        public void onDisplayChanged(int displayId) {
            if (displayId == Display.DEFAULT_DISPLAY) handler.post(ScreenShareService.this::followRotation);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running != null) return START_NOT_STICKY; // already sharing
        // Android 10+ requires the foreground service (with its screen-capture type) before the capture starts.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION, notification());
        }
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        projection = data == null ? null : manager.getMediaProjection(resultCode, data);
        if (projection == null) {
            stopReason = "refused";
            stopSelf();
            return START_NOT_STICKY;
        }
        running = this;
        thread = new HandlerThread("screen-share");
        thread.start();
        handler = new Handler(thread.getLooper());
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // Stopped by Android: the "Stop sharing" chip, or another app took over the screen capture.
                stopSelf();
            }
        }, handler);
        handler.post(this::begin);
        registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        ((DisplayManager) getSystemService(DISPLAY_SERVICE)).registerDisplayListener(rotation, handler);
        return START_NOT_STICKY;
    }

    private void begin() {
        try {
            startWorkingEncoder();
            display = projection.createVirtualDisplay("Classroom Bridge", width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, inputSurface, null, handler);
            Sink target = sink;
            if (target != null) target.onShareState(true, "started", width, height);
        } catch (IOException | RuntimeException error) {
            Log.e(TAG, "couldn't start sharing", error);
            stopReason = "failed";
            stopSelf();
        }
    }

    /** The encoded size: the screen's shape, at most LONG_SIDE on its long side, in steps of 16 (encoders like that). */
    private void measure() {
        Display screen = ((DisplayManager) getSystemService(DISPLAY_SERVICE)).getDisplay(Display.DEFAULT_DISPLAY);
        DisplayMetrics metrics = new DisplayMetrics();
        screen.getRealMetrics(metrics);
        double scale = Math.min(1.0, longSide / (double) Math.max(metrics.widthPixels, metrics.heightPixels));
        width = Math.max(16, (int) Math.round(metrics.widthPixels * scale / 16) * 16);
        height = Math.max(16, (int) Math.round(metrics.heightPixels * scale / 16) * 16);
        density = metrics.densityDpi;
    }

    /** Tries the sizes and settings in turn until this tablet's encoder accepts one. */
    private void startWorkingEncoder() throws IOException {
        RuntimeException last = null;
        for (boolean extras : new boolean[] {true, false}) {
            for (int side : LONG_SIDES) {
                longSide = side;
                measure();
                try {
                    startEncoder(extras);
                    return;
                } catch (RuntimeException error) { // MediaCodec.CodecException, IllegalArgumentException, ...
                    Log.w(TAG, "encoder refused " + width + "x" + height + (extras ? " with extras" : ""), error);
                    last = error;
                    stopEncoder();
                }
            }
        }
        throw last;
    }

    private void startEncoder(boolean extras) throws IOException {
        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        if (extras) {
            // A still screen (a photo, a page) is sent again every 100 ms, so it keeps getting sharper rather than
            // staying at the quality of the moment it stopped moving.
            format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
            format.setInteger(MediaFormat.KEY_PRIORITY, 0); // real time
        }
        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        inputSurface = encoder.createInputSurface();
        encoder.start();
        encoding = true;
        MediaCodec codec = encoder;
        output = new Thread(() -> drain(codec), "screen-encoder");
        output.start();
    }

    /** Hands each encoded frame on; key frames carry the stream's setup (SPS/PPS) so the PC can start from any of them. */
    private void drain(MediaCodec codec) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] config = new byte[0];
        try {
            while (encoding) {
                int index = codec.dequeueOutputBuffer(info, 100_000);
                if (index < 0) continue;
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (buffer != null && info.size > 0) {
                    buffer.position(info.offset);
                    buffer.limit(info.offset + info.size);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        config = new byte[info.size];
                        buffer.get(config);
                    } else {
                        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        byte[] frame = new byte[(key ? config.length : 0) + info.size];
                        if (key) System.arraycopy(config, 0, frame, 0, config.length);
                        buffer.get(frame, key ? config.length : 0, info.size);
                        Sink target = sink;
                        if (target != null) target.onShareFrame(frame, key);
                    }
                }
                codec.releaseOutputBuffer(index, false);
            }
        } catch (IllegalStateException error) {
            // The encoder was stopped (sharing ended, or the tablet turned).
        }
    }

    private void keyFrameNow() {
        if (encoder == null) return;
        Bundle request = new Bundle();
        request.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            encoder.setParameters(request);
        } catch (IllegalStateException ignored) {
        }
    }

    /** The tablet was turned: start a new stream the other way round. */
    private void followRotation() {
        if (display == null) return;
        int oldWidth = width;
        int oldHeight = height;
        measure();
        if (width == oldWidth && height == oldHeight) return;
        stopEncoder();
        try {
            startWorkingEncoder();
            display.resize(width, height, density);
            display.setSurface(inputSurface);
            Sink target = sink;
            if (target != null) target.onShareState(true, "rotated", width, height);
        } catch (IOException | RuntimeException error) {
            Log.e(TAG, "couldn't follow the rotation", error);
            stopReason = "failed";
            stopSelf();
        }
    }

    private void stopEncoder() {
        encoding = false;
        if (display != null) display.setSurface(null);
        if (output != null) {
            try {
                output.join(500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            output = null;
        }
        if (encoder != null) {
            try {
                encoder.stop();
            } catch (IllegalStateException ignored) {
            }
            encoder.release();
            encoder = null;
        }
        if (inputSurface != null) {
            inputSurface.release();
            inputSurface = null;
        }
    }

    private void release() {
        stopEncoder();
        if (display != null) {
            display.release();
            display = null;
        }
        if (projection != null) {
            projection.stop();
            projection = null;
        }
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ScreenShareService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder
                .setSmallIcon(android.R.drawable.ic_menu_slideshow)
                .setContentTitle("Showing this tablet on the classroom PC")
                .setContentText("Open any app: the projector shows it. Classroom Bridge's PC mode shows the PC.")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build())
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        boolean wasRunning = running == this;
        running = null;
        if (handler != null) {
            try {
                unregisterReceiver(screenOff);
            } catch (IllegalArgumentException ignored) {
            }
            ((DisplayManager) getSystemService(DISPLAY_SERVICE)).unregisterDisplayListener(rotation);
            // Stop on the sharing thread, so it can't overlap a start or a rotation in progress there.
            CountDownLatch done = new CountDownLatch(1);
            handler.post(() -> {
                release();
                done.countDown();
            });
            try {
                done.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            thread.quitSafely();
        } else {
            release();
        }
        stopForeground(true);
        Sink target = sink;
        if (target != null && (wasRunning || !"stopped".equals(stopReason))) target.onShareState(false, stopReason, 0, 0);
        super.onDestroy();
    }
}
