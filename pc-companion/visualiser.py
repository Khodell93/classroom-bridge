"""PC side of the iPad visualiser: composes the camera or a photo with its annotations for the classroom display.

The iPad owns the lesson (photos, strokes, undo). It sends:
- a "scene" (what to show: pc / live / photo / blank / hold, rotation and the committed strokes) whenever it changes,
- photos and "save" images as chunked blobs on the reliable media channel,
- "ink-live" points on the lossy ink channel while a stroke is being drawn, so the display keeps up with the pen.
"""

import asyncio
import ctypes
import datetime
import io
import json
import os
import pathlib
import re
import sys
import threading
from collections import OrderedDict

from aiortc.mediastreams import MediaStreamError
from PIL import Image, ImageDraw, ImageOps

MAX_BLOB_BYTES = 25_000_000
MAX_SCENE_BYTES = 8_000_000
PHOTO_CACHE_SIZE = 12
HIGHLIGHTER_OPACITY = 0.35
ROTATIONS = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}


def fit_size(width, height, screen_width, screen_height):
    scale = min(screen_width / width, screen_height / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def parse_color(value, fallback=(255, 59, 48)):
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or ""))
    if not match:
        return fallback
    text = match.group(1)
    return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))


def clean_points(points, limit=20_000):
    cleaned = []
    if not isinstance(points, list):
        return cleaned
    for point in points[:limit]:
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        cleaned.append((min(1.0, max(0.0, x)), min(1.0, max(0.0, y))))
    return cleaned


def clean_stroke(raw):
    if not isinstance(raw, dict):
        return None
    try:
        width = min(0.2, max(0.0005, float(raw.get("width", 0.004))))
    except (TypeError, ValueError):
        width = 0.004
    return {
        "id": str(raw.get("id", ""))[:64],
        "tool": "highlighter" if raw.get("tool") == "highlighter" else "pen",
        "color": parse_color(raw.get("color")),
        "width": width,
        "points": clean_points(raw.get("points")),
    }


class InkLayers:
    """Pen and highlighter layers at the displayed image size. Highlighter is drawn opaque and blended once,
    so overlapping highlighter strokes do not darken each other."""

    def __init__(self, size):
        self.size = size
        self.pen = Image.new("RGBA", size, (0, 0, 0, 0))
        self.highlight = Image.new("RGBA", size, (0, 0, 0, 0))
        self.pen_draw = ImageDraw.Draw(self.pen)
        self.highlight_draw = ImageDraw.Draw(self.highlight)
        self.has_pen = False
        self.has_highlight = False
        self.highlight_mask = None

    def draw(self, stroke, points):
        if not points:
            return
        width, height = self.size
        pixels = [(x * width, y * height) for x, y in points]
        line_width = max(1, round(stroke["width"] * width))
        color = (*stroke["color"], 255)
        if stroke["tool"] == "highlighter":
            drawer = self.highlight_draw
            self.has_highlight = True
            self.highlight_mask = None
        else:
            drawer = self.pen_draw
            self.has_pen = True
        if len(pixels) > 1:
            drawer.line(pixels, fill=color, width=line_width, joint="curve")
        radius = line_width / 2
        for x, y in (pixels[0], pixels[-1]):
            drawer.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

    def compose(self, base):
        """Returns base (RGB, same size) with the ink applied. Modifies and returns base."""
        if self.has_highlight:
            if self.highlight_mask is None:
                self.highlight_mask = self.highlight.getchannel("A").point(lambda alpha: int(alpha * HIGHLIGHTER_OPACITY))
            base = Image.composite(self.highlight.convert("RGB"), base, self.highlight_mask)
        if self.has_pen:
            base.paste(self.pen, (0, 0), self.pen)
        return base


