"""In-app updates from the public downloads repository's GitHub releases.

The private source repository's build workflows publish each build as a release named build-<commit time>.
The companion finds the newest release that has a download for this platform, verifies it, and swaps
itself in place using a small helper script that runs after the app quits.
"""

import hashlib
import json
import os
import pathlib
import platform
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

import certifi

RELEASES_URL = "https://api.github.com/repos/Khodell93/classroom-bridge-downloads/releases?per_page=15"
DOWNLOAD_PAGE = "https://github.com/Khodell93/classroom-bridge-downloads/releases/latest"


def current_version():
    base = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).parent))
    try:
        return int((base / "version.txt").read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        return 0


def asset_name():
    if sys.platform == "win32":
        return "ClassroomBridge-Windows-x64.zip"
    if sys.platform == "darwin":
        architecture = "Apple-Silicon-arm64" if platform.machine() == "arm64" else "Intel-x64"
        return f"ClassroomBridge-macOS-{architecture}.zip"
    return None


def _open(url, accept="application/vnd.github+json"):
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "ClassroomBridge-Companion"})
    return urllib.request.urlopen(request, timeout=30, context=ssl.create_default_context(cafile=certifi.where()))


def find_update():
    """Returns the newest release download for this platform if it is newer than this app, else None."""
    name = asset_name()
    if not name or not getattr(sys, "frozen", False):
        return None
    with _open(RELEASES_URL) as response:
        releases = json.load(response)
    best = None
    for release in releases:
        tag = str(release.get("tag_name", ""))
        if release.get("draft") or not tag.startswith("build-"):
            continue
        try:
            version = int(tag.removeprefix("build-"))
        except ValueError:
            continue
        asset = next((item for item in release.get("assets", []) if item.get("name") == name and item.get("state") == "uploaded"), None)
        if asset and (best is None or version > best["version"]):
            best = {
                "version": version,
                "title": release.get("name") or tag,
                "url": asset["browser_download_url"],
                "size": int(asset.get("size", 0)),
                "digest": str(asset.get("digest") or ""),
            }
    return best if best and best["version"] > current_version() else None


def download(update, progress):
    folder = pathlib.Path(tempfile.mkdtemp(prefix="classroom-bridge-update-"))
    archive = folder / asset_name()
    digest = hashlib.sha256()
    received = 0
    with _open(update["url"], accept="application/octet-stream") as response, archive.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
            received += len(chunk)
            if update["size"]:
                progress(received / update["size"])
    if update["size"] and received != update["size"]:
        raise OSError("The download was incomplete. Try again.")
    expected = update["digest"].removeprefix("sha256:")
    if expected and digest.hexdigest() != expected:
        raise OSError("The download did not match the published file. Try again.")
    return folder, archive


def install_and_restart(folder, archive):
    """Unpacks the update and starts a helper that replaces the app once this process has exited."""
    if sys.platform == "darwin":
        _install_macos(folder, archive)
    elif sys.platform == "win32":
        _install_windows(folder, archive)
    else:
        raise OSError("Updates are only supported on Windows and macOS.")


def _install_macos(folder, archive):
    app = pathlib.Path(sys.executable).resolve().parents[2]
    if app.suffix != ".app":
        raise OSError("Could not find the installed ClassroomBridge.app.")
    if "AppTranslocation" in str(app):
        raise OSError("Move ClassroomBridge.app into your Applications folder, open it from there, then choose Update again.")
    if not os.access(app.parent, os.W_OK):
        raise OSError(f"This Mac account cannot replace the app in {app.parent}. Ask an administrator, or download it from {DOWNLOAD_PAGE}.")
    unpacked = folder / "unpacked"
    # ditto keeps the app bundle's symlinks and permissions, which Python's zipfile does not.
    subprocess.run(["ditto", "-x", "-k", str(archive), str(unpacked)], check=True)
    new_app = unpacked / "ClassroomBridge.app"
    if not new_app.exists():
        raise OSError("The update did not contain ClassroomBridge.app.")
    script = folder / "install.sh"
    script.write_text(f"""#!/bin/sh
while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.5; done
rm -rf "{app}.old" && mv "{app}" "{app}.old" && mv "{new_app}" "{app}" && rm -rf "{app}.old" || {{ [ -d "{app}" ] || mv "{app}.old" "{app}"; }}
open "{app}"
rm -rf "{folder}"
""", encoding="utf-8")
    script.chmod(0o700)
    subprocess.Popen(["/bin/sh", str(script)], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _install_windows(folder, archive):
    install_dir = pathlib.Path(sys.executable).resolve().parent
    if not os.access(install_dir, os.W_OK):
        raise OSError(f"This Windows account cannot write to {install_dir}. Ask school IT, or download it from {DOWNLOAD_PAGE}.")
    unpacked = folder / "unpacked"
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(unpacked)
    if not (unpacked / "ClassroomBridge.exe").exists():
        raise OSError("The update did not contain ClassroomBridge.exe.")
    script = folder / "install.cmd"
    script.write_text(f"""@echo off
:wait
rem The one-file .exe runs as a launcher plus the app itself; wait for both to close.
tasklist /FI "PID eq {os.getpid()}" 2>nul | find "{os.getpid()}" >nul && (timeout /t 1 /nobreak >nul & goto wait)
tasklist /FI "PID eq {os.getppid()}" 2>nul | find "{os.getppid()}" >nul && (timeout /t 1 /nobreak >nul & goto wait)
robocopy "{unpacked}" "{install_dir}" /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP >nul
start "" "{install_dir}\\ClassroomBridge.exe"
""", encoding="utf-8")
    subprocess.Popen(
        ["cmd.exe", "/c", str(script)],
        cwd=str(folder),
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
