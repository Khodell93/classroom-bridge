"""Opening the companion automatically when the teacher signs in to the computer.

Windows: a value under HKCU\\...\\Run (per user). If IT installed the MSI with auto-start, the per-machine HKLM value
is used instead and the teacher can't turn it off here. macOS: a LaunchAgent in ~/Library/LaunchAgents.
Both start the app with --background so it connects quietly and stays in the tray / Dock.
"""

import pathlib
import plistlib
import sys

from agent import settings_dir

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "ClassroomBridge"
AGENT_LABEL = "com.classroombridge.companion"


def supported():
    return getattr(sys, "frozen", False) and sys.platform in ("win32", "darwin")


def _app_path():
    executable = pathlib.Path(sys.executable).resolve()
    if sys.platform == "darwin":
        return executable.parents[2]  # .../ClassroomBridge.app
    return executable


def _agent_file():
    return pathlib.Path.home() / "Library" / "LaunchAgents" / f"{AGENT_LABEL}.plist"


def managed_by_it():
    """True when the MSI installed a machine-wide auto-start entry."""
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, RUN_KEY) as key:
            winreg.QueryValueEx(key, VALUE_NAME)
            return True
    except OSError:
        return False


def is_enabled():
    if not supported():
        return False
    if sys.platform == "win32":
        if managed_by_it():
            return True
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                winreg.QueryValueEx(key, VALUE_NAME)
                return True
        except OSError:
            return False
    return _agent_file().exists()


def set_enabled(enabled):
    if not supported() or managed_by_it():
        return
    if sys.platform == "win32":
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, f'"{_app_path()}" --background')
            else:
                try:
                    winreg.DeleteValue(key, VALUE_NAME)
                except OSError:
                    pass
    else:
        path = _agent_file()
        if enabled:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("wb") as handle:
                plistlib.dump({
                    "Label": AGENT_LABEL,
                    "ProgramArguments": ["/usr/bin/open", "-g", "-a", str(_app_path()), "--args", "--background"],
                    "RunAtLoad": True,
                }, handle)
        else:
            path.unlink(missing_ok=True)


def remove_user_entry():
    """The MSI starts the app for everyone; a teacher's own entry (often for an old downloaded copy) would start a
    second companion, so it is removed."""
    if sys.platform != "win32" or not managed_by_it():
        return
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, VALUE_NAME)
    except OSError:
        pass


def apply_first_run_default():
    """Turn auto-start on the first time the installed app runs; afterwards respect the teacher's choice."""
    marker = settings_dir() / "autostart-configured"
    if not supported() or marker.exists():
        return
    try:
        set_enabled(True)
        marker.write_text("1", encoding="ascii")
    except OSError:
        pass
