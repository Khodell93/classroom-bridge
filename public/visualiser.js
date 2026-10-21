// Visualiser: live iPad camera, captured photos kept on this iPad, and per-photo annotations.
// Loaded after vis-items.js and before app.js; app.js calls initVisualiser() once its own setup has run.
//
// Model: each page (the live camera, or a saved photo) has a list of annotation items in image coordinates (0–1)
// (see vis-items.js), so annotations survive rotation, zoom, saving and being shown at any size. The iPad sends the
// PC a "scene" describing what to show, plus live messages while the teacher draws or drags.

let cameraStream;
let cameraSender;
let mediaChannel;
let cameraView = "off"; // "off" | "live" (camera running)
let cameraFacing = "environment";
// Live video runs at 1080p so the iPad's hardware encoder keeps it smooth; Capture briefly switches to 4K.
const LIVE_CAMERA_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };
const STILL_CAMERA_SIZE = { width: { ideal: 3840 }, height: { ideal: 2160 } };
let cameraCapabilities = {};
let cameraZoom = 1;
let pendingCameraZoom;
let cameraPinch;
let cameraGestureWasPinch = false;
const cameraTouches = new Map();

const PEN_COLOURS = ["#ff3b30", "#007aff", "#34c759", "#ffcc00", "#111111", "#ffffff"];
// Pixel sizes on the iPad view for each size step; text and stamps are fractions of the image height.
const PEN_SIZES = { pen: [3, 6, 12], highlighter: [16, 26, 40] };
const TEXT_SIZES = [0.035, 0.05, 0.075];
const STAMP_SIZES = [0.06, 0.09, 0.13];
const SHAPES = { line: "╱", arrow: "↗", rect: "▭", ellipse: "◯", box: "▮" };
const STAMPS = { tick: "✓", cross: "✗", star: "★", question: "?", number: "①" };
const ERASER_RADIUS = 16;
const LASER_SECONDS = 0.8;

const visualiser = {
  photos: [],            // { id, lesson, created, width, height, strokes (items), adjust, blob, url, thumb }
  lessons: [],           // { id, name, created }
  lesson: undefined,     // current lesson id
  page: "live",          // "live" or a photo id
  liveStrokes: [],
  liveRotation: 0,
  liveAdjust: null,
  view: { x: 0, y: 0, s: 1 },  // zoom/pan of the current photo
  history: new Map(),    // page -> { undo: [items...], redo: [items...] }
  tool: "pen",
  shape: "arrow",
  stamp: "tick",
  colour: PEN_COLOURS[0],
  sizeIndex: 1,
  blank: false,
  hold: false,
  spotlight: null,       // { x, y, r } in image coordinates
  curtain: null,         // { reveal } fraction shown from the top
  pip: null,             // { corner, size } picture-in-picture camera over the PC screen (PC mode)
  active: null,          // stroke or shape being drawn
  activePointer: undefined,
  erasing: null,
  laserTrail: [],
  pendingLive: [],
  liveFrame: undefined,
  renderFrame: undefined,
  viewFrame: undefined,
  photoTouches: new Map(),
  photoGesture: null,
  overlayGesture: null,
  sentPhotos: new Set(),
  sendQueue: Promise.resolve(),
  sceneVersion: 0,
  blobCounter: 0,
  saveRequests: new Map(),
  exportCache: new Map(), // photo id -> { key, file }
  db: undefined,
};

// ---------- Storage (IndexedDB): lessons and photos are kept on this iPad until deleted ----------

function openVisualiserDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("classroom-bridge-visualiser", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("lessons")) db.createObjectStore("lessons", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action, storeName = "photos") {
  if (!visualiser.db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const transaction = visualiser.db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function storePhoto(photo) {
  const { id, lesson, created, width, height, strokes, adjust, blob } = photo;
  return dbRequest("readwrite", store => store.put({ id, lesson, created, width, height, strokes, adjust, blob })).catch(() => {
    showToast("This iPad's storage is full — delete some photos or lessons.");
  });
}

function storeLesson(lesson) {
  return dbRequest("readwrite", store => store.put(lesson), "lessons").catch(() => {});
}

const storeTimers = new Map();
function storePhotoSoon(photo) {
  window.clearTimeout(storeTimers.get(photo.id));
  storeTimers.set(photo.id, window.setTimeout(() => storePhoto(photo), 400));
}

function lessonName(date = new Date()) {
  return `Lesson ${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

async function newLesson(name = lessonName()) {
  const lesson = { id: newId(), name, created: Date.now() };
  visualiser.lessons.push(lesson);
  await storeLesson(lesson);
  return lesson;
}

async function loadStoredPhotos() {
  try {
    visualiser.db = await openVisualiserDb();
    navigator.storage?.persist?.().catch(() => {});
    visualiser.lessons = ((await dbRequest("readonly", store => store.getAll(), "lessons")) || []).sort((a, b) => a.created - b.created);
    const rows = (await dbRequest("readonly", store => store.getAll())) || [];
    rows.sort((first, second) => first.created - second.created);
    // Photos from before lessons existed go into one lesson named after the first of them.
    const orphans = rows.filter(row => !row.lesson || !visualiser.lessons.some(lesson => lesson.id === row.lesson));
    if (orphans.length) {
      const lesson = await newLesson(lessonName(new Date(orphans[0].created)));
      for (const row of orphans) row.lesson = lesson.id;
    }
    for (const row of rows) {
      const photo = { ...row, strokes: row.strokes || [], url: URL.createObjectURL(row.blob) };
      photo.thumb = await makeThumbnail(row.blob).catch(() => photo.url);
      visualiser.photos.push(photo);
      if (orphans.includes(row)) storePhoto(photo);
    }
  } catch {
    showToast("Photos can't be kept on this iPad (private browsing?). They will be lost when the app closes.");
  }
  const remembered = readStoredValue("classroom-bridge-lesson");
  visualiser.lesson = visualiser.lessons.some(lesson => lesson.id === remembered) ? remembered : visualiser.lessons[visualiser.lessons.length - 1]?.id;
  if (!visualiser.lesson) visualiser.lesson = (await newLesson()).id;
  writeStoredValue("classroom-bridge-lesson", visualiser.lesson);
  renderFilmstrip();
  updateVisualiserControls();
}

function lessonPhotos() {
  return visualiser.photos.filter(photo => photo.lesson === visualiser.lesson);
}

function currentLesson() {
  return visualiser.lessons.find(lesson => lesson.id === visualiser.lesson);
}

// ---------- Helpers ----------

function newId() {
  return window.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canvasToJpeg(canvas, quality = 0.92) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function makeThumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = 180 / Math.max(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return URL.createObjectURL(await canvasToJpeg(canvas, 0.8));
}

let toastTimer;
function showToast(message, seconds = 3.5) {
  const toast = document.querySelector("#vis-toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, seconds * 1000);
}

function currentPhoto() {
  return visualiser.photos.find(photo => photo.id === visualiser.page);
}

function pageStrokes(page = visualiser.page) {
  if (page === "live") return visualiser.liveStrokes;
  return visualiser.photos.find(photo => photo.id === page)?.strokes ?? [];
}

function pageAdjust() {
  return visualiser.page === "live" ? visualiser.liveAdjust : currentPhoto()?.adjust ?? null;
}

function historyFor(page = visualiser.page) {
  if (!visualiser.history.has(page)) visualiser.history.set(page, { undo: [], redo: [] });
  return visualiser.history.get(page);
}

// Replace a page's items; record=true makes it one undo step.
function setPageStrokes(strokes, { record = true, page = visualiser.page } = {}) {
  if (record) {
    const history = historyFor(page);
    history.undo.push(pageStrokes(page));
    if (history.undo.length > 100) history.undo.shift();
    history.redo = [];
  }
  if (page === "live") visualiser.liveStrokes = strokes;
  else {
    const photo = visualiser.photos.find(item => item.id === page);
    if (!photo) return;
    photo.strokes = strokes;
    storePhotoSoon(photo);
  }
  updateVisualiserControls();
  requestInkRender();
  syncScene();
}

function undo() {
  const history = historyFor();
  if (!history.undo.length) return;
  history.redo.push(pageStrokes());
  setPageStrokes(history.undo.pop(), { record: false });
}

function redo() {
  const history = historyFor();
  if (!history.redo.length) return;
  history.undo.push(pageStrokes());
  setPageStrokes(history.redo.pop(), { record: false });
}

function clearPage() {
  if (pageStrokes().length) setPageStrokes([]);
}

// ---------- Geometry ----------

function liveAspect() {
  const width = cameraVideo.videoWidth || 16;
  const height = cameraVideo.videoHeight || 9;
  return visualiser.liveRotation % 180 ? height / width : width / height;
}

// Where the whole camera image or photo sits inside the iPad stage (letterboxed, unzoomed), in client pixels.
function cameraContentRect() {
  const bounds = cameraStage.getBoundingClientRect();
  const photo = currentPhoto();
  const aspect = photo ? photo.width / photo.height : liveAspect();
  const width = Math.min(bounds.width, bounds.height * aspect);
  const height = width / aspect;
  return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top + (bounds.height - height) / 2, width, height, aspect };
}

function currentView() {
  return visualiser.page === "live" ? { x: 0, y: 0, s: 1 } : visualiser.view;
}

// Where the (possibly zoomed) image is drawn: the full image's rectangle, which may extend beyond the stage.
function imageRect() {
  const content = cameraContentRect();
  const { x, y, s } = currentView();
  return { left: content.left - x * content.width * s, top: content.top - y * content.height * s, width: content.width * s, height: content.height * s, content };
}

function imagePoint(event) {
  const rect = imageRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  ];
}

function clampView(view) {
  const s = Math.max(1, Math.min(6, view.s));
  const limit = 1 - 1 / s;
  return { s, x: Math.max(0, Math.min(limit, view.x)), y: Math.max(0, Math.min(limit, view.y)) };
}

// Rotates the live video element; photos are rotated in their pixels instead.
function layoutCameraVideo() {
  const rotation = visualiser.liveRotation;
  const bounds = cameraStage.getBoundingClientRect();
  if (rotation % 180) {
    cameraVideo.style.width = `${bounds.height}px`;
    cameraVideo.style.height = `${bounds.width}px`;
    cameraVideo.style.left = `${(bounds.width - bounds.height) / 2}px`;
    cameraVideo.style.top = `${(bounds.height - bounds.width) / 2}px`;
  } else {
    cameraVideo.style.width = cameraVideo.style.height = cameraVideo.style.left = cameraVideo.style.top = "";
  }
  cameraVideo.style.transform = rotation ? `rotate(${rotation}deg)` : "";
  cameraVideo.style.filter = adjustFilter(visualiser.liveAdjust);
}

function layoutPhoto() {
  const photo = currentPhoto();
  if (!photo) return;
  const content = cameraContentRect();
  const stage = cameraStage.getBoundingClientRect();
  const { x, y, s } = visualiser.view;
  photoImage.style.transformOrigin = `${content.left - stage.left}px ${content.top - stage.top}px`;
  photoImage.style.transform = s > 1 ? `translate(${-x * content.width * s}px, ${-y * content.height * s}px) scale(${s})` : "";
  photoImage.style.filter = adjustFilter(photo.adjust);
}

// ---------- Rendering annotations on the iPad ----------

function requestInkRender() {
  if (visualiser.renderFrame) return;
  visualiser.renderFrame = requestAnimationFrame(renderInk);
}

function renderInk() {
  visualiser.renderFrame = undefined;
  resizeCanvas(cameraInk);
  const context = cameraInk.getContext("2d");
  context.clearRect(0, 0, cameraInk.width, cameraInk.height);
  if (currentMode !== "camera" || (visualiser.page === "live" && cameraView !== "live")) return;
  const ratio = window.devicePixelRatio || 1;
  const canvasBounds = cameraInk.getBoundingClientRect();
  const full = imageRect();
  const rect = { left: full.left - canvasBounds.left, top: full.top - canvasBounds.top, width: full.width, height: full.height };
  const content = full.content;
  context.save();
  context.beginPath();
  context.rect((content.left - canvasBounds.left) * ratio, (content.top - canvasBounds.top) * ratio, content.width * ratio, content.height * ratio);
  context.clip();
  for (const item of pageStrokes()) drawItem(context, item, rect, ratio);
  if (visualiser.active) drawItem(context, visualiser.active, rect, ratio);
  drawOverlays(context, rect, content, canvasBounds, ratio);
  context.restore();
}

function drawOverlays(context, rect, content, canvasBounds, ratio) {
  const toCanvas = ([x, y]) => [(rect.left + x * rect.width) * ratio, (rect.top + y * rect.height) * ratio];
  const now = performance.now() / 1000;
  visualiser.laserTrail = visualiser.laserTrail.filter(entry => now - entry.t < LASER_SECONDS);
  if (visualiser.laserTrail.length) {
    const base = Math.max(3, content.width / 220) * ratio;
    context.strokeStyle = context.fillStyle = "#ff283c";
    context.lineCap = "round";
    for (let index = 1; index < visualiser.laserTrail.length; index += 1) {
      const life = 1 - (now - visualiser.laserTrail[index].t) / LASER_SECONDS;
      context.lineWidth = Math.max(1, base * life);
      context.beginPath();
      context.moveTo(...toCanvas(visualiser.laserTrail[index - 1].p));
      context.lineTo(...toCanvas(visualiser.laserTrail[index].p));
      context.stroke();
    }
    const [x, y] = toCanvas(visualiser.laserTrail[visualiser.laserTrail.length - 1].p);
    context.beginPath();
    context.arc(x, y, base * 1.6, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 2 * ratio;
    context.strokeStyle = "#fff";
    context.stroke();
    requestInkRender();
  }
  const left = (content.left - canvasBounds.left) * ratio;
  const top = (content.top - canvasBounds.top) * ratio;
  const width = content.width * ratio;
  const height = content.height * ratio;
  if (visualiser.spotlight) {
    const [cx, cy] = toCanvas([visualiser.spotlight.x, visualiser.spotlight.y]);
    const radius = visualiser.spotlight.r * rect.width * ratio;
    context.save();
    context.fillStyle = "rgba(0,0,0,0.78)";
    context.beginPath();
    context.rect(left, top, width, height);
    context.arc(cx, cy, radius, 0, Math.PI * 2, true);
    context.fill("evenodd");
    context.restore();
  }
  if (visualiser.curtain) {
    const curtainTop = Math.max(top, toCanvas([0, visualiser.curtain.reveal])[1]);
    if (curtainTop < top + height) {
      context.fillStyle = "#161b24";
      context.fillRect(left, curtainTop, width, top + height - curtainTop);
      context.fillStyle = "#9cc8ff";
      context.fillRect(left, curtainTop, width, Math.max(3, height / 180));
    }
  }
}

// ---------- Drawing, shapes, text, stamps, laser and erasing ----------

function inkWidth(tool = visualiser.tool) {
  const sizes = PEN_SIZES[tool === "highlighter" ? "highlighter" : "pen"];
  return sizes[visualiser.sizeIndex] / imageRect().width;
}

function nextNumberLabel() {
  const numbers = pageStrokes().filter(item => item.type === "stamp" && item.kind === "number").map(item => Number(item.label) || 0);
  return String(Math.max(0, ...numbers) + 1);
}

function beginVisualiserInk(event) {
  if (visualiser.page === "live" && cameraView !== "live") return false;
  const point = imagePoint(event);
  visualiser.activePointer = event.pointerId;
  visualiser.activePointerType = event.pointerType;
  visualiser.activeClient = { x: event.clientX, y: event.clientY };
  const tool = visualiser.tool;
  if (tool === "eraser") {
    visualiser.erasing = { recorded: false };
    eraseAt(event);
  } else if (tool === "laser") {
    addLaserPoints([point]);
  } else if (tool === "text") {
    openTextEditor(point);
    visualiser.activePointer = undefined;
    return true;
  } else if (tool === "stamp") {
    const stamp = { id: newId(), type: "stamp", kind: visualiser.stamp, color: visualiser.colour, at: roundPoint(point), size: STAMP_SIZES[visualiser.sizeIndex] };
    if (stamp.kind === "number") stamp.label = nextNumberLabel();
    setPageStrokes([...pageStrokes(), stamp]);
    visualiser.activePointer = undefined;
    return true;
  } else if (tool === "shape") {
    visualiser.active = { id: newId(), type: visualiser.shape, color: visualiser.colour, width: inkWidth("pen"), a: point, b: point };
    scheduleLiveInk();
  } else {
    visualiser.active = { id: newId(), tool, color: visualiser.colour, width: inkWidth(tool), points: [point] };
    visualiser.pendingLive = [point];
    scheduleLiveInk();
  }
  cameraInk.setPointerCapture?.(event.pointerId);
  requestInkRender();
  return true;
}

function moveVisualiserInk(event) {
  if (event.pointerId !== visualiser.activePointer) return;
  visualiser.activeClient = { x: event.clientX, y: event.clientY };
  if (visualiser.erasing) {
    eraseAt(event);
    return;
  }
  const events = event.getCoalescedEvents?.() ?? [event];
  if (visualiser.tool === "laser") {
    addLaserPoints(events.map(imagePoint));
    return;
  }
  const item = visualiser.active;
  if (!item) return;
  if (item.points) {
    const rect = imageRect();
    for (const sample of events) {
      const point = imagePoint(sample);
      const last = item.points[item.points.length - 1];
      if (Math.hypot((point[0] - last[0]) * rect.width, (point[1] - last[1]) * rect.height) < 1.5) continue;
      item.points.push(point);
      visualiser.pendingLive.push(point);
    }
  } else {
    item.b = imagePoint(event);
  }
  scheduleLiveInk();
  requestInkRender();
}

function endVisualiserInk(event) {
  if (event && event.pointerId !== visualiser.activePointer) return;
  visualiser.activePointer = undefined;
  if (visualiser.erasing) {
    visualiser.erasing = null;
    return;
  }
  const item = visualiser.active;
  if (!item) return;
  flushLiveInk();
  visualiser.active = null;
  if (item.points) {
    item.points = item.points.map(roundPoint);
  } else {
    sendInk({ type: "shape-live", item: null });
    const rect = imageRect();
    if (Math.hypot((item.b[0] - item.a[0]) * rect.width, (item.b[1] - item.a[1]) * rect.height) < 6) {
      requestInkRender();
      return;
    }
    item.a = roundPoint(item.a);
    item.b = roundPoint(item.b);
  }
  setPageStrokes([...pageStrokes(), item]);
}

// Throws away a stroke or shape in progress (e.g. when a second finger turns it into a pinch).
function cancelVisualiserInk() {
  if (!visualiser.active && !visualiser.erasing) return;
  const wasShape = visualiser.active && !visualiser.active.points;
  visualiser.active = null;
  visualiser.erasing = null;
  visualiser.activePointer = undefined;
  visualiser.pendingLive = [];
  if (wasShape) sendInk({ type: "shape-live", item: null });
  requestInkRender();
  syncScene(); // drops the half-drawn stroke on the PC
}

function eraseAt(event) {
  const rect = imageRect();
  const [px, py] = imagePoint(event);
  const hit = item => itemHit(item, px * rect.width, py * rect.height, rect.width, rect.height, ERASER_RADIUS);
  const items = pageStrokes();
  if (!items.some(hit)) return;
  // The first item removed in a gesture records one undo step for the whole gesture.
  setPageStrokes(items.filter(item => !hit(item)), { record: !visualiser.erasing.recorded });
  visualiser.erasing.recorded = true;
}

function addLaserPoints(points) {
  const now = performance.now() / 1000;
  for (const point of points) visualiser.laserTrail.push({ t: now, p: point });
  if (!visualiser.hold && !visualiser.blank) sendInk({ type: "laser", points: points.map(roundPoint) });
  requestInkRender();
}

function scheduleLiveInk() {
  if (!visualiser.liveFrame) visualiser.liveFrame = requestAnimationFrame(flushLiveInk);
}

function flushLiveInk() {
  if (visualiser.liveFrame) cancelAnimationFrame(visualiser.liveFrame);
  visualiser.liveFrame = undefined;
  const item = visualiser.active;
  if (!item || visualiser.hold || visualiser.blank) {
    visualiser.pendingLive = [];
    return;
  }
  if (!item.points) {
    sendInk({ type: "shape-live", item: { ...item, a: roundPoint(item.a), b: roundPoint(item.b) } });
    return;
  }
  if (!visualiser.pendingLive.length) return;
  const { id, tool, color, width } = item;
  sendInk({ type: "ink-live", stroke: { id, tool, color, width }, points: visualiser.pendingLive.splice(0, 512) });
}

// ---------- Text ----------

function openTextEditor(point) {
  const editor = document.querySelector("#vis-text-editor");
  const rect = imageRect();
  const stage = cameraStage.getBoundingClientRect();
  const size = TEXT_SIZES[visualiser.sizeIndex];
  editor.value = "";
  editor.dataset.x = String(point[0]);
  editor.dataset.y = String(point[1]);
  editor.dataset.size = String(size);
  editor.style.left = `${rect.left - stage.left + point[0] * rect.width}px`;
  editor.style.top = `${rect.top - stage.top + point[1] * rect.height}px`;
  editor.style.fontSize = `${Math.max(12, size * rect.height)}px`;
  editor.style.color = visualiser.colour;
  editor.hidden = false;
  window.setTimeout(() => editor.focus(), 0);
}

function commitTextEditor() {
  const editor = document.querySelector("#vis-text-editor");
  if (editor.hidden) return;
  editor.hidden = true;
  const text = editor.value.trim();
  editor.blur();
  if (!text) return;
  setPageStrokes([...pageStrokes(), {
    id: newId(), type: "text", color: visualiser.colour, text: text.slice(0, 500),
    at: roundPoint([Number(editor.dataset.x), Number(editor.dataset.y)]), size: Number(editor.dataset.size),
  }]);
}

// ---------- Talking to the PC ----------

function sceneMessage() {
  if (currentMode !== "camera") {
    if (visualiser.pip && cameraView === "live") {
      return { type: "scene", mode: "pip", corner: visualiser.pip.corner, size: visualiser.pip.size, rotation: visualiser.liveRotation, adjust: visualiser.liveAdjust };
    }
    return { type: "scene", mode: "pc" };
  }
  if (visualiser.hold) return { type: "scene", mode: "hold" };
  if (visualiser.blank) return { type: "scene", mode: "blank" };
  const overlays = { spotlight: visualiser.spotlight, curtain: visualiser.curtain };
  const photo = currentPhoto();
  if (photo) return { type: "scene", mode: "photo", photoId: photo.id, items: photo.strokes, adjust: photo.adjust, viewport: visualiser.view, ...overlays };
  if (cameraView === "live") return { type: "scene", mode: "live", rotation: visualiser.liveRotation, items: visualiser.liveStrokes, adjust: visualiser.liveAdjust, ...overlays };
  return { type: "scene", mode: "pc" };
}

function waitForMediaDrain(channel) {
  return new Promise(resolve => {
    const done = () => { channel.removeEventListener("bufferedamountlow", done); channel.removeEventListener("close", done); resolve(); };
    channel.addEventListener("bufferedamountlow", done);
    channel.addEventListener("close", done);
  });
}

// Everything on the media channel goes through one queue so chunks of different blobs never interleave.
function enqueueMedia(task) {
  visualiser.sendQueue = visualiser.sendQueue.then(task).catch(() => {});
  return visualiser.sendQueue;
}

async function sendBlobNow(kind, data, meta, onProgress) {
  const channel = mediaChannel;
  if (channel?.readyState !== "open") return false;
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const id = ++visualiser.blobCounter;
  channel.send(JSON.stringify({ type: "blob-start", id, kind, size: buffer.byteLength, meta }));
  for (let offset = 0; offset < buffer.byteLength; offset += 16 * 1024) {
    if (channel.bufferedAmount > 1024 * 1024) {
      await waitForMediaDrain(channel);
      onProgress?.(offset / buffer.byteLength);
    }
    if (channel.readyState !== "open") return false;
    channel.send(buffer.slice(offset, offset + 16 * 1024));
  }
  channel.send(JSON.stringify({ type: "blob-end", id }));
  return true;
}

function syncScene() {
  const version = ++visualiser.sceneVersion;
  enqueueMedia(async () => {
    if (version !== visualiser.sceneVersion || mediaChannel?.readyState !== "open") return;
    const message = sceneMessage();
    if (message.mode === "photo" && !visualiser.sentPhotos.has(message.photoId)) {
      const photo = currentPhoto();
      if (photo && await sendBlobNow("photo", photo.blob, { photoId: photo.id })) visualiser.sentPhotos.add(photo.id);
    }
    if (version !== visualiser.sceneVersion) return;
    const text = JSON.stringify(sceneMessage());
    if (text.length < 15000) mediaChannel.send(text);
    else await sendBlobNow("scene", new TextEncoder().encode(text).buffer, {});
  });
  attachCameraTrack();
}

// Small, frequent updates while dragging (zoom, spotlight, curtain); the full scene follows when the drag ends.
function sendViewUpdate() {
  if (visualiser.viewFrame) return;
  visualiser.viewFrame = requestAnimationFrame(() => {
    visualiser.viewFrame = undefined;
    if (visualiser.hold || visualiser.blank) return;
    const message = { type: "view-update", spotlight: visualiser.spotlight, curtain: visualiser.curtain };
    if (visualiser.page !== "live") message.viewport = visualiser.view;
    enqueueMedia(() => { if (mediaChannel?.readyState === "open") mediaChannel.send(JSON.stringify(message)); });
  });
}

// Called by app.js when the PC's media channel opens (also after every reconnect).
function visualiserMediaChannelOpened() {
  visualiser.sentPhotos.clear();
  syncScene();
}

// Called by app.js for visualiser replies from the PC on the control channel.
function visualiserMessage(message) {
  if (message.type === "need-photo") {
    visualiser.sentPhotos.delete(String(message.id));
    syncScene();
  } else if (message.type === "saved" || message.type === "save-error") {
    const label = visualiser.saveRequests.get(message.requestId);
    visualiser.saveRequests.delete(message.requestId);
    showToast(message.type === "saved"
      ? `Saved to the PC: ${message.path}`
      : `The PC couldn't save ${label || "the file"}: ${message.message}`, 5);
  }
}

async function attachCameraTrack() {
  if (!cameraSender) return;
  const sending = cameraView === "live" && (
    (currentMode === "camera" && visualiser.page === "live" && !visualiser.hold && !visualiser.blank)
    || (currentMode === "pc" && Boolean(visualiser.pip)));
  const track = sending ? cameraTrack() ?? null : null;
  try {
    if (cameraSender.track === track) return;
    await cameraSender.replaceTrack(track);
    if (!track) return;
    const settings = track.getSettings();
    const parameters = cameraSender.getParameters();
    if (!parameters.encodings?.length) return;
    // Up to 1080p at a high bitrate; "balanced" lowers detail briefly rather than freezing frames when the network dips.
    parameters.encodings[0].maxBitrate = 6_000_000;
    parameters.encodings[0].maxFramerate = 30;
    parameters.encodings[0].scaleResolutionDownBy = Math.max(1, Math.max(settings.width || 1920, settings.height || 1080) / 1920);
    parameters.degradationPreference = "balanced";
    await cameraSender.setParameters(parameters);
  } catch {}
}

// ---------- Camera ----------

function cameraTrack() {
  return cameraStream?.getVideoTracks()[0];
}

async function openCamera() {
  try {
    toolsDrawer.hidden = true;
    await startCamera(cameraFacing);
  } catch (error) {
    document.querySelector("#camera-message").textContent = error?.name === "NotAllowedError"
      ? "Camera access is blocked. Allow the camera for this site in Settings → Apps → Safari → Camera, then tap Start camera."
      : `Camera unavailable: ${error?.message || error}. Choose a photo instead.`;
    updateVisualiserControls();
  }
}

async function startCamera(facing) {
  stopCamera();
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, ...LIVE_CAMERA_SIZE, frameRate: { ideal: 30 } },
    audio: false,
  });
  cameraFacing = facing;
  const track = cameraTrack();
  if (track && "contentHint" in track) track.contentHint = "detail";
  cameraCapabilities = track?.getCapabilities?.() ?? {};
  cameraZoom = track?.getSettings().zoom ?? cameraCapabilities.zoom?.min ?? 1;
  cameraVideo.srcObject = cameraStream;
  cameraVideo.onloadedmetadata = () => { layoutCameraVideo(); requestInkRender(); };
  cameraView = "live";
  showLive();
  if (typeof updatePipControls === "function") updatePipControls();
}

