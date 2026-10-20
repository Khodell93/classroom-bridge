import asyncio
import ctypes
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import ttk

import pyautogui

from agent import get_or_create_pairing_code, run
from airplay import AirPlayReceiver, get_or_create_pin, receiver_name
from desktop_overlay import DesktopInkOverlay
from presenter import CameraPresenter


SIGNAL_URL = "wss://classroom-bridge.nathan-sant.workers.dev"


class CompanionWindow:
    def __init__(self, root):
        self.root = root
        platform_name = "Mac" if sys.platform == "darwin" else "PC"
        self.root.title(f"Classroom Bridge {platform_name} Companion")
        self.root.geometry("520x520" if sys.platform == "darwin" else "500x450")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.messages = queue.Queue()
        self.ink_commands = queue.SimpleQueue()
        self.ink_schedule_lock = threading.Lock()
        self.ink_drain_scheduled = False
        self.stop_event = threading.Event()
        self.worker = None
        self.overlay = None
        self.presenter = CameraPresenter(root)
        self.airplay_messages = queue.Queue()
        self.airplay = AirPlayReceiver(self.airplay_messages.put)
        self.airplay_status = tk.StringVar(value="")
        self.code = tk.StringVar(value="— — — — — — — — — — — —")
        self.status = tk.StringVar(value="Ready to start")

        frame = ttk.Frame(root, padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Classroom Bridge", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Keep this window open while using the iPad controller.", wraplength=440).pack(anchor="w", pady=(6, 18))
        if sys.platform == "darwin":
            ttk.Label(frame, text="First use: allow Screen Recording and Accessibility in System Settings → Privacy & Security, then restart. For iPad pinch-to-zoom on this Mac's display, enable Accessibility → Zoom → Use keyboard shortcuts to zoom.", wraplength=460).pack(anchor="w", pady=(0, 10))
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
        ttk.Label(frame, text="IPAD APPS (ONEDRIVE, POWERPOINT…)", font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(14, 4))
        if self.airplay.supported:
            ttk.Label(frame, text=f"Screen Mirroring name: {receiver_name()}    First-time PIN: {get_or_create_pin()}", wraplength=440).pack(anchor="w")
            self.airplay_status.set("Starts with the companion. Windows may ask once to allow it through the firewall.")
        else:
            self.airplay_status.set("Turn on System Settings → General → AirDrop & Handoff → AirPlay Receiver, then on the iPad choose Control Centre → Screen Mirroring → this Mac.")
        ttk.Label(frame, textvariable=self.airplay_status, wraplength=440).pack(anchor="w")
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
        try:
            screen_width, screen_height = pyautogui.size()
            self.overlay = DesktopInkOverlay(self.root, screen_width, screen_height)
        except Exception as error:
            self.status.set(f"Could not prepare the desktop annotation overlay: {error}")
            return
        pairing_code = get_or_create_pairing_code()
        self.code.set(" ".join(pairing_code))
        self.status.set("Starting companion…")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.copy_button.configure(state="normal")
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self.run_companion, args=(pairing_code, self.stop_event), daemon=True)
        self.worker.start()
        self.airplay.start()

    def run_companion(self, pairing_code, stop_event):
        try:
            asyncio.run(run(SIGNAL_URL, pairing_code, self.messages.put, stop_event, self.queue_ink_command, self.presenter.handle))
        except Exception as error:
            self.messages.put(f"Could not start: {error}")

    def stop(self):
        self.stop_event.set()
        self.airplay.stop()
        self.close_overlay()
        self.stop_button.configure(state="disabled")
        self.status.set("Stopping companion…")

    def queue_ink_command(self, command):
        self.ink_commands.put(command)
        with self.ink_schedule_lock:
            if self.ink_drain_scheduled:
                return
            self.ink_drain_scheduled = True
        try:
            self.root.after(0, self.drain_ink_commands)
        except tk.TclError:
            with self.ink_schedule_lock:
                self.ink_drain_scheduled = False

    def drain_ink_commands(self):
        while True:
            while True:
                try:
                    command = self.ink_commands.get_nowait()
                except queue.Empty:
                    break
                if self.overlay is not None:
                    self.overlay.apply(command)
            with self.ink_schedule_lock:
                if self.ink_commands.empty():
                    self.ink_drain_scheduled = False
                    return

    def close_overlay(self):
        if self.overlay is not None:
            try:
                self.overlay.close()
            except Exception:
                pass
            self.overlay = None

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
        try:
            while True:
                self.airplay_status.set(self.airplay_messages.get_nowait())
        except queue.Empty:
            pass
        if self.worker and not self.worker.is_alive():
            self.airplay.stop()
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
            self.close_overlay()
            self.presenter.hide()
        self.root.after(100, self.poll_messages)

    def close(self):
        self.stop_event.set()
        self.airplay.stop()
        self.close_overlay()
        self.root.destroy()

    def open_privacy(self, section):
        subprocess.Popen(["open", f"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{section}"])


def main():
    root = tk.Tk()
    CompanionWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
