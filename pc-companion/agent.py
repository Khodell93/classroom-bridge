import argparse
import asyncio
import ctypes
import json
import logging
import os
import pathlib
import secrets
import ssl
import subprocess
import sys
import threading
import time

import certifi
import mss
import numpy as np
import pyautogui
import pyperclip
import websockets
from aiortc import RTCPeerConnection, RTCRtpSender, RTCSessionDescription, VideoStreamTrack, rate
from aiortc.codecs import h264, vpx
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame
from PIL import Image

import diag
from visualiser import MediaReceiver, VisualiserScene, relay_camera, send_screenshot

log = logging.getLogger("pc")
_frequent = diag.FrequentCounter(logging.getLogger("controls"))

# aiortc caps video at 1.5 Mbps (VP8) by default, which blurs text on a classroom display.
vpx.MAX_BITRATE = h264.MAX_BITRATE = 6_000_000
vpx.DEFAULT_BITRATE = h264.DEFAULT_BITRATE = 2_000_000

# The iPad's camera: tell its encoder there is plenty of bandwidth, as AirPlay assumes on a local network.
# aiortc's delay-based estimate starts low, climbs for ~40 s, and halves whenever Wi-Fi delay jitters, so the
# camera looked soft for the first half-minute and after every hiccup. The iPad's own loss-based control still
# backs off if packets are genuinely being lost.
CAMERA_BITRATE_FLOOR = 12_000_000  # matches the iPad camera's maxBitrate in visualiser.js


def apply_lan_bitrate_floor():
    original_add = rate.RemoteBitrateEstimator.add
    if getattr(original_add, "lan_floor", False):
        return

    def add(self, arrival_time_ms, abs_send_time, payload_size, ssrc):
        estimate = original_add(self, arrival_time_ms, abs_send_time, payload_size, ssrc)
        if estimate is None:
            # Report the floor from the first packets instead of waiting for the estimator's first update.
            last = getattr(self, "lan_floor_sent_ms", None)
            if last is not None and arrival_time_ms - last < 500:
                return None
            estimate = (0, list(self.ssrcs))
        self.lan_floor_sent_ms = arrival_time_ms
        bitrate, ssrcs = estimate
        return max(bitrate, CAMERA_BITRATE_FLOOR), ssrcs

    add.lan_floor = True
    add.original = original_add
    rate.RemoteBitrateEstimator.add = add


apply_lan_bitrate_floor()

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_screen_zoom_level = 1
ALLOWED_KEYS = {"left", "right", "up", "down", "space", "enter", "esc", "tab", "home", "end", "pageup", "pagedown", "backspace", "delete"}
WINDOWS_HOTKEYS = {
    ("ctrl", "a"), ("ctrl", "c"), ("ctrl", "v"), ("ctrl", "x"), ("ctrl", "z"),
    ("ctrl", "s"), ("ctrl", "o"), ("ctrl", "p"), ("ctrl", "f"), ("ctrl", "left"),
    ("ctrl", "right"), ("ctrl", "up"), ("ctrl", "down"), ("ctrl", "shift", "left"),
    ("ctrl", "shift", "right"), ("shift", "tab"), ("alt", "tab"), ("win", "e"),
    ("win", "left"), ("win", "right"), ("win", "up"), ("win", "down"),
    ("win", "tab"), ("win", "d"),
}
MAC_HOTKEYS = {
    ("command", "a"), ("command", "c"), ("command", "v"), ("command", "x"), ("command", "z"),
    ("command", "s"), ("command", "o"), ("command", "p"), ("command", "f"),
    ("command", "left"), ("command", "right"), ("command", "up"), ("command", "down"),
    ("command", "shift", "left"), ("command", "shift", "right"), ("shift", "tab"),
    ("alt", "tab"), ("command", "tab"), ("command", "left"),
}
# Windows shortcuts the iPad gestures send, and their Mac equivalents (Mission Control, show desktop).
MAC_GESTURE_HOTKEYS = {("win", "tab"): ("ctrl", "up"), ("win", "d"): ("command", "f3")}
_scroll_remainder = [0.0, 0.0]


