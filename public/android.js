// Android tablets: the Classroom Bridge Android app (android/) shows this same web app and adds
// window.ClassroomBridgeAndroid for saving files, the clipboard and sharing the screen. On Android the words say
// "tablet" rather than "iPad". AirPlay (Apple only) isn't offered: in the app, screen sharing takes its place
// (below); in Chrome on Android the camera uses the standard stream. Loaded straight after diag.js.

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
    if (ipadApps) ipadApps.hidden = true; // AirPlay is Apple only; the Android app shows it again as Share screen
  });
}

// ---------- Sharing the tablet's screen with the PC (the Android version of Screen Mirroring) ----------
// The app's ScreenShareService encodes the tablet's screen (H.264) and posts each frame here through a message
// channel ("F1:" + base64 for a key frame, "F0:" for others; state changes as JSON). The page sends the frames to
// the companion on a "screen" data channel of the connection it already has, in pieces of up to 16 KB, each with a
// 6-byte header: flags (1 first piece, 2 last piece, 4 key frame), the frame number (4 bytes), and a spare byte.
// The companion then reports "mirroring", and everything else works as with an iPad's AirPlay mirror.

const SHARE_PIECE = 16384 - 6;
const SHARE_BACKLOG = 2 * 1024 * 1024; // more than this waiting to go: skip to the next key frame
const androidShare = { port: null, active: false, channel: null, needKey: true, frame: 0, keyAskedAt: 0, size: null, keptConnection: false };

function androidCanShare() {
  return Boolean(androidApp && typeof androidApp.canShareScreen === "function" && androidApp.canShareScreen());
}

window.addEventListener("message", event => {
  if (event.data !== "classroom-bridge-screen" || !event.ports?.[0]) return;
  androidShare.port = event.ports[0];
  androidShare.port.onmessage = message => androidShareMessage(message.data);
});

function androidShareMessage(data) {
  if (typeof data !== "string") return;
  if (data.startsWith("F")) {
    androidShareFrame(data.slice(3), data[1] === "1");
    return;
  }
  try {
    const message = JSON.parse(data);
    if (message.type === "share") androidShareState(message);
  } catch {}
}

