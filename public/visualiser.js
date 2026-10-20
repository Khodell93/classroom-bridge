// Visualiser: live iPad camera, captured photos kept on this iPad, and per-photo annotations.
// Loaded before app.js; app.js calls initVisualiser() once its own setup has run.
//
// Model: each page (the live camera, or a saved photo) has a list of strokes in image coordinates (0–1), so
// annotations survive rotation, saving and being shown at any size. The iPad sends the PC a "scene" describing
// what to show and the committed strokes, plus "ink-live" points while a stroke is being drawn.

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
const PEN_SIZES = { pen: [3, 6, 12], highlighter: [16, 26, 40] };
const ERASER_RADIUS = 16;
const HIGHLIGHTER_ALPHA = 0.35;

const visualiser = {
  photos: [],            // { id, created, width, height, strokes, blob, url, thumb }
  page: "live",          // "live" or a photo id
  liveStrokes: [],
  liveRotation: 0,
  history: new Map(),    // page -> { undo: [strokes...], redo: [strokes...] }
  tool: "pen",
  colour: PEN_COLOURS[0],
  sizeIndex: 1,
  blank: false,
  hold: false,
  pencilSeen: false,
  active: null,          // stroke being drawn
  erasing: null,         // { removed: boolean }
  pendingLive: [],
  liveFrame: undefined,
  renderFrame: undefined,
  sentPhotos: new Set(),
  sendQueue: Promise.resolve(),
  sceneVersion: 0,
  blobCounter: 0,
  saveRequests: new Map(),
  exportCache: new Map(), // photo id -> { key, file }
  db: undefined,
};

// ---------- Storage (IndexedDB): photos are kept on this iPad until deleted ----------

function openVisualiserDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("classroom-bridge-visualiser", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action) {
  if (!visualiser.db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const transaction = visualiser.db.transaction("photos", mode);
    const request = action(transaction.objectStore("photos"));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function storePhoto(photo) {
  const { id, created, width, height, strokes, blob } = photo;
  return dbRequest("readwrite", store => store.put({ id, created, width, height, strokes, blob })).catch(() => {
    showToast("This iPad's storage is full — delete some photos.");
  });
}

let storeTimers = new Map();
function storePhotoSoon(photo) {
  window.clearTimeout(storeTimers.get(photo.id));
  storeTimers.set(photo.id, window.setTimeout(() => storePhoto(photo), 400));
}

async function loadStoredPhotos() {
  try {
    visualiser.db = await openVisualiserDb();
    navigator.storage?.persist?.().catch(() => {});
    const rows = (await dbRequest("readonly", store => store.getAll())) || [];
    rows.sort((first, second) => first.created - second.created);
    for (const row of rows) {
      const photo = { ...row, strokes: row.strokes || [], url: URL.createObjectURL(row.blob) };
      photo.thumb = await makeThumbnail(row.blob).catch(() => photo.url);
      visualiser.photos.push(photo);
    }
  } catch {
    showToast("Photos can't be kept on this iPad (private browsing?). They will be lost when the app closes.");
  }
  renderFilmstrip();
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
function showToast(message) {
  const toast = document.querySelector("#vis-toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

function currentPhoto() {
  return visualiser.photos.find(photo => photo.id === visualiser.page);
}

function pageStrokes(page = visualiser.page) {
  if (page === "live") return visualiser.liveStrokes;
  return visualiser.photos.find(photo => photo.id === page)?.strokes ?? [];
}

function historyFor(page = visualiser.page) {
  if (!visualiser.history.has(page)) visualiser.history.set(page, { undo: [], redo: [] });
  return visualiser.history.get(page);
}

// Replace a page's strokes; record=true makes it one undo step.
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

// Where the camera image or photo sits inside the iPad stage (letterboxed), in client pixels.
function cameraContentRect() {
  const bounds = cameraStage.getBoundingClientRect();
  const photo = currentPhoto();
  const aspect = photo ? photo.width / photo.height : liveAspect();
  const width = Math.min(bounds.width, bounds.height * aspect);
  const height = width / aspect;
  return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top + (bounds.height - height) / 2, width, height, aspect };
}

function imagePoint(event) {
  const content = cameraContentRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - content.left) / content.width)),
    Math.max(0, Math.min(1, (event.clientY - content.top) / content.height)),
  ];
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
}

// ---------- Rendering annotations on the iPad ----------

function requestInkRender() {
  if (visualiser.renderFrame) return;
  visualiser.renderFrame = requestAnimationFrame(renderInk);
}

