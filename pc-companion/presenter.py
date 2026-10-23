import logging
import threading
import tkinter as tk

from PIL import ImageTk


class CameraPresenter:
    """Full-screen window on the classroom display for the visualiser (live camera or a photo, with annotations).

    Commands arrive from the networking thread; only the newest one is kept and it is drawn on the Tk thread:
    {"type": "show", "image": PIL.Image} | {"type": "pip", "image", "place"} | {"type": "blank"} |
    {"type": "hide"}. Picture-in-picture is a small always-on-top window over whatever the PC is showing, wherever the
    teacher put it on the iPad ("place": its centre as shares of the screen, or a corner from older iPads).
    """

    PIP_MARGIN = 24

    def __init__(self, root):
        self.root = root
        self.window = None
        self.label = None
        self.photo = None
        self.pip_window = None
        self.pip_label = None
        self.pip_photo = None
        self.pip_geometry = None
        self.pending = None
        self.lock = threading.Lock()
        self.scheduled = False
        self.logged_kind = None
        # While the iPad is screen-mirroring, the mirror shows the camera (better quality, with the app's tools),
        # so the camera window stays closed. The companion window sets this.
        self.mirror_active = lambda: False

    def handle(self, command):
        with self.lock:
            self.pending = command
            if self.scheduled:
                return
            self.scheduled = True
        try:
            self.root.after(0, self.render)
        except (tk.TclError, RuntimeError):
            with self.lock:
                self.scheduled = False

    def render(self):
        with self.lock:
            command, self.pending = self.pending, None
            self.scheduled = False
        if command is None:
            return
        kind = command.get("type")
        if kind != self.logged_kind:
            self.logged_kind = kind
            logging.getLogger("projector").info("projector window: %s", kind)
        if kind == "hide":
            self.hide()
            return
        if kind == "show" and self.mirror_active():
            self.hide_full()
            return
        if kind == "pip":
            self.hide_full()
            self.show_pip(command["image"], command.get("place", "br"))
            return
        self.hide_pip()
        self.show()
        if kind == "blank":
            self.photo = None
            self.label.configure(image="")
            return
        image = command["image"]
        if self.photo is not None and (self.photo.width(), self.photo.height()) == image.size:
            self.photo.paste(image)
        else:
            self.photo = ImageTk.PhotoImage(image)
            self.label.configure(image=self.photo)

    def show(self):
        if self.window is not None:
            return
        self.window = tk.Toplevel(self.root)
        self.window.title("Classroom Bridge — Visualiser")
        self.window.configure(bg="black", cursor="none")
        self.window.attributes("-fullscreen", True)
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self.label = tk.Label(self.window, bg="black", borderwidth=0, highlightthickness=0, cursor="none")
        self.label.pack(fill="both", expand=True)
        # Windows won't let a background app bring a new window to the front, so it is made topmost for a moment
        # (which always works) and then a normal window again: the PC's own mouse and Alt+Tab keep working.
        self.window.attributes("-topmost", True)
        self.window.lift()
        self.window.focus_force()
        self.window.after(400, lambda window=self.window: window.winfo_exists() and window.attributes("-topmost", False))
        # The pointer appears when the real mouse moves and hides again after 3 s; Esc closes the window.
        self.window.bind("<Motion>", self.pointer_moved)
        self.window.bind("<Escape>", lambda event: self.hide())
        self.pointer_timer = None

    def pointer_moved(self, event=None):
        if self.window is None:
            return
        for widget in (self.window, self.label):
            widget.configure(cursor="")
        if self.pointer_timer is not None:
            self.window.after_cancel(self.pointer_timer)
        self.pointer_timer = self.window.after(3000, self.hide_pointer)

    def hide_pointer(self):
        self.pointer_timer = None
        if self.window is not None:
            for widget in (self.window, self.label):
                widget.configure(cursor="none")

    def show_pip(self, image, place):
        if self.pip_window is None:
            self.pip_window = tk.Toplevel(self.root)
            self.pip_window.overrideredirect(True)
            self.pip_window.attributes("-topmost", True)
            self.pip_window.configure(bg="white")
            self.pip_label = tk.Label(self.pip_window, bg="black", borderwidth=0, highlightthickness=0)
            self.pip_label.pack(padx=3, pady=3)
        width, height = image.size
        screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        if isinstance(place, str):  # a corner
            x = self.PIP_MARGIN if place in ("tl", "bl") else screen_width - width - 6 - self.PIP_MARGIN
            y = self.PIP_MARGIN if place in ("tl", "tr") else screen_height - height - 6 - self.PIP_MARGIN
        else:  # the centre, kept fully on screen
            x = max(0, min(screen_width - width - 6, round(place[0] * screen_width - (width + 6) / 2)))
            y = max(0, min(screen_height - height - 6, round(place[1] * screen_height - (height + 6) / 2)))
        geometry = f"{width + 6}x{height + 6}+{x}+{y}"
        if geometry != self.pip_geometry:
            self.pip_window.geometry(geometry)
            self.pip_geometry = geometry
        if self.pip_photo is not None and (self.pip_photo.width(), self.pip_photo.height()) == image.size:
            self.pip_photo.paste(image)
        else:
            self.pip_photo = ImageTk.PhotoImage(image)
            self.pip_label.configure(image=self.pip_photo)
        self.pip_window.lift()

    def hide_pip(self):
        if self.pip_window is not None:
            try:
                self.pip_window.destroy()
            except tk.TclError:
                pass
        self.pip_window = None
        self.pip_label = None
        self.pip_photo = None
        self.pip_geometry = None

    def hide(self):
        self.hide_pip()
        self.hide_full()

    def hide_full(self):
        if self.window is not None:
            try:
                self.window.destroy()
            except tk.TclError:
                pass
        self.window = None
        self.label = None
        self.photo = None
