const SIGNAL_PATH = "/signal/";
const SAVED_CODE_KEY = "classroom-bridge-pairing-code";
const FIRST_OPEN_KEY = "classroom-bridge-first-open-complete";
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const statusEl = document.querySelector("#connection-status");
const codeInput = document.querySelector("#pair-code");
const rememberCode = document.querySelector("#remember-code");
const setupModal = document.querySelector("#setup-modal");
const pcVideo = document.querySelector("#pc-video");
const pcPlaceholder = document.querySelector("#pc-placeholder");
const pcStage = document.querySelector("#pc-stage");
const pcInk = document.querySelector("#pc-ink");
const cameraVideo = document.querySelector("#camera-video");
const cameraInk = document.querySelector("#camera-ink");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const photoImage = document.querySelector("#photo-image");
const toolsDrawer = document.querySelector("#tools-drawer");
const modifiers = new Set();
let peerConnection;
let signalSocket;
let controlChannel;
let cameraStream;
let currentMode = "pc";
let currentToolsPage = "draw";
let drawEnabled = true;
let drawing = false;
let previousPoint;
let hostPlatform = "windows";

function setStatus(label, connected = false) {
  statusEl.querySelector("span").textContent = label;
  statusEl.classList.toggle("connected", connected);
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return false;
  }
  return true;
}

function sendControl(value) {
  if (controlChannel?.readyState !== "open") return false;
  controlChannel.send(JSON.stringify(value));
  return true;
}

function resizeCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(bounds.width * ratio);
  const height = Math.round(bounds.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function setCanvasSizes() {
  resizeCanvas(pcInk);
  resizeCanvas(cameraInk);
}

function beginInk(canvas, event) {
  if (!drawEnabled || (currentMode === "pc" && event.pointerType !== "pen")) return false;
  const bounds = canvas.getBoundingClientRect();
  resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = document.querySelector("#ink-color").value;
  context.lineWidth = Number(document.querySelector("#ink-width").value) * ratio;
  previousPoint = { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  drawing = true;
  if (event.currentTarget === canvas) canvas.setPointerCapture(event.pointerId);
  return true;
}

function moveInk(canvas, event) {
  if (!drawing) return;
  const bounds = canvas.getBoundingClientRect();
  const nextPoint = { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  const context = canvas.getContext("2d");
  context.beginPath();
  context.moveTo(previousPoint.x, previousPoint.y);
  context.lineTo(nextPoint.x, nextPoint.y);
  context.stroke();
  previousPoint = nextPoint;
}

function endInk() {
  drawing = false;
  previousPoint = undefined;
}

function updateModeControls() {
  document.querySelectorAll(".mode-button[data-mode]").forEach(button => button.classList.toggle("selected", button.dataset.mode === currentMode));
  document.querySelector("#pc-stage").hidden = currentMode !== "pc";
  document.querySelector("#camera-stage").hidden = currentMode !== "camera";
  document.querySelector("#stage-label").textContent = currentMode === "pc" ? "PC screen" : "Camera / photo";
  document.querySelectorAll(".pc-only").forEach(element => element.hidden = currentMode !== "pc");
  document.querySelector(".camera-row").hidden = currentMode !== "camera";
  document.querySelector("#draw-hint").textContent = currentMode === "pc"
    ? "Touch to control the PC. Draw with Apple Pencil; marks stay on the iPad and mirror to the TV."
    : "Draw on the live camera view or a selected photo with Apple Pencil or touch.";
  setCanvasSizes();
}

function selectToolsPage(page) {
  currentToolsPage = page;
  document.querySelectorAll(".drawer-tab").forEach(button => button.classList.toggle("selected", button.dataset.tools === page));
  document.querySelectorAll(".tool-page").forEach(panel => panel.hidden = panel.dataset.page !== page);
  toolsDrawer.hidden = false;
}

function openSetup() {
  setupModal.hidden = false;
  toolsDrawer.hidden = true;
  window.setTimeout(() => codeInput.focus(), 50);
}

function closeSetup() {
  setupModal.hidden = true;
}

function clearConnection() {
  if (controlChannel) {
    controlChannel.onclose = null;
    controlChannel.onmessage = null;
  }
  if (signalSocket) {
    signalSocket.onclose = null;
    signalSocket.onerror = null;
    signalSocket.close();
  }
  if (peerConnection) {
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }
  signalSocket = undefined;
  peerConnection = undefined;
  controlChannel = undefined;
  pcVideo.srcObject = null;
  pcPlaceholder.hidden = false;
  modifiers.clear();
  document.querySelectorAll(".modifier-key").forEach(button => button.classList.remove("selected"));
  document.querySelector("#modifier-hint").textContent = "Ready";
  setStatus("Not connected");
}

async function connect() {
  const code = codeInput.value.trim().toUpperCase().replace(/\s/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) {
    document.querySelector("#connect-message").textContent = "Enter the 12-character code shown by the PC companion.";
    return;
  }
  const codeSaved = rememberCode.checked ? writeStoredValue(SAVED_CODE_KEY, code) : removeStoredValue(SAVED_CODE_KEY);
  document.querySelector("#connect-button").disabled = true;
  document.querySelector("#connect-message").textContent = codeSaved
    ? "Connecting to the PC companion…"
    : "Connecting, but this browser did not allow saving the pairing code.";
  clearConnection();
  setStatus("Connecting…");
  try {
    peerConnection = new RTCPeerConnection({ iceServers });
    peerConnection.ontrack = event => {
      pcVideo.srcObject = event.streams[0];
      pcPlaceholder.hidden = true;
      setCanvasSizes();
    };
    peerConnection.ondatachannel = event => {
      controlChannel = event.channel;
      controlChannel.onopen = () => setStatus("PC connected", true);
      controlChannel.onclose = () => setStatus("PC connection ended");
      controlChannel.onmessage = clipboardMessage;
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") setStatus("PC connected", true);
      else if (peerConnection.connectionState === "failed") setStatus("Connection failed — school Wi-Fi may block it");
      else if (peerConnection.connectionState === "disconnected") setStatus("Reconnecting…");
    };
    peerConnection.onicecandidate = event => {
      if (event.candidate && signalSocket?.readyState === WebSocket.OPEN) signalSocket.send(JSON.stringify({ type: "candidate", candidate: event.candidate }));
    };
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    signalSocket = new WebSocket(`${protocol}//${location.host}${SIGNAL_PATH}${encodeURIComponent(code)}?role=ipad`);
    signalSocket.onmessage = async event => {
      const message = JSON.parse(event.data);
      if (message.type === "offer") {
        await peerConnection.setRemoteDescription(message.description);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        signalSocket.send(JSON.stringify({ type: "answer", description: peerConnection.localDescription }));
      } else if (message.type === "candidate" && message.candidate) {
        await peerConnection.addIceCandidate(message.candidate);
      }
    };
    signalSocket.onerror = () => {
      setStatus("Pairing service unavailable");
      document.querySelector("#connect-message").textContent = "Could not reach the pairing service. Check the internet connection and try again.";
      document.querySelector("#connect-button").disabled = false;
    };
    signalSocket.onopen = () => {
      closeSetup();
      document.querySelector("#connect-button").disabled = false;
      document.querySelector("#connect-message").textContent = "Connected to pairing. Waiting for the PC screen…";
      setStatus("Waiting for PC…");
      setCanvasSizes();
    };
    signalSocket.onclose = () => {
      if (peerConnection?.connectionState !== "connected") {
        setStatus("Pairing disconnected");
        document.querySelector("#connect-button").disabled = false;
      }
    };
  } catch (error) {
    setStatus("Could not connect");
    document.querySelector("#connect-message").textContent = error.message;
    document.querySelector("#connect-button").disabled = false;
  }
}

function selectMode(mode) {
  currentMode = mode;
  updateModeControls();
}

function clearInk() {
  for (const canvas of [pcInk, cameraInk]) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function handleKey(key) {
  const selected = ["ctrl", "alt", "shift", "win"].filter(modifier => modifiers.has(modifier));
  if (selected.length) {
    sendControl({ type: "hotkey", keys: [...selected, key] });
    modifiers.clear();
    document.querySelectorAll(".modifier-key").forEach(button => button.classList.remove("selected"));
    document.querySelector("#modifier-hint").textContent = "Ready";
  } else {
    sendControl({ type: "key", key });
  }
}

function handleShortcut(shortcut) {
  const keys = shortcut.split("+");
  if (hostPlatform === "macos") {
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] === "ctrl") keys[index] = "win";
    }
  }
  sendControl({ type: "hotkey", keys });
}

function sendTypedText() {
  const input = document.querySelector("#pc-text");
  if (!input.value) return;
  if (sendControl({ type: "text", text: input.value })) input.value = "";
}

async function pasteIpadClipboard() {
  const message = document.querySelector("#clipboard-message");
  if (controlChannel?.readyState !== "open") {
    message.textContent = "Connect to the PC first.";
    return;
  }
  if (!navigator.clipboard?.readText) {
    message.textContent = "Clipboard access is unavailable in this browser. Try pasting into the typing box instead.";
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      message.textContent = "The iPad clipboard is empty.";
      return;
    }
    if (sendControl({ type: "paste", text: text.slice(0, 20000) })) message.textContent = "Pasted the iPad clipboard into the active PC app.";
  } catch {
    message.textContent = "Safari blocked clipboard access. Tap again and allow Paste if prompted.";
  }
}

function clipboardMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "host-info") {
    hostPlatform = message.os === "macos" ? "macos" : "windows";
    const commandLabel = hostPlatform === "macos" ? "Command" : "Win";
    document.querySelector('[data-modifier="win"]').textContent = commandLabel;
    document.querySelector('[data-shortcut="ctrl+c"]').textContent = hostPlatform === "macos" ? "⌘+C" : "Ctrl+C";
    document.querySelector('[data-shortcut="ctrl+v"]').textContent = hostPlatform === "macos" ? "⌘+V" : "Ctrl+V";
    document.querySelector('[data-shortcut="ctrl+a"]').textContent = hostPlatform === "macos" ? "⌘+A" : "Ctrl+A";
    document.querySelector('[data-shortcut="win+e"]').textContent = hostPlatform === "macos" ? "Open Finder" : "Win+E · Files";
    document.querySelector('[data-shortcut="alt+tab"]').textContent = hostPlatform === "macos" ? "⌘+Tab" : "Alt+Tab";
    document.querySelector("#open-explorer strong").textContent = hostPlatform === "macos" ? "Open Finder" : "File Explorer";
    return;
  }
  if (message.type === "clipboard-error") {
    document.querySelector("#clipboard-message").textContent = "Windows could not access the clipboard. Try copying text on the PC and send again.";
    return;
  }
  if (message.type !== "clipboard-text") return;
  const text = String(message.text || "").slice(0, 20000);
  document.querySelector("#clipboard-preview").value = text;
  document.querySelector("#copy-to-ipad").disabled = !text;
  document.querySelector("#clipboard-message").textContent = text
    ? "PC clipboard received. Review it, then tap Copy to iPad."
    : "The PC clipboard is empty.";
}