function drawStroke(context, stroke, content, offsetX, offsetY, ratio) {
  const points = stroke.points;
  if (!points?.length) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = context.fillStyle = stroke.color;
  context.lineWidth = Math.max(1, stroke.width * content.width) * ratio;
  if (stroke.tool === "highlighter") context.globalAlpha = HIGHLIGHTER_ALPHA;
  const x = point => (offsetX + point[0] * content.width) * ratio;
  const y = point => (offsetY + point[1] * content.height) * ratio;
  context.beginPath();
  context.moveTo(x(points[0]), y(points[0]));
  if (points.length === 1) context.lineTo(x(points[0]) + 0.01, y(points[0]));
  for (let index = 1; index < points.length; index += 1) context.lineTo(x(points[index]), y(points[index]));
  context.stroke();
  context.restore();
}

function renderInk() {
  visualiser.renderFrame = undefined;
  resizeCanvas(cameraInk);
  const context = cameraInk.getContext("2d");
  context.clearRect(0, 0, cameraInk.width, cameraInk.height);
  if (currentMode !== "camera" || (visualiser.page === "live" && cameraView !== "live")) return;
  const ratio = window.devicePixelRatio || 1;
  const canvasBounds = cameraInk.getBoundingClientRect();
  const content = cameraContentRect();
  const offsetX = content.left - canvasBounds.left;
  const offsetY = content.top - canvasBounds.top;
  for (const stroke of pageStrokes()) drawStroke(context, stroke, content, offsetX, offsetY, ratio);
  if (visualiser.active) drawStroke(context, visualiser.active, content, offsetX, offsetY, ratio);
}

// ---------- Drawing and erasing ----------

function inkWidth() {
  const sizes = PEN_SIZES[visualiser.tool === "highlighter" ? "highlighter" : "pen"];
  return sizes[visualiser.sizeIndex] / cameraContentRect().width;
}

function beginVisualiserInk(event) {
  if (visualiser.page === "live" && cameraView !== "live") return false;
  if (visualiser.tool === "eraser") {
    visualiser.erasing = { recorded: false };
    eraseAt(event);
  } else {
    visualiser.active = {
      id: newId(),
      tool: visualiser.tool,
      color: visualiser.colour,
      width: inkWidth(),
      points: [imagePoint(event)],
    };
    visualiser.pendingLive = [...visualiser.active.points];
    scheduleLiveInk();
  }
  cameraInk.setPointerCapture?.(event.pointerId);
  requestInkRender();
  return true;
}

function moveVisualiserInk(event) {
  if (visualiser.erasing) {
    eraseAt(event);
    return;
  }
  const stroke = visualiser.active;
  if (!stroke) return;
  const events = event.getCoalescedEvents?.() ?? [event];
  const content = cameraContentRect();
  for (const sample of events) {
    const point = imagePoint(sample);
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot((point[0] - last[0]) * content.width, (point[1] - last[1]) * content.height) < 1.5) continue;
    stroke.points.push(point);
    visualiser.pendingLive.push(point);
  }
  scheduleLiveInk();
  requestInkRender();
}

function endVisualiserInk() {
  if (visualiser.erasing) {
    visualiser.erasing = null;
    return;
  }
  const stroke = visualiser.active;
  if (!stroke) return;
  flushLiveInk();
  visualiser.active = null;
  stroke.points = stroke.points.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
  setPageStrokes([...pageStrokes(), stroke]);
}

function eraseAt(event) {
  const content = cameraContentRect();
  const [px, py] = imagePoint(event);
  const hit = stroke => {
    const reach = ERASER_RADIUS + (stroke.width * content.width) / 2;
    return stroke.points.some(([x, y]) => Math.hypot((x - px) * content.width, (y - py) * content.height) <= reach);
  };
  const strokes = pageStrokes();
  if (!strokes.some(hit)) return;
  // The first stroke removed in a gesture records one undo step for the whole gesture.
  setPageStrokes(strokes.filter(stroke => !hit(stroke)), { record: !visualiser.erasing.recorded });
  visualiser.erasing.recorded = true;
}

function scheduleLiveInk() {
  if (!visualiser.liveFrame) visualiser.liveFrame = requestAnimationFrame(flushLiveInk);
}

function flushLiveInk() {
  if (visualiser.liveFrame) cancelAnimationFrame(visualiser.liveFrame);
  visualiser.liveFrame = undefined;
  const stroke = visualiser.active;
  if (!stroke || !visualiser.pendingLive.length || visualiser.hold || visualiser.blank) {
    visualiser.pendingLive = [];
    return;
  }
  const { id, tool, color, width } = stroke;
  sendInk({ type: "ink-live", stroke: { id, tool, color, width }, points: visualiser.pendingLive.splice(0, 512) });
}

