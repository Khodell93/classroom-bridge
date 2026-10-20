import asyncio
import ctypes
import queue
import secrets
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import ttk

from agent import ROOM_ALPHABET, run


SIGNAL_URL = "wss://classroom-bridge.nathan-sant.workers.dev"


class CompanionWindow:
    def __init__(self, root):
        self.root = root
        platform_name = "Mac" if sys.platform == "darwin" else "PC"
        self.root.title(f"Classroom Bridge {platform_name} Companion")
        self.root.geometry("520x440" if sys.platform == "darwin" else "500x340")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.messages = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None
        self.code = tk.StringVar(value="— — — — — — — — — — — —")
        self.status = tk.StringVar(value="Ready to start")

        frame = ttk.Frame(root, padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Classroom Bridge", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Keep this window open while using the iPad controller.", wraplength=440).pack(anchor="w", pady=(6, 18))
        if sys.platform == "darwin":
            ttk.Label(frame, text="First use: allow Screen Recording and Accessibility in System Settings → Privacy & Security, then restart this app.", wraplength=460).pack(anchor="w", pady=(0, 10))
            permissions = ttk.Frame(frame)
            permissions.pack(anchor="w", pady=(0, 12))
            ttk.Button(permissions, text="Screen Recording settings", command=lambda: self.open_privacy("ScreenCapture")).pack(side="left", padx=(0, 8))
            ttk.Button(permissions, text="Accessibility settings", command=lambda: self.open_privacy("Accessibility")).pack(side="left")
        ttk.Label(frame, text="PAIRING CODE", font=("Segoe UI", 9, "bold")).pack(anchor="center")
        ttk.Label(frame, textvariable=self.code, font=("Consolas", 24, "bold")).pack(anchor="center", pady=(6, 10))
        self.copy_button = ttk.Button(frame, text="Copy code", command=self.copy_code, state="disabled")
        self.copy_button.pack(anchor="center")
        ttk.Separator(frame).pack(fill="x", pady=18)
        ttk.Label(frame, textvariable=self.status, wraplength=440).pack(anchor="w")
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(18, 0))
        self.start_button = ttk.Button(buttons, text="Start companion", command=self.start)
        self.start_button.pack(side="left")
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.pack(side="right")
        self.root.after(100, self.poll_messages)

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        if sys.platform == "darwin":
            try:
                application_services = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
                trusted = application_services.AXIsProcessTrusted
                trusted.restype = ctypes.c_bool
                if not trusted():
                    self.status.set("Allow Classroom Bridge under System Settings → Privacy & Security → Accessibility, then quit and reopen the app. Mouse and keyboard control need this permission.")
                    return
            except (AttributeError, OSError):
                self.status.set("Could not check macOS Accessibility permission. Enable it in System Settings → Privacy & Security → Accessibility, then restart this app.")
                return
        pairing_code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(12))
        self.code.set(" ".join(pairing_code))
        self.status.set("Starting companion…")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.copy_button.configure(state="normal")
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self.run_companion, args=(pairing_code, self.stop_event), daemon=True)
        self.worker.start()

    def run_companion(self, pairing_code, stop_event):
        try:
            asyncio.run(run(SIGNAL_URL, pairing_code, self.messages.put, stop_event))
        except Exception as error:
            self.messages.put(f"Could not start: {error}")

    def stop(self):
        self.stop_event.set()
        self.stop_button.configure(state="disabled")
        self.status.set("Stopping companion…")

    def copy_code(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.code.get().replace(" ", ""))
        self.status.set("Pairing code copied. Enter it on the iPad.")

    def poll_messages(self):
        try:
            while True:
                self.status.set(self.messages.get_nowait())
        except queue.Empty:
            pass
        if self.worker and not self.worker.is_alive():
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
        self.root.after(100, self.poll_messages)

    def close(self):
        self.stop_event.set()
        self.root.destroy()

    def open_privacy(self, section):
        subprocess.Popen(["open", f"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{section}"])


def main():
    root = tk.Tk()
    CompanionWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
