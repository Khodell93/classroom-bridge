// PC tools: pair by QR code, save the PC screen (with its ink) into the lesson, and picture-in-picture camera.
// Loaded before app.js; app.js calls initPcTools() once its own setup has run.

const PAIR_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;
const pcTools = {
  scanner: null,      // { stream, timer }
  screenshots: new Map(),
  incoming: null,     // blob being received from the PC
};
const PIP_CORNERS = ["br", "bl", "tl", "tr"];
const PIP_PLACE_KEY = "classroom-bridge-pip-place";
const PIP_MIN_SIZE = 0.12;  // share of the PC screen's width
const PIP_MAX_SIZE = 0.8;
const PIP_MARGIN = 0.02;    // corners and snapping keep this far from the screen edge
const PIP_SNAP = 0.03;      // a camera dropped this close to an edge snaps to it

// ---------- Pairing by QR code ----------

function pairingCodeFrom(text) {
  const value = String(text || "").trim();
  const fromLink = value.match(/[#&?]pair=([A-Za-z0-9]{12})/);
  const code = (fromLink ? fromLink[1] : value).toUpperCase().replace(/\s/g, "");
  return PAIR_PATTERN.test(code) ? code : null;
}

function pairWith(code) {
  codeInput.value = code;
  rememberCode.checked = true;
  connect();
}

function loadQrDecoder() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/jsQR.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("The QR reader could not load."));
    document.head.append(script);
  });
}

async function openQrScanner() {
  const overlay = document.querySelector("#qr-scanner");
  const message = document.querySelector("#qr-message");
  const video = document.querySelector("#qr-video");
  overlay.hidden = false;
  message.textContent = "Point the iPad at the QR code in the companion window on the PC.";
  try {
    await loadQrDecoder();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    pcTools.scanner = { stream, timer: window.setInterval(() => {
      if (!video.videoWidth) return;
      const scale = Math.min(1, 720 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = window.jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
      if (!found) return;
      const code = pairingCodeFrom(found.data);
      if (!code) {
        message.textContent = "That QR code isn't a Classroom Bridge code.";
        return;
      }
      closeQrScanner();
      closeSetup();
      pairWith(code);
    }, 150) };
  } catch (error) {
    message.textContent = error?.name === "NotAllowedError"
      ? "Camera access is blocked. Allow the camera for this site, or type the code instead."
      : `The camera couldn't start: ${error?.message || error}. Type the code instead.`;
  }
}

function closeQrScanner() {
  const scanner = pcTools.scanner;
  pcTools.scanner = null;
  if (scanner) {
    window.clearInterval(scanner.timer);
    scanner.stream.getTracks().forEach(track => track.stop());
  }
  document.querySelector("#qr-video").srcObject = null;
  document.querySelector("#qr-scanner").hidden = true;
  // The scanner can interrupt the visualiser camera on an iPad; restart it if it was running.
  if (cameraStream && cameraTrack()?.readyState === "ended") openCamera();
}

// A link like https://…/#pair=CODE (e.g. scanned with the iPad Camera app) pairs straight away.
function pairFromAddress() {
  const code = pairingCodeFrom(location.hash);
  if (!code) return false;
  history.replaceState(null, "", location.pathname + location.search);
  closeSetup();
  pairWith(code);
  return true;
}

// ---------- Messages from the PC on the media channel (screenshots) ----------

function pcMediaMessage(event) {
  if (typeof event.data !== "string") {
    const blob = pcTools.incoming;
    if (!blob) return;
    blob.chunks.push(event.data);
    blob.received += event.data.byteLength ?? event.data.size ?? 0;
    return;
  }
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "blob-start") {
    pcTools.incoming = { id: message.id, kind: message.kind, size: message.size, meta: message.meta || {}, chunks: [], received: 0 };
  } else if (message.type === "blob-end") {
    const blob = pcTools.incoming;
    pcTools.incoming = null;
    if (blob && blob.id === message.id && blob.received === blob.size && blob.kind === "screenshot") {
      saveScreenshot(new Blob(blob.chunks, { type: "image/jpeg" }), blob.meta);
    }
  }
}

