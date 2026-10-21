"""Automatic updates for MSI installs (Windows, per-machine in Program Files).

Teachers can't write to Program Files, so the in-app updater is off there. Instead the MSI registers a scheduled
task that runs `ClassroomBridge.exe --update-service` as the system account a few minutes after start-up and once a
day. It downloads the newest published MSI, checks its SHA-256 fingerprint, and installs it silently. It never
updates while the companion is open, so a lesson is never interrupted; a PC that is left on all day updates the
next time it starts.

IT can turn this off with AUTOUPDATE=0 when installing the MSI (or later by setting AutoUpdate to 0 under
HKLM\\Software\\Classroom Bridge).
"""

import ctypes
import datetime
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

import updater

TASK_NAME = "Classroom Bridge Updater"
MSI_NAME = "ClassroomBridge-Windows-x64.msi"
SETTINGS_KEY = r"Software\Classroom Bridge"
DOWNLOAD_PREFIX = "classroom-bridge-msi-"


def install_dir():
    return pathlib.Path(sys.executable).resolve().parent


def log(message):
    # Kept in the install folder: only administrators and the system account can write there.
    path = install_dir() / "update.log"
    try:
        if path.exists() and path.stat().st_size > 256_000:
            path.replace(path.with_suffix(".old.log"))
        with path.open("a", encoding="utf-8") as output:
            output.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}  {message}\n")
    except OSError:
        pass


def setting(name, default):
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, SETTINGS_KEY, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            return str(winreg.QueryValueEx(key, name)[0])
    except OSError:
        return default


# Scheduled task -------------------------------------------------------------------------------------------------------

def task_xml():
    executable = str(pathlib.Path(sys.executable).resolve()).replace("&", "&amp;").replace("<", "&lt;")
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keeps Classroom Bridge up to date. Installs updates only while the companion is closed.</Description></RegistrationInfo>
  <Triggers>
    <BootTrigger><Delay>PT3M</Delay></BootTrigger>
    <CalendarTrigger>
      <StartBoundary>2025-01-01T07:10:00</StartBoundary>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
      <RandomDelay>PT30M</RandomDelay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="System"><Exec><Command>{executable}</Command><Arguments>--update-service</Arguments></Exec></Actions>
</Task>
"""


def schtasks(*arguments):
    return subprocess.run(
        [os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "schtasks.exe"), *arguments],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )


def install_task():
    folder = pathlib.Path(tempfile.mkdtemp(prefix="classroom-bridge-task-"))
    try:
        definition = folder / "task.xml"
        definition.write_text(task_xml(), encoding="utf-16")
        result = schtasks("/Create", "/TN", TASK_NAME, "/XML", str(definition), "/F")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    log(f"Scheduled task registered (exit {result.returncode}). {result.stdout.strip()} {result.stderr.strip()}".strip())
    return result.returncode


def remove_task():
    """Run when the MSI is uninstalled (not upgraded): removes the task and the update logs."""
    schtasks("/Delete", "/TN", TASK_NAME, "/F")
    for path in install_dir().glob("update*.log"):
        try:
            path.unlink()
        except OSError:
            pass
    return 0


# Update ---------------------------------------------------------------------------------------------------------------

def companion_running():
    """True if a teacher has Classroom Bridge open (in any signed-in session)."""

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32), ("th32ProcessID", ctypes.c_uint32),
            ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", ctypes.c_uint32), ("cntThreads", ctypes.c_uint32),
            ("th32ParentProcessID", ctypes.c_uint32), ("pcPriClassBase", ctypes.c_long), ("dwFlags", ctypes.c_uint32),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        return False
    ourselves = {os.getpid(), os.getppid()}  # A one-file app runs as two processes: launcher and Python.
    entry = ProcessEntry()
    entry.dwSize = ctypes.sizeof(ProcessEntry)
    running = False
    try:
        more = kernel32.Process32FirstW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
        while more:
            if entry.szExeFile.lower() == "classroombridge.exe" and entry.th32ProcessID not in ourselves and entry.th32ParentProcessID not in ourselves:
                running = True
                break
            more = kernel32.Process32NextW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(snapshot))
    return running


def newest_msi():
    # At start-up the network can take a few minutes to come up.
    for attempt in range(10):
        try:
            return updater.newest_release(MSI_NAME)
        except Exception as error:
            if attempt == 9:
                raise
            log(f"Could not reach the downloads page ({error}); trying again in a minute.")
            time.sleep(60)
    return None


def remove_old_downloads():
    for folder in pathlib.Path(tempfile.gettempdir()).glob(DOWNLOAD_PREFIX + "*"):
        if time.time() - folder.stat().st_mtime > 3600:
            shutil.rmtree(folder, ignore_errors=True)


def start_msi_install(msi):
    """Starts msiexec on its own and returns at once, so this app's files are free to be replaced."""
    arguments = [
        os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "msiexec.exe"),
        "/i", str(msi), "/qn", "/norestart", "/l*v", str(install_dir() / "update-install.log"),
        f"AUTOSTART={'0' if setting('AutoStart', '1') == '0' else '1'}", "AUTOUPDATE=1",
    ]
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        subprocess.Popen(arguments, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
    except OSError:
        subprocess.Popen(arguments, creationflags=flags, close_fds=True)


def update(from_file=None):
    if setting("AutoUpdate", "1") == "0":
        log("Automatic updates are turned off (AutoUpdate = 0).")
        return 0
    if companion_running():
        log("Classroom Bridge is open, so the update check waits for the next start-up.")
        return 0
    remove_old_downloads()
    if from_file:
        msi = pathlib.Path(from_file)
        log(f"Installing {msi}.")
    else:
        release = newest_msi()
        current = updater.current_version()
        if not release or release["version"] <= current:
            log(f"Up to date (this build {current}, newest {release['version'] if release else 'none'}).")
            return 0
        log(f"Downloading {release['title']} (build {release['version']}; this build {current}).")
        # mkdtemp under the system account's temp folder: other accounts can't change the file before msiexec reads it.
        folder, msi = updater.download(release, lambda share: None, folder=tempfile.mkdtemp(prefix=DOWNLOAD_PREFIX))
        log("Download verified against the published SHA-256 fingerprint. Installing.")
    start_msi_install(msi)
    return 0


def main(arguments):
    try:
        if "--install-updater" in arguments:
            return install_task()
        if "--remove-updater" in arguments:
            return remove_task()
        from_file = arguments[arguments.index("--from-file") + 1] if "--from-file" in arguments else None
        return update(from_file)
    except Exception as error:
        log(f"Update failed: {type(error).__name__}: {error}")
        return 1
