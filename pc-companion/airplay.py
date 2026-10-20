"""Runs the bundled UxPlay AirPlay receiver so the iPad can mirror any app to this PC.

The teacher uses Control Centre → Screen Mirroring on the iPad, exactly as with an Apple TV.
Video is decoded locally and shown full-screen; nothing passes through Classroom Bridge's servers.
"""

import os
import pathlib
import secrets
import socket
import subprocess
import sys
import threading

from agent import settings_dir


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


class AirPlayReceiver:
    def __init__(self, notify):
        self.notify = notify
        self.process = None
        self.log_lines = []

    @property
    def supported(self):
        return sys.platform == "win32"

    def start(self):
        if not self.supported or self.running:
            return
        folder = bundled_receiver_dir()
        executable = folder / "uxplay.exe"
        if not executable.exists():
            self.notify("iPad apps (AirPlay) is not included in this build.")
            return
        data = settings_dir()
        environment = dict(os.environ)
        environment.update({
            "PATH": f"{folder}{os.pathsep}{environment.get('PATH', '')}",
            "GST_PLUGIN_PATH": str(folder / "lib" / "gstreamer-1.0"),
            "GST_PLUGIN_SYSTEM_PATH_1_0": str(folder / "lib" / "gstreamer-1.0"),
            "GST_PLUGIN_SCANNER": str(folder / "libexec" / "gstreamer-1.0" / "gst-plugin-scanner.exe"),
            "GST_REGISTRY_1_0": str(data / "gstreamer-registry.bin"),
            "UXPLAYRC": str(data / "uxplayrc-unused"),
        })
        arguments = [
            str(executable),
            "-n", receiver_name(), "-nh",
            "-pin", get_or_create_pin(), "-reg", str(data / "airplay-trusted-ipads.txt"),
            "-p",
            "-fs", "-vs", "d3d11videosink",
        ]
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
        threading.Thread(target=self._read_output, args=(self.process,), daemon=True).start()
        self.notify(f"iPad apps ready — on the iPad open Control Centre → Screen Mirroring → {receiver_name()}.")

    def _read_output(self, process):
        for raw in process.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self.log_lines = (self.log_lines + [line])[-200:]
        process.wait()
        if process is self.process and process.returncode != 0:
            self.notify("iPad apps (AirPlay) stopped unexpectedly. Choose Stop, then Start companion to retry.")

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def stop(self):
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
