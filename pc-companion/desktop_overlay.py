import sys


class DesktopInkOverlay:
    def __init__(self, root, width, height):
        self.width = width
        self.height = height
        self.strokes = []
        self.active_stroke = None
        self.visible = False
        if sys.platform == "darwin":
            self._init_macos()
        elif sys.platform == "win32":
            self._init_windows(root)
        else:
            raise RuntimeError("Desktop ink overlay is supported on macOS and Windows.")

    def _init_windows(self, root):
        import ctypes
        import tkinter as tk

        self.tk = tk
        self.window = tk.Toplevel(root)
        self.window.overrideredirect(True)
        self.window.geometry(f"{self.width}x{self.height}+0+0")
        self.window.configure(bg="#010203")
        self.window.wm_attributes("-topmost", True)
        self.window.wm_attributes("-transparentcolor", "#010203")
        self.canvas = tk.Canvas(self.window, width=self.width, height=self.height, bg="#010203", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.window.withdraw()
        self.window.update_idletasks()
        window_handle = self.window.winfo_id()
        get_window_long = ctypes.windll.user32.GetWindowLongW
        get_window_long.restype = ctypes.c_long
        style = get_window_long(window_handle, -20)
        ctypes.windll.user32.SetWindowLongW(window_handle, -20, style | 0x00080000 | 0x00000020 | 0x00000080)

    def _init_macos(self):
        import AppKit

        self.appkit = AppKit
        screen = AppKit.NSScreen.mainScreen()
        frame = screen.frame()
        self.width = int(frame.size.width)
        self.height = int(frame.size.height)

        overlay = self

        class InkView(AppKit.NSView):
            def drawRect_(view, rect):
                AppKit.NSColor.clearColor().set()
                AppKit.NSBezierPath.bezierPath().fill()
                for stroke in overlay.strokes:
                    points = stroke["points"]
                    if not points:
                        continue
                    red, green, blue = overlay._color(stroke["color"])
                    AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(red, green, blue, 1).set()
                    path = AppKit.NSBezierPath.bezierPath()
                    path.setLineCapStyle_(AppKit.NSRoundLineCapStyle)
                    path.setLineJoinStyle_(AppKit.NSRoundLineJoinStyle)
                    path.setLineWidth_(stroke["width"])
                    path.moveToPoint_(overlay._point(points[0]))
                    for point in points[1:]:
                        path.lineToPoint_(overlay._point(point))
                    path.stroke()

        self.window = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            frame, AppKit.NSWindowStyleMaskBorderless, AppKit.NSBackingStoreBuffered, False
        )
        self.window.setOpaque_(False)
        self.window.setBackgroundColor_(AppKit.NSColor.clearColor())
        self.window.setIgnoresMouseEvents_(True)
        self.window.setHasShadow_(False)
        self.window.setLevel_(AppKit.NSFloatingWindowLevel)
        self.window.setCollectionBehavior_(AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary)
        self.view = InkView.alloc().initWithFrame_(frame)
        self.window.setContentView_(self.view)
        self.window.orderOut_(None)

    def _color(self, value):
        value = value.lstrip("#")
        return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))

    def _point(self, point):
        return self.appkit.NSMakePoint(point[0] * self.width, (1 - point[1]) * self.height)

    def apply(self, command):
        kind = command.get("type")
        if kind == "ink-start":
            self.active_stroke = {
                "color": command.get("color", "#ff4b6e"),
                "width": max(1, min(80, float(command.get("width", 4)))),
                "points": [(float(command.get("x", 0)), float(command.get("y", 0)))],
            }
            self.strokes.append(self.active_stroke)
            self._show()
        elif kind == "ink-move" and self.active_stroke is not None:
            self.active_stroke["points"].append((float(command.get("x", 0)), float(command.get("y", 0))))
            self._redraw()
        elif kind == "ink-end":
            self.active_stroke = None
            self._redraw()
        elif kind == "ink-clear":
            self.strokes.clear()
            self.active_stroke = None
            self._redraw()

    def _show(self):
        if not self.visible:
            self.visible = True
            if sys.platform == "darwin":
                self.window.orderFrontRegardless()
            else:
                self.window.deiconify()
                self.window.lift()
        self._redraw()

    def _redraw(self):
        if sys.platform == "darwin":
            self.view.setNeedsDisplay_(True)
        else:
            self.canvas.delete("ink")
            for stroke in self.strokes:
                points = stroke["points"]
                if len(points) < 2:
                    continue
                coords = [coordinate for point in points for coordinate in (point[0] * self.width, point[1] * self.height)]
                self.canvas.create_line(*coords, fill=stroke["color"], width=stroke["width"], capstyle="round", joinstyle="round", smooth=True, tags="ink")

    def close(self):
        if sys.platform == "darwin":
            self.window.orderOut_(None)
            self.window.close()
        else:
            self.window.destroy()
        self.visible = False
