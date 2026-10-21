"""CI check (Windows): the AirPlay receiver starts with the companion's settings, even when an old plugin cache
written by another copy (e.g. a deleted download) is lying around."""
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import airplay  # noqa: E402

bundle = pathlib.Path(sys.argv[1]).resolve()
work = pathlib.Path(tempfile.mkdtemp())


def run_receiver(folder, environment, seconds=10):
    process = subprocess.Popen(
        [str(folder / "uxplay.exe"), "-n", "Classroom Bridge - CI", "-nh", "-p", "-vs", "d3d11videosink"],
        cwd=folder, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    )
    time.sleep(seconds)
    alive = process.poll() is None
    if alive:
        process.kill()
    output = process.communicate()[0].decode("utf-8", "replace")
    return alive, output


# A stale cache: written by a copy of the receiver in another folder, which is then deleted.
old_copy = work / "old-download" / "airplay"
shutil.copytree(bundle, old_copy)
stale = airplay.settings_dir() / "gstreamer-registry.bin"
environment = airplay.receiver_environment(old_copy)
environment["GST_REGISTRY_1_0"] = str(stale)
subprocess.run([str(old_copy / "gst-inspect-1.0.exe"), "libav"], env=environment, capture_output=True, timeout=120)
shutil.rmtree(old_copy.parent)
print(f"Stale cache written: {stale.exists()} ({stale.stat().st_size if stale.exists() else 0} bytes)")
stale_copy = work / "stale-copy.bin"  # receiver_environment() deletes old caches, so test the old way on a copy
shutil.copy(stale, stale_copy)

# The old way (one shared cache) with that stale file — shows whether this reproduces the field failure.
environment = airplay.receiver_environment(bundle)
environment["GST_REGISTRY_1_0"] = str(stale_copy)
environment.pop("GST_REGISTRY_FORK")  # as the companion ran it before
alive, output = run_receiver(bundle, environment)
print(f"Shared stale cache: receiver {'kept running' if alive else 'stopped'}")
print("\n".join(output.splitlines()[-6:]))

# The companion's way (the legacy shared cache is put back first, as on a teacher's PC)
shutil.copy(stale_copy, stale)
# The companion's way: its own cache per folder and version, plugins loaded in-process.
alive, output = run_receiver(bundle, airplay.receiver_environment(bundle))
print(output)
assert alive, "The receiver stopped with the companion's settings"
assert not stale.exists(), "The stale shared cache was not removed"
assert not airplay.explain_failure(["Required gstreamer plugin 'libav' not found"], 1).startswith("Required")
print("Receiver keeps running with the companion's settings; stale cache removed")
print("\n".join(airplay.plugin_diagnostics(bundle)[:8]))
