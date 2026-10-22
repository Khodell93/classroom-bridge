"""PC side of the iPad visualiser: composes the camera or a photo with its annotations for the classroom display.

The iPad owns the lesson (photos, annotations, undo). It sends:
- a "scene" (what to show: pc / live / photo / blank / hold, plus rotation, annotation items, zoom viewport,
  brightness/contrast, spotlight and curtain) whenever it changes, on the reliable media channel;
- "view-update" messages (viewport, spotlight, curtain) while the teacher is dragging, on the same channel;
- photos and files to save as chunked blobs, on the same channel;
- "ink-live", "shape-live" and "laser" messages while drawing, on the lossy ink channel, so the display keeps up.

Item geometry mirrors public/vis-items.js, so the projector shows exactly what the iPad shows.
"""

import asyncio
import ctypes
import datetime
import io
import json
import logging
import math
import os
import pathlib
import re
import sys
import threading
import time
from collections import OrderedDict

import mss
import numpy as np
from aiortc.mediastreams import MediaStreamError
from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_PHOTO_BYTES = 25_000_000
MAX_SAVE_BYTES = 600_000_000
MAX_SCENE_BYTES = 8_000_000
PHOTO_CACHE_SIZE = 6
ITEM_ALPHA = 0.35
STAMP_INK = 0.14
LASER_SECONDS = 0.8
ROTATIONS = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}
ITEM_TYPES = {"stroke", "line", "arrow", "rect", "box", "ellipse", "text", "stamp"}
STAMP_KINDS = {"tick", "cross", "star", "question", "number"}
_fonts = {}


def fit_size(width, height, screen_width, screen_height):
    scale = min(screen_width / width, screen_height / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def font(size):
    size = max(6, min(600, int(round(size))))
    if size not in _fonts:
        _fonts[size] = ImageFont.load_default(size=size)
    return _fonts[size]


# ---------- Cleaning what the iPad sends ----------

def parse_color(value, fallback=(255, 59, 48)):
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or ""))
    if not match:
        return fallback
    text = match.group(1)
    return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))