def scroll_desktop(dx, dy):
    """Scrolls by a finger movement in desktop pixels (content follows the finger, like a touchscreen)."""
    if sys.platform == "win32":
        # Windows wheel units: 120 is one notch (about 100 px in most apps); modern apps scroll smoothly by less.
        _scroll_remainder[0] += dy * 1.2
        _scroll_remainder[1] += -dx * 1.2
        vertical, horizontal = int(_scroll_remainder[0]), int(_scroll_remainder[1])
        _scroll_remainder[0] -= vertical
        _scroll_remainder[1] -= horizontal
        user32 = ctypes.windll.user32
        if vertical:
            user32.mouse_event(0x0800, 0, 0, ctypes.c_uint32(vertical & 0xFFFFFFFF).value, 0)
        if horizontal:
            user32.mouse_event(0x1000, 0, 0, ctypes.c_uint32(horizontal & 0xFFFFFFFF).value, 0)
    elif sys.platform == "darwin":
        import Quartz

        event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 2, int(round(dy)), int(round(dx)))
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    else:
        _scroll_remainder[0] += dy / 40
        clicks = int(_scroll_remainder[0])
        _scroll_remainder[0] -= clicks
        if clicks:
            pyautogui.scroll(clicks)


def settings_dir():
    if sys.platform == "darwin":
        folder = pathlib.Path.home() / "Library" / "Application Support" / "ClassroomBridge"
    else:
        folder = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")) / "ClassroomBridge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_or_create_pairing_code():
    code_path = settings_dir() / "pairing-code.txt"
    try:
        code = code_path.read_text(encoding="ascii").strip().upper()
        if len(code) == 12 and all(character in ROOM_ALPHABET for character in code):
            return code
    except OSError:
        pass
    code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(12))
    code_path.write_text(code, encoding="ascii")
    if sys.platform != "win32":
        code_path.chmod(0o600)
    return code


def zoom_app(steps):
    """Zooms the app under the pointer with its own zoom, like a touchpad pinch (iPad pinch in PC mode)."""
    steps = max(-5, min(5, steps))
    if not steps:
        return
    if sys.platform == "win32":
        # Ctrl + wheel: Chrome, Edge, Office, File Explorer and most apps zoom by one level per notch (120).
        user32 = ctypes.windll.user32
        user32.keybd_event(0x11, 0, 0, 0)  # Ctrl down
        try:
            for _ in range(abs(steps)):
                user32.mouse_event(0x0800, 0, 0, ctypes.c_uint32((120 if steps > 0 else -120) & 0xFFFFFFFF).value, 0)
        finally:
            user32.keybd_event(0x11, 0, 0x0002, 0)  # Ctrl up
    elif sys.platform == "darwin":
        for _ in range(abs(steps)):
            pyautogui.hotkey("command", "=" if steps > 0 else "-")
    else:
        pyautogui.keyDown("ctrl")
        try:
            pyautogui.scroll(steps)
        finally:
            pyautogui.keyUp("ctrl")


def set_screen_zoom(target):
    global _screen_zoom_level
    target = max(1, min(4, int(round(float(target)))))
    if target == _screen_zoom_level:
        return
    if sys.platform == "darwin":
        if _screen_zoom_level == 1 and target > 1:
            pyautogui.hotkey("option", "command", "8")
            _screen_zoom_level = 2
        while _screen_zoom_level < target:
            pyautogui.hotkey("option", "command", "shift", "=")
            _screen_zoom_level += 1
        while _screen_zoom_level > target:
            if target == 1:
                pyautogui.hotkey("option", "command", "8")
                _screen_zoom_level = 1
            else:
                pyautogui.hotkey("option", "command", "-")
                _screen_zoom_level -= 1
    else:
        while _screen_zoom_level < target:
            pyautogui.hotkey("win", "add")
            _screen_zoom_level += 1
        while _screen_zoom_level > target:
            if target == 1:
                pyautogui.hotkey("win", "esc")
                _screen_zoom_level = 1
            else:
                pyautogui.hotkey("win", "subtract")
                _screen_zoom_level -= 1