// ---------- Talking to the PC ----------

function sceneMessage() {
  if (currentMode !== "camera") return { type: "scene", mode: "pc" };
  if (visualiser.hold) return { type: "scene", mode: "hold" };
  if (visualiser.blank) return { type: "scene", mode: "blank" };
  const photo = currentPhoto();
  if (photo) return { type: "scene", mode: "photo", photoId: photo.id, strokes: photo.strokes };
  if (cameraView === "live") return { type: "scene", mode: "live", rotation: visualiser.liveRotation, strokes: visualiser.liveStrokes };
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

async function sendBlobNow(kind, data, meta) {
  const channel = mediaChannel;
  if (channel?.readyState !== "open") return false;
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const id = ++visualiser.blobCounter;
  channel.send(JSON.stringify({ type: "blob-start", id, kind, size: buffer.byteLength, meta }));
  for (let offset = 0; offset < buffer.byteLength; offset += 16 * 1024) {
    if (channel.bufferedAmount > 1024 * 1024) await waitForMediaDrain(channel);
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
      : `The PC couldn't save ${label || "the photo"}: ${message.message}`);
  }
}

async function attachCameraTrack() {
  if (!cameraSender) return;
  const sending = currentMode === "camera" && cameraView === "live" && visualiser.page === "live" && !visualiser.hold && !visualiser.blank;
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
}

function stopCamera() {
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraVideo.srcObject = null;
  cameraView = "off";
}