class VisualiserScene:
    def __init__(self, screen_size, show, reply):
        self.screen_size = screen_size
        self.show = show          # presenter callback: {"type": "show", "image"} | {"type": "blank"} | {"type": "hide"}
        self.reply = reply        # sends a dict to the iPad on the control channel
        self.lock = threading.Lock()
        self.mode = "pc"
        self.rotation = 0
        self.photo_id = None
        self.strokes = []
        self.provisional = {}
        self.layers = None
        self.photos = OrderedDict()
        self.photos_in_flight = set()
        self.requested = set()
        self.compose_pending = False

    # Scene state from the iPad -------------------------------------------------------------------------------------

    def set_scene(self, message):
        mode = message.get("mode")
        if mode not in ("pc", "live", "photo", "blank", "hold"):
            return
        if mode == "hold":
            with self.lock:
                self.mode = "hold"
            return
        try:
            rotation = int(message.get("rotation", 0)) % 360
        except (TypeError, ValueError):
            rotation = 0
        strokes = [stroke for stroke in (clean_stroke(raw) for raw in (message.get("strokes") or [])[:5000]) if stroke]
        self.requested.clear()
        with self.lock:
            self.mode = mode
            self.rotation = rotation if rotation in (0, 90, 180, 270) else 0
            self.photo_id = str(message.get("photoId") or "")[:64] or None
            self.strokes = strokes
            self.provisional = {}
            self.layers = None
            if mode == "pc":
                self.show({"type": "hide"})
            elif mode == "blank":
                self.show({"type": "blank"})
        if mode == "photo":
            self.schedule_photo()

    def ink_live(self, message):
        if self.mode not in ("live", "photo"):
            return
        stroke = clean_stroke(message.get("stroke"))
        if not stroke or not stroke["id"]:
            return
        points = clean_points(message.get("points"), limit=512)
        if not points:
            return
        with self.lock:
            previous = self.provisional.get(stroke["id"])
            self.provisional[stroke["id"]] = points[-1]
            if self.layers is not None:
                self.layers.draw(stroke, ([previous] if previous else []) + points)
        if self.mode == "photo":
            self.schedule_photo()

    def add_photo(self, photo_id, image):
        self.photos[photo_id] = image
        self.photos.move_to_end(photo_id)
        while len(self.photos) > PHOTO_CACHE_SIZE:
            self.photos.popitem(last=False)
        self.photos_in_flight.discard(photo_id)
        self.requested.discard(photo_id)
        if self.mode == "photo" and self.photo_id == photo_id:
            with self.lock:
                self.layers = None
            self.schedule_photo()

    # Drawing --------------------------------------------------------------------------------------------------------

    def _layers_for(self, size):
        """Call with the lock held."""
        if self.layers is None or self.layers.size != size:
            self.layers = InkLayers(size)
            for stroke in self.strokes:
                self.layers.draw(stroke, stroke["points"])
            self.provisional = {}
        return self.layers

    def wants_live_frames(self):
        return self.mode == "live"

    def compose_live(self, frame):
        """Runs in a worker thread: converts one decoded video frame to the displayed, annotated image and shows it.
        Showing happens under the lock, so a frame can never reach the display after the scene has moved on."""
        rotation = self.rotation
        width, height = (frame.height, frame.width) if rotation in (90, 270) else (frame.width, frame.height)
        target = fit_size(width, height, *self.screen_size)
        source = (target[1], target[0]) if rotation in (90, 270) else target
        image = frame.reformat(width=source[0], height=source[1], format="rgb24").to_image()
        if rotation:
            image = image.transpose(ROTATIONS[rotation])
        with self.lock:
            if self.mode != "live":
                return
            self.show({"type": "show", "image": self._layers_for(image.size).compose(image)})

    def schedule_photo(self):
        if self.compose_pending:
            return
        self.compose_pending = True
        asyncio.get_running_loop().call_later(0.03, lambda: asyncio.ensure_future(self._compose_photo()))

    async def _compose_photo(self):
        self.compose_pending = False
        if self.mode != "photo" or not self.photo_id:
            return
        base = self.photos.get(self.photo_id)
        if base is None:
            if self.photo_id not in self.photos_in_flight and self.photo_id not in self.requested:
                self.requested.add(self.photo_id)
                self.reply({"type": "need-photo", "id": self.photo_id})
            return

        photo_id = self.photo_id

        def compose():
            with self.lock:
                if self.mode == "photo" and self.photo_id == photo_id:
                    self.show({"type": "show", "image": self._layers_for(base.size).compose(base.copy())})

        await asyncio.to_thread(compose)


