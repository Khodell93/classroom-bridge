// Visualiser extras: compare, crop & straighten, whiteboard pages, time-lapse, recording, PDF export and lessons.
// Loaded after visualiser.js; visualiser.js calls initExtras(), updateExtrasControls(), decorateFilmstrip() and
// filmstripTileClicked() when they exist.

const extras = {
  compare: null,        // { selected: [photo ids] }
  crop: null,           // { corners: [[x, y] x4] in image coordinates, dragging }
  timelapse: null,      // { seconds, timer, count }
  recording: null,      // { recorder, chunks, canvas, frame, started, audio }
  result: null,         // File ready to save
};

// ---------- Compare ----------

function startCompare() {
  closeFlyouts();
  extras.compare = { selected: visualiser.page !== "live" ? [visualiser.page] : [] };
  updateVisualiserControls();
  renderFilmstrip();
  showToast("Choose 2–4 photos in the filmstrip, then tap Show side by side.", 5);
}

function cancelCompare() {
  extras.compare = null;
  updateVisualiserControls();
  renderFilmstrip();
}

function filmstripTileClicked(photo) {
  if (!extras.compare) return false;
  const selected = extras.compare.selected;
  const index = selected.indexOf(photo.id);
  if (index >= 0) selected.splice(index, 1);
  else if (selected.length < 4) selected.push(photo.id);
  else showToast("Up to 4 photos can be compared.");
  updateVisualiserControls();
  renderFilmstrip();
  return true;
}

function decorateFilmstrip(list) {
  if (!extras.compare) return;
  list.classList.add("choosing");
  for (const tile of list.querySelectorAll("[data-photo]")) {
    const order = extras.compare.selected.indexOf(tile.dataset.photo);
    tile.classList.toggle("chosen", order >= 0);
    if (order >= 0) tile.insertAdjacentHTML("beforeend", `<b>${order + 1}</b>`);
  }
}

// Builds one new photo with the chosen photos (and their annotations) side by side, ready to annotate again.
async function showCompare() {
  const photos = extras.compare.selected.map(id => visualiser.photos.find(photo => photo.id === id)).filter(Boolean);
  if (photos.length < 2) {
    showToast("Choose at least 2 photos.");
    return;
  }
  extras.compare = null;
  showToast("Arranging photos…");
  const canvas = document.createElement("canvas");
  canvas.width = 3840;
  canvas.height = 2160;
  const context = canvas.getContext("2d");
  context.fillStyle = "#0d1117";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const columns = photos.length === 4 ? 2 : photos.length;
  const rows = photos.length === 4 ? 2 : 1;
  const gap = 24;
  const cellWidth = (canvas.width - gap * (columns + 1)) / columns;
  const cellHeight = (canvas.height - gap * (rows + 1)) / rows;
  for (const [index, photo] of photos.entries()) {
    const source = await composeAnnotatedCanvas(photo);
    const scale = Math.min(cellWidth / source.width, cellHeight / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = gap + column * (cellWidth + gap) + (cellWidth - width) / 2;
    const top = gap + row * (cellHeight + gap) + (cellHeight - height) / 2;
    context.drawImage(source, left, top, width, height);
  }
  const blob = await canvasToJpeg(canvas, 0.9);
  if (blob) await addPhoto(blob, canvas.width, canvas.height);
}

// ---------- Crop & straighten ----------

function startCrop() {
  const photo = currentPhoto();
  if (!photo) return;
  closeFlyouts();
  setPhotoView({ x: 0, y: 0, s: 1 });
  extras.crop = { corners: [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]], dragging: null };
  document.querySelector("#vis-crop-layer").hidden = false;
  layoutCrop();
  updateVisualiserControls();
}

function cancelCrop() {
  extras.crop = null;
  document.querySelector("#vis-crop-layer").hidden = true;
  updateVisualiserControls();
}

function layoutCrop() {
  if (!extras.crop) return;
  const rect = imageRect();
  const stage = cameraStage.getBoundingClientRect();
  const toStage = ([x, y]) => [rect.left - stage.left + x * rect.width, rect.top - stage.top + y * rect.height];
  const points = extras.crop.corners.map(toStage);
  document.querySelectorAll(".vis-crop-handle").forEach((handle, index) => {
    handle.style.left = `${points[index][0]}px`;
    handle.style.top = `${points[index][1]}px`;
  });
  const outline = document.querySelector("#vis-crop-outline");
  outline.setAttribute("viewBox", `0 0 ${stage.width} ${stage.height}`);
  outline.querySelector("polygon").setAttribute("points", points.map(point => point.join(",")).join(" "));
}

