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
const pcScreen = document.querySelector("#pc-screen");
const pcInk = document.querySelector("#pc-ink");
const cameraVideo = document.querySelector("#camera-video");
const cameraInk = document.querySelector("#camera-ink");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const photoImage = document.querySelector("#photo-image");
const cameraStage = document.querySelector("#camera-stage");
const toolsDrawer = document.querySelector("#tools-drawer");
const modifiers = new Set();
let peerConnection;
let signalSocket;
let controlChannel;
let inkChannel;
let currentMode = "pc";
let currentToolsPage = "draw";
let drawEnabled = true;
let drawing = false;
let drawingCanvas;
let lastRemoteInkPoint;
let pendingRemoteInkPoints = [];
let remoteInkFrame;
let previousPoint;
let hostPlatform = "windows";
let hostScreenWidth = 1280;
let hostScreenHeight = 720;
let activePairingCode = "";
let sessionActive = false;
let wakeLockSentinel;
let reconnectTimer;
let wasBackgrounded = false;
let mousePointerStart;
let mousePointerMoved = false;
let remoteInputValue = "";
let lastTap = null;
let pcZoom = 1;
let hostZoomStep = 1;
let pcPanX = 0;
let pcPanY = 0;
let pinchGesture;
const activeTouches = new Map();
const suppressedTouches = new Set();

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

function sendInk(value) {
  if (inkChannel?.readyState === "open") {
    if (value.type.startsWith("ink-move") && inkChannel.bufferedAmount > 8192) return false;
    inkChannel.send(JSON.stringify(value));
    return true;
  }
  return sendControl(value);
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
  if (!drawEnabled || event.pointerType !== "pen") return false;
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
  drawingCanvas = canvas;
  if (sendsRemoteInk(canvas)) {
    pendingRemoteInkPoints = [];
    const point = remoteInkPoint(canvas, event);
    lastRemoteInkPoint = point;
    sendInk({ type: "ink-start", ...point, color: context.strokeStyle, width: Number(document.querySelector("#ink-width").value) * remoteInkScale(canvas) });
  }
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
  if (sendsRemoteInk(canvas)) {
    const point = remoteInkPoint(canvas, event);
    const distance = lastRemoteInkPoint && Math.hypot((point.x - lastRemoteInkPoint.x) * hostScreenWidth, (point.y - lastRemoteInkPoint.y) * hostScreenHeight);
    if (!lastRemoteInkPoint || distance >= 1) {
      pendingRemoteInkPoints.push(point);
      lastRemoteInkPoint = point;
      if (!remoteInkFrame) remoteInkFrame = requestAnimationFrame(flushRemoteInkPoints);
    }
  }
}

function flushRemoteInkPoints() {
  if (remoteInkFrame) cancelAnimationFrame(remoteInkFrame);
  remoteInkFrame = undefined;
  if (pendingRemoteInkPoints.length) {
    sendInk({ type: "ink-move-batch", points: pendingRemoteInkPoints });
    pendingRemoteInkPoints = [];
  }
}

function endInk() {
  if (drawingCanvas && sendsRemoteInk(drawingCanvas)) {
    flushRemoteInkPoints();
    sendInk({ type: "ink-end" });
  }
  drawing = false;
  previousPoint = undefined;
  drawingCanvas = undefined;
  lastRemoteInkPoint = undefined;
}

function sendsRemoteInk(canvas) {
  return canvas === pcInk;
}

function remoteInkPoint(canvas, event) {
  return desktopPoint(event);
}

function remoteInkScale() {
  const stageBounds = pcStage.getBoundingClientRect();
  return hostScreenWidth / Math.min(stageBounds.width, stageBounds.height * 16 / 9);
}