function stopCamera() {
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraVideo.srcObject = null;
  cameraView = "off";
}

function leavePage() {
  commitTextEditor();
  cancelVisualiserInk();
  visualiser.view = { x: 0, y: 0, s: 1 };
  visualiser.photoTouches.clear();
  visualiser.photoGesture = null;
}

function showLive() {
  leavePage();
  visualiser.page = "live";
  photoImage.hidden = true;
  photoImage.style.transform = photoImage.style.filter = "";
  cameraVideo.hidden = cameraView !== "live";
  cameraPlaceholder.hidden = cameraView === "live";
  if (cameraView === "live") cameraVideo.play().catch(() => {});
  layoutCameraVideo();
  updateVisualiserControls();
  renderFilmstrip();
  requestInkRender();
  syncScene();
}

function showPhoto(id) {
  const photo = visualiser.photos.find(item => item.id === id);
  if (!photo) return;
  if (visualiser.page !== id) leavePage();
  visualiser.page = id;
  photoImage.src = photo.url;
  photoImage.hidden = false;
  cameraVideo.hidden = true;
  cameraPlaceholder.hidden = true;
  layoutPhoto();
  updateVisualiserControls();
  renderFilmstrip();
  requestInkRender();
  syncScene();
  prepareExport(photo);
}