function cropHandlePointer(event) {
  const index = Number(event.currentTarget.dataset.corner);
  if (event.type === "pointerdown") {
    extras.crop.dragging = index;
    event.currentTarget.setPointerCapture(event.pointerId);
  } else if (event.type === "pointermove" && extras.crop.dragging === index) {
    extras.crop.corners[index] = imagePoint(event);
    layoutCrop();
  } else if (event.type === "pointerup" || event.type === "pointercancel") {
    extras.crop.dragging = null;
  }
  event.preventDefault();
  event.stopPropagation();
}

// Projective map from the unit square (u, v) onto a quadrilateral (corners in order TL, TR, BR, BL).
function squareToQuad(corners) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let a, b, d, e, g, h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x3 - x0; d = y1 - y0; e = y3 - y0; g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const denominator = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / denominator;
    h = (dx1 * sy - sx * dy1) / denominator;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3;
  }
  return [a, b, x0, d, e, y0, g, h, 1];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(value => value / determinant);
}

function applyMatrix(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

async function applyCrop() {
  const photo = currentPhoto();
  if (!photo || !extras.crop) return;
  showToast("Straightening…", 10);
  const image = await loadImage(photo.url);
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = photo.width;
  sourceCanvas.height = photo.height;
  sourceCanvas.getContext("2d").drawImage(image, 0, 0);
  const source = sourceCanvas.getContext("2d").getImageData(0, 0, photo.width, photo.height);
  const corners = extras.crop.corners.map(([x, y]) => [x * photo.width, y * photo.height]);
  const edge = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  let width = Math.max(edge(corners[0], corners[1]), edge(corners[3], corners[2]));
  let height = Math.max(edge(corners[0], corners[3]), edge(corners[1], corners[2]));
  const limit = Math.min(1, 3840 / Math.max(width, height));
  width = Math.max(8, Math.round(width * limit));
  height = Math.max(8, Math.round(height * limit));
  const map = squareToQuad(corners);
  const output = new ImageData(width, height);
  const src = source.data;
  const out = output.data;
  const sourceWidth = photo.width;
  const sourceHeight = photo.height;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const w = map[6] * u + map[7] * v + 1;
      const sx = Math.min(sourceWidth - 1.001, Math.max(0, (map[0] * u + map[1] * v + map[2]) / w - 0.5));
      const sy = Math.min(sourceHeight - 1.001, Math.max(0, (map[3] * u + map[4] * v + map[5]) / w - 0.5));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sourceWidth + x0) * 4, i10 = i00 + 4, i01 = i00 + sourceWidth * 4, i11 = i01 + 4;
      const o = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = src[i00 + channel] + (src[i10 + channel] - src[i00 + channel]) * fx;
        const bottom = src[i01 + channel] + (src[i11 + channel] - src[i01 + channel]) * fx;
        out[o + channel] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(output, 0, 0);
  // Move annotations with the page: source pixels → unit square of the new image.
  const inverse = invert3(map);
  const scale = width / Math.max(1, edge(corners[0], corners[1]));
  const strokes = photo.strokes.map(item => transformItem(
    item,
    ([x, y]) => applyMatrix(inverse, x * sourceWidth, y * sourceHeight),
    (sourceWidth * scale) / width,
    (sourceHeight * scale) / height,
  ));
  extras.crop = null;
  document.querySelector("#vis-crop-layer").hidden = true;
  await replacePhotoImage(photo, canvas, strokes);
  showToast("Photo straightened.");
}

// ---------- Whiteboard pages ----------