function updateModeControls() {
  document.querySelectorAll(".mode-button[data-mode]").forEach(button => button.classList.toggle("selected", button.dataset.mode === currentMode));
  document.querySelector("#pc-stage").hidden = currentMode !== "pc";
  document.querySelector("#camera-stage").hidden = currentMode !== "camera";
  document.querySelector("#stage-label").textContent = currentMode === "pc" ? "PC screen" : "Camera / photo";
  document.querySelectorAll(".pc-only").forEach(element => element.hidden = currentMode !== "pc");
  document.querySelector(".camera-row").hidden = currentMode !== "camera";
  document.querySelector("#draw-hint").textContent = currentMode === "pc"
    ? "Finger controls the mouse; pinch to zoom the view. Apple Pencil annotations appear on both screens."
    : "Use the toolbar on the left of the camera to draw. In live view a finger taps to focus and pinches to zoom; Apple Pencil draws.";
  setCanvasSizes();
  updateVisualiserControls();
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
  resetPcZoom();
  sessionActive = false;
  activePairingCode = "";
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = undefined;
  }
  sendControl({ type: "mouse-up" });
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
  inkChannel = undefined;
  mediaChannel = undefined;
  cameraSender = undefined;
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
  activePairingCode = code;
  sessionActive = true;
  setStatus("Connecting…");
  requestScreenWakeLock();
  try {
    peerConnection = new RTCPeerConnection({ iceServers });
    peerConnection.ontrack = event => {
      pcVideo.srcObject = event.streams[0];
      pcPlaceholder.hidden = true;
      setCanvasSizes();
    };
    peerConnection.ondatachannel = event => {
      if (event.channel.label === "ink") {
        inkChannel = event.channel;
        return;
      }
      if (event.channel.label === "media") {
        mediaChannel = event.channel;
        mediaChannel.binaryType = "arraybuffer";
        mediaChannel.bufferedAmountLowThreshold = 256 * 1024;
        mediaChannel.onopen = visualiserMediaChannelOpened;
        return;
      }
      controlChannel = event.channel;
      controlChannel.onopen = () => {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        sendControl({ type: "screen-zoom", zoom: hostZoomStep });
        setStatus("PC connected", true);
        requestScreenWakeLock();
      };
      controlChannel.onclose = () => {
        if (!sessionActive) return;
        setStatus("Connection interrupted — reconnecting…");
        scheduleReconnect(2500);
      };
      controlChannel.onmessage = clipboardMessage;
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        setStatus("PC connected", true);
        requestScreenWakeLock();
      } else if (peerConnection.connectionState === "failed") {
        setStatus("Connection lost — reconnecting…");
        scheduleReconnect(500);
      } else if (peerConnection.connectionState === "disconnected") {
        setStatus("Connection interrupted — reconnecting…");
        scheduleReconnect(5000);
      }
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
        // Reuse the PC's video transceiver in the other direction for the camera, so no renegotiation is needed.
        const transceiver = peerConnection.getTransceivers().find(item => item.receiver.track?.kind === "video");
        if (transceiver) {
          transceiver.direction = "sendrecv";
          cameraSender = transceiver.sender;
        }
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        signalSocket.send(JSON.stringify({ type: "answer", description: peerConnection.localDescription }));
        attachCameraTrack();
      } else if (message.type === "candidate" && message.candidate) {
        await peerConnection.addIceCandidate(message.candidate);
      }
    };
    signalSocket.onerror = () => {
      setStatus("Pairing service unavailable");
      document.querySelector("#connect-message").textContent = "Could not reach the pairing service. Check the internet connection and try again.";
      document.querySelector("#connect-button").disabled = false;
      scheduleReconnect(3000);
    };
    signalSocket.onopen = () => {
      closeSetup();
      document.querySelector("#connect-button").disabled = false;
      document.querySelector("#connect-message").textContent = "Connected to pairing. Waiting for the PC screen…";
      setStatus("Waiting for PC…");
      setCanvasSizes();
    };
    const currentSocket = signalSocket;
    currentSocket.onclose = () => {
      if (signalSocket !== currentSocket) return;
      if (peerConnection?.connectionState !== "connected") {
        setStatus("Pairing interrupted — reconnecting…");
        document.querySelector("#connect-button").disabled = false;
        scheduleReconnect(1500);
      }
    };
  } catch (error) {
    setStatus("Could not connect");
    document.querySelector("#connect-message").textContent = error.message;
    document.querySelector("#connect-button").disabled = false;
    scheduleReconnect(3000);
  }
}

