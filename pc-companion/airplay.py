"""Runs the bundled UxPlay AirPlay receiver so the iPad can mirror any app to this PC.

The teacher uses Control Centre → Screen Mirroring on the iPad, exactly as with an Apple TV.
Video is decoded locally and shown full-screen; nothing passes through Classroom Bridge's servers.
iPads find the receiver by mDNS on the same network segment, and by a Bluetooth LE beacon (airplay_beacon.py)
when the iPads' Wi-Fi is on a different segment from the PC, as is common in schools.
"""

import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import threading
import time

from agent import settings_dir
from airplay_beacon import Beacon, local_ipv4, receiver_port


def bundled_receiver_dir():
    # PyInstaller one-file builds run from a temporary folder; the receiver ships beside the .exe.
    base = pathlib.Path(sys.executable).parent if getattr(sys, "frozen", False) else pathlib.Path(__file__).parent
    return base / "airplay"


def receiver_name():
    # Plain ASCII: UxPlay on Windows reads its arguments in the ANSI code page.
    return f"Classroom Bridge - {socket.gethostname()}"


def get_or_create_pin():
    """A fixed per-PC PIN; each iPad enters it once, after which UxPlay's register remembers that iPad."""
    pin_path = settings_dir() / "airplay-pin.txt"
    try:
        pin = pin_path.read_text(encoding="ascii").strip()
        if len(pin) == 4 and pin.isdigit() and pin != "0000":
            return pin
    except OSError:
        pass
    pin = f"{secrets.randbelow(9999) + 1:04d}"
    pin_path.write_text(pin, encoding="ascii")
    return pin


def registry_file(folder):
    """GStreamer's plugin cache. One per install folder and version: a cache written by another copy (an old
    download, a previous version) can point at plugins that are no longer there, and then the receiver stops
    with "Required gstreamer plugin ... not found"."""
    import hashlib
    import updater

    key = hashlib.sha1(f"{folder}|{updater.current_version()}".encode()).hexdigest()[:12]
    current = settings_dir() / f"gstreamer-registry-{key}.bin"
    for old in settings_dir().glob("gstreamer-registry*.bin"):
        if old != current:
            try:
                old.unlink()
            except OSError:
                pass
    return current


def receiver_environment(folder):
    environment = dict(os.environ)
    environment.update({
        "PATH": f"{folder}{os.pathsep}{environment.get('PATH', '')}",
        "GST_PLUGIN_PATH": str(folder / "lib" / "gstreamer-1.0"),
        "GST_PLUGIN_SYSTEM_PATH_1_0": str(folder / "lib" / "gstreamer-1.0"),
        "GST_PLUGIN_SCANNER": str(folder / "libexec" / "gstreamer-1.0" / "gst-plugin-scanner.exe"),
        # Load plugins inside uxplay.exe, whose folder holds every DLL they need. The separate scanner lives in a
        # subfolder, so Windows could pick up different copies of shared DLLs from System32 first.
        "GST_REGISTRY_FORK": "no",
        "GST_REGISTRY_1_0": str(registry_file(folder)),
        "UXPLAYRC": str(settings_dir() / "uxplayrc-unused"),
    })
    return environment


