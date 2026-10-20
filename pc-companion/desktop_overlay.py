import sys


if sys.platform == "darwin":
    import AppKit

    class ClassroomBridgeDesktopInkOverlayView(AppKit.NSView):
        def drawRect_(view, rect):
            AppKit.NSColor.clearColor().set()
            AppKit.NSRectFillUsingOperation(view.bounds(), AppKit.NSCompositingOperationClear)
            view.overlay_image.drawInRect_fromRect_operation_fraction_(
                view.bounds(), AppKit.NSZeroRect, AppKit.NSCompositingOperationSourceOver, 1
            )


class DesktopInkOverlay:
    def __init__(self, root, width, height):
        self.width = width
        self.height = height
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
        self.image = AppKit.NSImage.alloc().initWithSize_(frame.size)

        self.window = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            frame, AppKit.NSWindowStyleMaskBorderless, AppKit.NSBackingStoreBuffered, False
        )
        self.window.setOpaque_(False)
        self.window.setBackgroundColor_(AppKit.NSColor.clearColor())
        self.window.setIgnoresMouseEvents_(True)
        self.window.setHasShadow_(False)
        self.window.setLevel_(AppKit.NSFloatingWindowLevel)
        self.window.setCollectionBehavior_(AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary)
        self.view = ClassroomBridgeDesktopInkOverlayView.alloc().initWithFrame_(frame)
        self.view.overlay_image = self.image
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
                "last": (float(command.get("x", 0)), float(command.get("y", 0))),
            }
            self._show()
        elif kind == "ink-move" and self.active_stroke is not None:
            point = (float(command.get("x", 0)), float(command.get("y", 0)))
            self._draw_segment(self.active_stroke, self.active_stroke["last"], point)
            self.active_stroke["last"] = point
        elif kind == "ink-move-batch" and self.active_stroke is not None:
            points = command.get("points")
            if isinstance(points, list):
                converted = []
                for point in points[:256]:
                    if not isinstance(point, dict):
                        continue
                    try:
                        converted.append((float(point["x"]), float(point["y"])))
                    except (KeyError, TypeError, ValueError):
                        continue
                if converted:
                    self._draw_segments(self.active_stroke, self.active_stroke["last"], converted)
                    self.active_stroke["last"] = converted[-1]
        elif kind == "ink-end":
            self.active_stroke = None
        elif kind == "ink-clear":
            self.active_stroke = None
            if sys.platform == "darwin":
                frame = self.window.frame()
                self.image = self.appkit.NSImage.alloc().initWithSize_(frame.size)
                self.view.overlay_image = self.image
                self.view.setNeedsDisplay_(True)
            else:
                self.canvas.delete("ink")

    def _show(self):
        if not self.visible:
            self.visible = True
            if sys.platform == "darwin":
                self.window.orderFrontRegardless()
            else:
                self.window.deiconify()
                self.window.lift()
        self.view.setNeedsDisplay_(True) if sys.platform == "darwin" else None

    def _draw_segment(self, stroke, start, end):
        self._draw_segments(stroke, start, [end])

    def _draw_segments(self, stroke, start, points):
        if sys.platform == "darwin":
            appkit = self.appkit
            self.image.lockFocus()
            red, green, blue = self._color(stroke["color"])
            appkit.NSColor.colorWithCalibratedRed_green_blue_alpha_(red, green, blue, 1).set()
            path = appkit.NSBezierPath.bezierPath()
            path.setLineCapStyle_(appkit.NSRoundLineCapStyle)
            path.setLineWidth_(stroke["width"])
            path.moveToPoint_(self._point(start))
            for point in points:
                path.lineToPoint_(self._point(point))
            path.stroke()
            self.image.unlockFocus()
            all_points = [start, *points]
            padding = stroke["width"] * 2
            x = min(point[0] for point in all_points) * self.width - padding
            y = (1 - max(point[1] for point in all_points)) * self.height - padding
            width = (max(point[0] for point in all_points) - min(point[0] for point in all_points)) * self.width + padding * 2
            height = (max(point[1] for point in all_points) - min(point[1] for point in all_points)) * self.height + padding * 2
            self.view.setNeedsDisplayInRect_(self.appkit.NSMakeRect(x, y, width, height))
        else:
            previous = start
            for point in points:
                self.canvas.create_line(
                    previous[0] * self.width,
                    previous[1] * self.height,
                    point[0] * self.width,
                    point[1] * self.height,
                    fill=stroke["color"],
                    width=stroke["width"],
                    capstyle="round",
                    tags="ink",
                )
                previous = point

    def close(self):
        if sys.platform == "darwin":
            self.window.orderOut_(None)
            self.window.close()
        else:
            self.window.destroy()
        self.visible = False
