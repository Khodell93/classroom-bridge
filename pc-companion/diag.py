"""Diagnostic log: what the companion and the iPad did, so a teacher can reproduce a problem and send one file.

Written to <settings folder>/logs/classroom-bridge.log (Windows: %LOCALAPPDATA%\\ClassroomBridge\\logs), rotated at
2 MB with 3 old copies kept. The iPad sends its own events over the control channel ("log" messages) and they are
written into the same file, marked [ipad], so one file shows both sides in order.

Privacy: typed text, pasted or copied text, the pairing code and the AirPlay PIN are never written — only that
something was typed and how long it was.
"""

import logging
import logging.handlers
import platform
import sys
import threading

LOG_NAME = "classroom-bridge.log"
_configured = False


def log_dir():
    from agent import settings_dir

    folder = settings_dir() / "logs"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def log_path():
    return log_dir() / LOG_NAME


def setup():
    """Starts the log file and records crashes from any thread. Safe to call more than once."""
    global _configured
    if _configured:
        return
    _configured = True
    handler = logging.handlers.RotatingFileHandler(log_path(), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d %(levelname)-7s [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for noisy in ("aioice", "aiortc", "websockets", "PIL", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    log = logging.getLogger("app")
    try:
        import updater

        version = updater.current_version()
    except Exception:
        version = "unknown"
    log.info("==== Classroom Bridge companion starting: build %s, %s %s, Python %s, %s",
             version, platform.system(), platform.release(), platform.python_version(), sys.executable)

    def excepthook(kind, value, traceback):
        log.critical("Unhandled error", exc_info=(kind, value, traceback))

    def thread_excepthook(args):
        log.critical("Unhandled error in thread %s", args.thread.name if args.thread else "?",
                     exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook


def asyncio_exception_handler(loop, context):
    error = context.get("exception")
    logging.getLogger("async").error("%s", context.get("message", "Error in background task"),
                                     exc_info=(type(error), error, error.__traceback__) if error else None)


# Control messages that arrive many times a second: counted, not written one by one.
FREQUENT = {"move", "scroll", "ink-move", "ink-move-batch", "ink-live", "shape-live", "laser", "view-update"}
# Fields whose values must never reach the log (replaced by their length).
PRIVATE = {"text", "value", "code", "pin", "password"}


def describe(command):
    """A short, private-safe summary of a control message from the iPad."""
    parts = [str(command.get("type"))]
    for key, value in command.items():
        if key == "type":
            continue
        if key in PRIVATE:
            parts.append(f"{key}=<{len(str(value))} chars>")
        elif isinstance(value, (int, float, bool)) or (isinstance(value, str) and len(value) <= 40):
            parts.append(f"{key}={value!r}" if isinstance(value, str) else f"{key}={value}")
        elif isinstance(value, list) and len(value) <= 6 and all(isinstance(item, str) for item in value):
            parts.append(f"{key}={'+'.join(value)}")
        else:
            parts.append(f"{key}=…")
    return " ".join(parts)


class FrequentCounter:
    """Counts frequent messages and writes one summary line every few seconds."""

    def __init__(self, logger, interval=10.0):
        self.logger = logger
        self.interval = interval
        self.counts = {}
        self.lock = threading.Lock()
        self.last = None

    def add(self, kind, now):
        with self.lock:
            self.counts[kind] = self.counts.get(kind, 0) + 1
            if self.last is None:
                self.last = now
            if now - self.last >= self.interval:
                summary = ", ".join(f"{name}×{count}" for name, count in sorted(self.counts.items()))
                self.counts = {}
                self.last = now
                self.logger.info("frequent messages in the last %.0f s: %s", self.interval, summary)


def write_ipad_entries(entries):
    """Writes log entries forwarded by the iPad (a list of {t, c, m})."""
    log = logging.getLogger("ipad")
    if not isinstance(entries, list):
        return
    for entry in entries[:500]:
        if not isinstance(entry, dict):
            continue
        category = str(entry.get("c", ""))[:20]
        message = str(entry.get("m", ""))[:2000].replace("\n", " | ")
        stamp = str(entry.get("t", ""))[:30]
        level = logging.WARNING if category in ("error", "MARK") else logging.INFO
        log.log(level, "%s %s: %s", stamp, category, message)