function androidShareState(message) {
  const wasActive = androidShare.active;
  androidShare.active = Boolean(message.active);
  diag("share", `tablet screen sharing ${message.active ? "on" : "off"} (${message.reason})${message.width ? ` ${message.width}×${message.height}` : ""}`);
  if (androidShare.active) {
    androidShare.size = { width: message.width, height: message.height };
    androidShare.needKey = true;
    androidShareAnnounce();
    if (!wasActive) {
      window.clearTimeout(androidShare.answerTimer);
      androidShare.answerTimer = window.setTimeout(() => {
        // A companion older than screen sharing never answers: carry on with the standard camera stream.
        if (!androidShare.active || mirrorMode.active || controlChannel?.readyState !== "open") return;
        diag("share", "the PC didn't start showing the shared screen (companion too old?)");
        showToast("The PC didn't show the shared screen: update the Classroom Bridge companion on the PC. Using standard quality for now.", 7);
        mirrorMode.standardChosen = true;
        updateMirrorPrompt();
        startCameraIfWaiting();
      }, 8000);
    }
  } else {
    sendControl({ type: "screen-share", active: false });
    if (message.reason === "refused" && !wasActive) showToast("Screen sharing wasn't started. Tap Share screen to try again, or use standard quality.", 5);
    else if (message.reason === "failed" || message.reason === "unavailable") showToast("This tablet couldn't share its screen. Use standard quality for the camera.", 6);
    // Locked, or stopped from Android's notification while Classroom Bridge was in the background: now it lets go
    // of the PC, as it does without sharing.
    if (document.hidden && androidShare.keptConnection) {
      androidShare.keptConnection = false;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  }
  updateAndroidShareButton();
  if (typeof updateMirrorPrompt === "function") updateMirrorPrompt();
}

// Tells the PC (again, after a reconnect) that the screen is coming, on a fresh data channel.
function androidShareAnnounce() {
  if (!androidShare.active || !peerConnection || controlChannel?.readyState !== "open") return;
  if (!androidShare.channel || androidShare.channel.readyState === "closed" || androidShare.channel.readyState === "closing"
      || androidShare.channel.peer !== peerConnection) {
    try {
      androidShare.channel = peerConnection.createDataChannel("screen", { ordered: true });
      androidShare.channel.peer = peerConnection;
      androidShare.channel.binaryType = "arraybuffer";
      androidShare.channel.onopen = () => androidAskKeyFrame(true);
    } catch (error) {
      diag("share", `couldn't open the screen channel: ${error}`);
      return;
    }
  }
  sendControl({ type: "screen-share", active: true, ...androidShare.size });
  androidShare.needKey = true;
  androidAskKeyFrame(true);
}

function androidAskKeyFrame(now = false) {
  if (!androidShare.port) return;
  if (!now && performance.now() - androidShare.keyAskedAt < 500) return;
  androidShare.keyAskedAt = performance.now();
  androidShare.port.postMessage("keyframe");
}

function androidShareFrame(base64, keyFrame) {
  if (!androidShare.active) return;
  const channel = androidShare.channel;
  // In Classroom Bridge's PC mode the projector shows the PC itself (the PC hides the mirror), so nothing is sent.
  const wanted = document.hidden || currentMode !== "pc";
  if (!wanted || channel?.readyState !== "open" || channel.bufferedAmount > SHARE_BACKLOG) {
    androidShare.needKey = true;
    return;
  }
  if (androidShare.needKey && !keyFrame) {
    androidAskKeyFrame();
    return;
  }
  androidShare.needKey = false;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const frame = androidShare.frame = (androidShare.frame + 1) >>> 0;
  for (let offset = 0; offset < bytes.length || offset === 0; offset += SHARE_PIECE) {
    const piece = bytes.subarray(offset, offset + SHARE_PIECE);
    const message = new Uint8Array(6 + piece.length);
    message[0] = (offset === 0 ? 1 : 0) | (offset + SHARE_PIECE >= bytes.length ? 2 : 0) | (keyFrame ? 4 : 0);
    new DataView(message.buffer).setUint32(1, frame);
    message.set(piece, 6);
    channel.send(message);
    if (!bytes.length) break;
  }
}

// app.js asks these: on a new connection, when the PC wants a key frame (it started late, or lost its place), and
// whether going to another app should keep the connection (it should while the screen is shared).
function androidConnectionOpened() {
  androidShareAnnounce();
}

function androidScreenKeyFrame() {
  androidShare.needKey = true;
  androidAskKeyFrame(true);
}

function androidKeepsConnection() {
  return androidShare.active;
}

function toggleAndroidShare() {
  if (androidShare.active) {
    androidApp.stopScreenShare();
    return;
  }
  if (controlChannel?.readyState !== "open") {
    showToast("Connect to the PC first.");
    return;
  }
  showToast("Android asks to share the screen: choose “Entire screen” (so other apps show too), then Start.", 6);
  androidApp.startScreenShare();
}

function updateAndroidShareButton() {
  const button = document.querySelector("#ipad-apps-open");
  if (!button || !androidCanShare()) return;
  button.lastChild.nodeValue = androidShare.active ? " Stop sharing" : " Share screen";
  button.classList.toggle("selected", androidShare.active);
}

if (ANDROID_DEVICE) {
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("#ipad-apps-open");
    if (!button || !androidCanShare()) return;
    // In the Android app this button shares the screen, which shows any app on the PC (as iPad apps does by AirPlay).
    button.hidden = false;
    button.addEventListener("click", event => {
      event.stopImmediatePropagation();
      toggleAndroidShare();
    }, true);
    updateAndroidShareButton();
  });
}
