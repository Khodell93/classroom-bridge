import asyncio
import ctypes
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk

import pyautogui
import qrcode
from PIL import Image, ImageTk

import startup
import updater
from agent import get_or_create_pairing_code, run
from airplay import AirPlayReceiver, get_or_create_pin, receiver_name
from desktop_overlay import DesktopInkOverlay
from presenter import CameraPresenter


SIGNAL_URL = "wss://classroom-bridge.nathan-sant.workers.dev"
APP_URL = "https://classroom-bridge.nathan-sant.workers.dev"
ASSETS = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).parent)) / "assets"


def pairing_qr(code, size=176):
    """A QR code the iPad scans in Classroom Bridge (or with the Camera app) to pair without typing."""
    image = qrcode.make(f"{APP_URL}/#pair={code}", box_size=8, border=2).convert("RGB")
    return image.resize((size, size), Image.Resampling.NEAREST)


class CompanionWindow:
    def __init__(self, root, background=False):
        self.root = root
        platform_name = "Mac" if sys.platform == "darwin" else "PC"
        self.root.title(f"Classroom Bridge {platform_name} Companion")
        self.root.geometry("560x620" if sys.platform == "darwin" else "540x560")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.messages = queue.Queue()
        self.ink_commands = queue.SimpleQueue()
        self.ink_schedule_lock = threading.Lock()
        self.ink_drain_scheduled = False
        self.stop_event = threading.Event()
        self.worker = None
        self.overlay = None
        self.tray = None
        self.tray_messages = queue.Queue()
        self.told_about_tray = False
        self.presenter = CameraPresenter(root)
        self.airplay_messages = queue.Queue()
        self.airplay = AirPlayReceiver(self.airplay_messages.put)
        self.airplay_status = tk.StringVar(value="")
        self.update_messages = queue.Queue()
        self.available_update = None
        self.pairing_code = get_or_create_pairing_code()
        self.code = tk.StringVar(value=" ".join(self.pairing_code))
        self.status = tk.StringVar(value="Starting…")
        self.autostart = tk.BooleanVar(value=startup.is_enabled())
        self.set_window_icon()

        frame = ttk.Frame(root, padding=22)
        frame.pack(fill="both", expand=True)
        header = ttk.Frame(frame)
        header.pack(fill="x")
        try:
            self.logo = ImageTk.PhotoImage(Image.open(ASSETS / "icon-64.png").resize((44, 44), Image.Resampling.LANCZOS))
            ttk.Label(header, image=self.logo).pack(side="left", padx=(0, 12))
        except OSError:
            self.logo = None
        titles = ttk.Frame(header)
        titles.pack(side="left", fill="x")
        ttk.Label(titles, text="Classroom Bridge", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(titles, textvariable=self.status, wraplength=430, foreground="#35506f").pack(anchor="w")

        if sys.platform == "darwin":
            ttk.Label(frame, text="First use: allow Screen Recording and Accessibility in System Settings → Privacy & Security, then restart. For iPad pinch-to-zoom on this Mac's display, enable Accessibility → Zoom → Use keyboard shortcuts to zoom.", wraplength=500).pack(anchor="w", pady=(14, 6))
            permissions = ttk.Frame(frame)
            permissions.pack(anchor="w")
            ttk.Button(permissions, text="Screen Recording settings", command=lambda: self.open_privacy("ScreenCapture")).pack(side="left", padx=(0, 8))
            ttk.Button(permissions, text="Accessibility settings", command=lambda: self.open_privacy("Accessibility")).pack(side="left")

        pairing = ttk.Frame(frame)
        pairing.pack(fill="x", pady=(18, 6))
        self.qr_image = ImageTk.PhotoImage(pairing_qr(self.pairing_code))
        ttk.Label(pairing, image=self.qr_image).pack(side="left", padx=(0, 18))
        details = ttk.Frame(pairing)
        details.pack(side="left", fill="both", expand=True)
        ttk.Label(details, text="PAIR THE IPAD", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        ttk.Label(details, text="In Classroom Bridge on the iPad, tap ⚙ → Scan QR code and point it at this code. Or type:", wraplength=300).pack(anchor="w", pady=(4, 8))
        ttk.Label(details, textvariable=self.code, font=("Consolas", 17, "bold")).pack(anchor="w")
        ttk.Button(details, text="Copy code", command=self.copy_code).pack(anchor="w", pady=(8, 0))

        ttk.Separator(frame).pack(fill="x", pady=14)
        ttk.Label(frame, text="IPAD APPS (ONEDRIVE, POWERPOINT…)", font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(0, 4))
        if self.airplay.supported:
            ttk.Label(frame, text=f"Screen Mirroring name: {receiver_name()}    First-time PIN: {get_or_create_pin()}", wraplength=500).pack(anchor="w")
            self.airplay_status.set("Starts with the companion. Windows may ask once to allow it through the firewall.")
        else:
            self.airplay_status.set("Turn on System Settings → General → AirDrop & Handoff → AirPlay Receiver, then on the iPad choose Control Centre → Screen Mirroring → this Mac.")
        ttk.Label(frame, textvariable=self.airplay_status, wraplength=500).pack(anchor="w")

        ttk.Separator(frame).pack(fill="x", pady=14)
        if startup.supported():
            if startup.managed_by_it():
                ttk.Label(frame, text="Opens automatically when you sign in (set up by your IT department).").pack(anchor="w")
            else:
                ttk.Checkbutton(frame, text="Open automatically when I sign in, ready in the background", variable=self.autostart, command=self.toggle_autostart).pack(anchor="w")
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(14, 0))
        self.start_button = ttk.Button(buttons, text="Start", command=self.start)
        self.start_button.pack(side="left")
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))
        self.update_button = ttk.Button(buttons, text="Update", command=self.start_update)
        ttk.Button(buttons, text="Quit", command=self.quit_app).pack(side="right")
        ttk.Button(buttons, text="Hide window", command=self.hide_window).pack(side="right", padx=(0, 8))

        if sys.platform == "darwin":
            # Closing the window keeps the companion running; clicking the Dock icon brings it back; ⌘Q quits.
            self.root.createcommand("::tk::mac::ReopenApplication", self.show_window)
            self.root.createcommand("::tk::mac::Quit", self.quit_app)
        self.start_tray()
        threading.Thread(target=self.check_for_update, daemon=True).start()
        self.root.after(100, self.poll_messages)
        self.root.after(300, self.start)
        if background:
            self.root.after(800, self.hide_window)

    # Window, tray and sign-in ----------------------------------------------------------------------------------------

    def set_window_icon(self):
        try:
            if sys.platform == "win32":
                self.root.iconbitmap(default=str(ASSETS / "app.ico"))
            self.window_icon = ImageTk.PhotoImage(Image.open(ASSETS / "icon-256.png"))
            self.root.iconphoto(True, self.window_icon)
        except (OSError, tk.TclError):
            pass

    def start_tray(self):
        if sys.platform != "win32":
            return
        try:
            import pystray

            menu = pystray.Menu(
                pystray.MenuItem("Open Classroom Bridge", lambda: self.tray_messages.put("open"), default=True),
                pystray.MenuItem("Quit", lambda: self.tray_messages.put("quit")),
            )
            self.tray = pystray.Icon("ClassroomBridge", Image.open(ASSETS / "icon-64.png"), "Classroom Bridge", menu)
            self.tray.run_detached()
        except Exception:
            self.tray = None

    def hide_window(self):
        if sys.platform == "win32" and self.tray is None:
            self.root.iconify()
            return
        self.root.withdraw()
        if self.tray is not None and not self.told_about_tray:
            self.told_about_tray = True
            try:
                self.tray.notify("Classroom Bridge is still running. Open it from the tray icon near the clock.", "Classroom Bridge")
            except Exception:
                pass

    def show_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def toggle_autostart(self):
        try:
            startup.set_enabled(self.autostart.get())
        except OSError as error:
            self.status.set(f"Couldn't change the sign-in setting: {error}")
            self.autostart.set(startup.is_enabled())

    # Companion -------------------------------------------------------------------------------------------------------

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
                    self.show_window()
                    return
            except (AttributeError, OSError):
                self.status.set("Could not check macOS Accessibility permission. Enable it in System Settings → Privacy & Security → Accessibility, then restart this app.")
                self.show_window()
                return
        try:
            screen_width, screen_height = pyautogui.size()
            self.overlay = DesktopInkOverlay(self.root, screen_width, screen_height)
        except Exception as error:
            self.status.set(f"Could not prepare the desktop annotation overlay: {error}")
            return
        self.status.set("Starting companion…")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self.run_companion, args=(self.pairing_code, self.stop_event), daemon=True)
        self.worker.start()
        self.airplay.start()

    def run_companion(self, pairing_code, stop_event):
        """Keeps the companion connected: after a network drop or a sleeping PC it reconnects by itself."""
        delay = 2
        while not stop_event.is_set():
            started = time.monotonic()
            problem = "Connection closed"
            try:
                asyncio.run(run(SIGNAL_URL, pairing_code, self.messages.put, stop_event, self.queue_ink_command, self.presenter.handle))
            except Exception as error:
                problem = f"No connection ({str(error)[:70] or type(error).__name__})"
            if stop_event.is_set():
                break
            if time.monotonic() - started > 60:
                delay = 2
            self.messages.put(f"{problem} — trying again in {delay} s…")
            stop_event.wait(delay)
            delay = min(30, delay * 2)
        self.messages.put("Stopped. Choose Start to connect again.")

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
        self.root.clipboard_append(self.pairing_code)
        self.status.set("Pairing code copied. Enter it on the iPad.")

    # Updates ---------------------------------------------------------------------------------------------------------

    def check_for_update(self):
        try:
            update = updater.find_update()
        except Exception:
            return  # Offline or GitHub unavailable; the companion works without updates.
        if update:
            self.update_messages.put(("available", update))

    def start_update(self):
        update = self.available_update
        if not update:
            return
        self.stop_event.set()
        self.airplay.stop()
        self.close_overlay()
        self.presenter.hide()
        for button in (self.start_button, self.stop_button, self.update_button):
            button.configure(state="disabled")
        self.status.set("Downloading the update…")

        def work():
            try:
                folder, archive = updater.download(update, lambda share: self.update_messages.put(("progress", share)))
                updater.install_and_restart(folder, archive)
                self.update_messages.put(("restart", None))
            except Exception as error:
                self.update_messages.put(("failed", str(error)))

        threading.Thread(target=work, daemon=True).start()

    def handle_update_message(self, kind, value):
        if kind == "available":
            self.available_update = value
            self.update_button.configure(text=f"Update ({value['title']})")
            self.update_button.pack(side="left", padx=(8, 0))
        elif kind == "progress":
            self.status.set(f"Downloading the update… {int(value * 100)}%")
        elif kind == "restart":
            self.status.set("Installing the update — Classroom Bridge will reopen in a moment.")
            self.root.after(300, self.quit_for_update)
        elif kind == "failed":
            self.status.set(f"Update failed: {value}")
            self.start_button.configure(state="normal")
            self.update_button.configure(state="normal")

    def quit_for_update(self):
        self.quit_app()
        os._exit(0)

    # Main loop -------------------------------------------------------------------------------------------------------

    def poll_messages(self):
        for source, handle in ((self.messages, self.status.set), (self.airplay_messages, self.airplay_status.set)):
            try:
                while True:
                    handle(source.get_nowait())
            except queue.Empty:
                pass
        try:
            while True:
                self.handle_update_message(*self.update_messages.get_nowait())
        except queue.Empty:
            pass
        try:
            while True:
                action = self.tray_messages.get_nowait()
                if action == "open":
                    self.show_window()
                elif action == "quit":
                    self.quit_app()
                    return
        except queue.Empty:
            pass
        if self.worker and not self.worker.is_alive():
            self.worker = None
            self.airplay.stop()
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
            self.close_overlay()
            self.presenter.hide()
        self.root.after(100, self.poll_messages)

    def quit_app(self):
        self.stop_event.set()
        self.airplay.stop()
        self.close_overlay()
        if self.tray is not None:
            try:
                self.tray.stop()
            except Exception:
                pass
        self.root.destroy()

    def open_privacy(self, section):
        subprocess.Popen(["open", f"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{section}"])


def main():
    startup.apply_first_run_default()
    root = tk.Tk()
    CompanionWindow(root, background="--background" in sys.argv)
    root.mainloop()


if __name__ == "__main__":
    main()
