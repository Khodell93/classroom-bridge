#!/usr/bin/env bash
# Run inside MSYS2 UCRT64 after building UxPlay: copies uxplay.exe, the GStreamer plugins and every
# DLL they need into one folder that ships beside ClassroomBridge.exe (no MSYS2 or Bonjour needed).
set -euo pipefail
source_dir="$1"
out="$2"
prefix=/ucrt64

mkdir -p "$out/lib/gstreamer-1.0" "$out/libexec/gstreamer-1.0" "$out/licenses"
cp "$source_dir/build/uxplay.exe" "$out/"
cp "$prefix"/lib/gstreamer-1.0/*.dll "$out/lib/gstreamer-1.0/"
cp "$prefix/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$out/libexec/gstreamer-1.0/"
cp "$prefix/bin/gst-inspect-1.0.exe" "$out/"
# The video decoder plugin comes from build_minimal_libav.sh (FFmpeg with only the decoders AirPlay needs) instead
# of MSYS2's, whose FFmpeg pulls in ~100 DLLs including libva (blocked by security software on a school PC) and
# libplacebo -> vulkan-1.dll (missing on some PCs). The VA-API plugin needs libva too and isn't used, and the
# codec2json debugging plugin needs a library that isn't bundled.
libav_build="${3:?path to the build_minimal_libav.sh output}"
rm -f "$out/lib/gstreamer-1.0/libgstlibav.dll" "$out/lib/gstreamer-1.0/libgstva.dll" "$out/lib/gstreamer-1.0/libgstcodec2json.dll"
cp "$libav_build/libgstlibav.dll" "$out/lib/gstreamer-1.0/"
cp "$libav_build"/prefix/bin/*.dll "$out/"
export PATH="$out:$PATH"  # so ldd can follow the minimal FFmpeg's own (system-only) dependencies

# Resolve DLL dependencies repeatedly until nothing new is found.
while true; do
  before=$(ls "$out" | wc -l)
  { find "$out" \( -name '*.exe' -o -name '*.dll' \) -print0 | xargs -0 -n 20 ldd 2>/dev/null || true; } \
    | awk '{print $3}' | { grep -i "^$prefix/bin/" || true; } | sort -u \
    | while read -r dll; do cp -n "$dll" "$out/"; done
  after=$(ls "$out" | wc -l)
  [ "$before" -eq "$after" ] && break
done

cp "$source_dir/LICENSE" "$out/licenses/UxPlay-LICENSE.txt"
cat > "$out/licenses/README.txt" <<NOTICE
iPad apps (AirPlay) in Classroom Bridge uses UxPlay, free software under the
GNU General Public License v3 (see UxPlay-LICENSE.txt).
Source: https://github.com/FDH2/UxPlay at commit $(git -C "$source_dir" rev-parse HEAD)

It also uses GStreamer and FFmpeg libraries from the MSYS2 project, which are
free software under the GNU LGPL/GPL. Their sources are available from
https://packages.msys2.org/ (packages mingw-w64-ucrt-x86_64-gstreamer,
-gst-plugins-base, -gst-plugins-good, -gst-plugins-bad). The libav plugin is gst-libav $(pkg-config --modversion gstreamer-1.0)
built against FFmpeg 7.1.1 (LGPL, https://ffmpeg.org/releases/) configured with only the H.264/H.265/AAC/ALAC
decoders; see pc-companion/build_minimal_libav.sh in the Classroom Bridge source for the exact options.
NOTICE
du -sh "$out"
