import asyncio
import logging
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

import single_instance
import diag
import startup
import updater
import visualiser
from agent import get_or_create_pairing_code, run, settings_dir
from airplay import AirPlayReceiver, get_or_create_pin, receiver_name
from desktop_overlay import DesktopInkOverlay
from presenter import CameraPresenter


SIGNAL_URL = "wss://classroom-bridge.nathan-sant.workers.dev"
APP_URL = "https://classroom-bridge.nathan-sant.workers.dev"
log = logging.getLogger("app")
ASSETS = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).parent)) / "assets"
UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
# An automatic update restarts the app, so it waits until no iPad is connected and either the app has only just
# opened or nobody has used the computer for a while.
UPDATE_AFTER_LAUNCH_S = 180
UPDATE_WHEN_IDLE_S = 20 * 60


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
        self.airplay.on_mirroring = lambda active: self.update_messages.put(("mirroring", active))
        self.presenter.mirror_active = lambda: self.airplay.mirroring
        self.last_mirror_check = 0
        self.airplay_status = tk.StringVar(value="")
        self.update_messages = queue.Queue()
        self.available_update = None
        self.updating = False
        self.auto_update_failed = False
        self.launched = time.monotonic()
        self.background = background
        self.ipad_connected = False
        self.auto_update = tk.BooleanVar(value=not (settings_dir() / "auto-update-off").exists())
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

        # Shown when a newer version is published.
        self.banner = tk.Frame(frame, background="#fff1c2", highlightbackground="#e0b84a", highlightthickness=1)
        self.banner_text = tk.Label(self.banner, background="#fff1c2", foreground="#4a3500", justify="left", wraplength=360, font=("Segoe UI", 10))
        self.banner_text.pack(side="left", fill="x", expand=True, padx=10, pady=8)
        self.update_button = ttk.Button(self.banner, text="Update now", command=self.update_now)
        self.update_button.pack(side="right", padx=10, pady=8)
        self.banner_anchor = header

        if sys.platform == "darwin":
            ttk.Label(frame, text="First use: allow Screen Recording and Accessibility in System Settings → Privacy & Security, then restart.", wraplength=500).pack(anchor="w", pady=(14, 6))
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
        if updater.managed_install():
            ttk.Label(frame, text="Updates install automatically when this PC starts (set up by the installer).").pack(anchor="w")
        elif getattr(sys, "frozen", False):
            ttk.Checkbutton(frame, text="Install updates automatically (when no iPad is connected)", variable=self.auto_update, command=self.toggle_auto_update).pack(anchor="w")
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(14, 0))
        self.start_button = ttk.Button(buttons, text="Start", command=self.start)
        self.start_button.pack(side="left")
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))
        ttk.Button(buttons, text="Quit", command=self.quit_app).pack(side="right")
        ttk.Button(buttons, text="Hide window", command=self.hide_window).pack(side="right", padx=(0, 8))
        ttk.Button(buttons, text="Show log", command=self.show_log).pack(side="right", padx=(0, 8))

        if sys.platform == "darwin":
            # Closing the window keeps the companion running; clicking the Dock icon brings it back; ⌘Q quits.
            self.root.createcommand("::tk::mac::ReopenApplication", self.show_window)
            self.root.createcommand("::tk::mac::Quit", self.quit_app)
        self.start_tray()
        self.schedule_update_check()
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
                asyncio.run(run(SIGNAL_URL, pairing_code, self.messages.put, stop_event, self.queue_ink_command, self.presenter.handle,
                                lambda connected: self.update_messages.put(("ipad", connected)), self.airplay.info,
                                lambda: self.airplay.mirroring))
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

    def schedule_update_check(self):
        threading.Thread(target=self.check_for_update, daemon=True).start()
        self.root.after(UPDATE_CHECK_MS, self.schedule_update_check)

    def toggle_auto_update(self):
        flag = settings_dir() / "auto-update-off"
        try:
            if self.auto_update.get():
                flag.unlink(missing_ok=True)
                self.root.after(1000, self.install_update_if_quiet)
            else:
                flag.write_text("Automatic updates are off. Delete this file (or tick the box in the app) to turn them on.\n", encoding="utf-8")
        except OSError as error:
            self.status.set(f"Couldn't change the update setting: {error}")

    def install_update_if_quiet(self):
        """Installs a waiting update automatically, but never while a teacher is using the companion."""
        if not self.available_update or self.available_update.get("managed") or not self.auto_update.get() or self.updating or self.auto_update_failed or self.ipad_connected:
            return
        if time.monotonic() - self.launched < UPDATE_AFTER_LAUNCH_S or updater.idle_seconds() >= UPDATE_WHEN_IDLE_S:
            self.start_update(automatic=True)

    def show_update_banner(self, update):
        text = f"A newer version of Classroom Bridge is available ({update['title'].removeprefix('Classroom Bridge – ')})."
        if update.get("managed"):
            import update_service

            if update_service.setting("AutoUpdate", "1") == "0":
                text += " Your IT department installs updates on this PC."
                self.update_button.pack_forget()
            else:
                text += " It installs by itself when this PC next starts, or choose Update now (about a minute)."
        else:
            text += " It installs by itself when no iPad is connected, or choose Update now."
        self.banner_text.configure(text=text)
        self.banner.pack(fill="x", pady=(12, 0), after=self.banner_anchor)
        # The window has a fixed size; make room for the banner.
        self.root.update_idletasks()
        self.root.geometry(f"{self.root.winfo_width()}x{self.root.winfo_reqheight()}")

    def update_now(self):
        if self.available_update and self.available_update.get("managed"):
            self.managed_update_now()
        else:
            self.start_update()

    def managed_update_now(self):
        """MSI install: the update runs as the system account through the installer's scheduled task."""
        import update_service

        self.update_button.configure(state="disabled")
        problem = update_service.request_update()
        if problem:
            self.status.set(f"Couldn't start the update ({problem[:90]}). It will install when this PC next starts.")
            self.update_button.configure(state="normal")
            return
        self.status.set("Updating — Classroom Bridge closes now and reopens in about a minute.")
        update_service.reopen_after_update()
        self.root.after(1500, self.quit_app)

    def check_for_update(self):
        try:
            update = updater.find_update()
        except Exception:
            return  # Offline or GitHub unavailable; the companion works without updates.
        if update:
            self.update_messages.put(("available", update))

    def start_update(self, automatic=False):
        update = self.available_update
        if not update or self.updating:
            return
        self.updating = True
        self.updating_automatically = automatic
        background = automatic and (self.background or not self.root.winfo_viewable())
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
                updater.install_and_restart(folder, archive, background)
                self.update_messages.put(("restart", None))
            except Exception as error:
                self.update_messages.put(("failed", str(error)))

        threading.Thread(target=work, daemon=True).start()

    def handle_update_message(self, kind, value):
        if kind != "progress":
            log.info("update/iPad event: %s %s", kind, value.get("title", "") if isinstance(value, dict) else value)
        if kind == "mirroring":
            if value and self.presenter.logged_kind == "show":
                self.presenter.hide_full()  # the mirror takes over the camera
            self.apply_mirror_visibility()
            return
        if kind == "ipad":
            self.ipad_connected = value
            if not value:
                self.root.after(5000, self.install_update_if_quiet)
        elif kind == "available":
            self.available_update = value
            self.show_update_banner(value)
            self.install_update_if_quiet()
        elif kind == "progress":
            self.status.set(f"Downloading the update… {int(value * 100)}%")
        elif kind == "restart":
            self.status.set("Installing the update — Classroom Bridge will reopen in a moment.")
            self.root.after(300, self.quit_for_update)
        elif kind == "failed":
            self.updating = False
            self.status.set(f"Update failed: {value}")
            self.start_button.configure(state="normal")
            self.update_button.configure(state="normal")
            if self.updating_automatically:
                # Don't keep retrying in the background; the Update button still works, and the companion carries on.
                self.auto_update_failed = True
                self.root.after(3000, self.start)

    def quit_for_update(self):
        self.quit_app()
        os._exit(0)

    # Main loop -------------------------------------------------------------------------------------------------------

    def poll_messages(self):
        for source, handle, name in ((self.messages, self.status.set, "status"), (self.airplay_messages, self.airplay_status.set, "airplay")):
            try:
                while True:
                    text = source.get_nowait()
                    logging.getLogger(name).info("%s", str(text).replace(get_or_create_pin(), "<PIN>"))
                    handle(text)
            except queue.Empty:
                pass
        try:
            while True:
                self.handle_update_message(*self.update_messages.get_nowait())
        except queue.Empty:
            pass
        if self.airplay.mirroring and time.monotonic() - self.last_mirror_check > 0.5:
            self.last_mirror_check = time.monotonic()
            self.apply_mirror_visibility()
        if single_instance.show_requested():
            self.show_window()
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
        if self.available_update and time.monotonic() - getattr(self, "last_quiet_check", 0) > 60:
            self.last_quiet_check = time.monotonic()
            self.install_update_if_quiet()
        self.root.after(100, self.poll_messages)

    def apply_mirror_visibility(self):
        """While the iPad mirrors, the projector shows the mirror when the teacher is in another iPad app or in
        Classroom Bridge's camera mode. In PC mode it shows the real desktop (the mirror would show the iPad showing
        the desktop: a hall of mirrors), and for Blank the black camera window covers the screen instead."""
        if not self.airplay.mirroring:
            return
        in_app = self.ipad_connected and visualiser.ipad_app_visible
        self.airplay.show_mirror(not in_app or visualiser.current_scene_mode in ("live", "photo", "hold"))

    def show_log(self):
        """Opens the log folder with the log file selected, so it can be attached to an email."""
        path = diag.log_path()
        log.info("teacher opened the log folder")
        for handler in logging.getLogger().handlers:
            handler.flush()
        try:
            if sys.platform == "win32":
                subprocess.Popen(["explorer", "/select,", str(path)])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", str(path)])
            self.status.set(f"The log is {path}. Send that file (and the older .log.1, .log.2 files if there are any).")
        except OSError as error:
            self.status.set(f"The log is {path} (couldn't open the folder: {error}).")

    def quit_app(self):
        log.info("companion quitting")
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
    keep_running, note = single_instance.claim()
    if not keep_running:
        return
    diag.setup()
    if note:
        log.info("%s", note)
    startup.remove_user_entry()
    startup.apply_first_run_default()
    root = tk.Tk()
    root.report_callback_exception = lambda kind, value, traceback: log.error("Error in the window", exc_info=(kind, value, traceback))
    window = CompanionWindow(root, background="--background" in sys.argv)
    if note:
        root.after(1500, lambda: window.status.set(note))
    root.mainloop()


if __name__ == "__main__":
    main()