async function requestScreenWakeLock() {
  if (!sessionActive || document.hidden || wakeLockSentinel) return;
  if (!navigator.wakeLock) {
    statusEl.title = "This iPad browser cannot prevent automatic locking. Keep Classroom Bridge open and return if iPadOS pauses it.";
    return;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = undefined; }, { once: true });
    statusEl.title = "The screen stays awake while Classroom Bridge is visible. Switching apps or manually locking may still pause iPadOS.";
    if (peerConnection?.connectionState === "connected") setStatus("PC connected · screen awake", true);
  } catch {
    wakeLockSentinel = undefined;
    statusEl.title = "iPadOS may dim or lock the screen. Keep Classroom Bridge open to maintain the connection.";
    if (peerConnection?.connectionState === "connected") setStatus("PC connected · keep screen awake", true);
  }
}

function scheduleReconnect(delay = 1500) {
  if (!sessionActive || document.hidden || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    if (!sessionActive || document.hidden) return;
    if (peerConnection?.connectionState === "connected" && controlChannel?.readyState === "open") return;
    codeInput.value = activePairingCode;
    connect();
  }, delay);
}

function desktopPoint(event) {
  const bounds = pcStage.getBoundingClientRect();
  const stageX = bounds.left + (event.clientX - bounds.left - pcPanX) / pcZoom;
  const stageY = bounds.top + (event.clientY - bounds.top - pcPanY) / pcZoom;
  const streamAspect = 16 / 9;
  const stageAspect = bounds.width / bounds.height;
  const streamWidth = stageAspect > streamAspect ? bounds.height * streamAspect : bounds.width;
  const streamHeight = stageAspect > streamAspect ? bounds.height : bounds.width / streamAspect;
  const streamLeft = bounds.left + (bounds.width - streamWidth) / 2;
  const streamTop = bounds.top + (bounds.height - streamHeight) / 2;
  const streamX = Math.max(0, Math.min(1, (stageX - streamLeft) / streamWidth));
  const streamY = Math.max(0, Math.min(1, (stageY - streamTop) / streamHeight));
  const desktopAspect = hostScreenWidth / hostScreenHeight;
  const desktopWidth = desktopAspect > streamAspect ? 1 : desktopAspect / streamAspect;
  const desktopHeight = desktopAspect > streamAspect ? streamAspect / desktopAspect : 1;
  const desktopLeft = (1 - desktopWidth) / 2;
  const desktopTop = (1 - desktopHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (streamX - desktopLeft) / desktopWidth)),
    y: Math.max(0, Math.min(1, (streamY - desktopTop) / desktopHeight)),
  };
}

function applyPcZoom() {
  pcScreen.style.transform = `translate3d(${pcPanX}px, ${pcPanY}px, 0) scale(${pcZoom})`;
  document.querySelector("#zoom-reset").hidden = currentMode !== "pc" || pcZoom <= 1.01;
}

function resetPcZoom() {
  if (hostZoomStep !== 1) sendControl({ type: "screen-zoom", zoom: 1 });
  hostZoomStep = 1;
  pcZoom = 1;
  pcPanX = 0;
  pcPanY = 0;
  pinchGesture = undefined;
  activeTouches.clear();
  suppressedTouches.clear();
  applyPcZoom();
}

function startPinch() {
  if (activeTouches.size < 2) return;
  const [first, second] = [...activeTouches.values()].slice(0, 2);
  const bounds = pcStage.getBoundingClientRect();
  const centerX = (first.x + second.x) / 2;
  const centerY = (first.y + second.y) / 2;
  pinchGesture = {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    zoom: pcZoom,
    anchorX: (centerX - bounds.left - pcPanX) / pcZoom,
    anchorY: (centerY - bounds.top - pcPanY) / pcZoom,
  };
  mousePointerStart = undefined;
  lastTap = null;
  sendControl({ type: "mouse-up" });
}

