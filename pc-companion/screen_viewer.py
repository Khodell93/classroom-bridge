import io
import threading
import time
import tkinter as tk

from PIL import Image, ImageTk


class IPadScreenViewer:
    """Full-screen window that shows the iPad's shared screen on the classroom display."""

    STALE_SECONDS = 6

    def __init__(self, root):
        self.root = root
        self.window = None
        self.label = None
        self.photo = None
        self.latest = None
        self.lock = threading.Lock()
        self.render_scheduled = False
        self.last_frame_at = 0.0

    def handle(self, event):
        """Called from the networking thread."""
        kind = event.get("type")
        if kind == "screen-frame":
            with self.lock:
                self.latest = event["jpeg"]
                if self.render_scheduled:
                    return
                self.render_scheduled = True
            try:
                self.root.after(0, self.render)
            except (tk.TclError, RuntimeError):
                with self.lock:
                    self.render_scheduled = False
        elif kind == "screen-stop":
            try:
                self.root.after(0, self.hide)
            except (tk.TclError, RuntimeError):
                pass

    def render(self):
        with self.lock:
            data, self.latest = self.latest, None
            self.render_scheduled = False
        if data is None:
            return
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except (OSError, ValueError):
            return
        self.show()
        width = max(self.window.winfo_width(), 1)
        height = max(self.window.winfo_height(), 1)
        scale = min(width / image.width, height / image.height)
        size = (max(int(image.width * scale), 1), max(int(image.height * scale), 1))
        self.photo = ImageTk.PhotoImage(image.resize(size, Image.Resampling.BILINEAR))
        self.label.configure(image=self.photo)
        self.last_frame_at = time.monotonic()

    def show(self):
        if self.window is not None:
            return
        self.window = tk.Toplevel(self.root)
        self.window.title("Classroom Bridge — iPad screen")
        self.window.configure(bg="black")
        self.window.attributes("-fullscreen", True)
        self.window.bind("<Escape>", lambda _event: self.hide())
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self.label = tk.Label(self.window, bg="black", borderwidth=0)
        self.label.pack(fill="both", expand=True)
        self.window.update_idletasks()
        self.root.after(1000, self.check_stale)

    def check_stale(self):
        if self.window is None:
            return
        if time.monotonic() - self.last_frame_at > self.STALE_SECONDS:
            self.hide()
        else:
            self.root.after(1000, self.check_stale)

    def hide(self):
        if self.window is not None:
            try:
                self.window.destroy()
            except tk.TclError:
                pass
        self.window = None
        self.label = None
        self.photo = None
