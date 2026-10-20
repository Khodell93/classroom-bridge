import threading
import tkinter as tk

from PIL import ImageTk


class CameraPresenter:
    """Full-screen window on the classroom display for the visualiser (live camera or a photo, with annotations).

    Commands arrive from the networking thread; only the newest one is kept and it is drawn on the Tk thread:
    {"type": "show", "image": PIL.Image} | {"type": "blank"} | {"type": "hide"}.
    """

    def __init__(self, root):
        self.root = root
        self.window = None
        self.label = None
        self.photo = None
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
        self.label = tk.Label(self.window, bg="black", borderwidth=0, highlightthickness=0)
        self.label.pack(fill="both", expand=True)
        self.window.lift()

    def hide(self):
        if self.window is not None:
            try:
                self.window.destroy()
            except tk.TclError:
                pass
        self.window = None
        self.label = None
        self.photo = None
