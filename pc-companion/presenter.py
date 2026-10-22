import threading
import tkinter as tk

from PIL import ImageTk


class CameraPresenter:
    """Full-screen window on the classroom display for the visualiser (live camera or a photo, with annotations).

    Commands arrive from the networking thread; only the newest one is kept and it is drawn on the Tk thread:
    {"type": "show", "image": PIL.Image} | {"type": "pip", "image", "corner"} | {"type": "blank"} | {"type": "hide"}.
    Picture-in-picture is a small always-on-top window in a corner, over whatever the PC is showing.
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
        if kind == "hide":
            self.hide()
            return
        if kind == "pip":
            self.hide_full()
            self.show_pip(command["image"], command.get("corner", "br"))
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
        # Always on top while it shows: Windows won't let a background app bring a new window to the front, so
        # the first time the camera opened it appeared behind the teacher's windows. The iPad closes it again.
        self.window.attributes("-topmost", True)
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self.label = tk.Label(self.window, bg="black", borderwidth=0, highlightthickness=0)
        self.label.pack(fill="both", expand=True)
        self.window.lift()
        self.window.focus_force()

    def show_pip(self, image, corner):
        if self.pip_window is None:
            self.pip_window = tk.Toplevel(self.root)
            self.pip_window.overrideredirect(True)
            self.pip_window.attributes("-topmost", True)
            self.pip_window.configure(bg="white")
            self.pip_label = tk.Label(self.pip_window, bg="black", borderwidth=0, highlightthickness=0)
            self.pip_label.pack(padx=3, pady=3)
        width, height = image.size
        screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        x = self.PIP_MARGIN if corner in ("tl", "bl") else screen_width - width - 6 - self.PIP_MARGIN
        y = self.PIP_MARGIN if corner in ("tl", "tr") else screen_height - height - 6 - self.PIP_MARGIN
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
