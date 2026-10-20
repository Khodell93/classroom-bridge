// Annotation items shared by the iPad view, saving/export and (mirrored in pc-companion/visualiser.py) the PC.
//
// Every item lives in image coordinates (0–1). Widths are a fraction of the image width; text and stamp sizes
// are a fraction of the image height. Kinds:
//   stroke   { tool: "pen" | "highlighter", points: [[x, y], ...] }       (type may be absent on older photos)
//   line | arrow | rect | ellipse   { a: [x, y], b: [x, y] }
//   box      { a, b }  translucent filled highlight box
//   text     { at: [x, y] top-left, size, text }
//   stamp    { kind: "tick" | "cross" | "star" | "question" | "number", label, at: [x, y] centre, size }
// itemPrimitives() turns an item into simple drawing primitives in pixels; both sides render those the same way.

const ITEM_ALPHA = 0.35;
const STAMP_INK = 0.14;

function itemType(item) {
  return item.type || "stroke";
}

function itemPrimitives(item, width, height) {
  const px = point => [point[0] * width, point[1] * height];
  const lineWidth = Math.max(1, (item.width || 0.004) * width);
  const color = item.color || "#ff3b30";
  switch (itemType(item)) {
    case "stroke":
      return [{ kind: "polyline", points: (item.points || []).map(px), width: lineWidth, color, alpha: item.tool === "highlighter" ? ITEM_ALPHA : 1 }];
    case "line":
      return [{ kind: "polyline", points: [px(item.a), px(item.b)], width: lineWidth, color, alpha: 1 }];
    case "arrow": {
      const [ax, ay] = px(item.a);
      const [bx, by] = px(item.b);
      const angle = Math.atan2(by - ay, bx - ax);
      const head = Math.max(14, lineWidth * 4.5);
      const spread = 0.45;
      const tip = [bx, by];
      const left = [bx - head * Math.cos(angle - spread), by - head * Math.sin(angle - spread)];
      const right = [bx - head * Math.cos(angle + spread), by - head * Math.sin(angle + spread)];
      const shaftEnd = [bx - head * 0.75 * Math.cos(angle), by - head * 0.75 * Math.sin(angle)];
      return [
        { kind: "polyline", points: [[ax, ay], shaftEnd], width: lineWidth, color, alpha: 1 },
        { kind: "polygon", points: [tip, left, right], color, alpha: 1 },
      ];
    }
    case "rect": {
      const [ax, ay] = px(item.a);
      const [bx, by] = px(item.b);
      return [{ kind: "polyline", points: [[ax, ay], [bx, ay], [bx, by], [ax, by], [ax, ay]], width: lineWidth, color, alpha: 1 }];
    }
    case "box": {
      const [ax, ay] = px(item.a);
      const [bx, by] = px(item.b);
      return [{ kind: "polygon", points: [[ax, ay], [bx, ay], [bx, by], [ax, by]], color, alpha: ITEM_ALPHA }];
    }
    case "ellipse": {
      const [ax, ay] = px(item.a);
      const [bx, by] = px(item.b);
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      const points = [];
      for (let index = 0; index <= 64; index += 1) {
        const angle = (index / 64) * Math.PI * 2;
        points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
      }
      return [{ kind: "polyline", points, width: lineWidth, color, alpha: 1 }];
    }
    case "text": {
      const size = Math.max(6, (item.size || 0.05) * height);
      const [x, y] = px(item.at);
      return String(item.text || "").split("\n").map((line, index) => ({
        kind: "text", text: line, x, y: y + index * size * 1.2, size, color, anchor: "lt",
      }));
    }
    case "stamp": {
      const size = Math.max(10, (item.size || 0.08) * height);
      const [cx, cy] = px(item.at);
      const at = (dx, dy) => [cx + dx * size, cy + dy * size];
      const ink = size * STAMP_INK;
      switch (item.kind) {
        case "tick":
          return [{ kind: "polyline", points: [at(-0.36, 0.02), at(-0.1, 0.3), at(0.4, -0.32)], width: ink, color, alpha: 1 }];
        case "cross":
          return [
            { kind: "polyline", points: [at(-0.3, -0.3), at(0.3, 0.3)], width: ink, color, alpha: 1 },
            { kind: "polyline", points: [at(-0.3, 0.3), at(0.3, -0.3)], width: ink, color, alpha: 1 },
          ];
        case "star": {
          const points = [];
          for (let index = 0; index < 10; index += 1) {
            const radius = index % 2 ? 0.19 : 0.47;
            const angle = -Math.PI / 2 + (index * Math.PI) / 5;
            points.push(at(radius * Math.cos(angle), radius * Math.sin(angle)));
          }
          return [{ kind: "polygon", points, color, alpha: 1 }];
        }
        case "question":
          return [
            { kind: "circle", cx, cy, r: size * 0.46, width: size * 0.07, color, alpha: 1 },
            { kind: "text", text: "?", x: cx, y: cy, size: size * 0.62, color, anchor: "mm" },
          ];
        default: {
          const text = String(item.label ?? "1").slice(0, 3);
          return [
            { kind: "disc", cx, cy, r: size * 0.46, color, alpha: 1 },
            { kind: "text", text, x: cx, y: cy, size: size * (text.length > 1 ? 0.46 : 0.58), color: contrastingInk(color), anchor: "mm" },
          ];
        }
      }
    }
    default:
      return [];
  }
}

function contrastingInk(hex) {
  const value = String(hex).replace("#", "");
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) || 0);
  return r * 0.299 + g * 0.587 + b * 0.114 > 160 ? "#111111" : "#ffffff";
}

const ITEM_FONT = "700 {size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";