def clamp(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(number):
        return fallback
    return min(high, max(low, number))


def clean_point(point):
    try:
        return (clamp(point[0], -0.5, 1.5, 0.0), clamp(point[1], -0.5, 1.5, 0.0))
    except (TypeError, IndexError, KeyError):
        return None


def clean_points(points, limit=20_000):
    if not isinstance(points, list):
        return []
    return [point for point in (clean_point(raw) for raw in points[:limit]) if point]


def clean_item(raw):
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type") or "stroke"
    if kind not in ITEM_TYPES:
        return None
    item = {
        "id": str(raw.get("id", ""))[:64],
        "type": kind,
        "color": parse_color(raw.get("color")),
        "width": clamp(raw.get("width"), 0.0005, 0.2, 0.004),
    }
    if kind == "stroke":
        item["tool"] = "highlighter" if raw.get("tool") == "highlighter" else "pen"
        item["points"] = clean_points(raw.get("points"))
    elif kind in ("line", "arrow", "rect", "box", "ellipse"):
        item["a"], item["b"] = clean_point(raw.get("a") or [0, 0]), clean_point(raw.get("b") or [0, 0])
        if not item["a"] or not item["b"]:
            return None
    else:
        item["at"] = clean_point(raw.get("at") or [0, 0])
        item["size"] = clamp(raw.get("size"), 0.005, 0.6, 0.05)
        if not item["at"]:
            return None
        if kind == "text":
            item["text"] = str(raw.get("text", ""))[:500]
        else:
            item["kind"] = raw.get("kind") if raw.get("kind") in STAMP_KINDS else "tick"
            item["label"] = str(raw.get("label", "1"))[:3]
    return item


def clean_viewport(raw):
    if not isinstance(raw, dict):
        return (0.0, 0.0, 1.0)
    scale = clamp(raw.get("s"), 1.0, 8.0, 1.0)
    limit = 1 - 1 / scale
    return (clamp(raw.get("x"), 0.0, limit, 0.0), clamp(raw.get("y"), 0.0, limit, 0.0), scale)


def clean_adjust(raw):
    if not isinstance(raw, dict):
        return None
    adjust = (clamp(raw.get("b"), -0.8, 1.5, 0.0), clamp(raw.get("c"), -0.8, 2.0, 0.0), bool(raw.get("mono")))
    return adjust if adjust != (0.0, 0.0, False) else None


def clean_spotlight(raw):
    if not isinstance(raw, dict):
        return None
    return (clamp(raw.get("x"), 0, 1, 0.5), clamp(raw.get("y"), 0, 1, 0.5), clamp(raw.get("r"), 0.02, 1, 0.2))


def clean_curtain(raw):
    if not isinstance(raw, dict):
        return None
    return clamp(raw.get("reveal"), 0, 1, 0.3)


# ---------- Geometry (mirrors itemPrimitives in public/vis-items.js) ----------

def contrasting_ink(color):
    red, green, blue = color
    return (17, 17, 17) if red * 0.299 + green * 0.587 + blue * 0.114 > 160 else (255, 255, 255)


def item_primitives(item, width, height):
    def px(point):
        return (point[0] * width, point[1] * height)

    line_width = max(1.0, item["width"] * width)
    color = item["color"]
    kind = item["type"]
    if kind == "stroke":
        return [("polyline", [px(point) for point in item["points"]], line_width, color, ITEM_ALPHA if item["tool"] == "highlighter" else 1)]
    if kind == "line":
        return [("polyline", [px(item["a"]), px(item["b"])], line_width, color, 1)]
    if kind == "arrow":
        (ax, ay), (bx, by) = px(item["a"]), px(item["b"])
        angle = math.atan2(by - ay, bx - ax)
        head = max(14.0, line_width * 4.5)
        spread = 0.45
        left = (bx - head * math.cos(angle - spread), by - head * math.sin(angle - spread))
        right = (bx - head * math.cos(angle + spread), by - head * math.sin(angle + spread))
        shaft_end = (bx - head * 0.75 * math.cos(angle), by - head * 0.75 * math.sin(angle))
        return [("polyline", [(ax, ay), shaft_end], line_width, color, 1), ("polygon", [(bx, by), left, right], color, 1)]
    if kind in ("rect", "box"):
        (ax, ay), (bx, by) = px(item["a"]), px(item["b"])
        corners = [(ax, ay), (bx, ay), (bx, by), (ax, by)]
        if kind == "box":
            return [("polygon", corners, color, ITEM_ALPHA)]
        return [("polyline", corners + [(ax, ay)], line_width, color, 1)]
    if kind == "ellipse":
        (ax, ay), (bx, by) = px(item["a"]), px(item["b"])
        cx, cy, rx, ry = (ax + bx) / 2, (ay + by) / 2, abs(bx - ax) / 2, abs(by - ay) / 2
        points = [(cx + rx * math.cos(index / 64 * math.tau), cy + ry * math.sin(index / 64 * math.tau)) for index in range(65)]
        return [("polyline", points, line_width, color, 1)]
    if kind == "text":
        size = max(6.0, item["size"] * height)
        x, y = px(item["at"])
        return [("text", line, (x, y + index * size * 1.2), size, color, "lt") for index, line in enumerate(item["text"].split("\n"))]
    size = max(10.0, item["size"] * height)
    cx, cy = px(item["at"])

    def at(dx, dy):
        return (cx + dx * size, cy + dy * size)

    ink = size * STAMP_INK
    stamp = item["kind"]
    if stamp == "tick":
        return [("polyline", [at(-0.36, 0.02), at(-0.1, 0.3), at(0.4, -0.32)], ink, color, 1)]
    if stamp == "cross":
        return [("polyline", [at(-0.3, -0.3), at(0.3, 0.3)], ink, color, 1), ("polyline", [at(-0.3, 0.3), at(0.3, -0.3)], ink, color, 1)]
    if stamp == "star":
        points = []
        for index in range(10):
            radius = 0.19 if index % 2 else 0.47
            angle = -math.pi / 2 + index * math.pi / 5
            points.append(at(radius * math.cos(angle), radius * math.sin(angle)))
        return [("polygon", points, color, 1)]
    if stamp == "question":
        return [("circle", (cx, cy), size * 0.46, size * 0.07, color, 1), ("text", "?", (cx, cy), size * 0.62, color, "mm")]
    label = item["label"] or "1"
    return [("disc", (cx, cy), size * 0.46, 0, color, 1), ("text", label, (cx, cy), size * (0.46 if len(label) > 1 else 0.58), contrasting_ink(color), "mm")]


def draw_primitive(draw, primitive, offset):
    ox, oy = offset
    kind = primitive[0]
    if kind == "polyline":
        _, points, width, color, _alpha = primitive
        if not points:
            return
        pixels = [(x - ox, y - oy) for x, y in points]
        line_width = max(1, round(width))
        fill = (*color, 255)
        if len(pixels) > 1:
            draw.line(pixels, fill=fill, width=line_width, joint="curve")
        radius = line_width / 2
        for x, y in (pixels[0], pixels[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)
    elif kind == "polygon":
        _, points, color, _alpha = primitive
        draw.polygon([(x - ox, y - oy) for x, y in points], fill=(*color, 255))
    elif kind in ("circle", "disc"):
        _, (cx, cy), radius, width, color, _alpha = primitive
        box = (cx - ox - radius, cy - oy - radius, cx - ox + radius, cy - oy + radius)
        if kind == "disc":
            draw.ellipse(box, fill=(*color, 255))
        else:
            draw.ellipse(box, outline=(*color, 255), width=max(1, round(width)))
    elif kind == "text":
        _, text, (x, y), size, color, anchor = primitive
        draw.text((x - ox, y - oy), text, font=font(size), fill=(*color, 255), anchor=anchor)


def primitive_alpha(primitive):
    return primitive[-1] if primitive[0] in ("polyline", "polygon", "circle", "disc") else 1


class InkLayers:
    """Opaque and translucent layers for the visible part of an image. Translucent items (highlighter, highlight
    boxes) are drawn solid and blended once, so overlapping strokes don't darken each other, as on the iPad."""

    def __init__(self, size, viewport):
        self.size = size
        self.viewport = viewport
        x, y, scale = viewport
        self.full = (size[0] * scale, size[1] * scale)
        self.offset = (x * self.full[0], y * self.full[1])
        self.solid = Image.new("RGBA", size, (0, 0, 0, 0))
        self.translucent = Image.new("RGBA", size, (0, 0, 0, 0))
        self.solid_draw = ImageDraw.Draw(self.solid)
        self.translucent_draw = ImageDraw.Draw(self.translucent)
        self.has_solid = False
        self.has_translucent = False
        self.mask = None

    def draw(self, item, points=None):
        if points is not None:
            item = {**item, "points": points}
        for primitive in item_primitives(item, *self.full):
            if primitive_alpha(primitive) < 1:
                draw_primitive(self.translucent_draw, primitive, self.offset)
                self.has_translucent = True
                self.mask = None
            else:
                draw_primitive(self.solid_draw, primitive, self.offset)
                self.has_solid = True

    def compose(self, base):
        if self.has_translucent:
            if self.mask is None:
                self.mask = self.translucent.getchannel("A").point(lambda alpha: int(alpha * ITEM_ALPHA))
            base = Image.composite(self.translucent.convert("RGB"), base, self.mask)
        if self.has_solid:
            base.paste(self.solid, (0, 0), self.solid)
        return base


def apply_adjust(image, adjust):
    if not adjust:
        return image
    brightness, contrast, mono = adjust
    table = [max(0, min(255, round(((value * (1 + brightness)) - 127.5) * (1 + contrast) + 127.5))) for value in range(256)]
    image = image.point(table * 3)
    if mono:
        pixels = np.asarray(image, dtype=np.float32)
        luminance = (pixels[..., 0] * 0.2126 + pixels[..., 1] * 0.7152 + pixels[..., 2] * 0.0722).clip(0, 255).astype(np.uint8)
        image = Image.fromarray(np.stack([luminance] * 3, axis=-1))
    return image


# ---------- The scene ----------

class VisualiserScene:
    def __init__(self, screen_size, show, reply, send_media=None):
        self.screen_size = screen_size
        # presenter callback: {"type": "show", "image"} | {"type": "pip", "image", "corner"} | {"type": "blank"} | {"type": "hide"}
        self.show = show
        self.reply = reply        # sends a dict to the iPad on the control channel
        self.send_media = send_media  # sends a blob (kind, bytes, meta) to the iPad on the media channel
        self.pip = ("br", 0.32)
        self.lock = threading.Lock()
        self.mode = "pc"
        self.rotation = 0
        self.photo_id = None
        self.items = []
        self.viewport = (0.0, 0.0, 1.0)
        self.adjust = None
        self.spotlight = None
        self.curtain = None
        self.provisional = {}     # stroke id -> last point drawn into the layers
        self.shape = None         # shape being dragged out (drawn on top until committed)
        self.laser = []           # [(time, x, y)]
        self.layers = None
        self.photos = OrderedDict()
        self.photos_in_flight = set()
        self.requested = set()
        self.compose_pending = False

    # State from the iPad ---------------------------------------------------------------------------------------------

    def set_scene(self, message):
        mode = message.get("mode")
        if mode not in ("pc", "live", "photo", "blank", "hold", "pip"):
            logging.getLogger("scene").warning("ignored scene with unknown mode %r", mode)
            return
        if mode != getattr(self, "logged_mode", None):
            self.logged_mode = mode
            logging.getLogger("scene").info("iPad scene: %s", mode)
        if mode == "hold":
            with self.lock:
                self.mode = "hold"
            return
        try:
            rotation = int(message.get("rotation", 0)) % 360
        except (TypeError, ValueError):
            rotation = 0
        raw_items = message.get("items", message.get("strokes")) or []
        items = [item for item in (clean_item(raw) for raw in raw_items[:5000]) if item]
        self.requested.clear()
        with self.lock:
            self.mode = mode
            self.rotation = rotation if rotation in (0, 90, 180, 270) else 0
            self.photo_id = str(message.get("photoId") or "")[:64] or None
            self.items = items
            self.viewport = clean_viewport(message.get("viewport"))
            self.adjust = clean_adjust(message.get("adjust"))
            self.spotlight = clean_spotlight(message.get("spotlight"))
            self.curtain = clean_curtain(message.get("curtain"))
            corner = message.get("corner") if message.get("corner") in ("tl", "tr", "bl", "br") else "br"
            self.pip = (corner, clamp(message.get("size"), 0.15, 0.6, 0.32))
            self.provisional = {}
            self.shape = None
            self.layers = None
            if mode == "pc":
                self.show({"type": "hide"})
            elif mode == "blank":
                self.show({"type": "blank"})
        if mode == "photo":
            self.schedule_photo()

    def view_update(self, message):
        with self.lock:
            if "viewport" in message:
                viewport = clean_viewport(message.get("viewport"))
                if viewport != self.viewport:
                    self.viewport = viewport
                    self.layers = None
            if "spotlight" in message:
                self.spotlight = clean_spotlight(message.get("spotlight"))
            if "curtain" in message:
                self.curtain = clean_curtain(message.get("curtain"))
        if self.mode == "photo":
            self.schedule_photo()

    def ink_live(self, message):
        if self.mode not in ("live", "photo"):
            return
        stroke = clean_item({**(message.get("stroke") or {}), "type": "stroke", "points": []})
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

    def shape_live(self, message):
        if self.mode not in ("live", "photo"):
            return
        with self.lock:
            self.shape = clean_item(message.get("item")) if message.get("item") else None
        if self.mode == "photo":
            self.schedule_photo()

    def laser_points(self, message):
        if self.mode not in ("live", "photo"):
            return
        now = time.monotonic()
        with self.lock:
            self.laser = [entry for entry in self.laser if now - entry[0] < LASER_SECONDS]
            self.laser.extend((now, x, y) for x, y in clean_points(message.get("points"), limit=256))
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

    def _layers_for(self, size, viewport):
        """Call with the lock held."""
        if self.layers is None or self.layers.size != size or self.layers.viewport != viewport:
            self.layers = InkLayers(size, viewport)
            for item in self.items:
                self.layers.draw(item)
            self.provisional = {}
        return self.layers

    def _finish(self, image, viewport):
        """Call with the lock held: ink, the shape being drawn, laser, spotlight and curtain on the visible image."""
        image = self._layers_for(image.size, viewport).compose(image)
        if self.shape:
            extra = InkLayers(image.size, viewport)
            extra.draw(self.shape)
            image = extra.compose(image)
        x0, y0, scale = viewport
        full_width, full_height = image.size[0] * scale, image.size[1] * scale

        def to_pixels(x, y):
            return ((x - x0) * full_width, (y - y0) * full_height)

        now = time.monotonic()
        trail = [entry for entry in self.laser if now - entry[0] < LASER_SECONDS]
        if trail or self.spotlight or self.curtain is not None:
            image = image.copy() if image is self.photos.get(self.photo_id) else image
            draw = ImageDraw.Draw(image)
            if trail:
                base = max(4.0, image.size[0] / 220)
                previous = None
                for moment, x, y in trail:
                    point = to_pixels(x, y)
                    life = 1 - (now - moment) / LASER_SECONDS
                    if previous:
                        draw.line([previous, point], fill=(255, 40, 60), width=max(1, round(base * life)))
                    previous = point
                radius = base * 1.6
                draw.ellipse((previous[0] - radius, previous[1] - radius, previous[0] + radius, previous[1] + radius), fill=(255, 40, 60), outline=(255, 255, 255), width=2)
            if self.spotlight:
                sx, sy, sr = self.spotlight
                cx, cy = to_pixels(sx, sy)
                radius = sr * full_width
                mask = Image.new("L", image.size, 200)
                ImageDraw.Draw(mask).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=0)
                image = Image.composite(Image.new("RGB", image.size, (0, 0, 0)), image, mask)
                draw = ImageDraw.Draw(image)
            if self.curtain is not None:
                top = max(0, to_pixels(0, self.curtain)[1])
                if top < image.size[1]:
                    draw.rectangle((0, top, image.size[0], image.size[1]), fill=(22, 27, 36))
                    draw.rectangle((0, top, image.size[0], top + max(3, image.size[1] / 180)), fill=(156, 200, 255))
        return image, bool(trail)

    def wants_live_frames(self):
        return self.mode in ("live", "pip")

    def compose_live(self, frame):
        """Runs in a worker thread: converts one decoded video frame to the displayed, annotated image and shows it.
        Showing happens under the lock, so a frame can never reach the display after the scene has moved on."""
        rotation = self.rotation
        width, height = (frame.height, frame.width) if rotation in (90, 270) else (frame.width, frame.height)
        pip = self.mode == "pip"
        corner, share = self.pip
        bounds = (self.screen_size[0] * share, self.screen_size[1] * share) if pip else self.screen_size
        target = fit_size(width, height, *bounds)
        source = (target[1], target[0]) if rotation in (90, 270) else target
        image = frame.reformat(width=source[0], height=source[1], format="rgb24").to_image()
        if rotation:
            image = image.transpose(ROTATIONS[rotation])
        image = apply_adjust(image, self.adjust)
        with self.lock:
            if self.mode == "pip" and pip:
                self.show({"type": "pip", "image": image, "corner": corner})
                return
            if self.mode != "live" or pip:
                return
            image, _ = self._finish(image, (0.0, 0.0, 1.0))
            self.show({"type": "show", "image": image})

    def schedule_photo(self, delay=0.03):
        if self.compose_pending:
            return
        self.compose_pending = True
        asyncio.get_running_loop().call_later(delay, lambda: asyncio.ensure_future(self._compose_photo()))

    async def _compose_photo(self):
        self.compose_pending = False
        if self.mode != "photo" or not self.photo_id:
            return
        original = self.photos.get(self.photo_id)
        if original is None:
            if self.photo_id not in self.photos_in_flight and self.photo_id not in self.requested:
                self.requested.add(self.photo_id)
                self.reply({"type": "need-photo", "id": self.photo_id})
            return
        photo_id, viewport, adjust = self.photo_id, self.viewport, self.adjust
        size = fit_size(original.width, original.height, *self.screen_size)

        def compose():
            x, y, scale = viewport
            box = (x * original.width, y * original.height, (x + 1 / scale) * original.width, (y + 1 / scale) * original.height)
            visible = original.resize(size, Image.Resampling.BILINEAR, box=box, reducing_gap=2.0)
            visible = apply_adjust(visible, adjust)
            with self.lock:
                if self.mode != "photo" or self.photo_id != photo_id:
                    return False
                if self.viewport != viewport:
                    return True  # the teacher is still zooming; compose again with the newest viewport
                image, laser_active = self._finish(visible, viewport)
                self.show({"type": "show", "image": image})
                return laser_active

        if await asyncio.to_thread(compose):
            self.schedule_photo(0.04)  # keep the laser trail fading


def grab_screen():
    """The whole main display at full resolution, including the desktop ink overlay."""
    with mss.mss() as capture:
        shot = capture.grab(capture.monitors[1])
        image = Image.frombytes("RGB", shot.size, shot.rgb)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return buffer.getvalue(), image.size


async def send_screenshot(scene, request_id):
    try:
        data, (width, height) = await asyncio.to_thread(grab_screen)
    except Exception as error:  # screen capture permission (macOS) or display errors
        scene.reply({"type": "screenshot-error", "requestId": request_id, "message": str(error)})
        return
    if not scene.send_media or not scene.send_media("screenshot", data, {"requestId": request_id, "width": width, "height": height}):
        scene.reply({"type": "screenshot-error", "requestId": request_id, "message": "The connection closed."})


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


def decode_photo(data):
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image).convert("RGB")
    if max(image.size) > 4096:
        image.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
    return image


