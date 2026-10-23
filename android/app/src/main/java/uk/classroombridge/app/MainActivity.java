package uk.classroombridge.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Classroom Bridge for Android tablets: the same web app the iPads use, full screen, with what a browser tab can't
 * do on its own here: camera and microphone permission, the photo picker, saving photos and recordings to the tablet,
 * and the clipboard. Everything else (pairing, the PC screen, the visualiser) is the web app, so it updates itself.
 */
public class MainActivity extends Activity {
    private static final int MEDIA_PERMISSIONS = 1;
    private static final int PICK_FILES = 2;

    private WebView webView;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> pendingFiles;
    private final Map<String, Saving> savings = new HashMap<>();
    private Uri appUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appUri = Uri.parse(BuildConfig.APP_URL);
        // A lesson shouldn't be interrupted by the tablet going to sleep.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(0xff07111f);
        setContentView(webView);
        hideSystemBars();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setUserAgentString(settings.getUserAgentString() + " ClassroomBridgeAndroid/" + BuildConfig.VERSION_NAME);
        webView.addJavascriptInterface(new Bridge(), "ClassroomBridgeAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isAppPage(url)) return false;
                // Help pages and other sites open in the browser, not inside the app.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                intent.setType(types.length > 0 && !types[0].isEmpty() ? types[0] : "*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Choose photos"), PICK_FILES);
                } catch (ActivityNotFoundException error) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(startUrl(getIntent()));
        }
    }

    private boolean isAppPage(Uri url) {
        return "https".equals(url.getScheme()) && appUri.getHost() != null && appUri.getHost().equals(url.getHost());
    }

    /** A pairing link (…/#pair=CODE) from the companion's QR code opens the app paired. */
    private String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        return data != null && isAppPage(data) ? data.toString() : BuildConfig.APP_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent.getData();
        if (data != null && isAppPage(data)) webView.loadUrl(data.toString());
    }

    private void handlePermission(PermissionRequest request) {
        if (!isAppPage(request.getOrigin())) {
            request.deny();
            return;
        }
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needed.add(Manifest.permission.CAMERA);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needed.add(Manifest.permission.RECORD_AUDIO);
        }
        List<String> missing = new ArrayList<>();
        for (String permission : needed) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (missing.isEmpty()) {
            grantAllowed(request);
            return;
        }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSIONS);
    }

    /** Grants the parts of the web page's request that Android allows (for example the camera but not the mic). */
    private void grantAllowed(PermissionRequest request) {
        List<String> granted = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            }
        }
        if (granted.isEmpty()) request.deny();
        else request.grant(granted.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == MEDIA_PERMISSIONS && pendingPermission != null) {
            PermissionRequest request = pendingPermission;
            pendingPermission = null;
            grantAllowed(request);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || pendingFiles == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int index = 0; index < clip.getItemCount(); index++) result[index] = clip.getItemAt(index).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    private void hideSystemBars() {
        // Full screen like the iPad Home Screen app; a swipe from the edge shows Android's bars for a moment.
        webView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // The page sees itself hidden, so (as on the iPad) it lets go of the PC while the tablet is locked or in
        // another app, and reconnects when it comes back.
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true); // keep the app (and its pairing) rather than closing it
    }

    @Override
    protected void onDestroy() {
        for (Saving saving : savings.values()) saving.abandon();
        savings.clear();
        webView.destroy();
        super.onDestroy();
    }

    /** A photo or recording being saved, sent from the page in pieces. */
    private class Saving {
        final String name;
        final String mime;
        final File temporary;
        final OutputStream output;

        Saving(String name, String mime) throws IOException {
            this.name = name;
            this.mime = mime;
            temporary = File.createTempFile("saving", ".part", getCacheDir());
            output = new FileOutputStream(temporary);
        }

        void abandon() {
            try {
                output.close();
            } catch (IOException ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
        }
    }

    /** What the web app can ask of the tablet (window.ClassroomBridgeAndroid). */
    private class Bridge {
        @JavascriptInterface
        public String beginSave(String name, String mime) {
            try {
                String id = Long.toHexString(System.nanoTime());
                synchronized (savings) {
                    savings.put(id, new Saving(cleanName(name), mime == null ? "application/octet-stream" : mime));
                }
                return id;
            } catch (IOException error) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean appendSave(String id, String base64) {
            Saving saving;
            synchronized (savings) {
                saving = savings.get(id);
            }
            if (saving == null) return false;
            try {
                saving.output.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException error) {
                return false;
            }
        }

        /** Copies the finished file into Pictures (photos), Movies (recordings) or Downloads. */
        @JavascriptInterface
        public String finishSave(String id) {
            Saving saving;
            synchronized (savings) {
                saving = savings.remove(id);
            }
            if (saving == null) return "";
            try {
                saving.output.close();
                String place = publish(saving);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Saved to " + place, Toast.LENGTH_SHORT).show());
                return place;
            } catch (IOException error) {
                return "";
            } finally {
                //noinspection ResultOfMethodCallIgnored
                saving.temporary.delete();
            }
        }

        @JavascriptInterface
        public String readClipboard() {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
            return text == null ? "" : text.toString();
        }

        @JavascriptInterface
        public void writeClipboard(String text) {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Classroom Bridge", text));
        }
    }

    private static String cleanName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\n\\r]", "_").trim();
        return clean.isEmpty() ? "Classroom Bridge" : clean;
    }

    private String publish(Saving saving) throws IOException {
        boolean image = saving.mime.startsWith("image/");
        boolean video = saving.mime.startsWith("video/");
        String folder = image ? Environment.DIRECTORY_PICTURES : video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_DOWNLOADS;
        String label = (image ? "Pictures" : video ? "Movies" : "Downloads") + "/Classroom Bridge";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri collection = image ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, saving.name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, saving.mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Classroom Bridge");
            Uri item = getContentResolver().insert(collection, values);
            if (item == null) throw new IOException("no media store");
            try (OutputStream output = getContentResolver().openOutputStream(item)) {
                if (output == null) throw new IOException("can't write");
                java.nio.file.Files.copy(saving.temporary.toPath(), output);
            }
            return label;
        }
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread(() -> requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, 3));
            throw new IOException("storage permission needed");
        }
        File directory = new File(Environment.getExternalStoragePublicDirectory(folder), "Classroom Bridge");
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        File target = new File(directory, saving.name);
        java.nio.file.Files.copy(saving.temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(target)));
        return label;
    }
}
