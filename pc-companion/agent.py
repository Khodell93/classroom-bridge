import argparse
import asyncio
import json
import secrets
import string
import sys
import threading

import mss
import numpy as np
import pyautogui
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame
from PIL import Image

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ALLOWED_KEYS = {"left", "right", "space", "enter", "esc", "home", "end", "pageup", "pagedown"}


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
    if kind == "move":
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
    elif kind == "hotkey" and command.get("keys") == ["win", "e"]:
        pyautogui.hotkey("win", "e")
    elif kind == "text":
        value = str(command.get("text", ""))[:250]
        if value.isprintable():
            pyautogui.write(value, interval=0.01)


async def run(signal_url, room, notify=print, stop_event=None):
    stop_event = stop_event or threading.Event()
    peer = RTCPeerConnection()
    video_track = DesktopVideo()
    peer.addTrack(video_track)
    channel = peer.createDataChannel("controls")
    width, height = pyautogui.size()
    channel.on("message", lambda raw: handle_message(raw, width, height))
    pair_url = f"{signal_url.rstrip('/')}/signal/{room}?role=pc"
    notify("Connecting to Classroom Bridge…")
    offered = False
    try:
        async with websockets.connect(pair_url, max_size=48_000, ping_interval=20) as socket:
            notify("Ready — enter the pairing code on the iPad.")
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                message = json.loads(raw)
                if message.get("type") == "peer-ready" and not offered:
                    offered = True
                    offer = await peer.createOffer()
                    await peer.setLocalDescription(offer)
                    await socket.send(json.dumps({"type": "offer", "description": {"type": peer.localDescription.type, "sdp": peer.localDescription.sdp}}))
                    notify("iPad found — connecting…")
                elif message.get("type") == "answer":
                    description = message.get("description", {})
                    await peer.setRemoteDescription(RTCSessionDescription(sdp=description["sdp"], type=description["type"]))
                    notify("Connected. The iPad can now control this desktop.")
                elif message.get("type") == "candidate" and message.get("candidate"):
                    candidate_data = message["candidate"]
                    candidate = candidate_from_sdp(candidate_data["candidate"].removeprefix("candidate:"))
                    candidate.sdpMid = candidate_data.get("sdpMid")
                    candidate.sdpMLineIndex = candidate_data.get("sdpMLineIndex")
                    await peer.addIceCandidate(candidate)
    except KeyboardInterrupt:
        pass
    finally:
        await peer.close()
        video_track.capture.close()
        notify("Companion stopped.")


def handle_message(raw, width, height):
    try:
        command = json.loads(raw)
        perform_control(command, width, height)
    except (ValueError, TypeError, KeyError, pyautogui.FailSafeException):
        return


def main():
    parser = argparse.ArgumentParser(description="Classroom Bridge Windows companion")
    parser.add_argument("--signal", required=True, help="Cloudflare Worker base URL, e.g. wss://classroom-bridge.example.workers.dev")
    args = parser.parse_args()
    room = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(12))
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
