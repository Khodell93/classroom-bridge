// What draws, and what fingers do, on the PC screen and in the visualiser — plus palm rejection.
//   pencil       Apple Pencil draws; fingers control the PC (or zoom, pan and focus the camera).
//   finger       a finger draws too; two fingers still scroll, zoom and pan.
//   pencil-only  only the Pencil works on the screen; fingers and a resting hand are ignored (buttons still work).
// Until the teacher picks one, it is "finger" in the visualiser and "pencil" on the PC screen, and switches to
// "pencil" the first time an Apple Pencil is used, like Notes.
// Palm rejection: in every mode, a touch that lands while the Pencil is writing (or just after) is ignored, and a
// hand that landed just before the Pencil is cancelled, so a wrist never clicks, scrolls or draws.
// Loaded before visualiser.js and app.js; it only calls their functions when events arrive.

const DRAW_INPUT_KEY = "classroom-bridge-draw-input";
const PENCIL_SEEN_KEY = "classroom-bridge-pencil-seen";
const DRAW_INPUTS = ["pencil", "finger", "pencil-only"];
// Touches this soon after the Pencil last touched the screen are a resting hand. Timed from the Pencil's last
// contact rather than tracking down/up, so a missed "Pencil lifted" event can never block fingers for good.
// (Contact size isn't used: iPad Safari reports ordinary fingertips as wide as some palms.)
const PALM_AFTER_PEN_MS = 600;
const drawInput = {
  chosen: null,
  pencilSeen: false,
  penContactAt: -Infinity,
  ignored: new Set(),   // touch pointers rejected for the rest of their life
  touchStarts: new Map(),
};

function drawInputMode() {
  if (drawInput.chosen) return drawInput.chosen;
  if (drawInput.pencilSeen) return "pencil";
  return currentMode === "camera" ? "finger" : "pencil";
}

function fingerDrawsInk() {
  return drawInputMode() === "finger";
}

const DRAW_INPUT_LABELS = {
  pencil: { icon: "✎", toast: "Pencil draws · fingers control the PC and the camera. A resting hand is ignored." },
  finger: { icon: "☝", toast: "Finger draws · two fingers scroll and zoom." },
  "pencil-only": { icon: "✎", toast: "Pencil only · fingers are ignored on the screen, so your hand can rest on it. Buttons still work." },
};

function cycleDrawInput() {
  const next = DRAW_INPUTS[(DRAW_INPUTS.indexOf(drawInputMode()) + 1) % DRAW_INPUTS.length];
  drawInput.chosen = next;
  diag("draw", `draw input set to ${next}`);
  writeStoredValue(DRAW_INPUT_KEY, next);
  updateDrawInputControls();
  showToast(DRAW_INPUT_LABELS[next].toast);
}

function updateDrawInputControls() {
  const mode = drawInputMode();
  document.querySelectorAll(".draw-input-button").forEach(button => {
    button.dataset.input = mode;
    button.querySelector("span").textContent = DRAW_INPUT_LABELS[mode].icon;
    const label = { pencil: "Pencil draws, fingers control", finger: "Finger draws", "pencil-only": "Pencil only, fingers off" }[mode];
    button.setAttribute("aria-label", `${label}. Tap to change.`);
    button.title = label;
  });
}

// Call first for every pointer event on a drawing surface. Returns true if the event must be ignored.
function rejectDrawPointer(event) {
  const type = event.type;
  if (event.pointerType === "pen") {
    // A hovering Pencil (iPad Pro) sends moves without touching: those don't count.
    const touching = type === "pointerdown" || type === "pointerup" || type === "pointercancel" || (event.buttons & 1) || event.pressure > 0;
    if (touching) drawInput.penContactAt = performance.now();
    if (type === "pointerdown") {
      if (!drawInput.pencilSeen) {
        drawInput.pencilSeen = true;
        writeStoredValue(PENCIL_SEEN_KEY, "1");
        if (!drawInput.chosen) {
          updateDrawInputControls();
          showToast("Apple Pencil found: the Pencil draws and fingers control. Change this with the ✎ button.", 5);
        }
      }
      cancelRecentTouches();
    }
    return false;
  }
  if (event.pointerType !== "touch") return false;
  const id = event.pointerId;
  if (type === "pointerdown") {
    const writing = performance.now() - drawInput.penContactAt < PALM_AFTER_PEN_MS;
    if (drawInputMode() === "pencil-only" || writing) {
      diagCount(writing ? "touch-ignored-while-writing" : "touch-ignored-pencil-only");
      drawInput.ignored.add(id);
      event.preventDefault();
      return true;
    }
    drawInput.touchStarts.set(id, performance.now());
    return false;
  }
  if (drawInput.ignored.has(id)) {
    if (type === "pointerup" || type === "pointercancel") drawInput.ignored.delete(id);
    event.preventDefault();
    return true;
  }
  if (type === "pointerup" || type === "pointercancel") drawInput.touchStarts.delete(id);
  return false;
}

// The Pencil came down: a hand already on the screen is resting on it, not tapping or scrolling.
function cancelRecentTouches() {
  const recent = [...drawInput.touchStarts.keys()];
  if (!recent.length) return;
  diag("draw", `Pencil came down: cancelled ${recent.length} resting touch(es)`);
  for (const id of recent) {
    drawInput.touchStarts.delete(id);
    drawInput.ignored.add(id);
  }
  if (typeof cancelPcTouches === "function") cancelPcTouches(recent);
  if (typeof cancelVisualiserTouches === "function") cancelVisualiserTouches(recent);
}

function initDrawInput() {
  const stored = readStoredValue(DRAW_INPUT_KEY);
  drawInput.chosen = DRAW_INPUTS.includes(stored) ? stored : null;
  drawInput.pencilSeen = readStoredValue(PENCIL_SEEN_KEY) === "1";
  document.querySelectorAll(".draw-input-button").forEach(button => button.addEventListener("click", cycleDrawInput));
  updateDrawInputControls();
}