async function addWhiteboard(style) {
  closeFlyouts();
  const canvas = document.createElement("canvas");
  canvas.width = 2560;
  canvas.height = 1440;
  const context = canvas.getContext("2d");
  context.fillStyle = style === "chalk" ? "#1f3b2d" : "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = style === "chalk" ? "rgba(255,255,255,0.12)" : "#c9d6e8";
  context.fillStyle = "#b8c4d6";
  context.lineWidth = 3;
  const line = (x1, y1, x2, y2) => { context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); };
  if (style === "lined") {
    for (let y = 160; y < canvas.height; y += 90) line(0, y, canvas.width, y);
    context.strokeStyle = "#f1a7a7";
    line(220, 0, 220, canvas.height);
  } else if (style === "squared") {
    for (let x = 80; x < canvas.width; x += 80) line(x, 0, x, canvas.height);
    for (let y = 80; y < canvas.height; y += 80) line(0, y, canvas.width, y);
  } else if (style === "dotted") {
    for (let x = 80; x < canvas.width; x += 80) for (let y = 80; y < canvas.height; y += 80) {
      context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.fill();
    }
  } else if (style === "music") {
    context.strokeStyle = "#7d8ba0";
    for (let staff = 0; staff < 5; staff += 1) {
      const top = 170 + staff * 250;
      for (let index = 0; index < 5; index += 1) line(120, top + index * 30, canvas.width - 120, top + index * 30);
    }
  }
  const blob = await canvasToJpeg(canvas, 0.92);
  if (blob) await addPhoto(blob, canvas.width, canvas.height);
}

// ---------- Time-lapse ----------

function startTimelapse(seconds) {
  closeFlyouts();
  stopTimelapse();
  if (cameraView !== "live") {
    showToast("Start the camera first.");
    return;
  }
  extras.timelapse = { seconds, count: 0, timer: window.setInterval(async () => {
    if (cameraView !== "live" || document.hidden) return;
    await capturePhoto({ silent: true });
    if (extras.timelapse) extras.timelapse.count += 1;
    updateExtrasControls();
  }, seconds * 1000) };
  updateVisualiserControls();
}

function stopTimelapse() {
  if (!extras.timelapse) return;
  window.clearInterval(extras.timelapse.timer);
  const count = extras.timelapse.count;
  extras.timelapse = null;
  updateVisualiserControls();
  if (count) showToast(`Time-lapse stopped — ${count} photo${count === 1 ? "" : "s"} added.`);
}

// ---------- Recording (what the projector shows, with the teacher's voice if allowed) ----------

function recordingMimeType() {
  const candidates = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) ?? "";
}

