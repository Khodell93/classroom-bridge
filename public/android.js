// Android tablets: the Classroom Bridge Android app (android/) shows this same web app and adds
// window.ClassroomBridgeAndroid for saving files and the clipboard. In Chrome on Android, or in the app, the
// words say "tablet" rather than "iPad", and AirPlay screen mirroring (Apple only) isn't offered: the camera
// uses the standard stream. Loaded straight after diag.js.

const ANDROID_DEVICE = /Android/i.test(navigator.userAgent);
const androidApp = typeof window.ClassroomBridgeAndroid === "object" ? window.ClassroomBridgeAndroid : null;

function deviceWords(text) {
  if (!ANDROID_DEVICE || typeof text !== "string") return text;
  return text.replace(/iPadOS/g, "Android").replace(/\biPads\b/g, "tablets").replace(/\biPad\b/g, "tablet");
}

function localizeForAndroid(root = document.body) {
  if (!ANDROID_DEVICE || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes("iPad")) node.nodeValue = deviceWords(node.nodeValue);
  }
  root.querySelectorAll("[aria-label*='iPad'], [title*='iPad'], [placeholder*='iPad']").forEach(element => {
    for (const name of ["aria-label", "title", "placeholder"]) {
      if (element.hasAttribute(name)) element.setAttribute(name, deviceWords(element.getAttribute(name)));
    }
  });
}

// Saves a photo or recording through the app, in pieces so a long recording doesn't need one huge string.
async function androidSaveFile(file) {
  const id = androidApp.beginSave(file.name, file.type);
  if (!id) return false;
  const piece = 384 * 1024; // a multiple of 3, so each piece encodes on its own
  for (let offset = 0; offset < file.size; offset += piece) {
    const bytes = new Uint8Array(await file.slice(offset, offset + piece).arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    if (!androidApp.appendSave(id, btoa(binary))) return false;
  }
  return Boolean(androidApp.finishSave(id));
}

if (ANDROID_DEVICE) {
  document.documentElement.classList.add("android");
  document.addEventListener("DOMContentLoaded", () => {
    localizeForAndroid();
    const ipadApps = document.querySelector("#ipad-apps-open");
    if (ipadApps) ipadApps.hidden = true; // AirPlay is Apple only
  });
}