// ---------- Save the PC screen into the lesson ----------

function requestScreenshot() {
  if (controlChannel?.readyState !== "open") {
    showToast("Connect to the PC first.");
    return;
  }
  const requestId = newId();
  pcTools.screenshots.set(requestId, Date.now());
  const flash = document.querySelector("#pc-flash");
  flash.hidden = false;
  flash.classList.remove("flash");
  void flash.offsetWidth;
  flash.classList.add("flash");
  sendControl({ type: "screenshot", requestId });
  showToast("Saving the PC screen…");
}

async function saveScreenshot(blob, meta) {
  if (!pcTools.screenshots.delete(meta.requestId)) return;
  let { width, height } = meta;
  if (!width || !height) {
    const bitmap = await createImageBitmap(blob);
    ({ width, height } = bitmap);
    bitmap.close?.();
  }
  await addPhoto(blob, width, height, [], { show: false });
  const count = lessonPhotos().length;
  showToast(`PC screen saved to "${currentLesson()?.name ?? "this lesson"}" — ${count} photo${count === 1 ? "" : "s"}. Find it in Camera.`);
}

function screenshotFailed(message) {
  pcTools.screenshots.delete(message.requestId);
  showToast(`The PC couldn't capture its screen: ${message.message || "unknown error"}.${hostPlatform === "macos" ? " Check Screen Recording permission on the Mac." : ""}`, 6);
}

// ---------- Picture-in-picture camera over the PC screen ----------
// The camera box on the iPad sits exactly where the camera appears on the PC screen. Drag it anywhere; resize it with
// the corner handle or a pinch; ↻ sends it to the next corner. Position is the box's centre as a share of the PC
// screen (x, y), size its width as a share of the screen's width.

const pipGesture = { pointers: new Map(), start: null, sendTimer: null };

function pipActive() {
  return Boolean(visualiser.pip);
}

function storedPipPlace() {
  try {
    const place = JSON.parse(readStoredValue(PIP_PLACE_KEY) || "null");
    if (place && [place.x, place.y, place.size].every(Number.isFinite)) return place;
  } catch {}
  // Earlier versions remembered a corner and a size.
  const size = Number(readStoredValue("classroom-bridge-pip-size")) || 0.32;
  return { ...pipCornerPlace(readStoredValue("classroom-bridge-pip-corner") || "br", size), size };
}

// The camera's height as a share of the PC screen's height, for a given width share.
function pipHeightShare(size) {
  const video = document.querySelector("#pc-pip-video");
  let aspect = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
  if (visualiser.liveRotation % 180) aspect = 1 / aspect;
  return size * aspect * hostScreenWidth / hostScreenHeight;
}

function pipCornerPlace(corner, size) {
  const halfWidth = size / 2;
  const halfHeight = pipHeightShare(size) / 2;
  return {
    x: corner.endsWith("l") ? PIP_MARGIN + halfWidth : 1 - PIP_MARGIN - halfWidth,
    y: corner.startsWith("t") ? PIP_MARGIN + halfHeight : 1 - PIP_MARGIN - halfHeight,
  };
}

function nearestPipCorner(pip) {
  return `${pip.y < 0.5 ? "t" : "b"}${pip.x < 0.5 ? "l" : "r"}`;
}