function nextCameraFrame() {
  return new Promise(resolve => {
    const timeout = window.setTimeout(resolve, 700);
    if (cameraVideo.requestVideoFrameCallback) cameraVideo.requestVideoFrameCallback(() => { window.clearTimeout(timeout); resolve(); });
  });
}

// Draws the current video frame, rotated like the live view, onto a new canvas.
function grabVideoFrame() {
  const rotation = visualiser.liveRotation;
  const sourceWidth = cameraVideo.videoWidth;
  const sourceHeight = cameraVideo.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = rotation % 180 ? sourceHeight : sourceWidth;
  canvas.height = rotation % 180 ? sourceWidth : sourceHeight;
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(cameraVideo, -sourceWidth / 2, -sourceHeight / 2);
  return canvas;
}

// Average brightness (0–255) of the current video frame, sampled small so it is cheap.
function frameBrightness() {
  const sample = document.createElement("canvas");
  sample.width = 48;
  sample.height = 27;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(cameraVideo, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let total = 0;
  for (let index = 0; index < pixels.length; index += 4) total += pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
  return total / (pixels.length / 4);
}

// Capture takes the correctly exposed live frame at once, then tries the camera's 4K mode for a sharper photo.
// iPadOS re-runs auto-exposure when the resolution changes, so the 4K frame is only used once it is as bright as
// the live frame was; otherwise the live frame is kept. Live annotations and adjustments move onto the new photo.
// With silent=true (time-lapse) the view stays on the live camera.
async function capturePhoto({ silent = false } = {}) {
  if (cameraView !== "live" || !cameraVideo.videoWidth || visualiser.capturing) return;
  visualiser.capturing = true;
  const flash = document.querySelector("#vis-flash");
  flash.hidden = false;
  flash.classList.remove("flash");
  void flash.offsetWidth;
  flash.classList.add("flash");
  const track = cameraTrack();
  const liveWidth = cameraVideo.videoWidth;
  let canvas = grabVideoFrame();
  const reference = frameBrightness();
  // Time-lapse keeps the live frame: switching to 4K every few seconds would flicker the projector.
  if (!silent) try {
    await track?.applyConstraints({ ...STILL_CAMERA_SIZE, frameRate: { ideal: 30 } });
    const deadline = performance.now() + 2500;
    let previous = -1;
    while (performance.now() < deadline) {
      await nextCameraFrame();
      if (cameraVideo.videoWidth <= liveWidth) continue;
      const brightness = frameBrightness();
      const settled = previous >= 0 && Math.abs(brightness - previous) <= Math.max(2, previous * 0.03);
      if (brightness >= reference * 0.92 && settled) {
        canvas = grabVideoFrame();
        break;
      }
      previous = brightness;
    }
  } catch {}
  if (!silent) track?.applyConstraints({ ...LIVE_CAMERA_SIZE, frameRate: { ideal: 30 } }).catch(() => {});
  try {
    const blob = await canvasToJpeg(canvas);
    if (!blob) return;
    let strokes = [];
    if (!silent) {
      strokes = visualiser.liveStrokes;
      visualiser.liveStrokes = [];
      visualiser.history.delete("live");
    }
    await addPhoto(blob, canvas.width, canvas.height, strokes, { adjust: visualiser.liveAdjust, show: !silent });
  } finally {
    visualiser.capturing = false;
  }
}

async function addPhoto(blob, width, height, strokes = [], { adjust = null, show = true } = {}) {
  const photo = { id: newId(), lesson: visualiser.lesson, created: Date.now(), width, height, strokes, adjust, blob, url: URL.createObjectURL(blob) };
  photo.thumb = await makeThumbnail(blob).catch(() => photo.url);
  visualiser.photos.push(photo);
  // Annotations carried over from live view can be undone on the photo.
  if (strokes.length) visualiser.history.set(photo.id, { undo: [[]], redo: [] });
  await storePhoto(photo);
  if (show) showPhoto(photo.id);
  else renderFilmstrip();
  return photo;
}

// Replaces a photo's pixels (rotate, crop) and its items, keeping its place in the lesson.
async function replacePhotoImage(photo, canvas, strokes) {
  const blob = await canvasToJpeg(canvas);
  if (!blob) return;
  URL.revokeObjectURL(photo.url);
  if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
  Object.assign(photo, { blob, width: canvas.width, height: canvas.height, url: URL.createObjectURL(blob), strokes });
  photo.thumb = await makeThumbnail(blob).catch(() => photo.url);
  visualiser.history.delete(photo.id);
  visualiser.sentPhotos.delete(photo.id);
  visualiser.exportCache.delete(photo.id);
  await storePhoto(photo);
  visualiser.view = { x: 0, y: 0, s: 1 };
  showPhoto(photo.id);
}

// Photos are limited to 4K on the long edge and re-encoded so they are upright.
async function importPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 3840 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await canvasToJpeg(canvas);
  if (blob) await addPhoto(blob, canvas.width, canvas.height);
}