async def relay_camera(track, scene):
    """Shows the iPad camera on the PC, always converting only the newest frame so latency never builds up."""
    latest = None
    arrived = asyncio.Event()

    async def receive():
        nonlocal latest
        try:
            while True:
                latest = await track.recv()
                arrived.set()
        except MediaStreamError:
            latest = None
            arrived.set()

    receiver = asyncio.ensure_future(receive())
    try:
        while not receiver.done() or latest is not None:
            await arrived.wait()
            arrived.clear()
            frame, latest = latest, None
            if frame is None or not scene.wants_live_frames():
                continue
            await asyncio.to_thread(scene.compose_live, frame)
    finally:
        receiver.cancel()


def decode_photo(data, screen_size):
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image).convert("RGB")
    return image.resize(fit_size(image.width, image.height, *screen_size), Image.Resampling.LANCZOS)


def documents_dir():
    override = os.environ.get("CLASSROOM_BRIDGE_SAVE_DIR")
    if override:
        return pathlib.Path(override)
    if sys.platform == "win32":
        # The real Documents folder, which may be redirected into OneDrive.
        buffer = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) == 0 and buffer.value:
            return pathlib.Path(buffer.value)
    return pathlib.Path.home() / "Documents"


def save_image(data, name):
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("not a JPEG image")
    folder = documents_dir() / "Classroom Bridge" / datetime.date.today().isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w .-]", "", str(name or ""))[:60].strip(" .") or datetime.datetime.now().strftime("Visualiser %H-%M-%S")
    path = folder / f"{stem}.jpg"
    counter = 2
    while path.exists():
        path = folder / f"{stem} ({counter}).jpg"
        counter += 1
    path.write_bytes(data)
    return path


class MediaReceiver:
    """Reliable media channel: small JSON scenes, plus chunked blobs (blob-start, binary chunks, blob-end)."""

    def __init__(self, scene):
        self.scene = scene
        self.blob = None

    def handle(self, raw):
        if isinstance(raw, bytes):
            blob = self.blob
            if blob is None:
                return
            blob["received"] += len(raw)
            if blob["received"] > blob["size"]:
                self.blob = None
                return
            blob["chunks"].append(raw)
            return
        try:
            message = json.loads(raw)
        except ValueError:
            return
        kind = message.get("type")
        if kind == "scene":
            self.scene.set_scene(message)
        elif kind == "blob-start":
            try:
                size = int(message.get("size", 0))
            except (TypeError, ValueError):
                return
            limit = MAX_SCENE_BYTES if message.get("kind") == "scene" else MAX_BLOB_BYTES
            if not 0 < size <= limit or message.get("kind") not in ("photo", "scene", "save"):
                self.blob = None
                return
            self.blob = {"id": message.get("id"), "kind": message["kind"], "meta": message.get("meta") or {}, "size": size, "received": 0, "chunks": []}
            if message["kind"] == "photo":
                self.scene.photos_in_flight.add(str(self.blob["meta"].get("photoId", ""))[:64])
        elif kind == "blob-end":
            blob, self.blob = self.blob, None
            if blob and blob["id"] == message.get("id") and blob["received"] == blob["size"]:
                asyncio.ensure_future(self.finish(blob, b"".join(blob["chunks"])))

    async def finish(self, blob, data):
        meta = blob["meta"]
        if blob["kind"] == "scene":
            try:
                message = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return
            if isinstance(message, dict):
                self.scene.set_scene(message)
        elif blob["kind"] == "photo":
            photo_id = str(meta.get("photoId", ""))[:64]
            try:
                image = await asyncio.to_thread(decode_photo, data, self.scene.screen_size)
            except (OSError, ValueError, Image.DecompressionBombError):
                self.scene.photos_in_flight.discard(photo_id)
                return
            self.scene.add_photo(photo_id, image)
        elif blob["kind"] == "save":
            try:
                path = await asyncio.to_thread(save_image, data, meta.get("name"))
                self.scene.reply({"type": "saved", "path": str(path), "requestId": meta.get("requestId")})
            except (OSError, ValueError) as error:
                self.scene.reply({"type": "save-error", "message": str(error), "requestId": meta.get("requestId")})