class DesktopVideo(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.capture = mss.mss()
        self.monitor = self.capture.monitors[1]

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        shot = await asyncio.to_thread(self.capture.grab, self.monitor)
        rgb = np.asarray(shot)[:, :, :3][:, :, ::-1]
        frame_image = Image.fromarray(rgb)
        frame_image.thumbnail((1280, 720), Image.Resampling.BILINEAR)
        canvas = Image.new("RGB", (1280, 720), "black")
        canvas.paste(frame_image, ((1280 - frame_image.width) // 2, (720 - frame_image.height) // 2))
        frame = VideoFrame.from_ndarray(np.asarray(canvas), format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


def prefer_h264(peer):
    """Offer H.264 first: the iPad encodes and decodes it in hardware (as AirPlay does); VP8 is software in Safari."""
    codecs = RTCRtpSender.getCapabilities("video").codecs
    preferred = [codec for codec in codecs if codec.mimeType.lower() == "video/h264"]
    others = [codec for codec in codecs if codec.mimeType.lower() != "video/h264"]
    for transceiver in peer.getTransceivers():
        if transceiver.kind == "video":
            transceiver.setCodecPreferences(preferred + others)


def perform_control(command, screen_width, screen_height):
    kind = command.get("type")
    if kind == "screen-zoom":
        set_screen_zoom(command.get("zoom", 1))
    elif kind == "app-zoom":
        zoom_app(int(command.get("steps", 0)))
    elif kind == "move":
        x = max(0.0, min(1.0, float(command.get("x", 0))))
        y = max(0.0, min(1.0, float(command.get("y", 0))))
        pyautogui.moveTo(int(x * (screen_width - 1)), int(y * (screen_height - 1)))
    elif kind == "mouse-down":
        pyautogui.mouseDown()
    elif kind == "mouse-up":
        pyautogui.mouseUp()
    elif kind == "click":
        pyautogui.click()
    elif kind == "right-click":
        pyautogui.click(button="right")
    elif kind == "scroll":
        scroll_desktop(max(-4000.0, min(4000.0, float(command.get("dx", 0)))), max(-4000.0, min(4000.0, float(command.get("dy", 0)))))
    elif kind == "key" and command.get("key") in ALLOWED_KEYS:
        pyautogui.press(command["key"])
    elif kind == "hotkey":
        keys = command.get("keys")
        if isinstance(keys, list):
            if sys.platform == "darwin":
                mapped = tuple("command" if key == "win" else key for key in keys)
                if tuple(keys) in MAC_GESTURE_HOTKEYS:
                    pyautogui.hotkey(*MAC_GESTURE_HOTKEYS[tuple(keys)])
                elif tuple(keys) == ("win", "e"):
                    subprocess.Popen(["open", "-a", "Finder"])
                elif mapped in MAC_HOTKEYS:
                    pyautogui.hotkey(*mapped)
            elif tuple(keys) in WINDOWS_HOTKEYS:
                pyautogui.hotkey(*keys)
    elif kind == "text":
        value = str(command.get("text", ""))[:250]
        if value.isprintable():
            if value.isascii():
                pyautogui.write(value, interval=0.01)
            else:
                pyperclip.copy(value)
                pyautogui.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
    elif kind == "paste":
        value = str(command.get("text", ""))[:20000]
        pyperclip.copy(value)
        pyautogui.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")


async def run(signal_url, room, notify=print, stop_event=None, on_ink=None, on_view=None, on_peer=None, airplay_info=None):
    """on_peer(connected) is told when an iPad connects or disconnects (the window updates only while none is)."""
    on_peer = on_peer or (lambda connected: None)
    stop_event = stop_event or threading.Event()
    width, height = pyautogui.size()
    pair_url = f"{signal_url.rstrip('/')}/signal/{room}?role=pc"
    asyncio.get_running_loop().set_exception_handler(diag.asyncio_exception_handler)
    log.info("connecting to the signalling server (screen %sx%s)", width, height)
    notify("Connecting to Classroom Bridge…")
    peer = None
    pending_candidates = []
    video_track = None
    try:
        tls_context = ssl.create_default_context(cafile=certifi.where())
        async with websockets.connect(pair_url, max_size=48_000, ping_interval=20, ssl=tls_context) as socket:
            log.info("signalling connected; waiting for the iPad")
            notify("Ready — enter the pairing code on the iPad.")
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                message = json.loads(raw)
                if message.get("type") != "candidate":
                    log.info("signalling: %s", message.get("type"))
                if message.get("type") == "peer-ready":
                    if peer is not None:
                        log.info("iPad reconnected: replacing the previous connection")
                        await peer.close()
                        if video_track:
                            video_track.capture.close()
                    peer = RTCPeerConnection()
                    def connection_changed(peer=peer):
                        log.info("iPad connection: %s (ice %s)", peer.connectionState, peer.iceConnectionState)
                        on_peer(peer.connectionState == "connected")

                    peer.on("connectionstatechange", connection_changed)
                    video_track = DesktopVideo()
                    peer.addTrack(video_track)
                    prefer_h264(peer)
                    channel = peer.createDataChannel("controls")
                    ink_channel = peer.createDataChannel("ink", ordered=True, maxRetransmits=0)
                    media_channel = peer.createDataChannel("media", ordered=True)
                    scene = None
                    if on_view:
                        scene = VisualiserScene(
                            (width, height), on_view,
                            lambda message, channel=channel: send_json(channel, message),
                            lambda kind, data, meta, media_channel=media_channel: send_blob(media_channel, kind, data, meta),
                        )
                        media_channel.on("message", MediaReceiver(scene).handle)

                        @peer.on("track")
                        def on_track(track, scene=scene):
                            log.info("iPad camera track arrived (%s)", track.kind)
                            if track.kind == "video":
                                asyncio.ensure_future(relay_camera(track, scene))
                    channel.on("open", lambda: channel.send(json.dumps({
                        "type": "host-info",
                        "os": "macos" if sys.platform == "darwin" else "windows",
                        "screenWidth": width,
                        "screenHeight": height,
                    })))
                    channel.on("message", lambda raw, scene=scene: handle_message(raw, width, height, channel, on_ink, scene, airplay_info))
                    ink_channel.on("message", lambda raw, scene=scene: handle_message(raw, width, height, on_ink=on_ink, scene=scene))
                    pending_candidates.clear()
                    offer = await peer.createOffer()
                    await peer.setLocalDescription(offer)
                    await socket.send(json.dumps({"type": "offer", "description": {"type": peer.localDescription.type, "sdp": peer.localDescription.sdp}}))
                    notify("iPad found — connecting…")
                elif message.get("type") == "answer":
                    if peer is None:
                        continue
                    description = message.get("description", {})
                    await peer.setRemoteDescription(RTCSessionDescription(sdp=description["sdp"], type=description["type"]))
                    for candidate in pending_candidates:
                        await peer.addIceCandidate(candidate)
                    pending_candidates.clear()
                    notify("Connected. The iPad can now control this desktop.")
                elif message.get("type") == "candidate" and message.get("candidate"):
                    if peer is None:
                        continue
                    candidate_data = message["candidate"]
                    candidate = candidate_from_sdp(candidate_data["candidate"].removeprefix("candidate:"))
                    candidate.sdpMid = candidate_data.get("sdpMid")
                    candidate.sdpMLineIndex = candidate_data.get("sdpMLineIndex")
                    if peer.remoteDescription:
                        await peer.addIceCandidate(candidate)
                    else:
                        pending_candidates.append(candidate)
    except KeyboardInterrupt:
        pass
    except Exception:
        log.exception("connection ended with an error")
        raise
    finally:
        log.info("companion connection stopped")
        if peer is not None:
            await peer.close()
        if video_track:
            video_track.capture.close()
        if on_view:
            on_view({"type": "hide"})
        on_peer(False)
        notify("Companion stopped.")


def send_json(channel, message):
    if channel.readyState == "open":
        channel.send(json.dumps(message))


def send_blob(channel, kind, data, meta):
    """Sends bytes to the iPad in 16 KB chunks, framed like the iPad's own blobs (blob-start, chunks, blob-end)."""
    if channel.readyState != "open":
        return False
    blob_id = secrets.token_hex(6)
    channel.send(json.dumps({"type": "blob-start", "id": blob_id, "kind": kind, "size": len(data), "meta": meta}))
    for offset in range(0, len(data), 16384):
        channel.send(data[offset:offset + 16384])
    channel.send(json.dumps({"type": "blob-end", "id": blob_id}))
    return True


def handle_message(raw, width, height, channel=None, on_ink=None, scene=None, airplay_info=None):
    command = None
    try:
        command = json.loads(raw)
        kind = command.get("type")
        if kind == "log":
            diag.write_ipad_entries(command.get("entries"))
            return
        if kind in diag.FREQUENT:
            _frequent.add(kind, time.monotonic())
        else:
            log.info("from iPad: %s", diag.describe(command))
        if command.get("type") == "screenshot":
            if scene:
                asyncio.ensure_future(send_screenshot(scene, str(command.get("requestId", ""))[:64]))
        elif command.get("type") in ("ink-live", "shape-live", "laser"):
            if scene:
                {"ink-live": scene.ink_live, "shape-live": scene.shape_live, "laser": scene.laser_points}[command["type"]](command)
        elif command.get("type") == "airplay-info":
            # The iPad's "iPad apps" panel: receiver name, PIN and how iPads can find this PC.
            info = airplay_info() if airplay_info else {"supported": False}
            if channel:
                send_json(channel, {"type": "airplay-info", "os": "macos" if sys.platform == "darwin" else "windows", **info})
        elif command.get("type") == "clipboard-read":
            if channel and channel.readyState == "open":
                try:
                    response = {"type": "clipboard-text", "text": pyperclip.paste()[:20000]}
                except pyperclip.PyperclipException:
                    response = {"type": "clipboard-error"}
                channel.send(json.dumps(response))
        elif isinstance(command.get("type"), str) and command["type"].startswith("ink-"):
            if on_ink:
                on_ink(command)
        else:
            perform_control(command, width, height)
    except pyperclip.PyperclipException:
        if channel and channel.readyState == "open":
            channel.send(json.dumps({"type": "clipboard-error"}))
    except (ValueError, TypeError, KeyError, pyautogui.FailSafeException) as error:
        summary = diag.describe(command) if isinstance(command, dict) else "<unreadable message>"
        log.warning("couldn't carry out an iPad command (%s: %s): %s", type(error).__name__, error, summary)
        return


def main():
    parser = argparse.ArgumentParser(description="Classroom Bridge Windows companion")
    parser.add_argument("--signal", required=True, help="Cloudflare Worker base URL, e.g. wss://classroom-bridge.example.workers.dev")
    args = parser.parse_args()
    room = get_or_create_pairing_code()
    try:
        print("Classroom Bridge is ready.")
        print(f"Pairing code: {room}")
        print("Keep this window open during the lesson. Press Ctrl+C to stop.")
        asyncio.run(run(args.signal, room))
    except Exception as error:
        print(f"Could not start the companion: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
