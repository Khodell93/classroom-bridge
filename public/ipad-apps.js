// "iPad apps": show OneDrive, PowerPoint or any other iPad app on the projector through the PC.
// A web app can't start Screen Mirroring itself, so this panel walks the teacher through the two taps with this PC's
// exact receiver name and PIN, and checks the things that stop the PC appearing: the receiver, its Bluetooth
// beacon, the firewall, and whether the school network lets the iPad reach the PC directly.
// Loaded before app.js; app.js routes "airplay-info" replies here.

const ipadApps = { info: null, route: null, retry: 0 };

async function connectionRoute() {
  if (!peerConnection) return null;
  try {
    const stats = await peerConnection.getStats();
    let pair = null;
    stats.forEach(report => {
      if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    });
    if (!pair) stats.forEach(report => {
      if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pair = report;
    });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const types = [local?.candidateType, remote?.candidateType];
    // host/prflx on both ends: packets go straight between the iPad and the PC on the school network.
    return { direct: types.every(type => type === "host" || type === "prflx"), relayed: types.includes("relay") };
  } catch {
    return null;
  }
}

function openIpadApps() {
  document.querySelector("#ipad-apps").hidden = false;
  ipadApps.retry = 0;
  refreshIpadApps();
}

function closeIpadApps() {
  document.querySelector("#ipad-apps").hidden = true;
  window.clearTimeout(ipadApps.timer);
}

async function refreshIpadApps() {
  ipadApps.route = await connectionRoute();
  if (controlChannel?.readyState === "open") sendControl({ type: "airplay-info" });
  else ipadApps.info = null;
  renderIpadApps();
}

function ipadAppsInfo(message) {
  ipadApps.info = message;
  renderIpadApps();
  // The PC checks Bluetooth and the firewall a few seconds after the receiver starts.
  if (message.checking && ipadApps.retry++ < 10 && !document.querySelector("#ipad-apps").hidden) {
    window.clearTimeout(ipadApps.timer);
    ipadApps.timer = window.setTimeout(refreshIpadApps, 2500);
  }
}

function checkLine(state, text) {
  const item = document.createElement("li");
  item.className = `check ${state}`;
  const mark = document.createElement("b");
  mark.textContent = { ok: "✓", bad: "✕", warn: "!", wait: "…" }[state];
  const span = document.createElement("span");
  span.textContent = text;
  item.append(mark, span);
  return item;
}

function renderIpadApps() {
  const info = ipadApps.info;
  const connected = controlChannel?.readyState === "open";
  const mac = info?.os === "macos" || (!info && hostPlatform === "macos");
  const name = info?.supported ? info.name : mac ? (info?.name || "this Mac") : "Classroom Bridge - <PC name>";
  document.querySelector("#ipad-apps-name").textContent = name;
  document.querySelector("#ipad-apps-pin-step").hidden = !info?.pin;
  document.querySelector("#ipad-apps-pin").textContent = info?.pin || "";
  document.querySelector("#ipad-apps-mac").hidden = !mac;

  const checks = document.querySelector("#ipad-apps-checks");
  checks.replaceChildren();
  if (!connected) {
    checks.append(checkLine("warn", "Connect to the PC first to check that iPad apps will work."));
    return;
  }
  if (!info) {
    checks.append(checkLine("wait", "Asking the PC…"));
  } else if (mac) {
    checks.append(checkLine("ok", "This Mac uses its own AirPlay Receiver (see the note above)."));
  } else if (!info.supported || !info.running) {
    checks.append(checkLine("bad", "The PC's AirPlay receiver isn't running. On the PC, choose Start in the Classroom Bridge window."));
  } else {
    checks.append(checkLine("ok", `The PC's receiver is running as "${info.name}".`));
    if (info.checking) checks.append(checkLine("wait", "Checking Bluetooth and the firewall…"));
    else {
      checks.append(info.bluetooth
        ? checkLine("ok", "Bluetooth beacon on: an iPad near the PC lists it even on a different Wi-Fi network.")
        : checkLine("warn", `No Bluetooth beacon: ${info.bluetoothProblem || "unavailable."} The iPad only finds the PC if the school Wi-Fi lets them see each other. Turning on the PC's Bluetooth (or adding a USB Bluetooth adapter) usually fixes "PC not in the list".`));
      if (info.firewall === "blocked") checks.append(checkLine("bad", "Windows Firewall blocks the receiver. School IT can install the Classroom Bridge MSI, which allows it."));
      else if (info.firewall === "missing") checks.append(checkLine("warn", "Windows Firewall hasn't allowed the receiver yet. Allow it if Windows asks on the PC, or ask IT to install the Classroom Bridge MSI."));
      else if (info.firewall === "allowed") checks.append(checkLine("ok", "Windows Firewall allows the receiver."));
    }
  }
  const route = ipadApps.route;
  if (route?.direct) checks.append(checkLine("ok", "The iPad and the PC reach each other directly on the school network."));
  else if (route) checks.append(checkLine("bad", "The iPad and the PC only reach each other through the internet: the school network keeps them apart, so mirroring can't connect even when the PC is listed. Ask IT to allow AirPlay from the iPads to this PC, as they do for the Apple TVs."));
}

function initIpadApps() {
  document.querySelector("#ipad-apps-open").addEventListener("click", openIpadApps);
  document.querySelector("#ipad-apps-close").addEventListener("click", closeIpadApps);
  document.querySelector("#ipad-apps-done").addEventListener("click", closeIpadApps);
  document.querySelector("#ipad-apps-recheck").addEventListener("click", () => {
    ipadApps.retry = 0;
    ipadApps.info = null;
    renderIpadApps();
    refreshIpadApps();
  });
}
