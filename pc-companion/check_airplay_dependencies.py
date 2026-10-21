"""CI check: every DLL the bundled AirPlay receiver needs is either in the bundle or part of standard Windows 10/11.

A DLL that the build machine happens to have (installed by its graphics drivers or tools) but school PCs don't
makes Windows refuse to load a plugin with "The specified module could not be found". That is how a missing
vulkan-1.dll stopped the video decoder (libgstlibav -> avfilter -> libplacebo -> vulkan-1) on a school PC.
"""
import pathlib
import sys

import pefile

# DLLs every Windows 10/11 installation has.
WINDOWS = {
    "advapi32.dll", "avrt.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll", "comctl32.dll", "comdlg32.dll",
    "crypt32.dll", "d2d1.dll", "d3d11.dll", "d3d12.dll", "d3d9.dll", "d3dcompiler_47.dll", "dbghelp.dll", "dnsapi.dll",
    "dsound.dll", "dwmapi.dll", "dwrite.dll", "dxgi.dll", "gdi32.dll", "gdiplus.dll", "hid.dll", "imm32.dll",
    "iphlpapi.dll", "kernel32.dll", "ksuser.dll", "mmdevapi.dll", "msimg32.dll", "msvcrt.dll", "ncrypt.dll",
    "ntdll.dll", "ole32.dll", "oleaut32.dll", "opengl32.dll", "powrprof.dll", "propsys.dll", "psapi.dll", "rpcrt4.dll",
    "secur32.dll", "setupapi.dll", "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll", "userenv.dll",
    "usp10.dll", "uxtheme.dll", "version.dll", "winhttp.dll", "winmm.dll", "wintrust.dll", "wldap32.dll",
    "ws2_32.dll", "wsock32.dll",
}
# Missing on some Windows editions or not bundled, but only needed by plugins the receiver never uses:
# Media Foundation (absent on "N" editions) and the codec2json debugging plugin.
OPTIONAL = {"mf.dll", "mfplat.dll", "mfreadwrite.dll", "libjson-glib-1.0-0.dll"}

root = pathlib.Path(sys.argv[1])
files = {path.name.lower(): path for path in root.rglob("*") if path.suffix.lower() in (".dll", ".exe")}
problems = []
for name, path in sorted(files.items()):
    image = pefile.PE(str(path), fast_load=True)
    image.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
    for entry in getattr(image, "DIRECTORY_ENTRY_IMPORT", []):
        needed = entry.dll.decode().lower()
        if needed in files or needed in WINDOWS or needed in OPTIONAL or needed.startswith(("api-ms-win-", "ext-ms-")):
            continue
        problems.append(f"{name} needs {needed}, which is neither bundled nor part of standard Windows")
print("\n".join(problems) or f"All {len(files)} receiver files only need bundled DLLs or standard Windows DLLs.")
sys.exit(1 if problems else 0)