async function rotateView() {
  const photo = currentPhoto();
  if (!photo) {
    visualiser.liveRotation = (visualiser.liveRotation + 90) % 360;
    writeStoredValue("classroom-bridge-live-rotation", String(visualiser.liveRotation));
    visualiser.liveStrokes = [];
    visualiser.history.delete("live");
    layoutCameraVideo();
    requestInkRender();
    syncScene();
    return;
  }
  // Rotate the photo's pixels 90° clockwise, and its items with it.
  const image = await loadImage(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.height;
  canvas.height = photo.width;
  const context = canvas.getContext("2d");
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  // Widths are fractions of the image width and sizes of its height, which swap, so both are rescaled to keep
  // the same pixel size.
  const strokes = photo.strokes.map(item => transformItem(item, ([x, y]) => [1 - y, x], photo.width / photo.height, photo.height / photo.width));
  await replacePhotoImage(photo, canvas, strokes);
}

async function deletePhoto(id) {
  const index = visualiser.photos.findIndex(photo => photo.id === id);
  if (index < 0) return;
  const lessonList = lessonPhotos();
  const position = lessonList.findIndex(photo => photo.id === id);
  const [photo] = visualiser.photos.splice(index, 1);
  URL.revokeObjectURL(photo.url);
  if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
  visualiser.history.delete(id);
  visualiser.exportCache.delete(id);
  await dbRequest("readwrite", store => store.delete(id)).catch(() => {});
  const remaining = lessonPhotos();
  const next = remaining[Math.min(position, remaining.length - 1)];
  if (visualiser.page === id) {
    if (next) showPhoto(next.id);
    else showLive();
  } else renderFilmstrip();
}

async function deletePhotos(photos) {
  for (const photo of photos) {
    URL.revokeObjectURL(photo.url);
    if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
    visualiser.history.delete(photo.id);
    visualiser.exportCache.delete(photo.id);
    await dbRequest("readwrite", store => store.delete(photo.id)).catch(() => {});
  }
  const ids = new Set(photos.map(photo => photo.id));
  visualiser.photos = visualiser.photos.filter(photo => !ids.has(photo.id));
}

async function clearAllPhotos() {
  const photos = lessonPhotos();
  if (!photos.length || !window.confirm(`Delete all ${photos.length} photos in this lesson from the iPad?`)) return;
  await deletePhotos(photos);
  showLive();
}

// ---------- Saving ----------

// The photo at full resolution with its adjustments and annotations (not zoom or presenter overlays).
async function composeAnnotatedCanvas(photo) {
  const image = await loadImage(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.width;
  canvas.height = photo.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  applyAdjustToCanvas(canvas, photo.adjust);
  const rect = { left: 0, top: 0, width: canvas.width, height: canvas.height };
  for (const item of photo.strokes) drawItem(context, item, rect, 1);
  return canvas;
}

async function composeAnnotated(photo) {
  return canvasToJpeg(await composeAnnotatedCanvas(photo));
}

function timestampName(prefix, time) {
  const date = new Date(time);
  const pad = value => String(value).padStart(2, "0");
  return `${prefix} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function photoFileName(photo) {
  return timestampName("Visualiser", photo.created);
}

function exportKey(photo) {
  const adjust = photo.adjust ? `${photo.adjust.b}|${photo.adjust.c}|${photo.adjust.mono}` : "";
  return `${photo.width}x${photo.height}:${photo.strokes.length}:${photo.strokes[photo.strokes.length - 1]?.id ?? ""}:${adjust}`;
}

// Safari only allows the share sheet straight after a tap, so the annotated image is prepared in advance.
async function prepareExport(photo) {
  const key = exportKey(photo);
  if (visualiser.exportCache.get(photo.id)?.key === key) return visualiser.exportCache.get(photo.id).file;
  const blob = await composeAnnotated(photo);
  const file = new File([blob], `${photoFileName(photo)}.jpg`, { type: "image/jpeg" });
  visualiser.exportCache.set(photo.id, { key, file });
  return file;
}

// Opens the share sheet for a ready file (Save Image / Save to Files / AirDrop), or downloads it.
async function shareFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error?.name !== "AbortError") showToast("Sharing didn't work. Try again.");
    }
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

async function saveToIpad() {
  const photo = currentPhoto();
  if (!photo) return;
  const cached = visualiser.exportCache.get(photo.id);
  if (!cached || cached.key !== exportKey(photo)) {
    prepareExport(photo).then(() => showToast("Ready — tap Save to iPad again."));
    return;
  }
  await shareFile(cached.file);
}

// Sends any file (photo, PDF, video) to be saved in Documents/Classroom Bridge on the PC.
function sendFileToPc(file, name) {
  if (mediaChannel?.readyState !== "open") {
    showToast("Connect to the PC to save there.");
    return false;
  }
  const requestId = newId();
  visualiser.saveRequests.set(requestId, file.name);
  const big = file.size > 20_000_000;
  showToast(big ? "Sending to the PC… 0%" : "Saving to the PC…", 30);
  enqueueMedia(() => sendBlobNow("save", file, { name, requestId }, share => {
    if (big) showToast(`Sending to the PC… ${Math.round(share * 100)}%`, 30);
  }));
  return true;
}

async function saveToPc() {
  const photo = currentPhoto();
  if (!photo) return;
  if (mediaChannel?.readyState !== "open") {
    showToast("Connect to the PC to save there.");
    return;
  }
  sendFileToPc(await prepareExport(photo), photoFileName(photo));
}

// ---------- Camera gestures (finger in live view) ----------

function canFocusAtPoint() {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  return Boolean(supported.pointsOfInterest || cameraCapabilities.focusMode?.includes("single-shot"));
}

async function applyCameraSetting(setting) {
  try {
    await cameraTrack()?.applyConstraints({ advanced: [setting] });
    return true;
  } catch {
    return false;
  }
}

function setCameraZoom(value) {
  const range = cameraCapabilities.zoom;
  if (!range) return;
  cameraZoom = Math.max(range.min, Math.min(Math.min(range.max, range.min * 10), value));
  updateVisualiserControls();
  if (pendingCameraZoom) return;
  pendingCameraZoom = requestAnimationFrame(async () => {
    pendingCameraZoom = undefined;
    await applyCameraSetting({ zoom: cameraZoom });
  });
}

async function focusCameraAt(event) {
  if (!canFocusAtPoint() || visualiser.liveRotation) return;
  const [x, y] = imagePoint(event);
  const setting = { pointsOfInterest: [{ x, y }] };
  if (cameraCapabilities.focusMode?.includes("single-shot")) setting.focusMode = "single-shot";
  if (cameraCapabilities.exposureMode?.includes("single-shot")) setting.exposureMode = "single-shot";
  if (!await applyCameraSetting(setting)) return;
  const ring = document.querySelector("#focus-ring");
  const stageBounds = cameraStage.getBoundingClientRect();
  ring.style.left = `${event.clientX - stageBounds.left}px`;
  ring.style.top = `${event.clientY - stageBounds.top}px`;
  ring.hidden = false;
  ring.classList.remove("pulse");
  void ring.offsetWidth;
  ring.classList.add("pulse");
  window.clearTimeout(ring.hideTimer);
  ring.hideTimer = window.setTimeout(() => { ring.hidden = true; }, 1200);
}

function cameraGesture(event) {
  const phase = event.type;
  if (phase === "pointerdown") {
    cameraTouches.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    cameraInk.setPointerCapture?.(event.pointerId);
    if (cameraTouches.size === 2 && cameraCapabilities.zoom) {
      const [first, second] = [...cameraTouches.values()];
      cameraPinch = { distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), zoom: cameraZoom };
      cameraGestureWasPinch = true;
    }
  } else if (phase === "pointermove") {
    const touch = cameraTouches.get(event.pointerId);
    if (!touch) return;
    touch.x = event.clientX;
    touch.y = event.clientY;
    if (cameraPinch && cameraTouches.size >= 2) {
      const [first, second] = [...cameraTouches.values()];
      setCameraZoom(cameraPinch.zoom * Math.hypot(second.x - first.x, second.y - first.y) / cameraPinch.distance);
    }
  } else {
    const touch = cameraTouches.get(event.pointerId);
    cameraTouches.delete(event.pointerId);
    if (cameraTouches.size < 2) cameraPinch = undefined;
    const tapped = touch && phase === "pointerup" && Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < 12;
    if (tapped && !cameraGestureWasPinch) focusCameraAt(event);
    if (!cameraTouches.size) cameraGestureWasPinch = false;
  }
  event.preventDefault();
}

// ---------- Photo zoom and pan (fingers on a photo) ----------

function startPhotoGesture() {
  const touches = [...visualiser.photoTouches.values()];
  const content = cameraContentRect();
  const view = { ...visualiser.view };
  if (touches.length >= 2) {
    const [first, second] = touches;
    visualiser.photoGesture = {
      kind: "pinch",
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      view,
      anchor: [
        view.x + ((first.x + second.x) / 2 - content.left) / (content.width * view.s),
        view.y + ((first.y + second.y) / 2 - content.top) / (content.height * view.s),
      ],
    };
  } else if (touches.length === 1) {
    visualiser.photoGesture = { kind: "pan", view, start: [touches[0].x, touches[0].y] };
  }
}

function updatePhotoGesture() {
  const gesture = visualiser.photoGesture;
  const touches = [...visualiser.photoTouches.values()];
  if (!gesture || !touches.length) return;
  const content = cameraContentRect();
  let view;
  if (gesture.kind === "pinch" && touches.length >= 2) {
    const [first, second] = touches;
    const s = Math.max(1, Math.min(6, gesture.view.s * Math.hypot(second.x - first.x, second.y - first.y) / gesture.distance));
    const midX = (first.x + second.x) / 2;
    const midY = (first.y + second.y) / 2;
    view = { s, x: gesture.anchor[0] - (midX - content.left) / (content.width * s), y: gesture.anchor[1] - (midY - content.top) / (content.height * s) };
  } else if (gesture.kind === "pan") {
    const s = gesture.view.s;
    view = { s, x: gesture.view.x - (touches[0].x - gesture.start[0]) / (content.width * s), y: gesture.view.y - (touches[0].y - gesture.start[1]) / (content.height * s) };
  } else return;
  setPhotoView(view, false);
}

function setPhotoView(view, final = true) {
  visualiser.view = clampView(view);
  layoutPhoto();
  updateVisualiserControls();
  requestInkRender();
  if (final) syncScene();
  else sendViewUpdate();
}

function photoTouch(event) {
  const type = event.type;
  if (type === "pointerdown") {
    visualiser.photoTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    cameraInk.setPointerCapture?.(event.pointerId);
    startPhotoGesture();
  } else if (type === "pointermove") {
    const touch = visualiser.photoTouches.get(event.pointerId);
    if (!touch) return;
    touch.x = event.clientX;
    touch.y = event.clientY;
    updatePhotoGesture();
  } else {
    visualiser.photoTouches.delete(event.pointerId);
    if (visualiser.photoTouches.size) startPhotoGesture();
    else {
      visualiser.photoGesture = null;
      syncScene();
    }
  }
  event.preventDefault();
}

// ---------- Spotlight and curtain (drag with any finger or the Pencil while they are on) ----------

function overlayPointer(event) {
  const type = event.type;
  const point = imagePoint(event);
  const gesture = visualiser.overlayGesture ??= { touches: new Map() };
  if (type === "pointerdown") {
    gesture.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    cameraInk.setPointerCapture?.(event.pointerId);
    if (gesture.touches.size === 2 && visualiser.spotlight) {
      const [first, second] = [...gesture.touches.values()];
      gesture.pinch = { distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), r: visualiser.spotlight.r };
    }
  } else if (type === "pointermove") {
    const touch = gesture.touches.get(event.pointerId);
    if (!touch) return;
    touch.x = event.clientX;
    touch.y = event.clientY;
  } else {
    gesture.touches.delete(event.pointerId);
    if (gesture.touches.size < 2) gesture.pinch = undefined;
    if (!gesture.touches.size) {
      visualiser.overlayGesture = null;
      syncScene();
    }
    event.preventDefault();
    return;
  }
  if (visualiser.spotlight) {
    if (gesture.pinch && gesture.touches.size >= 2) {
      const [first, second] = [...gesture.touches.values()];
      visualiser.spotlight.r = Math.max(0.03, Math.min(0.9, gesture.pinch.r * Math.hypot(second.x - first.x, second.y - first.y) / gesture.pinch.distance));
    } else if (gesture.touches.size === 1) {
      visualiser.spotlight.x = point[0];
      visualiser.spotlight.y = point[1];
    }
  } else if (visualiser.curtain && gesture.touches.size === 1) {
    visualiser.curtain.reveal = point[1];
  }
  requestInkRender();
  sendViewUpdate();
  event.preventDefault();
}

function toggleSpotlight() {
  visualiser.spotlight = visualiser.spotlight ? null : { x: 0.5, y: 0.5, r: 0.18 };
  if (visualiser.spotlight) visualiser.curtain = null;
  updateVisualiserControls();
  requestInkRender();
  syncScene();
}

function toggleCurtain() {
  visualiser.curtain = visualiser.curtain ? null : { reveal: 0.25 };
  if (visualiser.curtain) visualiser.spotlight = null;
  updateVisualiserControls();
  requestInkRender();
  syncScene();
}

// ---------- Pointer routing ----------

// Whether a finger draws is the teacher's choice (draw-input.js). In live view a finger always works the camera
// instead; on a photo, two fingers always zoom and pan.
function fingerDraws() {
  return fingerDrawsInk() && visualiser.page !== "live";
}

// The Pencil came down while these touches were on the screen: they are a resting hand, so undo what they did.
function cancelVisualiserTouches(ids) {
  if (visualiser.activePointerType === "touch" && ids.includes(visualiser.activePointer)) {
    cancelVisualiserInk();
    visualiser.activePointer = undefined;
  }
  let photoChanged = false;
  for (const id of ids) {
    if (visualiser.photoTouches.delete(id)) photoChanged = true;
    cameraTouches.delete(id);
    visualiser.overlayGesture?.touches.delete(id);
  }
  if (cameraTouches.size < 2) cameraPinch = undefined;
  if (visualiser.overlayGesture) {
    visualiser.overlayGesture.pinch = undefined;
    if (!visualiser.overlayGesture.touches.size) visualiser.overlayGesture = null;
  }
  if (photoChanged) {
    if (visualiser.photoTouches.size) startPhotoGesture();
    else {
      visualiser.photoGesture = null;
      syncScene();
    }
  }
}

function handleCameraPointer(event) {
  const type = event.type;
  if (rejectDrawPointer(event)) return;
  const touch = event.pointerType === "touch";
  if (typeof extras !== "undefined" && extras.crop) return;
  const showing = visualiser.page !== "live" || cameraView === "live";
  if (showing && (visualiser.spotlight || visualiser.curtain || visualiser.overlayGesture)) {
    overlayPointer(event);
    return;
  }
  if (touch && visualiser.page === "live") {
    if (cameraTouches.has(event.pointerId) || type === "pointerdown") {
      if (cameraView === "live") cameraGesture(event);
    }
    return;
  }
  if (touch && visualiser.page !== "live") {
    if (type === "pointerdown") {
      if (fingerDraws() && !visualiser.photoTouches.size && visualiser.activePointer === undefined) {
        if (beginVisualiserInk(event)) event.preventDefault();
        return;
      }
      // A second finger turns a finger stroke into a pinch.
      if (visualiser.activePointer !== undefined && visualiser.activePointerType === "touch") {
        const first = { id: visualiser.activePointer, ...visualiser.activeClient };
        cancelVisualiserInk();
        visualiser.photoTouches.set(first.id, { x: first.x, y: first.y });
      }
      photoTouch(event);
      return;
    }
    if (visualiser.photoTouches.has(event.pointerId)) {
      photoTouch(event);
      return;
    }
    if (visualiser.activePointer !== event.pointerId) return;
  }
  if (type === "pointerdown") {
    if (visualiser.activePointer === undefined && beginVisualiserInk(event)) event.preventDefault();
  } else if (type === "pointermove") {
    if (visualiser.active || visualiser.erasing || visualiser.tool === "laser") {
      moveVisualiserInk(event);
      event.preventDefault();
    }
  } else {
    endVisualiserInk(event);
  }
}

// ---------- Adjust (brightness / contrast / black and white) ----------

function setPageAdjust(adjust) {
  const value = hasAdjust(adjust) ? adjust : null;
  if (visualiser.page === "live") {
    visualiser.liveAdjust = value;
    writeStoredValue("classroom-bridge-live-adjust", JSON.stringify(value));
    layoutCameraVideo();
  } else {
    const photo = currentPhoto();
    if (!photo) return;
    photo.adjust = value;
    storePhotoSoon(photo);
    layoutPhoto();
    prepareExport(photo);
  }
  syncAdjustPanel();
  syncScene();
}

function syncAdjustPanel() {
  const adjust = pageAdjust() ?? { b: 0, c: 0, mono: false };
  document.querySelector("#vis-brightness").value = String(adjust.b || 0);
  document.querySelector("#vis-contrast").value = String(adjust.c || 0);
  document.querySelector("#vis-mono").checked = Boolean(adjust.mono);
  document.querySelector("#vis-adjust").classList.toggle("selected", hasAdjust(pageAdjust()));
}

// ---------- Controls ----------

function updateVisualiserControls() {
  const inCamera = currentMode === "camera";
  const live = visualiser.page === "live";
  const showingSomething = !live || cameraView === "live";
  document.querySelector("#vis-tools").hidden = !inCamera || !showingSomething;
  document.querySelector("#vis-side").hidden = !inCamera;
  document.querySelector("#vis-top").hidden = !inCamera;
  document.querySelectorAll(".vis-photo-only").forEach(element => { element.hidden = live; });
  document.querySelectorAll(".vis-showing-only").forEach(element => { element.hidden = !showingSomething; });
  document.querySelector("#vis-reset-zoom").hidden = live || visualiser.view.s <= 1.01;
  document.querySelector("#vis-reset-zoom").textContent = `${visualiser.view.s.toFixed(1).replace(/\.0$/, "")}× · Reset`;
  document.querySelector("#camera-controls").hidden = !inCamera || !live || cameraView !== "live";
  document.querySelector("#camera-torch").hidden = !cameraCapabilities.torch;
  const zoomButton = document.querySelector("#camera-zoom");
  zoomButton.hidden = !cameraCapabilities.zoom;
  zoomButton.textContent = `${(cameraZoom / (cameraCapabilities.zoom?.min || 1)).toFixed(1).replace(/\.0$/, "")}×`;
  const shutter = document.querySelector("#vis-shutter");
  shutter.hidden = !inCamera || (live && cameraView !== "live");
  shutter.classList.toggle("to-live", !live);
  shutter.setAttribute("aria-label", live ? "Capture photo" : "Back to live camera");
  document.querySelector("#vis-blank").classList.toggle("selected", visualiser.blank);
  document.querySelector("#vis-hold").classList.toggle("selected", visualiser.hold);
  document.querySelector("#vis-spotlight").classList.toggle("selected", Boolean(visualiser.spotlight));
  document.querySelector("#vis-curtain").classList.toggle("selected", Boolean(visualiser.curtain));
  const banner = document.querySelector("#vis-banner");
  const bannerText = visualiser.hold ? "Projector frozen — tap Hold to update it"
    : visualiser.blank ? "Projector blanked — tap Blank to show it"
    : visualiser.spotlight ? "Spotlight — drag to move, pinch to resize"
    : visualiser.curtain ? "Curtain — drag to reveal" : "";
  banner.hidden = !inCamera || !bannerText;
  banner.textContent = bannerText;
  banner.classList.toggle("info", !visualiser.hold && !visualiser.blank);
  document.querySelectorAll(".vis-tool").forEach(button => button.classList.toggle("selected", button.dataset.tool === visualiser.tool));
  document.querySelector("#vis-shape-button").textContent = SHAPES[visualiser.shape];
  document.querySelector("#vis-stamp-button").textContent = STAMPS[visualiser.stamp];
  document.querySelector("#vis-size-button i").style.setProperty("--dot", `${[5, 9, 15][visualiser.sizeIndex]}px`);
  document.querySelectorAll(".vis-colour").forEach(button => button.classList.toggle("selected", button.dataset.colour === visualiser.colour));
  document.querySelectorAll("[data-shape]").forEach(button => button.classList.toggle("selected", button.dataset.shape === visualiser.shape));
  document.querySelectorAll("[data-stamp]").forEach(button => button.classList.toggle("selected", button.dataset.stamp === visualiser.stamp));
  document.querySelectorAll("[data-size]").forEach(button => button.classList.toggle("selected", Number(button.dataset.size) === visualiser.sizeIndex));
  const history = historyFor();
  document.querySelector("#vis-undo").disabled = !history.undo.length;
  document.querySelector("#vis-redo").disabled = !history.redo.length;
  document.querySelector("#vis-clear").disabled = !pageStrokes().length;
  document.querySelector("#camera-start").hidden = cameraView === "live";
  document.querySelector("#camera-stop").hidden = cameraView !== "live";
  document.querySelector("#vis-lesson").textContent = `▤ ${currentLesson()?.name ?? "Lesson"}`;
  syncAdjustPanel();
  if (typeof updateExtrasControls === "function") updateExtrasControls();
}

function renderFilmstrip() {
  const strip = document.querySelector("#vis-filmstrip");
  const photos = lessonPhotos();
  strip.hidden = currentMode !== "camera";
  const list = strip.querySelector(".vis-film-list");
  list.replaceChildren();
  const liveTile = document.createElement("button");
  liveTile.className = `vis-film-tile vis-film-live${visualiser.page === "live" ? " selected" : ""}`;
  liveTile.innerHTML = "<span>◉</span>Live";
  liveTile.setAttribute("aria-label", "Live camera");
  liveTile.addEventListener("click", () => {
    if (cameraView === "live") showLive();
    else { showLive(); openCamera(); }
  });
  list.append(liveTile);
  for (const photo of photos) {
    const tile = document.createElement("button");
    tile.className = `vis-film-tile${visualiser.page === photo.id ? " selected" : ""}`;
    tile.dataset.photo = photo.id;
    tile.setAttribute("aria-label", photoFileName(photo));
    const image = document.createElement("img");
    image.src = photo.thumb;
    image.alt = "";
    tile.append(image);
    if (photo.strokes.length) tile.insertAdjacentHTML("beforeend", "<i>✎</i>");
    tile.addEventListener("click", () => {
      if (typeof filmstripTileClicked === "function" && filmstripTileClicked(photo)) return;
      showPhoto(photo.id);
    });
    list.append(tile);
  }
  document.querySelector("#vis-clear-all").hidden = !photos.length;
  if (typeof decorateFilmstrip === "function") decorateFilmstrip(list);
  const selected = list.querySelector(".selected");
  selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// app.js calls this when the screen source changes (PC / Camera).
function visualiserModeChanged(mode) {
  if (mode !== "camera") closeFlyouts();
  if (typeof updatePipControls === "function") updatePipControls();
  updateVisualiserControls();
  renderFilmstrip();
  requestInkRender();
  syncScene();
  // Like the Camera app: opening Camera mode turns the camera on (this tap also satisfies Safari's permission rule).
  if (mode === "camera" && cameraView === "off" && visualiser.page === "live") openCamera();
}

function closeFlyouts(except) {
  document.querySelectorAll(".vis-flyout").forEach(flyout => { if (flyout !== except) flyout.hidden = true; });
}

function toggleFlyout(flyout, anchor) {
  const open = flyout.hidden;
  closeFlyouts(flyout);
  flyout.hidden = !open;
  if (open && anchor) {
    const stage = cameraStage.getBoundingClientRect();
    const bounds = anchor.getBoundingClientRect();
    flyout.style.top = `${Math.max(8, bounds.top - stage.top - 4)}px`;
  }
}

function initVisualiser() {
  const storedRotation = Number(readStoredValue("classroom-bridge-live-rotation"));
  if ([90, 180, 270].includes(storedRotation)) visualiser.liveRotation = storedRotation;
  try {
    const storedAdjust = JSON.parse(readStoredValue("classroom-bridge-live-adjust") || "null");
    if (hasAdjust(storedAdjust)) visualiser.liveAdjust = storedAdjust;
  } catch {}

  const colours = document.querySelector("#vis-colours");
  for (const colour of PEN_COLOURS) {
    const swatch = document.createElement("button");
    swatch.className = "vis-colour";
    swatch.dataset.colour = colour;
    swatch.style.setProperty("--swatch", colour);
    swatch.setAttribute("aria-label", `Ink colour ${colour}`);
    swatch.addEventListener("click", () => {
      visualiser.colour = colour;
      if (["eraser", "laser"].includes(visualiser.tool)) visualiser.tool = "pen";
      updateVisualiserControls();
    });
    colours.append(swatch);
  }
  document.querySelectorAll(".vis-tool[data-tool]").forEach(button => button.addEventListener("click", () => {
    const tool = button.dataset.tool;
    if (tool === "shape") toggleFlyout(document.querySelector("#vis-shape-menu"), button);
    else if (tool === "stamp") toggleFlyout(document.querySelector("#vis-stamp-menu"), button);
    else closeFlyouts();
    visualiser.tool = tool;
    if (tool === "highlighter" && ["#111111", "#ffffff"].includes(visualiser.colour)) visualiser.colour = "#ffcc00";
    updateVisualiserControls();
  }));
  document.querySelectorAll("[data-shape]").forEach(button => button.addEventListener("click", () => {
    visualiser.shape = button.dataset.shape;
    visualiser.tool = "shape";
    closeFlyouts();
    updateVisualiserControls();
  }));
  document.querySelectorAll("[data-stamp]").forEach(button => button.addEventListener("click", () => {
    visualiser.stamp = button.dataset.stamp;
    visualiser.tool = "stamp";
    closeFlyouts();
    updateVisualiserControls();
  }));
  document.querySelector("#vis-size-button").addEventListener("click", event => toggleFlyout(document.querySelector("#vis-size-menu"), event.currentTarget));
  document.querySelectorAll("[data-size]").forEach(button => button.addEventListener("click", () => {
    visualiser.sizeIndex = Number(button.dataset.size);
    if (visualiser.tool === "eraser") visualiser.tool = "pen";
    closeFlyouts();
    updateVisualiserControls();
  }));
  document.querySelector("#vis-undo").addEventListener("click", undo);
  document.querySelector("#vis-redo").addEventListener("click", redo);
  document.querySelector("#vis-clear").addEventListener("click", clearPage);
  document.querySelector("#vis-shutter").addEventListener("click", () => {
    if (visualiser.page !== "live") showLive();
    else capturePhoto();
  });
  document.querySelector("#vis-rotate").addEventListener("click", rotateView);
  document.querySelector("#vis-spotlight").addEventListener("click", toggleSpotlight);
  document.querySelector("#vis-curtain").addEventListener("click", toggleCurtain);
  document.querySelector("#vis-adjust").addEventListener("click", event => toggleFlyout(document.querySelector("#vis-adjust-panel")));
  const readAdjust = () => ({
    b: Number(document.querySelector("#vis-brightness").value),
    c: Number(document.querySelector("#vis-contrast").value),
    mono: document.querySelector("#vis-mono").checked,
  });
  document.querySelector("#vis-brightness").addEventListener("input", () => setPageAdjust(readAdjust()));
  document.querySelector("#vis-contrast").addEventListener("input", () => setPageAdjust(readAdjust()));
  document.querySelector("#vis-mono").addEventListener("change", () => setPageAdjust(readAdjust()));
  document.querySelector("#vis-adjust-document").addEventListener("click", () => setPageAdjust({ b: 0.15, c: 0.6, mono: false }));
  document.querySelector("#vis-adjust-bw").addEventListener("click", () => setPageAdjust({ b: 0.15, c: 0.8, mono: true }));
  document.querySelector("#vis-adjust-reset").addEventListener("click", () => setPageAdjust(null));
  document.querySelector("#vis-reset-zoom").addEventListener("click", () => setPhotoView({ x: 0, y: 0, s: 1 }));
  document.querySelector("#vis-blank").addEventListener("click", () => {
    visualiser.blank = !visualiser.blank;
    if (visualiser.blank) visualiser.hold = false;
    updateVisualiserControls();
    syncScene();
  });
  document.querySelector("#vis-hold").addEventListener("click", () => {
    visualiser.hold = !visualiser.hold;
    if (visualiser.hold) visualiser.blank = false;
    updateVisualiserControls();
    syncScene();
  });
  document.querySelector("#vis-save").addEventListener("click", saveToIpad);
  document.querySelector("#vis-save-pc").addEventListener("click", saveToPc);
  document.querySelector("#vis-delete").addEventListener("click", () => {
    if (window.confirm("Delete this photo from the iPad?")) deletePhoto(visualiser.page);
  });
  document.querySelector("#vis-clear-all").addEventListener("click", clearAllPhotos);
  const textEditor = document.querySelector("#vis-text-editor");
  textEditor.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitTextEditor();
    } else if (event.key === "Escape") {
      textEditor.value = "";
      commitTextEditor();
    }
  });
  textEditor.addEventListener("blur", commitTextEditor);

  document.querySelector("#camera-start").addEventListener("click", openCamera);
  document.querySelector("#placeholder-camera").addEventListener("click", openCamera);
  document.querySelector("#camera-stop").addEventListener("click", () => {
    stopCamera();
    toolsDrawer.hidden = true;
    showLive();
  });
  document.querySelector("#camera-flip").addEventListener("click", async () => {
    try {
      await startCamera(cameraFacing === "environment" ? "user" : "environment");
    } catch {
      await startCamera(cameraFacing).catch(() => {});
    }
  });
  document.querySelector("#camera-torch").addEventListener("click", async event => {
    const button = event.currentTarget;
    const on = !button.classList.contains("selected");
    if (await applyCameraSetting({ torch: on })) button.classList.toggle("selected", on);
  });
  document.querySelector("#camera-zoom").addEventListener("click", () => {
    const min = cameraCapabilities.zoom?.min || 1;
    const steps = [1, 2, 4].map(step => step * min).filter(step => step <= (cameraCapabilities.zoom?.max ?? min));
    setCameraZoom(steps.find(step => step > cameraZoom + 0.05) ?? min);
  });
  document.querySelectorAll(".photo-picker").forEach(input => input.addEventListener("change", async event => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    toolsDrawer.hidden = true;
    closeFlyouts();
    for (const file of files) {
      try {
        await importPhoto(file);
      } catch {
        showToast("That photo could not be opened. Try another image.");
      }
    }
  }));
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    cameraInk.addEventListener(type, handleCameraPointer);
  }
  cameraInk.addEventListener("pointerdown", () => closeFlyouts(), true);
  window.addEventListener("resize", () => { layoutCameraVideo(); layoutPhoto(); requestInkRender(); });
  if (typeof initExtras === "function") initExtras();
  loadStoredPhotos();
  updateVisualiserControls();
}