function showLive() {
  visualiser.page = "live";
  photoImage.hidden = true;
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
  visualiser.page = id;
  photoImage.src = photo.url;
  photoImage.hidden = false;
  cameraVideo.hidden = true;
  cameraPlaceholder.hidden = true;
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

// Capture grabs the camera at up to 4K (sharper than the live video), applies the live rotation to the pixels and
// keeps any live annotations on the new photo.
async function capturePhoto() {
  if (cameraView !== "live" || !cameraVideo.videoWidth) return;
  const flash = document.querySelector("#vis-flash");
  flash.hidden = false;
  flash.classList.remove("flash");
  void flash.offsetWidth;
  flash.classList.add("flash");
  const track = cameraTrack();
  let raised = false;
  try {
    await track?.applyConstraints({ ...STILL_CAMERA_SIZE, frameRate: { ideal: 30 } });
    raised = true;
    await nextCameraFrame();
    await nextCameraFrame();
  } catch {}
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
  if (raised) track.applyConstraints({ ...LIVE_CAMERA_SIZE, frameRate: { ideal: 30 } }).catch(() => {});
  const blob = await canvasToJpeg(canvas);
  if (!blob) return;
  const strokes = visualiser.liveStrokes;
  visualiser.liveStrokes = [];
  visualiser.history.delete("live");
  await addPhoto(blob, canvas.width, canvas.height, strokes);
}

async function addPhoto(blob, width, height, strokes = []) {
  const photo = { id: newId(), created: Date.now(), width, height, strokes, blob, url: URL.createObjectURL(blob) };
  photo.thumb = await makeThumbnail(blob).catch(() => photo.url);
  visualiser.photos.push(photo);
  // Annotations carried over from live view can be undone on the photo.
  if (strokes.length) visualiser.history.set(photo.id, { undo: [[]], redo: [] });
  await storePhoto(photo);
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
  // Rotate the photo's pixels 90° clockwise, and its strokes with it.
  const image = await loadImage(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.height;
  canvas.height = photo.width;
  const context = canvas.getContext("2d");
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  const blob = await canvasToJpeg(canvas);
  if (!blob) return;
  const widthScale = photo.width / photo.height;
  photo.strokes = photo.strokes.map(stroke => ({
    ...stroke,
    width: stroke.width * widthScale,
    points: stroke.points.map(([x, y]) => [Math.round((1 - y) * 10000) / 10000, x]),
  }));
  URL.revokeObjectURL(photo.url);
  if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
  Object.assign(photo, { blob, width: canvas.width, height: canvas.height, url: URL.createObjectURL(blob) });
  photo.thumb = await makeThumbnail(blob).catch(() => photo.url);
  visualiser.history.delete(photo.id);
  visualiser.sentPhotos.delete(photo.id);
  await storePhoto(photo);
  showPhoto(photo.id);
}

async function deletePhoto(id) {
  const index = visualiser.photos.findIndex(photo => photo.id === id);
  if (index < 0) return;
  const [photo] = visualiser.photos.splice(index, 1);
  URL.revokeObjectURL(photo.url);
  if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
  visualiser.history.delete(id);
  visualiser.exportCache.delete(id);
  await dbRequest("readwrite", store => store.delete(id)).catch(() => {});
  const next = visualiser.photos[Math.min(index, visualiser.photos.length - 1)];
  if (visualiser.page === id) {
    if (next) showPhoto(next.id);
    else showLive();
  } else renderFilmstrip();
}

async function clearAllPhotos() {
  if (!visualiser.photos.length || !window.confirm(`Delete all ${visualiser.photos.length} photos from this iPad?`)) return;
  for (const photo of visualiser.photos) {
    URL.revokeObjectURL(photo.url);
    if (photo.thumb !== photo.url) URL.revokeObjectURL(photo.thumb);
  }
  visualiser.photos = [];
  visualiser.history.clear();
  visualiser.exportCache.clear();
  await dbRequest("readwrite", store => store.clear()).catch(() => {});
  showLive();
}

// ---------- Saving ----------

async function composeAnnotated(photo) {
  const image = await loadImage(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.width;
  canvas.height = photo.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const content = { width: canvas.width, height: canvas.height };
  for (const stroke of photo.strokes) drawStroke(context, stroke, content, 0, 0, 1);
  return canvasToJpeg(canvas);
}

function photoFileName(photo) {
  const date = new Date(photo.created);
  const pad = value => String(value).padStart(2, "0");
  return `Visualiser ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function exportKey(photo) {
  return `${photo.width}x${photo.height}:${photo.strokes.length}:${photo.strokes[photo.strokes.length - 1]?.id ?? ""}`;
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

async function saveToIpad() {
  const photo = currentPhoto();
  if (!photo) return;
  const cached = visualiser.exportCache.get(photo.id);
  if (!cached || cached.key !== exportKey(photo)) {
    prepareExport(photo).then(() => showToast("Ready — tap Save again."));
    return;
  }
  if (navigator.canShare?.({ files: [cached.file] })) {
    try {
      await navigator.share({ files: [cached.file] });
    } catch (error) {
      if (error?.name !== "AbortError") showToast("Sharing didn't work. Try again.");
    }
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(cached.file);
  link.download = cached.file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

async function saveToPc() {
  const photo = currentPhoto();
  if (!photo) return;
  if (mediaChannel?.readyState !== "open") {
    showToast("Connect to the PC to save there.");
    return;
  }
  showToast("Saving to the PC…");
  const file = await prepareExport(photo);
  const requestId = newId();
  visualiser.saveRequests.set(requestId, file.name);
  enqueueMedia(() => sendBlobNow("save", file, { name: photoFileName(photo), requestId }));
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

// A finger draws only until an Apple Pencil is used (like Notes), so a resting hand doesn't leave marks.
// In live view a finger always works the camera instead.
function fingerDraws() {
  return !visualiser.pencilSeen && visualiser.page !== "live";
}

function handleCameraPointer(event) {
  const type = event.type;
  if (event.pointerType === "pen") visualiser.pencilSeen = true;
  const touch = event.pointerType === "touch";
  if (touch && (cameraTouches.has(event.pointerId) || (type === "pointerdown" && !fingerDraws()))) {
    if (visualiser.page === "live" && cameraView === "live") cameraGesture(event);
    return;
  }
  if (type === "pointerdown") {
    if (beginVisualiserInk(event)) event.preventDefault();
  } else if (type === "pointermove") {
    if (visualiser.active || visualiser.erasing) {
      moveVisualiserInk(event);
      event.preventDefault();
    }
  } else {
    endVisualiserInk();
  }
}

// ---------- Controls ----------

function updateVisualiserControls() {
  const inCamera = currentMode === "camera";
  const live = visualiser.page === "live";
  const showingSomething = !live || cameraView === "live";
  document.querySelector("#vis-tools").hidden = !inCamera || !showingSomething;
  document.querySelector("#vis-side").hidden = !inCamera;
  document.querySelector("#vis-photo-actions").hidden = !inCamera || live;
  document.querySelector("#camera-controls").hidden = !inCamera || !live || cameraView !== "live";
  document.querySelector("#camera-torch").hidden = !cameraCapabilities.torch;
  const zoomButton = document.querySelector("#camera-zoom");
  zoomButton.hidden = !cameraCapabilities.zoom;
  zoomButton.textContent = `${(cameraZoom / (cameraCapabilities.zoom?.min || 1)).toFixed(1).replace(/\.0$/, "")}×`;
  const shutter = document.querySelector("#vis-shutter");
  shutter.hidden = !inCamera || (live && cameraView !== "live");
  shutter.classList.toggle("to-live", !live);
  shutter.setAttribute("aria-label", live ? "Capture photo" : "Back to live camera");
  document.querySelector("#vis-rotate").hidden = !inCamera || !showingSomething;
  document.querySelector("#vis-blank").classList.toggle("selected", visualiser.blank);
  document.querySelector("#vis-hold").classList.toggle("selected", visualiser.hold);
  const banner = document.querySelector("#vis-banner");
  banner.hidden = !inCamera || (!visualiser.blank && !visualiser.hold);
  banner.textContent = visualiser.hold ? "Projector frozen — tap Hold to update it" : "Projector blanked — tap Blank to show it";
  document.querySelectorAll(".vis-tool").forEach(button => button.classList.toggle("selected", button.dataset.tool === visualiser.tool));
  document.querySelectorAll(".vis-colour").forEach(button => button.classList.toggle("selected", button.dataset.colour === visualiser.colour));
  document.querySelectorAll(".vis-size").forEach(button => button.classList.toggle("selected", Number(button.dataset.size) === visualiser.sizeIndex));
  const history = historyFor();
  document.querySelector("#vis-undo").disabled = !history.undo.length;
  document.querySelector("#vis-redo").disabled = !history.redo.length;
  document.querySelector("#vis-clear").disabled = !pageStrokes().length;
  document.querySelector("#camera-start").hidden = cameraView === "live";
  document.querySelector("#camera-stop").hidden = cameraView !== "live";
}

function renderFilmstrip() {
  const strip = document.querySelector("#vis-filmstrip");
  strip.hidden = currentMode !== "camera" || !visualiser.photos.length;
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
  for (const photo of visualiser.photos) {
    const tile = document.createElement("button");
    tile.className = `vis-film-tile${visualiser.page === photo.id ? " selected" : ""}`;
    tile.setAttribute("aria-label", photoFileName(photo));
    const image = document.createElement("img");
    image.src = photo.thumb;
    image.alt = "";
    tile.append(image);
    if (photo.strokes.length) tile.insertAdjacentHTML("beforeend", "<i>✎</i>");
    tile.addEventListener("click", () => showPhoto(photo.id));
    list.append(tile);
  }
  const selected = list.querySelector(".selected");
  selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// app.js calls this when the screen source changes (PC / Camera).
function visualiserModeChanged(mode) {
  updateVisualiserControls();
  renderFilmstrip();
  requestInkRender();
  syncScene();
  // Like the Camera app: opening Camera mode turns the camera on (this tap also satisfies Safari's permission rule).
  if (mode === "camera" && cameraView === "off" && visualiser.page === "live") openCamera();
}

function initVisualiser() {
  const storedRotation = Number(readStoredValue("classroom-bridge-live-rotation"));
  if ([90, 180, 270].includes(storedRotation)) visualiser.liveRotation = storedRotation;

  const colours = document.querySelector("#vis-colours");
  for (const colour of PEN_COLOURS) {
    const swatch = document.createElement("button");
    swatch.className = "vis-colour";
    swatch.dataset.colour = colour;
    swatch.style.setProperty("--swatch", colour);
    swatch.setAttribute("aria-label", `Ink colour ${colour}`);
    swatch.addEventListener("click", () => {
      visualiser.colour = colour;
      if (visualiser.tool === "eraser") visualiser.tool = "pen";
      updateVisualiserControls();
    });
    colours.append(swatch);
  }
  document.querySelectorAll(".vis-tool").forEach(button => button.addEventListener("click", () => {
    visualiser.tool = button.dataset.tool;
    if (visualiser.tool === "highlighter" && ["#111111", "#ffffff"].includes(visualiser.colour)) visualiser.colour = "#ffcc00";
    updateVisualiserControls();
  }));
  document.querySelectorAll(".vis-size").forEach(button => button.addEventListener("click", () => {
    visualiser.sizeIndex = Number(button.dataset.size);
    if (visualiser.tool === "eraser") visualiser.tool = "pen";
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
  window.addEventListener("resize", () => { layoutCameraVideo(); requestInkRender(); });
  loadStoredPhotos();
  updateVisualiserControls();
}
