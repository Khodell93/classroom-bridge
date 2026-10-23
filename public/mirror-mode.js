// Mirror-aware camera. The PC companion tells the iPad when it is screen-mirroring to the PC (AirPlay). Then, in
// Camera mode, the projector shows the mirror (the iPad's own screen: AirPlay quality, with every tool and annotation
// exactly as on the iPad) instead of the separate camera stream, which the iPad stops sending. In PC mode the PC
// hides the mirror and shows its desktop. So the class doesn't see the toolbars, they fade out after a few seconds
// without a touch; a finger tap brings them back (that tap doesn't draw). The Pencil writes without showing them.
// Loaded after visualiser.js and before app.js.

const MIRROR_IDLE_MS = 4000;
const mirrorMode = { active: false, lastActivity: 0, revealPointer: null, standardChosen: false, prompted: false, askedPcAt: -Infinity, pcCanMirror: true, receiverDown: false };

// The camera defaults to the mirror. A web app can't start Screen Mirroring itself, so in Camera mode without it,
// Classroom Bridge shows the two taps (once per lesson, then a small reminder pill), unless the teacher chooses the
// standard stream for this lesson.
// On an Android tablet the mirror is the app's screen sharing (android.js), which any companion can receive; in
// Chrome on Android there is neither, so the camera uses the standard stream.
function mirrorPromptApplies() {
  if (currentMode !== "camera" || mirrorMode.active || controlChannel?.readyState !== "open") return false;
  return ANDROID_DEVICE ? androidCanShare() : hostPlatform !== "macos";
}

function updateMirrorPrompt() {
  const applies = mirrorPromptApplies();
  document.querySelector("#mirror-pill").hidden = !applies || !mirrorMode.standardChosen && !mirrorMode.prompted;
  document.querySelector("#mirror-pill").textContent = mirrorMode.standardChosen
    ? "Standard quality · tap for best quality"
    : ANDROID_DEVICE ? "Camera off · tap to share the screen or use standard quality"
    : "Camera off · tap to start Screen Mirroring or use standard quality";
  if (!applies) {
    document.querySelector("#mirror-prompt").hidden = true;
    return;
  }
  // Ask the PC first: only prompt when its AirPlay receiver is running (mirrorInfoArrived).
  if (!ANDROID_DEVICE && !mirrorMode.prompted && !mirrorMode.standardChosen && mirrorMode.pcCanMirror && performance.now() - mirrorMode.askedPcAt > 30000) {
    mirrorMode.askedPcAt = performance.now();
    sendControl({ type: "airplay-info" });
  }
}

// Camera mode waits for the teacher's choice: mirroring (best) or the standard stream. Without a PC that can receive
// mirroring (not connected, a Mac host, or its receiver isn't running), the camera starts straight away.
function cameraMayStart() {
  if (mirrorMode.active || mirrorMode.standardChosen) return true;
  if (ANDROID_DEVICE) {
    if (!mirrorPromptApplies()) return true;
    if (!androidShare.active && !mirrorMode.prompted) openMirrorPrompt();
    return false; // starting: the PC reports mirroring in a moment, and the camera starts then
  }
  if (!mirrorPromptApplies() || !mirrorMode.pcCanMirror || mirrorMode.receiverDown) return true;
  mirrorMode.askedPcAt = performance.now();
  sendControl({ type: "airplay-info" }); // the answer opens the prompt, or starts the camera
  return false;
}

function startCameraIfWaiting() {
  if (currentMode === "camera" && cameraView === "off" && visualiser.page === "live") openCamera();
}

function mirrorInfoArrived(info) {
  if (info.name) mirrorReceiverName(info.name);
  if (!info.supported) mirrorMode.pcCanMirror = false; // no receiver here (e.g. a Mac host): don't keep asking
  mirrorMode.receiverDown = Boolean(info.supported && !info.running);
  if (info.supported && info.running) {
    if (mirrorPromptApplies() && !mirrorMode.prompted && !mirrorMode.standardChosen) openMirrorPrompt();
  } else if (!mirrorMode.standardChosen && !mirrorMode.active) {
    startCameraIfWaiting();
  }
}