// Keeps the whole camera on the PC screen.
function clampPip(pip, snap = false) {
  const size = Math.max(PIP_MIN_SIZE, Math.min(PIP_MAX_SIZE, pip.size));
  const halfWidth = size / 2;
  const halfHeight = Math.min(0.5, pipHeightShare(size) / 2);
  let x = Math.max(halfWidth, Math.min(1 - halfWidth, pip.x));
  let y = Math.max(halfHeight, Math.min(1 - halfHeight, pip.y));
  if (snap) {
    if (x - halfWidth < PIP_SNAP) x = Math.min(0.5, PIP_MARGIN + halfWidth);
    if (1 - x - halfWidth < PIP_SNAP) x = Math.max(0.5, 1 - PIP_MARGIN - halfWidth);
    if (y - halfHeight < PIP_SNAP) y = Math.min(0.5, PIP_MARGIN + halfHeight);
    if (1 - y - halfHeight < PIP_SNAP) y = Math.max(0.5, 1 - PIP_MARGIN - halfHeight);
  }
  return { x, y, size };
}

async function togglePip() {
  if (visualiser.pip) {
    visualiser.pip = null;
  } else {
    visualiser.pip = clampPip(storedPipPlace());
    if (cameraView !== "live") await openCamera();
  }
  updatePipControls();
  syncScene();
}

function nextPipCorner() {
  if (!visualiser.pip) return;
  const corner = PIP_CORNERS[(PIP_CORNERS.indexOf(nearestPipCorner(visualiser.pip)) + 1) % PIP_CORNERS.length];
  setPipPlace({ ...pipCornerPlace(corner, visualiser.pip.size), size: visualiser.pip.size }, true);
}

function setPipPlace(place, final) {
  visualiser.pip = clampPip(place, final);
  positionPip();
  if (final) {
    window.clearTimeout(pipGesture.sendTimer);
    pipGesture.sendTimer = null;
    writeStoredValue(PIP_PLACE_KEY, JSON.stringify(visualiser.pip));
    syncScene();
  } else if (!pipGesture.sendTimer) {
    // While dragging, the PC follows about 12 times a second.
    pipGesture.sendTimer = window.setTimeout(() => {
      pipGesture.sendTimer = null;
      syncScene();
    }, 80);
  }
}

function positionPip() {
  const panel = document.querySelector("#pc-pip-panel");
  if (!visualiser.pip || panel.hidden) return;
  const rect = desktopRect();
  const stage = pcStage.getBoundingClientRect();
  const width = visualiser.pip.size * rect.width;
  const height = pipHeightShare(visualiser.pip.size) * rect.height;
  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.left = `${rect.left - stage.left + visualiser.pip.x * rect.width - width / 2}px`;
  panel.style.top = `${rect.top - stage.top + visualiser.pip.y * rect.height - height / 2}px`;
  // A camera turned on its side: the video is laid out the other way round, then rotated into the box.
  const video = document.querySelector("#pc-pip-video");
  const sideways = visualiser.liveRotation % 180 !== 0;
  const inner = { width: width - 6, height: height - 6 }; // inside the 3 px border
  video.style.width = `${sideways ? inner.height : inner.width}px`;
  video.style.height = `${sideways ? inner.width : inner.height}px`;
  video.style.marginLeft = sideways ? `${(inner.width - inner.height) / 2}px` : "";
  video.style.marginTop = sideways ? `${(inner.height - inner.width) / 2}px` : "";
}

function updatePipControls() {
  const panel = document.querySelector("#pc-pip-panel");
  const video = document.querySelector("#pc-pip-video");
  const on = pipActive() && currentMode === "pc";
  document.querySelector("#pc-pip").classList.toggle("selected", pipActive());
  panel.hidden = !on;
  if (!on) {
    video.srcObject = null;
    return;
  }
  if (cameraStream && video.srcObject !== cameraStream) video.srcObject = cameraStream;
  video.style.transform = visualiser.liveRotation ? `rotate(${visualiser.liveRotation}deg)` : "";
  video.style.filter = adjustFilter(visualiser.liveAdjust);
  video.play().catch(() => {});
  positionPip();
}

function pipPointerDown(event) {
  if (event.target.closest("button")) return;
  // The camera box handles its own touches: they must not also move or click the PC's mouse.
  event.stopPropagation();
  event.preventDefault();
  if (rejectDrawPointer(event)) return; // a resting hand doesn't move it
  const panel = document.querySelector("#pc-pip-panel");
  panel.setPointerCapture(event.pointerId);
  pipGesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  pipGestureStart(event.target.closest(".pc-pip-resize") ? "resize" : null);
}

