const SIGNAL_PATH = "/signal/";
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const statusEl = document.querySelector("#connection-status");
const codeInput = document.querySelector("#pair-code");
const connectPanel = document.querySelector("#connect-panel");
const workspace = document.querySelector("#workspace");
const pcVideo = document.querySelector("#pc-video");
const pcPlaceholder = document.querySelector("#pc-placeholder");
const pcInk = document.querySelector("#pc-ink");
const cameraVideo = document.querySelector("#camera-video");
const cameraInk = document.querySelector("#camera-ink");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const photoImage = document.querySelector("#photo-image");
let peerConnection;
let signalSocket;
let controlChannel;
let cameraStream;
let currentMode = "pc";
let drawEnabled = true;
let drawing = false;
let previousPoint;

function setStatus(label, connected = false) {
  statusEl.textContent = label;
  statusEl.classList.toggle("connected", connected);
}

function sendControl(value) {
  if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify(value));
}

function resizeCanvas(canvas) {
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(box.width * ratio);
  const height = Math.round(box.height * ratio);
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
  const context = canvas.getContext("2d");
  resizeCanvas(canvas);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#ff4b6e";
  context.lineWidth = Math.max(3, 4 * (window.devicePixelRatio || 1));
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

for (const canvas of [pcInk, cameraInk]) {
  canvas.addEventListener("pointerdown", event => {
    if (currentMode === "camera" || (currentMode === "pc" && event.pointerType === "pen")) {
      if (beginInk(canvas, event)) event.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", event => {
    if (drawing) {
      moveInk(canvas, event);
      event.preventDefault();
    } else if (currentMode === "pc" && event.pointerType !== "pen") {
      const rect = canvas.getBoundingClientRect();
      sendControl({ type: "move", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
    }
  });
  canvas.addEventListener("pointerup", event => {
    if (drawing) endInk();
    else if (currentMode === "pc" && event.pointerType !== "pen") sendControl({ type: "click" });
  });
  canvas.addEventListener("pointercancel", endInk);
}

const pcStage = document.querySelector("#pc-stage");
pcStage.addEventListener("pointerdown", event => {
  if (currentMode !== "pc") return;
  if (event.pointerType === "pen") {
    beginInk(pcInk, event);
  } else {
    const rect = pcStage.getBoundingClientRect();
    sendControl({ type: "move", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
    sendControl({ type: "mouse-down" });
  }
  pcStage.setPointerCapture(event.pointerId);
});
pcStage.addEventListener("pointermove", event => {
  if (currentMode !== "pc") return;
  if (drawing && event.pointerType === "pen") moveInk(pcInk, event);
  else if (event.pointerType !== "pen") {
    const rect = pcStage.getBoundingClientRect();
    sendControl({ type: "move", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
  }
});
pcStage.addEventListener("pointerup", event => {
  if (event.pointerType === "pen") endInk();
  else sendControl({ type: "mouse-up" });
});
pcStage.addEventListener("pointercancel", endInk);

async function connect() {
  const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (code.length < 8) {
    document.querySelector("#connect-message").textContent = "Enter the pairing code shown by the Windows companion.";
    return;
  }
  document.querySelector("#connect-button").disabled = true;
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
      controlChannel.onclose = () => setStatus("Control channel closed");
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "failed") setStatus("Connection failed — check school Wi-Fi");
      if (peerConnection.connectionState === "disconnected") setStatus("Reconnecting…");
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
      } else if (message.type === "host-ready") {
        setStatus("Paired — negotiating…");
      }
    };
    signalSocket.onerror = () => setStatus("Pairing service unavailable");
    signalSocket.onopen = () => {
      connectPanel.hidden = true;
      workspace.hidden = false;
      setStatus("Waiting for PC…");
      setCanvasSizes();
    };
    signalSocket.onclose = () => {
      if (peerConnection?.connectionState !== "connected") setStatus("Pairing disconnected");
    };
  } catch (error) {
    setStatus("Could not connect");
    document.querySelector("#connect-message").textContent = error.message;
    document.querySelector("#connect-button").disabled = false;
  }
}

document.querySelector("#connect-button").addEventListener("click", connect);
codeInput.addEventListener("keydown", event => { if (event.key === "Enter") connect(); });
document.querySelectorAll(".mode-button").forEach(button => button.addEventListener("click", async () => {
  currentMode = button.dataset.mode;
  document.querySelectorAll(".mode-button").forEach(item => item.classList.toggle("selected", item === button));
  document.querySelector("#pc-stage").hidden = currentMode !== "pc";
  document.querySelector("#camera-stage").hidden = currentMode !== "camera";
  document.querySelector("#ink-tools").hidden = currentMode !== "camera";
  document.querySelector("#open-explorer").hidden = currentMode !== "pc";
  document.querySelector("#slide-controls").hidden = currentMode !== "pc";
  document.querySelector("#stage-hint").textContent = currentMode === "pc" ? "Touch to control the PC. Draw with Apple Pencil." : "Draw directly over the live camera view or selected image.";
  setCanvasSizes();
}));
document.querySelector("#pen-button").addEventListener("click", event => {
  drawEnabled = !drawEnabled;
  event.currentTarget.classList.toggle("active", drawEnabled);
});
document.querySelector("#clear-button").addEventListener("click", () => {
  for (const canvas of [pcInk, cameraInk]) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
});
document.querySelector("#previous-slide").addEventListener("click", () => sendControl({ type: "key", key: "left" }));
document.querySelector("#next-slide").addEventListener("click", () => sendControl({ type: "key", key: "right" }));
document.querySelector("#open-explorer").addEventListener("click", () => sendControl({ type: "hotkey", keys: ["win", "e"] }));
document.querySelector("#pc-text").addEventListener("keydown", event => {
  if (event.key === "Enter" && event.currentTarget.value) {
    sendControl({ type: "text", text: event.currentTarget.value });
    event.currentTarget.value = "";
  }
});
document.querySelector("#disconnect-button").addEventListener("click", () => {
  signalSocket?.close();
  peerConnection?.close();
  cameraStream?.getTracks().forEach(track => track.stop());
  location.reload();
});
document.querySelector("#camera-start").addEventListener("click", async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    cameraVideo.srcObject = cameraStream;
    cameraVideo.hidden = false;
    photoImage.hidden = true;
    cameraPlaceholder.hidden = true;
    document.querySelector("#camera-stop").hidden = false;
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
  document.querySelector("#camera-stop").hidden = true;
});
document.querySelector("#photo-input").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraVideo.hidden = true;
  photoImage.src = URL.createObjectURL(file);
  photoImage.hidden = false;
  cameraPlaceholder.hidden = true;
  document.querySelector("#camera-stop").hidden = true;
});
window.addEventListener("resize", setCanvasSizes);
window.addEventListener("beforeunload", () => cameraStream?.getTracks().forEach(track => track.stop()));
