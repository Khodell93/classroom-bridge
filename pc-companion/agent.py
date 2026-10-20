import argparse
import asyncio
import json
import os
import pathlib
import secrets
import ssl
import subprocess
import sys
import threading

import certifi
import mss
import numpy as np
import pyautogui
import pyperclip
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame
from PIL import Image

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
}
MAC_HOTKEYS = {
    ("command", "a"), ("command", "c"), ("command", "v"), ("command", "x"), ("command", "z"),
    ("command", "s"), ("command", "o"), ("command", "p"), ("command", "f"),
    ("command", "left"), ("command", "right"), ("command", "up"), ("command", "down"),
    ("command", "shift", "left"), ("command", "shift", "right"), ("shift", "tab"),
    ("alt", "tab"), ("command", "tab"), ("command", "left"),
}


def get_or_create_pairing_code():
    if sys.platform == "darwin":
        settings_dir = pathlib.Path.home() / "Library" / "Application Support" / "ClassroomBridge"
    else:
        settings_dir = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")) / "ClassroomBridge"
    settings_dir.mkdir(parents=True, exist_ok=True)
    code_path = settings_dir / "pairing-code.txt"
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


def perform_control(command, screen_width, screen_height):
    kind = command.get("type")
    if kind == "screen-zoom":
        set_screen_zoom(command.get("zoom", 1))
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
    elif kind == "key" and command.get("key") in ALLOWED_KEYS:
        pyautogui.press(command["key"])
    elif kind == "hotkey":
        keys = command.get("keys")
        if isinstance(keys, list):
            if sys.platform == "darwin":
                mapped = tuple("command" if key == "win" else key for key in keys)
                if tuple(keys) == ("win", "e"):
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


async def run(signal_url, room, notify=print, stop_event=None, on_ink=None, on_screen=None):
    stop_event = stop_event or threading.Event()
    width, height = pyautogui.size()
    pair_url = f"{signal_url.rstrip('/')}/signal/{room}?role=pc"
    notify("Connecting to Classroom Bridge…")
    peer = None
    pending_candidates = []
    video_track = None
    try:
        tls_context = ssl.create_default_context(cafile=certifi.where())
        async with websockets.connect(pair_url, max_size=1_000_000, ping_interval=20, ssl=tls_context) as socket:
            notify("Ready — enter the pairing code on the iPad.")
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                if isinstance(raw, bytes):
                    if on_screen:
                        on_screen({"type": "screen-frame", "jpeg": raw})
                    continue
                message = json.loads(raw)
                if message.get("type") in ("screen-start", "screen-stop"):
                    if on_screen:
                        on_screen(message)
                elif message.get("type") == "peer-ready":
                    if peer is not None:
                        await peer.close()
                        if video_track:
                            video_track.capture.close()
                    peer = RTCPeerConnection()
                    video_track = DesktopVideo()
                    peer.addTrack(video_track)
                    channel = peer.createDataChannel("controls")
                    ink_channel = peer.createDataChannel("ink", ordered=True, maxRetransmits=0)
                    channel.on("open", lambda: channel.send(json.dumps({
                        "type": "host-info",
                        "os": "macos" if sys.platform == "darwin" else "windows",
                        "screenWidth": width,
                        "screenHeight": height,
                    })))
                    channel.on("message", lambda raw: handle_message(raw, width, height, channel, on_ink))
                    ink_channel.on("message", lambda raw: handle_message(raw, width, height, on_ink=on_ink))
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
    finally:
        if peer is not None:
            await peer.close()
        if video_track:
            video_track.capture.close()
        notify("Companion stopped.")


def handle_message(raw, width, height, channel=None, on_ink=None):
    try:
        command = json.loads(raw)
        if command.get("type") == "clipboard-read":
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
    except (ValueError, TypeError, KeyError, pyautogui.FailSafeException):
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