function pipGestureStart(kind) {
  const points = [...pipGesture.pointers.values()];
  const rect = desktopRect();
  pipGesture.start = {
    kind: points.length >= 2 ? "pinch" : kind || "move",
    pip: { ...visualiser.pip },
    rect,
    points: points.map(point => ({ ...point })),
    distance: points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0,
  };
}

function pipPointerMove(event) {
  event.stopPropagation(); // even a hovering Pencil over the box doesn't move the PC's mouse
  if (!pipGesture.pointers.has(event.pointerId)) return;
  event.preventDefault();
  pipGesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const start = pipGesture.start;
  const points = [...pipGesture.pointers.values()];
  if (start.kind === "pinch" && points.length >= 2) {
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    const startMiddle = { x: (start.points[0].x + start.points[1].x) / 2, y: (start.points[0].y + start.points[1].y) / 2 };
    setPipPlace({
      size: start.pip.size * distance / Math.max(20, start.distance),
      x: start.pip.x + (middle.x - startMiddle.x) / start.rect.width,
      y: start.pip.y + (middle.y - startMiddle.y) / start.rect.height,
    }, false);
  } else if (start.kind === "resize") {
    // The handle is the bottom-right corner; the top-left corner stays put.
    const dx = (points[0].x - start.points[0].x) / start.rect.width;
    const dy = (points[0].y - start.points[0].y) / start.rect.height;
    const startHeight = pipHeightShare(start.pip.size);
    const grow = Math.max(dx, dy * start.pip.size / startHeight);
    const size = Math.max(PIP_MIN_SIZE, Math.min(PIP_MAX_SIZE, start.pip.size + grow));
    const left = start.pip.x - start.pip.size / 2;
    const top = start.pip.y - startHeight / 2;
    setPipPlace({ size, x: left + size / 2, y: top + pipHeightShare(size) / 2 }, false);
  } else if (start.kind === "move") {
    setPipPlace({
      size: start.pip.size,
      x: start.pip.x + (points[0].x - start.points[0].x) / start.rect.width,
      y: start.pip.y + (points[0].y - start.points[0].y) / start.rect.height,
    }, false);
  }
}

function pipPointerUp(event) {
  if (!pipGesture.pointers.has(event.pointerId)) return;
  event.stopPropagation();
  pipGesture.pointers.delete(event.pointerId);
  if (pipGesture.pointers.size) {
    pipGestureStart("move"); // one finger of a pinch lifted: carry on moving with the other
    return;
  }
  pipGesture.start = null;
  if (visualiser.pip) setPipPlace(visualiser.pip, true);
}

function initPcTools() {
  document.querySelector("#scan-qr").addEventListener("click", openQrScanner);
  document.querySelector("#qr-cancel").addEventListener("click", closeQrScanner);
  document.querySelector("#pc-capture").addEventListener("click", requestScreenshot);
  document.querySelector("#pc-pip").addEventListener("click", togglePip);
  document.querySelector("#pc-pip-corner").addEventListener("click", nextPipCorner);
  document.querySelector("#pc-pip-close").addEventListener("click", togglePip);
  const pipPanel = document.querySelector("#pc-pip-panel");
  pipPanel.addEventListener("pointerdown", pipPointerDown);
  pipPanel.addEventListener("pointermove", pipPointerMove);
  pipPanel.addEventListener("pointerup", pipPointerUp);
  pipPanel.addEventListener("pointercancel", pipPointerUp);
  document.querySelector("#pc-pip-video").addEventListener("loadedmetadata", () => visualiser.pip && setPipPlace(visualiser.pip, true));
  window.addEventListener("resize", positionPip);
  window.addEventListener("hashchange", pairFromAddress);
  return pairFromAddress();
}