function updatePinch() {
  if (activeTouches.size < 2 || !pinchGesture) return;
  const [first, second] = [...activeTouches.values()].slice(0, 2);
  const bounds = pcStage.getBoundingClientRect();
  const centerX = (first.x + second.x) / 2;
  const centerY = (first.y + second.y) / 2;
  pcZoom = Math.max(1, Math.min(4, pinchGesture.zoom * Math.hypot(second.x - first.x, second.y - first.y) / pinchGesture.distance));
  pcPanX = Math.max(bounds.width * (1 - pcZoom), Math.min(0, centerX - bounds.left - pinchGesture.anchorX * pcZoom));
  pcPanY = Math.max(bounds.height * (1 - pcZoom), Math.min(0, centerY - bounds.top - pinchGesture.anchorY * pcZoom));
  let nextHostZoomStep = hostZoomStep;
  while (nextHostZoomStep < 4 && pcZoom >= nextHostZoomStep + 0.35) nextHostZoomStep += 1;
  while (nextHostZoomStep > 1 && pcZoom <= nextHostZoomStep - 0.65) nextHostZoomStep -= 1;
  if (nextHostZoomStep !== hostZoomStep) {
    hostZoomStep = nextHostZoomStep;
    sendControl({ type: "screen-zoom", zoom: hostZoomStep });
  }
  sendControl({ type: "move", ...desktopPoint({ clientX: centerX, clientY: centerY }) });
  applyPcZoom();
}

function selectMode(mode) {
  if (mode !== "pc") resetPcZoom();
  if (mode !== currentMode) clearInk();
  currentMode = mode;
  updateModeControls();
  visualiserModeChanged(mode);
}

