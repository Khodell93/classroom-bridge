// Diagnostic log: what the iPad did, sent to the PC companion and written into its log file (marked [ipad]),
// so one file shows both sides in order. "Mark a problem" (Tools drawer) adds a marker with the teacher's note.
// Typed and pasted text is never logged (only its length). Events wait here while the PC isn't connected and are
// kept across a reload, then sent when it connects. Loaded first; the other scripts call diag() and diagControl().

const DIAG_PENDING_KEY = "classroom-bridge-diag-pending";
const DIAG_FREQUENT = new Set(["move", "scroll", "ink-move", "ink-move-batch", "ink-live", "shape-live", "laser", "view-update"]);
const DIAG_PRIVATE = new Set(["text", "value", "code", "pin", "password"]);
const diagLog = { pending: [], counts: {}, countsSince: Date.now() };

function diag(category, message) {
  diagLog.pending.push({ t: new Date().toISOString().slice(11, 23), c: category, m: String(message).slice(0, 1000) });
  if (diagLog.pending.length > 3000) diagLog.pending.splice(0, diagLog.pending.length - 3000);
}

// Counts something that happens many times a second; one summary line every 10 seconds.
function diagCount(name) {
  diagLog.counts[name] = (diagLog.counts[name] || 0) + 1;
}

function diagDescribe(value) {
  const parts = [String(value.type)];
  for (const [key, field] of Object.entries(value)) {
    if (key === "type") continue;
    if (DIAG_PRIVATE.has(key)) parts.push(`${key}=<${String(field).length} chars>`);
    else if (typeof field === "number") parts.push(`${key}=${Math.round(field * 1000) / 1000}`);
    else if (typeof field === "boolean" || (typeof field === "string" && field.length <= 40)) parts.push(`${key}=${field}`);
    else if (Array.isArray(field) && field.length <= 6 && field.every(item => typeof item === "string")) parts.push(`${key}=${field.join("+")}`);
    else parts.push(`${key}=…`);
  }
  return parts.join(" ");
}

// Every control or ink message the iPad sends to the PC.
function diagControl(value) {
  if (!value || typeof value.type !== "string") return;
  if (DIAG_FREQUENT.has(value.type)) diagCount(value.type);
  else diag("send", diagDescribe(value));
}

function diagFlush() {
  const now = Date.now();
  if (now - diagLog.countsSince >= 10000) {
    const summary = Object.entries(diagLog.counts).map(([name, count]) => `${name}×${count}`).join(", ");
    if (summary) diag("counts", `last ${Math.round((now - diagLog.countsSince) / 1000)} s: ${summary}`);
    diagLog.counts = {};
    diagLog.countsSince = now;
  }
  try {
    // controlChannel belongs to app.js (loaded later).
    if (!diagLog.pending.length || controlChannel?.readyState !== "open") return;
    while (diagLog.pending.length && controlChannel.bufferedAmount < 64 * 1024) {
      controlChannel.send(JSON.stringify({ type: "log", entries: diagLog.pending.splice(0, 100) }));
    }
  } catch {}
}

function markProblem() {
  const note = window.prompt("What went wrong? (optional — a few words help)") ?? "";
  diag("MARK", `Teacher marked a problem: ${note.trim() || "(no description)"}`);
  diagFlush();
  showToast(controlChannel?.readyState === "open"
    ? "Marked in the log. Carry on, then send the log from the PC (Show log in the Classroom Bridge window)."
    : "Marked. It will reach the PC's log when the iPad next connects.", 5);
}

window.addEventListener("error", event => {
  diag("error", `${event.message} (${String(event.filename || "").split("/").pop()}:${event.lineno}:${event.colno})`);
});
window.addEventListener("unhandledrejection", event => {
  const reason = event.reason;
  diag("error", `unhandled promise rejection: ${reason?.stack || reason?.message || reason}`);
});
document.addEventListener("visibilitychange", () => diag("app", document.hidden ? "went to the background" : "came back to the foreground"));
window.addEventListener("pagehide", () => {
  try {
    window.localStorage.setItem(DIAG_PENDING_KEY, JSON.stringify(diagLog.pending.slice(-500)));
  } catch {}
});

(() => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DIAG_PENDING_KEY) || "[]");
    window.localStorage.removeItem(DIAG_PENDING_KEY);
    if (Array.isArray(saved) && saved.length) {
      diagLog.pending.push({ t: "", c: "app", m: `— ${saved.length} events from before the app was last closed —` }, ...saved);
    }
  } catch {}
  const standalone = window.navigator.standalone || window.matchMedia?.("(display-mode: standalone)").matches;
  diag("app", `opened (${standalone ? "Home Screen app" : "Safari"}) ${navigator.userAgent} · screen ${screen.width}×${screen.height} @${window.devicePixelRatio}x`);
  window.setInterval(diagFlush, 2000);
})();