// Draws primitives onto a 2D context. map(point) converts item pixels to canvas pixels; scale converts lengths.
function drawPrimitives(context, primitives, map = point => point, scale = 1) {
  for (const primitive of primitives) {
    context.save();
    context.globalAlpha = primitive.alpha ?? 1;
    context.strokeStyle = context.fillStyle = primitive.color;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (primitive.kind === "polyline" && primitive.points.length) {
      context.lineWidth = primitive.width * scale;
      context.beginPath();
      const [x0, y0] = map(primitive.points[0]);
      context.moveTo(x0, y0);
      if (primitive.points.length === 1) context.lineTo(x0 + 0.01, y0);
      for (let index = 1; index < primitive.points.length; index += 1) context.lineTo(...map(primitive.points[index]));
      context.stroke();
    } else if (primitive.kind === "polygon") {
      context.beginPath();
      primitive.points.forEach((point, index) => (index ? context.lineTo(...map(point)) : context.moveTo(...map(point))));
      context.closePath();
      context.fill();
    } else if (primitive.kind === "circle" || primitive.kind === "disc") {
      const [cx, cy] = map([primitive.cx, primitive.cy]);
      context.beginPath();
      context.arc(cx, cy, primitive.r * scale, 0, Math.PI * 2);
      if (primitive.kind === "disc") context.fill();
      else {
        context.lineWidth = primitive.width * scale;
        context.stroke();
      }
    } else if (primitive.kind === "text") {
      const [x, y] = map([primitive.x, primitive.y]);
      context.font = ITEM_FONT.replace("{size}", String(primitive.size * scale));
      context.textAlign = primitive.anchor === "mm" ? "center" : "left";
      context.textBaseline = primitive.anchor === "mm" ? "middle" : "top";
      context.fillText(primitive.text, x, y);
    }
    context.restore();
  }
}

// Draws an item scaled to an image of width × height, placed with its top-left at (left, top) on the context,
// multiplied by ratio (device pixels per CSS pixel).
function drawItem(context, item, rect, ratio = 1) {
  const primitives = itemPrimitives(item, rect.width, rect.height);
  drawPrimitives(context, primitives, ([x, y]) => [(rect.left + x) * ratio, (rect.top + y) * ratio], ratio);
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [xi, yi] = points[index];
    const [xj, yj] = points[previous];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

// Whether a point (image pixels for an image of width × height) touches the item, within reach pixels.
function itemHit(item, px, py, width, height, reach) {
  for (const primitive of itemPrimitives(item, width, height)) {
    if (primitive.kind === "polyline") {
      const limit = reach + primitive.width / 2;
      const points = primitive.points;
      if (points.length === 1 && Math.hypot(px - points[0][0], py - points[0][1]) <= limit) return true;
      for (let index = 1; index < points.length; index += 1) {
        if (distanceToSegment(px, py, points[index - 1], points[index]) <= limit) return true;
      }
    } else if (primitive.kind === "polygon") {
      if (pointInPolygon(px, py, primitive.points)) return true;
    } else if (primitive.kind === "circle" || primitive.kind === "disc") {
      if (Math.hypot(px - primitive.cx, py - primitive.cy) <= primitive.r + reach) return true;
    } else if (primitive.kind === "text") {
      const textWidth = primitive.text.length * primitive.size * 0.6;
      const left = primitive.anchor === "mm" ? primitive.x - textWidth / 2 : primitive.x;
      const top = primitive.anchor === "mm" ? primitive.y - primitive.size / 2 : primitive.y;
      if (px >= left - reach && px <= left + textWidth + reach && py >= top - reach && py <= top + primitive.size * 1.2 + reach) return true;
    }
  }
  return false;
}

// Applies a point transform (image coords → image coords) to every position in an item, and scales widths/sizes.
function transformItem(item, mapPoint, widthScale = 1, sizeScale = 1) {
  const copy = { ...item };
  if (copy.points) copy.points = copy.points.map(point => roundPoint(mapPoint(point)));
  if (copy.a) copy.a = roundPoint(mapPoint(copy.a));
  if (copy.b) copy.b = roundPoint(mapPoint(copy.b));
  if (copy.at) copy.at = roundPoint(mapPoint(copy.at));
  if (copy.width) copy.width *= widthScale;
  if (copy.size) copy.size *= sizeScale;
  return copy;
}

function roundPoint([x, y]) {
  return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
}

// ---------- Image adjustments (identical maths on the PC) ----------

function hasAdjust(adjust) {
  return Boolean(adjust && (adjust.b || adjust.c || adjust.mono));
}

// CSS preview filter for the iPad.
function adjustFilter(adjust) {
  if (!hasAdjust(adjust)) return "";
  return `brightness(${1 + (adjust.b || 0)}) contrast(${1 + (adjust.c || 0)})${adjust.mono ? " grayscale(1)" : ""}`;
}

function adjustLookup(adjust) {
  const table = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) {
    table[value] = ((value * (1 + (adjust.b || 0))) - 127.5) * (1 + (adjust.c || 0)) + 127.5;
  }
  return table;
}

// Applies brightness/contrast/black-and-white to a canvas in place (used for saving and export).
function applyAdjustToCanvas(canvas, adjust) {
  if (!hasAdjust(adjust)) return;
  const context = canvas.getContext("2d");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const table = adjustLookup(adjust);
  for (let index = 0; index < data.length; index += 4) {
    let r = table[data[index]];
    let g = table[data[index + 1]];
    let b = table[data[index + 2]];
    if (adjust.mono) r = g = b = r * 0.2126 + g * 0.7152 + b * 0.0722;
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
  }
  context.putImageData(image, 0, 0);
}