function clearInk() {
  for (const canvas of [pcInk, cameraInk]) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  flushRemoteInkPoints();
  sendInk({ type: "ink-clear" });
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
    hostScreenWidth = Number(message.screenWidth) || hostScreenWidth;
    hostScreenHeight = Number(message.screenHeight) || hostScreenHeight;
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
  if (["need-photo", "saved", "save-error"].includes(message.type)) {
    visualiserMessage(message);
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
document.querySelector("#zoom-reset").addEventListener("click", resetPcZoom);
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
document.querySelector("#clear-button").addEventListener("click", () => {
  if (currentMode === "camera") clearPage();
  else clearInk();
});
document.querySelector("#previous-slide").addEventListener("click", () => sendControl({ type: "key", key: "left" }));
document.querySelector("#next-slide").addEventListener("click", () => sendControl({ type: "key", key: "right" }));
document.querySelector("#open-explorer").addEventListener("click", () => handleShortcut("win+e"));
const remoteTypingInput = document.querySelector("#remote-typing-input");
remoteTypingInput.addEventListener("input", () => {
  const value = remoteTypingInput.value;
  if (value.length > remoteInputValue.length && value.startsWith(remoteInputValue)) {
    sendControl({ type: "text", text: value.slice(remoteInputValue.length, remoteInputValue.length + 250) });
  } else if (value.length < remoteInputValue.length && remoteInputValue.startsWith(value)) {
    for (let index = 0; index < remoteInputValue.length - value.length; index += 1) sendControl({ type: "key", key: "backspace" });
  } else if (value !== remoteInputValue) {
    sendControl({ type: "text", text: value.slice(-250) });
  }
  remoteInputValue = value;
  if (value.length > 100) {
    remoteTypingInput.value = "";
    remoteInputValue = "";
  }
});
remoteTypingInput.addEventListener("beforeinput", event => {
  const deletionKeys = {
    deleteContentBackward: "backspace",
    deleteWordBackward: "backspace",
    deleteSoftLineBackward: "backspace",
    deleteContentForward: "delete",
    deleteWordForward: "delete",
    deleteSoftLineForward: "delete",
  };
  const key = deletionKeys[event.inputType];
  if (!key) return;
  event.preventDefault();
  sendControl({ type: "key", key });
});
remoteTypingInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendControl({ type: "key", key: "enter" });
    remoteTypingInput.blur();
  } else if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    sendControl({ type: "key", key: event.key.toLowerCase() });
  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"].includes(event.key)) {
    event.preventDefault();
    sendControl({ type: "key", key: ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Tab: "tab" })[event.key] });
  }
});
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
for (const canvas of [pcInk]) {
  canvas.addEventListener("pointerdown", event => {
    if (event.pointerType === "pen" && beginInk(canvas, event)) event.preventDefault();
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
  if (event.pointerType === "touch") {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouches.size >= 2) {
      if (!pinchGesture) startPinch();
      pcStage.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
  }
  if (event.isPrimary === false) return;
  if (event.pointerType === "pen") beginInk(pcInk, event);
  else {
    const point = desktopPoint(event);
    mousePointerStart = { x: event.clientX, y: event.clientY };
    mousePointerMoved = false;
    sendControl({ type: "move", ...point });
    sendControl({ type: "mouse-down" });
    event.preventDefault();
  }
  pcStage.setPointerCapture(event.pointerId);
});
pcStage.addEventListener("pointermove", event => {
  if (currentMode !== "pc") return;
  if (event.pointerType === "touch" && suppressedTouches.has(event.pointerId)) {
    event.preventDefault();
    return;
  }
  if (event.pointerType === "touch" && activeTouches.has(event.pointerId)) {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchGesture) {
      updatePinch();
      event.preventDefault();
      return;
    }
  }
  if (drawing && event.pointerType === "pen") moveInk(pcInk, event);
  else if (event.pointerType !== "pen") {
    if (mousePointerStart && Math.hypot(event.clientX - mousePointerStart.x, event.clientY - mousePointerStart.y) > 10) mousePointerMoved = true;
    const point = desktopPoint(event);
    sendControl({ type: "move", ...point });
  }
});
pcStage.addEventListener("pointerup", event => {
  if (event.pointerType === "pen") endInk();
  else {
    if (event.pointerType === "touch") {
      activeTouches.delete(event.pointerId);
      if (pinchGesture) {
        pinchGesture = undefined;
        for (const pointerId of activeTouches.keys()) suppressedTouches.add(pointerId);
        mousePointerStart = undefined;
        lastTap = null;
        sendControl({ type: "mouse-up" });
        event.preventDefault();
        return;
      }
      if (suppressedTouches.delete(event.pointerId)) {
        event.preventDefault();
        return;
      }
    }
    const point = desktopPoint(event);
    sendControl({ type: "move", ...point });
    sendControl({ type: "mouse-up" });
    if (mousePointerStart && !mousePointerMoved) {
      const now = Date.now();
      const isDoubleTap = lastTap && now - lastTap.time < 450 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 32;
      lastTap = { x: event.clientX, y: event.clientY, time: now };
      if (isDoubleTap && controlChannel?.readyState === "open") {
        if (!toolsDrawer.hidden) toolsDrawer.hidden = true;
        remoteTypingInput.value = "";
        remoteInputValue = "";
        remoteTypingInput.focus({ preventScroll: true });
        lastTap = null;
      }
    } else {
      lastTap = null;
    }
    mousePointerStart = undefined;
  }
});
pcStage.addEventListener("pointercancel", event => {
  if (event.pointerType === "pen") endInk();
  else {
    if (event.pointerType === "touch") {
      activeTouches.delete(event.pointerId);
      if (pinchGesture) {
        pinchGesture = undefined;
        for (const pointerId of activeTouches.keys()) suppressedTouches.add(pointerId);
      }
      if (suppressedTouches.delete(event.pointerId)) {
        mousePointerStart = undefined;
        sendControl({ type: "mouse-up" });
        event.preventDefault();
        return;
      }
    }
    sendControl({ type: "mouse-up" });
    mousePointerStart = undefined;
  }
});
pcStage.addEventListener("lostpointercapture", event => {
  if (event.pointerType !== "pen") {
    sendControl({ type: "mouse-up" });
    mousePointerStart = undefined;
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    wasBackgrounded = true;
    sendControl({ type: "mouse-up" });
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = undefined;
    }
    return;
  }
  requestScreenWakeLock();
  pcVideo.play().catch(() => {});
  if (sessionActive && wasBackgrounded) {
    wasBackgrounded = false;
    setStatus("Back in Classroom Bridge — reconnecting…");
    codeInput.value = activePairingCode;
    connect();
  }
});
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
initVisualiser();
updateModeControls();