document.querySelector("#connect-button").addEventListener("click", connect);
codeInput.addEventListener("keydown", event => { if (event.key === "Enter") connect(); });
document.querySelector("#setup-open").addEventListener("click", openSetup);
document.querySelector("#placeholder-setup").addEventListener("click", openSetup);
document.querySelector("#setup-close").addEventListener("click", closeSetup);
document.querySelector("#continue-offline").addEventListener("click", closeSetup);
document.querySelector("#tools-open").addEventListener("click", () => selectToolsPage(currentToolsPage));
document.querySelector("#tools-close").addEventListener("click", () => { toolsDrawer.hidden = true; });
document.querySelectorAll(".mode-button[data-mode]").forEach(button => button.addEventListener("click", () => selectMode(button.dataset.mode)));
document.querySelectorAll(".drawer-tab").forEach(button => button.addEventListener("click", () => selectToolsPage(button.dataset.tools)));
document.querySelector("#pen-button").addEventListener("click", event => {
  drawEnabled = !drawEnabled;
  event.currentTarget.classList.toggle("selected", drawEnabled);
});
document.querySelector("#clear-button").addEventListener("click", clearInk);
document.querySelector("#previous-slide").addEventListener("click", () => sendControl({ type: "key", key: "left" }));
document.querySelector("#next-slide").addEventListener("click", () => sendControl({ type: "key", key: "right" }));
document.querySelector("#open-explorer").addEventListener("click", () => handleShortcut("win+e"));
document.querySelector("#send-text").addEventListener("click", sendTypedText);
document.querySelector("#pc-text").addEventListener("keydown", event => { if (event.key === "Enter") sendTypedText(); });
document.querySelectorAll(".modifier-key").forEach(button => button.addEventListener("click", () => {
  const modifier = button.dataset.modifier;
  if (modifiers.has(modifier)) modifiers.delete(modifier);
  else modifiers.add(modifier);
  button.classList.toggle("selected", modifiers.has(modifier));
  document.querySelector("#modifier-hint").textContent = modifiers.size ? `${["ctrl", "alt", "shift", "win"].filter(modifier => modifiers.has(modifier)).join(" + ")} ready for next key` : "Ready";
}));
document.querySelectorAll(".key-button[data-key]").forEach(button => button.addEventListener("click", () => handleKey(button.dataset.key)));
document.querySelectorAll(".key-button[data-shortcut]").forEach(button => button.addEventListener("click", () => handleShortcut(button.dataset.shortcut)));
document.querySelector("#paste-ipad").addEventListener("click", pasteIpadClipboard);
document.querySelector("#request-pc-clipboard").addEventListener("click", () => {
  document.querySelector("#clipboard-message").textContent = sendControl({ type: "clipboard-read" })
    ? "Requesting text from the PC clipboard…"
    : "Connect to the PC first.";
});
document.querySelector("#copy-to-ipad").addEventListener("click", async () => {
  const text = document.querySelector("#clipboard-preview").value;
  try {
    await navigator.clipboard.writeText(text);
    document.querySelector("#clipboard-message").textContent = "Copied to the iPad clipboard.";
  } catch {
    document.querySelector("#clipboard-message").textContent = "Safari blocked clipboard access. You can select the text above and copy it manually.";
  }
});
document.querySelector("#disconnect-button").addEventListener("click", () => {
  clearConnection();
  toolsDrawer.hidden = true;
  openSetup();
});
document.querySelector("#immersive-button").addEventListener("click", () => {
  document.body.classList.toggle("immersive-mode");
});
document.querySelector("#camera-start").addEventListener("click", async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    cameraVideo.srcObject = cameraStream;
    cameraVideo.hidden = false;
    photoImage.hidden = true;
    cameraPlaceholder.hidden = true;
    document.querySelector("#camera-start").hidden = true;
    document.querySelector("#camera-stop").hidden = false;
    toolsDrawer.hidden = true;
  } catch (error) {
    cameraPlaceholder.querySelector("span:last-child").textContent = `Camera unavailable: ${error.message}. Choose a photo instead.`;
  }
});
document.querySelector("#camera-stop").addEventListener("click", () => {
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraVideo.srcObject = null;
  cameraVideo.hidden = true;
  cameraPlaceholder.hidden = false;
  document.querySelector("#camera-start").hidden = false;
  document.querySelector("#camera-stop").hidden = true;
});
document.querySelector("#photo-input").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraVideo.srcObject = null;
  cameraVideo.hidden = true;
  photoImage.src = URL.createObjectURL(file);
  photoImage.hidden = false;
  cameraPlaceholder.hidden = true;
  document.querySelector("#camera-start").hidden = false;
  document.querySelector("#camera-stop").hidden = true;
  toolsDrawer.hidden = true;
});

for (const canvas of [pcInk, cameraInk]) {
  canvas.addEventListener("pointerdown", event => {
    if (currentMode === "camera" || event.pointerType === "pen") {
      if (beginInk(canvas, event)) event.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", event => {
    if (drawing) {
      moveInk(canvas, event);
      event.preventDefault();
    }
  });
  canvas.addEventListener("pointerup", () => { if (drawing) endInk(); });
  canvas.addEventListener("pointercancel", endInk);
}

pcStage.addEventListener("pointerdown", event => {
  if (currentMode !== "pc") return;
  if (event.pointerType === "pen") beginInk(pcInk, event);
  else {
    const bounds = pcStage.getBoundingClientRect();
    sendControl({ type: "move", x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
    sendControl({ type: "mouse-down" });
  }
  pcStage.setPointerCapture(event.pointerId);
});
pcStage.addEventListener("pointermove", event => {
  if (currentMode !== "pc") return;
  if (drawing && event.pointerType === "pen") moveInk(pcInk, event);
  else if (event.pointerType !== "pen") {
    const bounds = pcStage.getBoundingClientRect();
    sendControl({ type: "move", x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
  }
});
pcStage.addEventListener("pointerup", event => {
  if (event.pointerType === "pen") endInk();
  else sendControl({ type: "mouse-up" });
});
pcStage.addEventListener("pointercancel", endInk);
window.addEventListener("resize", setCanvasSizes);
window.addEventListener("beforeunload", () => {
  cameraStream?.getTracks().forEach(track => track.stop());
  signalSocket?.close();
  peerConnection?.close();
});

const savedCode = readStoredValue(SAVED_CODE_KEY);
if (savedCode) {
  codeInput.value = savedCode;
  rememberCode.checked = true;
}
if (readStoredValue(FIRST_OPEN_KEY)) setupModal.hidden = true;
else writeStoredValue(FIRST_OPEN_KEY, "true");
updateModeControls();
