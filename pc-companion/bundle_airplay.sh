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
# The Vulkan loader: FFmpeg's avfilter (used by the video decoder plugin) links libplacebo, which needs it.
# Graphics drivers usually install it, but not on every school PC, and ldd resolves it to System32 on the build
# machine, so it is copied explicitly.
cp "$prefix/bin/vulkan-1.dll" "$out/"

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
-gst-plugins-base, -gst-plugins-good, -gst-plugins-bad, -gst-libav, -ffmpeg), and the Khronos Vulkan
loader (vulkan-1.dll, Apache License 2.0, package mingw-w64-ucrt-x86_64-vulkan-loader).
NOTICE
du -sh "$out"
