"""One companion per Windows sign-in.

Two companions with the same pairing code knock each other off the signalling server every few seconds, so the
iPad never stays connected, and only one AirPlay receiver can hold the AirPlay ports. That happens easily: a teacher
who first used the downloaded ZIP (which starts at sign-in) and then got the MSI has both starting together.

- Opening the companion again while it runs brings the running one to the front instead (copies are told apart
  by their path, since an old copy predates this check).
- The MSI copy (Program Files) wins over downloaded copies: it closes them and their receivers.
- A downloaded copy opened while the MSI copy runs says so and closes.
- AirPlay receivers left behind by a companion that crashed are closed, so they can't block the ports.
"""

import ctypes
import os
import pathlib
import sys
from ctypes import wintypes

SHOW_EVENT_NAME = "Local\\ClassroomBridgeCompanionShow"
_show_event = None


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32), ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", ctypes.c_uint32), ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32), ("pcPriClassBase", ctypes.c_long), ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CreateEventW.restype = wintypes.HANDLE
    kernel32.OpenEventW.restype = wintypes.HANDLE
    return kernel32


def _processes(kernel32):
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)
    if not snapshot or snapshot == wintypes.HANDLE(-1).value:
        return []
    found = []
    entry = _ProcessEntry()
    entry.dwSize = ctypes.sizeof(_ProcessEntry)
    try:
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            found.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile.lower()))
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def _image_path(kernel32, pid):
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
    finally:
        kernel32.CloseHandle(handle)
    return None


def _session(kernel32, pid):
    session = wintypes.DWORD()
    return session.value if kernel32.ProcessIdToSessionId(pid, ctypes.byref(session)) else None


def _terminate(kernel32, pid):
    handle = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    if handle:
        kernel32.TerminateProcess(handle, 0)
        kernel32.CloseHandle(handle)


def _is_managed(path):
    folders = [os.environ.get(name, "") for name in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)")]
    return any(folder and str(path).lower().startswith(folder.lower()) for folder in folders)


def _message(text):
    ctypes.windll.user32.MessageBoxW(None, text, "Classroom Bridge", 0x40)


def claim():
    """Call before opening the window. Returns (keep_running, note); note says what was tidied up, if anything."""
    global _show_event
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return True, None
    kernel32 = _kernel32()
    ours = str(pathlib.Path(sys.executable).resolve()).lower()
    session = _session(kernel32, os.getpid())
    me = {os.getpid(), os.getppid()}  # a one-file app runs as two processes: launcher and Python
    processes = _processes(kernel32)
    companions = []
    for pid, parent, name in processes:
        if name == "classroombridge.exe" and pid not in me and parent not in me and _session(kernel32, pid) == session:
            companions.append((pid, (_image_path(kernel32, pid) or "").lower()))
    elsewhere = [path for _, path in companions if path != ours]
    if companions and not elsewhere:
        # This same app is already running: bring it to the front (older versions just keep running).
        event = kernel32.OpenEventW(0x0002, False, SHOW_EVENT_NAME)  # EVENT_MODIFY_STATE
        if event:
            kernel32.SetEvent(event)
            kernel32.CloseHandle(event)
        return False, None
    if companions and not _is_managed(ours) and any(_is_managed(path) for path in elsewhere):
        _message("Classroom Bridge is already running on this PC (installed by your IT department).\n\n"
                 "Open it from the icon near the clock. This downloaded copy isn't needed and can be deleted.")
        return False, None
    note = None
    if companions:
        # Another copy (e.g. an old download that starts at sign-in) is running: this one replaces it.
        for pid, _ in companions:
            _terminate(kernel32, pid)
        note = f"Closed another copy of Classroom Bridge ({sorted(set(elsewhere))[0]}) so only one runs."
    # Receivers left by a closed or crashed companion would hold the AirPlay ports.
    for pid, _, name in processes:
        if name == "uxplay.exe" and _session(kernel32, pid) == session:
            _terminate(kernel32, pid)
    _show_event = kernel32.CreateEventW(None, False, False, SHOW_EVENT_NAME)
    return True, note


def show_requested():
    """True (once) when another launch asked this companion to show its window."""
    if sys.platform != "win32" or not _show_event:
        return False
    return ctypes.windll.kernel32.WaitForSingleObject(wintypes.HANDLE(_show_event), 0) == 0
