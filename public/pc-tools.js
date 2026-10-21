// PC tools: pair by QR code, save the PC screen (with its ink) into the lesson, and picture-in-picture camera.
// Loaded before app.js; app.js calls initPcTools() once its own setup has run.

const PAIR_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;
const pcTools = {
  scanner: null,      // { stream, timer }
  screenshots: new Map(),
  incoming: null,     // blob being received from the PC
};
const PIP_CORNERS = ["br", "bl", "tl", "tr"];
const PIP_SIZES = [0.22, 0.32, 0.45];

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

function pipActive() {
  return Boolean(visualiser.pip);
}

async function togglePip() {
  if (visualiser.pip) {
    visualiser.pip = null;
  } else {
    visualiser.pip = { corner: readStoredValue("classroom-bridge-pip-corner") || "br", size: Number(readStoredValue("classroom-bridge-pip-size")) || 0.32 };
    if (cameraView !== "live") await openCamera();
  }
  updatePipControls();
  syncScene();
}

function cyclePip(key) {
  if (!visualiser.pip) return;
  if (key === "corner") {
    visualiser.pip.corner = PIP_CORNERS[(PIP_CORNERS.indexOf(visualiser.pip.corner) + 1) % PIP_CORNERS.length];
    writeStoredValue("classroom-bridge-pip-corner", visualiser.pip.corner);
  } else {
    const index = PIP_SIZES.findIndex(size => Math.abs(size - visualiser.pip.size) < 0.01);
    visualiser.pip.size = PIP_SIZES[(index + 1) % PIP_SIZES.length];
    writeStoredValue("classroom-bridge-pip-size", String(visualiser.pip.size));
  }
  updatePipControls();
  syncScene();
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
  panel.dataset.corner = visualiser.pip.corner;
  panel.style.width = `${Math.round(visualiser.pip.size * 100)}%`;
  if (cameraStream && video.srcObject !== cameraStream) video.srcObject = cameraStream;
  video.style.transform = visualiser.liveRotation ? `rotate(${visualiser.liveRotation}deg)` : "";
  video.style.filter = adjustFilter(visualiser.liveAdjust);
  video.play().catch(() => {});
  document.querySelector("#pc-pip-size").textContent = ["S", "M", "L"][PIP_SIZES.findIndex(size => Math.abs(size - visualiser.pip.size) < 0.01)] ?? "M";
}

function initPcTools() {
  document.querySelector("#scan-qr").addEventListener("click", openQrScanner);
  document.querySelector("#qr-cancel").addEventListener("click", closeQrScanner);
  document.querySelector("#pc-capture").addEventListener("click", requestScreenshot);
  document.querySelector("#pc-pip").addEventListener("click", togglePip);
  document.querySelector("#pc-pip-corner").addEventListener("click", () => cyclePip("corner"));
  document.querySelector("#pc-pip-size").addEventListener("click", () => cyclePip("size"));
  document.querySelector("#pc-pip-close").addEventListener("click", togglePip);
  window.addEventListener("hashchange", pairFromAddress);
  return pairFromAddress();
}