function drawRecordingFrame() {
  const recording = extras.recording;
  if (!recording) return;
  const { canvas, context } = recording;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.filter = "none";
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const photo = currentPhoto();
  const showing = currentMode === "camera" && !visualiser.blank && (photo || cameraView === "live");
  if (showing) {
    const aspect = photo ? photo.width / photo.height : liveAspect();
    const width = Math.min(canvas.width, canvas.height * aspect);
    const height = width / aspect;
    const content = { left: (canvas.width - width) / 2, top: (canvas.height - height) / 2, width, height };
    const view = currentView();
    const rect = { left: content.left - view.x * width * view.s, top: content.top - view.y * height * view.s, width: width * view.s, height: height * view.s };
    context.save();
    context.beginPath();
    context.rect(content.left, content.top, width, height);
    context.clip();
    if ("filter" in context) context.filter = adjustFilter(pageAdjust()) || "none";
    if (photo) {
      if (photoImage.complete) context.drawImage(photoImage, rect.left, rect.top, rect.width, rect.height);
    } else {
      const rotation = visualiser.liveRotation;
      context.translate(content.left + width / 2, content.top + height / 2);
      context.rotate(rotation * Math.PI / 180);
      const drawWidth = rotation % 180 ? height : width;
      const drawHeight = rotation % 180 ? width : height;
      context.drawImage(cameraVideo, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    context.filter = "none";
    for (const item of pageStrokes()) drawItem(context, item, rect, 1);
    if (visualiser.active) drawItem(context, visualiser.active, rect, 1);
    drawOverlays(context, rect, content, { left: 0, top: 0 }, 1);
    context.restore();
  }
  recording.frame = requestAnimationFrame(drawRecordingFrame);
}

async function startRecording() {
  closeFlyouts();
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    showToast("This iPad's browser can't record video.");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const stream = canvas.captureStream(30);
  let audio;
  try {
    audio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audio.getAudioTracks().forEach(track => stream.addTrack(track));
  } catch {
    showToast("Recording without sound (microphone not allowed).");
  }
  const mimeType = recordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
  extras.recording = { recorder, chunks: [], canvas, context: canvas.getContext("2d"), started: Date.now(), audio, mimeType: recorder.mimeType || mimeType };
  recorder.ondataavailable = event => { if (event.data.size) extras.recording?.chunks.push(event.data); };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  drawRecordingFrame();
  extras.recording.clock = window.setInterval(updateExtrasControls, 1000);
  updateVisualiserControls();
}

function stopRecording() {
  if (extras.recording?.recorder.state === "recording") extras.recording.recorder.stop();
}

function finishRecording() {
  const recording = extras.recording;
  if (!recording) return;
  cancelAnimationFrame(recording.frame);
  window.clearInterval(recording.clock);
  recording.audio?.getTracks().forEach(track => track.stop());
  extras.recording = null;
  const type = recording.mimeType.split(";")[0] || "video/mp4";
  const extension = type.includes("webm") ? "webm" : "mp4";
  const name = timestampName("Recording", recording.started);
  const file = new File(recording.chunks, `${name}.${extension}`, { type });
  const seconds = Math.round((Date.now() - recording.started) / 1000);
  showResult(file, name, `Recording ready (${formatDuration(seconds)}, ${(file.size / 1_000_000).toFixed(1)} MB)`);
  updateVisualiserControls();
}

function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------- PDF export ----------

// A minimal PDF: one page per photo, each a full-page JPEG with its annotations.
async function buildLessonPdf(photos) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = part => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (number, body) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
    for (const piece of [].concat(body)) push(piece);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pageNumbers = photos.map((_, index) => 3 + index * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${photos.length} /Kids [${pageNumbers.map(number => `${number} 0 R`).join(" ")}] >>`);
  for (const [index, photo] of photos.entries()) {
    showToast(`Preparing PDF… ${index + 1} of ${photos.length}`, 30);
    const canvas = await composeAnnotatedCanvas(photo);
    const limit = Math.min(1, 2560 / Math.max(canvas.width, canvas.height));
    const scaled = document.createElement("canvas");
    scaled.width = Math.round(canvas.width * limit);
    scaled.height = Math.round(canvas.height * limit);
    scaled.getContext("2d").drawImage(canvas, 0, 0, scaled.width, scaled.height);
    const jpeg = new Uint8Array(await (await canvasToJpeg(scaled, 0.85)).arrayBuffer());
    const pageWidth = scaled.width >= scaled.height ? 842 : 595;
    const pageHeight = Math.round((pageWidth * scaled.height) / scaled.width);
    const [page, content, image] = [pageNumbers[index], pageNumbers[index] + 1, pageNumbers[index] + 2];
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index} ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const drawing = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im${index} Do Q`;
    object(content, `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`);
    object(image, [`<< /Type /XObject /Subtype /Image /Width ${scaled.width} /Height ${scaled.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  }
  const count = 3 + photos.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let number = 1; number < count; number += 1) push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

async function exportLessonPdf() {
  closeFlyouts();
  const photos = lessonPhotos();
  if (!photos.length) {
    showToast("This lesson has no photos yet.");
    return;
  }
  const blob = await buildLessonPdf(photos);
  const name = (currentLesson()?.name ?? "Lesson").replace(/[^\w .-]/g, "").trim() || "Lesson";
  showResult(new File([blob], `${name}.pdf`, { type: "application/pdf" }), name, `PDF ready — ${photos.length} page${photos.length === 1 ? "" : "s"}`);
}

// ---------- Result sheet (recordings and PDFs) ----------

function showResult(file, name, title) {
  extras.result = { file, name };
  document.querySelector("#vis-result-title").textContent = title;
  document.querySelector("#vis-result").hidden = false;
}

function closeResult() {
  extras.result = null;
  document.querySelector("#vis-result").hidden = true;
}

// ---------- Lessons ----------

function renderLessonMenu() {
  const list = document.querySelector("#vis-lesson-list");
  list.replaceChildren();
  for (const lesson of [...visualiser.lessons].reverse()) {
    const button = document.createElement("button");
    const count = visualiser.photos.filter(photo => photo.lesson === lesson.id).length;
    button.className = `vis-lesson-row${lesson.id === visualiser.lesson ? " selected" : ""}`;
    button.innerHTML = "<strong></strong><small></small>";
    button.querySelector("strong").textContent = lesson.name;
    button.querySelector("small").textContent = `${count} photo${count === 1 ? "" : "s"}`;
    button.addEventListener("click", () => switchLesson(lesson.id));
    list.append(button);
  }
}

function switchLesson(id) {
  closeFlyouts();
  cancelCompare();
  visualiser.lesson = id;
  writeStoredValue("classroom-bridge-lesson", id);
  showLive();
}

async function startNewLesson() {
  const name = window.prompt("Name the new lesson", lessonName());
  if (name === null) return;
  const lesson = await newLesson(name.trim() || lessonName());
  switchLesson(lesson.id);
}

async function renameLesson() {
  const lesson = currentLesson();
  if (!lesson) return;
  const name = window.prompt("Rename this lesson", lesson.name);
  if (!name?.trim()) return;
  lesson.name = name.trim().slice(0, 80);
  await storeLesson(lesson);
  renderLessonMenu();
  updateVisualiserControls();
}

async function deleteLesson() {
  const lesson = currentLesson();
  if (!lesson) return;
  const photos = lessonPhotos();
  if (!window.confirm(`Delete "${lesson.name}" and its ${photos.length} photo${photos.length === 1 ? "" : "s"} from this iPad?`)) return;
  await deletePhotos(photos);
  visualiser.lessons = visualiser.lessons.filter(item => item.id !== lesson.id);
  await dbRequest("readwrite", store => store.delete(lesson.id), "lessons").catch(() => {});
  const next = visualiser.lessons[visualiser.lessons.length - 1] ?? await newLesson();
  switchLesson(next.id);
}

// ---------- Controls ----------

function updateExtrasControls() {
  const inCamera = currentMode === "camera";
  const live = visualiser.page === "live";
  const comparing = Boolean(extras.compare);
  document.querySelector("#vis-compare").hidden = comparing || lessonPhotos().length < 2;
  document.querySelector("#vis-compare-show").hidden = !comparing;
  document.querySelector("#vis-compare-cancel").hidden = !comparing;
  document.querySelector("#vis-compare-show").textContent = `Show side by side (${extras.compare?.selected.length ?? 0})`;
  document.querySelector("#vis-crop").hidden = live || Boolean(extras.crop);
  const timelapse = document.querySelector("#vis-timelapse-stop");
  timelapse.hidden = !extras.timelapse;
  if (extras.timelapse) timelapse.textContent = `⏱ Every ${extras.timelapse.seconds} s · ${extras.timelapse.count} · Stop`;
  const record = document.querySelector("#vis-record");
  record.classList.toggle("recording", Boolean(extras.recording));
  record.innerHTML = extras.recording
    ? `■<small>${formatDuration(Math.round((Date.now() - extras.recording.started) / 1000))}</small>`
    : "●<small>Rec</small>";
  if (!inCamera) closeResult();
}

function initExtras() {
  document.querySelector("#vis-compare").addEventListener("click", startCompare);
  document.querySelector("#vis-compare-show").addEventListener("click", showCompare);
  document.querySelector("#vis-compare-cancel").addEventListener("click", cancelCompare);
  document.querySelector("#vis-crop").addEventListener("click", startCrop);
  document.querySelector("#vis-crop-apply").addEventListener("click", applyCrop);
  document.querySelector("#vis-crop-cancel").addEventListener("click", cancelCrop);
  document.querySelectorAll(".vis-crop-handle").forEach(handle => {
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) handle.addEventListener(type, cropHandlePointer);
  });
  document.querySelector(".vis-film-add").addEventListener("click", event => toggleFlyout(document.querySelector("#vis-add-menu"), event.currentTarget));
  document.querySelectorAll("[data-whiteboard]").forEach(button => button.addEventListener("click", () => addWhiteboard(button.dataset.whiteboard)));
  document.querySelectorAll("[data-timelapse]").forEach(button => button.addEventListener("click", () => startTimelapse(Number(button.dataset.timelapse))));
  document.querySelector("#vis-timelapse-stop").addEventListener("click", stopTimelapse);
  document.querySelector("#vis-record").addEventListener("click", () => (extras.recording ? stopRecording() : startRecording()));
  document.querySelector("#vis-lesson").addEventListener("click", event => {
    renderLessonMenu();
    toggleFlyout(document.querySelector("#vis-lesson-menu"));
  });
  document.querySelector("#vis-lesson-new").addEventListener("click", startNewLesson);
  document.querySelector("#vis-lesson-rename").addEventListener("click", renameLesson);
  document.querySelector("#vis-lesson-delete").addEventListener("click", deleteLesson);
  document.querySelector("#vis-lesson-pdf").addEventListener("click", exportLessonPdf);
  document.querySelector("#vis-result-ipad").addEventListener("click", () => extras.result && shareFile(extras.result.file));
  document.querySelector("#vis-result-pc").addEventListener("click", () => extras.result && sendFileToPc(extras.result.file, extras.result.name));
  document.querySelector("#vis-result-close").addEventListener("click", closeResult);
  window.addEventListener("resize", layoutCrop);
}