function openMirrorPrompt() {
  mirrorMode.prompted = true;
  diag("mirror", ANDROID_DEVICE ? "asked the teacher to share the screen for the camera" : "asked the teacher to start Screen Mirroring for the camera");
  document.querySelector("#mirror-prompt").hidden = false;
  document.querySelector("#mirror-pill").hidden = false;
}

function mirrorReceiverName(name) {
  document.querySelectorAll(".mirror-prompt-name").forEach(element => { element.textContent = name; });
}

function mirrorCleanAllowed() {
  if (!mirrorMode.active || currentMode !== "camera") return false;
  // Keep the controls up while something is open.
  return !document.querySelector("#tools-drawer:not([hidden]), .vis-flyout:not([hidden]), #vis-adjust-panel:not([hidden]), #vis-text-editor:not([hidden]), #vis-result:not([hidden]), #vis-crop-layer:not([hidden]), .modal-overlay:not([hidden])");
}

function setMirrorClean(clean) {
  document.body.classList.toggle("mirror-clean", clean);
}

function setMirroring(active) {
  if (active === mirrorMode.active) return;
  mirrorMode.active = active;
  diag("mirror", active ? "PC reports screen mirroring started" : "PC reports screen mirroring stopped");
  document.body.classList.toggle("mirroring", active);
  mirrorMode.lastActivity = performance.now();
  if (!active) setMirrorClean(false);
  if (active) {
    document.querySelector("#mirror-prompt").hidden = true;
    showToast(ANDROID_DEVICE
      ? "Screen sharing is on. In Camera, the projector shows this tablet's screen (best quality); the toolbars hide after a few seconds — tap to show them. Other apps show too."
      : "Screen Mirroring is on. In Camera, the projector shows this iPad's screen (best quality); the toolbars hide after a few seconds — tap to show them.", 6);
    startCameraIfWaiting();
  }
  updateMirrorPrompt();
  attachCameraTrack();
}

function mirrorActivity(event) {
  mirrorMode.lastActivity = performance.now();
  const clean = document.body.classList.contains("mirror-clean");
  if (event.type === "pointerdown" && clean && event.pointerType !== "pen") {
    // The tap that brings the controls back doesn't also draw, focus or click underneath.
    setMirrorClean(false);
    mirrorMode.revealPointer = event.pointerId;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.pointerId === mirrorMode.revealPointer) {
    if (event.type === "pointerup" || event.type === "pointercancel") mirrorMode.revealPointer = null;
    event.preventDefault();
    event.stopPropagation();
  }
}

function initMirrorMode() {
  document.querySelector("#mirror-prompt-done").addEventListener("click", () => { document.querySelector("#mirror-prompt").hidden = true; });
  document.querySelector("#mirror-prompt-share").addEventListener("click", () => {
    document.querySelector("#mirror-prompt").hidden = true;
    toggleAndroidShare();
  });
  document.querySelector("#mirror-prompt-standard").addEventListener("click", () => {
    mirrorMode.standardChosen = true;
    diag("mirror", "teacher chose the standard camera stream for this lesson");
    document.querySelector("#mirror-prompt").hidden = true;
    updateMirrorPrompt();
    startCameraIfWaiting(); // this tap also satisfies Safari's camera permission rule
  });
  document.querySelector("#mirror-pill").addEventListener("click", openMirrorPrompt);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    document.addEventListener(type, mirrorActivity, { capture: true, passive: false });
  }
  window.setInterval(() => {
    updateMirrorPrompt();
    const allowed = mirrorCleanAllowed();
    if (!allowed) setMirrorClean(false);
    else if (performance.now() - mirrorMode.lastActivity > MIRROR_IDLE_MS) setMirrorClean(true);
  }, 500);
}
