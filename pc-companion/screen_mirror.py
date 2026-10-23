"""Shows an Android tablet's shared screen: the Android version of an iPad's AirPlay mirror.

The Classroom Bridge Android app encodes the tablet's screen (H.264, from its hardware encoder) and the web page
sends each frame on a "screen" data channel that the tablet opens on the existing connection: pieces of up to 16 KB,
each starting with 6 bytes: flags (1 first piece, 2 last piece, 4 key frame), the frame number (4 bytes, big-endian)
and a spare byte. Key frames carry the stream's setup, so decoding can start at any of them.

The tablet says when sharing starts and stops ({"type": "screen-share", "active": ...} on the control channel); while
it shares, the companion reports "mirroring" exactly as for AirPlay, and the window decides when the mirror is on
screen (set_visible): in the tablet's Camera mode or another app, not in its PC mode.
"""

import logging
import queue
import struct
import threading

import av

from visualiser import fit_size

log = logging.getLogger("share")

HEADER = 6
FIRST, LAST, KEY = 1, 2, 4


class ScreenMirror:
    def __init__(self, show, screen_size, on_change=None):
        """show: the camera window's handle(); on_change(active) is told when sharing starts or stops."""
        self.show = show
        self.screen_size = screen_size
        self.on_change = on_change or (lambda active: None)
        self.request_keyframe = lambda: None  # set per connection: asks the tablet for a key frame
        self.active = False
        self.visible = False
        self.shown = False  # the camera window is showing the mirror
        self.lock = threading.Lock()
        self.parts = []
        self.part_frame = None
        self.part_key = False
        self.waiting_for_key = True
        self.stream = 0  # a new number for each sharing session: the decoder starts again
        self.frames = queue.Queue(maxsize=20)
        self.frames_shown = 0
        threading.Thread(target=self._decode_loop, daemon=True, name="screen-mirror").start()

    # From the connection (asyncio thread) ----------------------------------------------------------------------------

    def set_active(self, active, width=None, height=None):
        active = bool(active)
        with self.lock:
            if active == self.active:
                return
            self.active = active
            self.stream += 1
            self.parts = []
            self.waiting_for_key = True
            self.frames_shown = 0
        log.info("tablet screen sharing %s%s", "started" if active else "stopped", f" ({width}×{height})" if active and width else "")
        if not active:
            self._clear_queue()
            self.set_visible(False)
        self.on_change(active)

    def reset(self):
        """The tablet left: sharing is over."""
        self.set_active(False)

    def feed(self, data):
        """One piece of a frame from the "screen" data channel."""
        if not isinstance(data, (bytes, bytearray)) or len(data) < HEADER or not self.active:
            return
        flags = data[0]
        frame = struct.unpack(">I", data[1:5])[0]
        if flags & FIRST:
            self.parts = [bytes(data[HEADER:])]
            self.part_frame = frame
            self.part_key = bool(flags & KEY)
        elif self.parts and frame == self.part_frame:
            self.parts.append(bytes(data[HEADER:]))
        else:
            self.parts = []  # the start of this frame went missing: wait for the next one
            return
        if flags & LAST:
            whole, self.parts = b"".join(self.parts), []
            self._queue(whole, self.part_key)

    def _queue(self, frame, key):
        if self.waiting_for_key and not key:
            return
        self.waiting_for_key = False
        try:
            self.frames.put_nowait((self.stream, frame, key))
        except queue.Full:
            # This PC can't decode as fast as the tablet sends: drop what is waiting and start again at a key frame.
            log.warning("screen mirror fell behind; skipping to the next key frame")
            self._clear_queue()
            self.waiting_for_key = True
            self.request_keyframe()

    def _clear_queue(self):
        try:
            while True:
                self.frames.get_nowait()
        except queue.Empty:
            pass

    # From the window (Tk thread) ---------------------------------------------------------------------------------------

    def set_visible(self, visible):
        with self.lock:
            visible = bool(visible) and self.active
            if visible == self.visible:
                return
            self.visible = visible
            was_shown, self.shown = self.shown, False
        log.info("tablet screen %s", "shown" if visible else "hidden")
        if not visible and was_shown:
            self.show({"type": "mirror-off"})

    # Decoding (its own thread) -----------------------------------------------------------------------------------------

    def _new_decoder(self):
        decoder = av.CodecContext.create("h264", "r")
        decoder.options = {"flags": "low_delay"}  # show each frame as soon as it is decoded
        try:
            decoder.thread_type = "SLICE"  # frame threading would hold frames back
        except (AttributeError, TypeError, ValueError):
            pass
        return decoder

    def _decode_loop(self):
        decoder = None
        stream = None
        while True:
            frame_stream, data, key = self.frames.get()
            if decoder is None or frame_stream != stream:
                if not key:
                    continue
                decoder = self._new_decoder()
                stream = frame_stream
            try:
                pictures = decoder.decode(av.Packet(data))
            except Exception as error:  # a damaged frame: start again at the next key frame
                log.warning("couldn't decode a shared-screen frame (%s); asking for a key frame", error)
                decoder = None
                self.waiting_for_key = True
                self.request_keyframe()
                continue
            if not pictures or not self.frames.empty():
                continue  # behind: only the newest picture is worth showing
            self._present(pictures[-1], frame_stream)

    def _present(self, picture, frame_stream):
        if not self.visible:
            return
        width, height = fit_size(picture.width, picture.height, *self.screen_size)
        image = picture.reformat(width=width, height=height, format="rgb24").to_image()
        with self.lock:
            # Hidden, or sharing stopped, while this picture was being prepared: don't put it back on screen.
            if not self.visible or frame_stream != self.stream:
                return
            self.shown = True
            self.show({"type": "mirror", "image": image})
        self.frames_shown += 1
        if self.frames_shown == 1:
            log.info("first shared-screen picture shown (%sx%s from %sx%s)", width, height, picture.width, picture.height)
