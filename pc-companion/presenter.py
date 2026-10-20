import threading
import tkinter as tk

from PIL import ImageTk


class CameraPresenter:
    """Full-screen window on the classroom display for the iPad camera (live) or a photo (still).

    Events arrive from the networking thread; only the newest image is kept and it is drawn on the Tk thread.
    Apple Pencil ink is drawn by the separate desktop overlay, which stays above this window.
    """

    def __init__(self, root):
        self.root = root
        self.window = None
        self.label = None
        self.photo = None
        self.mode = "pc"
        self.live_image = None
        self.still_image = None
        self.pending = None
        self.lock = threading.Lock()
        self.scheduled = False

    def handle(self, event):
        with self.lock:
            kind = event.get("type")
            if kind == "view":
                self.pending = ("view", event["mode"])
            elif kind == "camera-frame":
                self.live_image = event["image"]
                self.pending = self.pending or ("refresh", None)
            elif kind == "still":
                # A finished photo always takes over the display; the iPad pauses live video before sending one.
                self.still_image = event["image"]
                self.pending = ("view", "still")
            if self.scheduled or self.pending is None:
                return
            self.scheduled = True
        try:
            self.root.after(0, self.render)
        except (tk.TclError, RuntimeError):
            with self.lock:
                self.scheduled = False

    def render(self):
        with self.lock:
            action, value = self.pending or (None, None)
            self.pending = None
            self.scheduled = False
            if action == "view":
                self.mode = value
                if value != "live":
                    self.live_image = None
            image = self.live_image if self.mode == "live" else self.still_image if self.mode == "still" else None
            if self.mode == "live":
                self.live_image = None
        if self.mode == "pc":
            self.hide()
            return
        self.show()
        if image is None:
            return
        if self.photo is not None and (self.photo.width(), self.photo.height()) == image.size:
            self.photo.paste(image)
        else:
            self.photo = ImageTk.PhotoImage(image)
            self.label.configure(image=self.photo)

    def show(self):
        if self.window is not None:
            return
        self.window = tk.Toplevel(self.root)
        self.window.title("Classroom Bridge — Camera")
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