def plugin_diagnostics(folder):
    """gst-inspect's own report on the video decoder plugin, for the log."""
    inspect = folder / "gst-inspect-1.0.exe"
    plugin = folder / "lib" / "gstreamer-1.0" / "libgstlibav.dll"
    lines = ["", "--- Diagnostics ---", f"libgstlibav.dll present: {plugin.exists()}"]
    if not inspect.exists():
        return lines
    try:
        result = subprocess.run(
            [str(inspect), str(plugin)], cwd=folder, env=receiver_environment(folder), capture_output=True,
            text=True, timeout=60, stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        lines += [line for line in (result.stdout + result.stderr).splitlines()[:40] if line.strip()]
    except (OSError, subprocess.TimeoutExpired) as error:
        lines.append(f"gst-inspect failed: {error}")
    return lines


class AirPlayReceiver:
    def __init__(self, notify):
        self.notify = notify
        self.process = None
        self.log_lines = []
        self.beacon = Beacon()
        self.ble_file = settings_dir() / "airplay-beacon.bin"
        self.discovery = {}
        self.wanted = False    # the companion wants the receiver running (restart it if it stops)
        self.failures = 0
        self.started_at = 0

    @property
    def supported(self):
        return sys.platform == "win32"

    def start(self):
        self.wanted = True
        if not self.supported or self.running:
            return
        folder = bundled_receiver_dir()
        executable = folder / "uxplay.exe"
        if not executable.exists():
            self.notify("iPad apps (AirPlay) is not included in this build.")
            return
        data = settings_dir()
        environment = receiver_environment(folder)
        arguments = [
            str(executable),
            "-n", receiver_name(), "-nh",
            "-pin", get_or_create_pin(), "-reg", str(data / "airplay-trusted-ipads.txt"),
            "-p",
            "-fs", "-vs", "d3d11videosink",
            "-ble", str(self.ble_file),
        ]
        try:
            self.ble_file.unlink(missing_ok=True)  # a stale file would advertise the previous run's port
        except OSError:
            pass
        try:
            self.process = subprocess.Popen(
                arguments,
                cwd=folder,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except OSError as error:
            self.notify(f"Could not start iPad apps (AirPlay): {error}")
            return
        self.started_at = time.monotonic()
        self.log_lines = []
        threading.Thread(target=self._read_output, args=(self.process,), daemon=True).start()
        self.notify(f"iPad apps starting — on the iPad: Control Centre → Screen Mirroring → {receiver_name()}.")
        threading.Thread(target=self._announce, args=(self.process, executable), daemon=True).start()

    def _announce(self, process, executable):
        """Starts the Bluetooth beacon once the receiver is listening, then reports how iPads can find this PC."""
        port = receiver_port(self.ble_file)
        if process is not self.process or not self.running:
            return
        address = local_ipv4()
        problem = self.beacon.start(address, port) if port else "The receiver didn't report its port."
        firewall = firewall_status(executable)
        lines = [f"Ready: on the iPad, Control Centre → Screen Mirroring → {receiver_name()}."]
        if problem:
            lines.append(f"Found by iPads on this PC's network only. {problem} If the PC isn't listed on the iPad, "
                         "turn on Bluetooth (or plug in a USB Bluetooth adapter), or ask IT to let this PC's AirPlay "
                         "through like the Apple TVs.")
        else:
            lines.append(f"Also found by Bluetooth: iPads near this PC see it even on a different Wi-Fi ({address}).")
        if firewall == "blocked":
            lines.append("Windows Firewall is blocking the receiver. Ask IT to install the Classroom Bridge MSI, "
                         "which adds the firewall rule, or to allow uxplay.exe.")
        elif firewall == "missing":
            lines.append("Windows Firewall has no rule for the receiver yet: allow it if Windows asks, or ask IT "
                         "to install the Classroom Bridge MSI.")
        self.discovery = {"address": address, "bluetooth": not problem, "bluetoothProblem": problem, "firewall": firewall}
        self.notify(" ".join(lines))

    def info(self):
        """What the iPad's "iPad apps" panel shows. The PIN is only sent to the paired iPad."""
        if not self.supported:
            return {"supported": False, "name": socket.gethostname()}
        return {"supported": True, "running": self.running, "name": receiver_name(), "pin": get_or_create_pin(),
                "checking": self.running and not self.discovery, **self.discovery}

    def _read_output(self, process):
        for raw in process.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self.log_lines = (self.log_lines + [line])[-200:]
                if "connection request from" in line:
                    device = line.split("connection request from", 1)[1].split(" with deviceID")[0].strip()
                    self.notify(f"{device} is connecting. If the iPad asks for a PIN, enter {get_or_create_pin()}.")
                elif "registered new client" in line:
                    self.notify("iPad paired: it won't need the PIN again on this PC.")
                elif "lost connection with client" in line:
                    self.notify("The iPad's mirroring connection dropped (network problem?). Start Screen Mirroring again.")
        process.wait()
        if process is not self.process:
            return  # stopped on purpose
        if any("required gstreamer plugin" in line.lower() for line in self.log_lines):
            # Usually a stale plugin cache; start again with a fresh one. Also record why Windows couldn't load it.
            self.log_lines += plugin_diagnostics(bundled_receiver_dir())
            registry_file(bundled_receiver_dir()).unlink(missing_ok=True)
        self.process = None
        self.beacon.stop()
        log_path = settings_dir() / "airplay-log.txt"
        try:
            log_path.write_text("\n".join(self.log_lines) + "\n", encoding="utf-8")
        except OSError:
            pass
        if time.monotonic() - self.started_at > 120:
            self.failures = 0
        self.failures += 1
        reason = explain_failure(self.log_lines, process.returncode)
        if self.wanted and self.failures <= 3:
            self.notify(f"iPad apps (AirPlay) stopped: {reason} Restarting it…")
            threading.Timer(3 * self.failures, self._restart).start()
        else:
            self.notify(f"iPad apps (AirPlay) keeps stopping: {reason} Details are in {log_path}.")

    def _restart(self):
        if self.wanted and not self.running:
            self.start()

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def stop(self):
        self.wanted = False
        self.beacon.stop()
        self.discovery = {}
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def firewall_status(program):
    """'allowed', 'blocked', 'missing' (no rule: Windows will ask) or 'unknown' for inbound connections to program."""
    if sys.platform != "win32":
        return "unknown"
    script = (
        f"$p = '{str(program).replace(chr(39), chr(39) * 2)}'; "
        "$rules = @(Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule "
        "-ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }); "
        "ConvertTo-Json -Compress @($rules | ForEach-Object { [string]$_.Action })"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        actions = json.loads(result.stdout.strip() or "[]")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return "unknown"
    actions = [actions] if isinstance(actions, str) else actions
    if "Block" in actions:
        return "blocked"
    if "Allow" in actions:
        return "allowed"
    return "missing"


def explain_failure(lines, code):
    """A short, teacher-readable reason the receiver exited, from the end of its log."""
    text = "\n".join(lines[-40:]).lower()
    if any(sign in text for sign in ("error listening", "error initialising socket", "address already in use", "10048")):
        return ("another program is using the AirPlay ports (TCP 7000, 7001, 7100). Close other AirPlay receivers "
                "or other copies of Classroom Bridge, or restart the PC.")
    if "required gstreamer plugin" in text:
        return "its video player couldn't load (a plugin cache problem, or security software blocking a file)."
    if "dnssd" in text or "dns-sd" in text:
        return "network discovery (mDNS) couldn't start on this PC."
    problem = next((line for line in reversed(lines) if any(word in line.lower() for word in ("error", "fail", "cannot", "could not"))), None)
    detail = (problem or (lines[-1] if lines else f"exit code {code}")).strip()
    return f"{detail[:160]}."