# ---------- Saving files on the PC ----------

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


def file_extension(data):
    if data.startswith(b"\xff\xd8"):
        return ".jpg"
    if data.startswith(b"%PDF"):
        return ".pdf"
    if data[4:8] == b"ftyp":
        return ".mp4"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm"
    raise ValueError("unsupported file type")


def save_file(data, name):
    extension = file_extension(data)
    folder = documents_dir() / "Classroom Bridge" / datetime.date.today().isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w .-]", "", str(name or ""))[:80].strip(" .") or datetime.datetime.now().strftime("Visualiser %H-%M-%S")
    path = folder / f"{stem}{extension}"
    counter = 2
    while path.exists():
        path = folder / f"{stem} ({counter}){extension}"
        counter += 1
    path.write_bytes(data)
    return path


class MediaReceiver:
    """Reliable media channel: small JSON messages, plus chunked blobs (blob-start, binary chunks, blob-end)."""

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
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "scene":
            self.scene.set_scene(message)
        elif kind == "view-update":
            self.scene.view_update(message)
        elif kind == "blob-start":
            try:
                size = int(message.get("size", 0))
            except (TypeError, ValueError):
                return
            blob_kind = message.get("kind")
            limit = {"scene": MAX_SCENE_BYTES, "photo": MAX_PHOTO_BYTES, "save": MAX_SAVE_BYTES}.get(blob_kind, 0)
            if not 0 < size <= limit:
                self.blob = None
                return
            meta = message.get("meta") if isinstance(message.get("meta"), dict) else {}
            self.blob = {"id": message.get("id"), "kind": blob_kind, "meta": meta, "size": size, "received": 0, "chunks": []}
            if blob_kind == "photo":
                self.scene.photos_in_flight.add(str(meta.get("photoId", ""))[:64])
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
                image = await asyncio.to_thread(decode_photo, data)
            except (OSError, ValueError, Image.DecompressionBombError):
                self.scene.photos_in_flight.discard(photo_id)
                return
            self.scene.add_photo(photo_id, image)
        elif blob["kind"] == "save":
            try:
                path = await asyncio.to_thread(save_file, data, meta.get("name"))
                self.scene.reply({"type": "saved", "path": str(path), "requestId": meta.get("requestId")})
            except (OSError, ValueError) as error:
                self.scene.reply({"type": "save-error", "message": str(error), "requestId": meta.get("requestId")})
