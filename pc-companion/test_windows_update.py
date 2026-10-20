"""CI check (Windows): the update helper replaces files beside the running app and relaunches it."""
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import updater  # noqa: E402

root = pathlib.Path(tempfile.mkdtemp())
install = root / "install"
(install / "airplay").mkdir(parents=True)
(install / "ClassroomBridge.exe").write_text("old")
(install / "airplay" / "uxplay.exe").write_text("old")
sys.executable = str(install / "ClassroomBridge.exe")
folder = root / "download"
folder.mkdir()
archive = folder / "update.zip"
with zipfile.ZipFile(archive, "w") as bundle:
    bundle.writestr("ClassroomBridge.exe", "new")
    bundle.writestr("airplay/uxplay.exe", "new")
    bundle.writestr("Start-Here.txt", "new")
updater._install_windows(folder, archive)
for _ in range(30):
    if (install / "Start-Here.txt").exists() and (install / "ClassroomBridge.exe").read_text() == "new":
        break
    time.sleep(1)
assert (install / "ClassroomBridge.exe").read_text() == "new", "app was not replaced"
assert (install / "airplay" / "uxplay.exe").read_text() == "new", "airplay folder was not replaced"
print("Windows update helper replaced the app and its airplay folder")
