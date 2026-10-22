// Mirror-aware camera. The PC companion tells the iPad when it is screen-mirroring to the PC (AirPlay). Then, in
// Camera mode, the projector shows the mirror (the iPad's own screen: AirPlay quality, with every tool and annotation
// exactly as on the iPad) instead of the separate camera stream, which the iPad stops sending. In PC mode the PC
// hides the mirror and shows its desktop. So the class doesn't see the toolbars, they fade out after a few seconds
// without a touch; a finger tap brings them back (that tap doesn't draw). The Pencil writes without showing them.
// Loaded after visualiser.js and before app.js.

const MIRROR_IDLE_MS = 4000;
const mirrorMode = { active: false, lastActivity: 0, revealPointer: null };

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
    showToast("Screen Mirroring is on. In Camera, the projector shows this iPad's screen (best quality); the toolbars hide after a few seconds — tap to show them.", 6);
  }
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
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    document.addEventListener(type, mirrorActivity, { capture: true, passive: false });
  }
  window.setInterval(() => {
    const allowed = mirrorCleanAllowed();
    if (!allowed) setMirrorClean(false);
    else if (performance.now() - mirrorMode.lastActivity > MIRROR_IDLE_MS) setMirrorClean(true);
  }, 500);
}
