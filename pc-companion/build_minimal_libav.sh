#!/usr/bin/env bash
# Run inside MSYS2 UCRT64. Builds the GStreamer "libav" plugin (avdec_h264, avdec_aac, avdec_alac…) against a
# minimal FFmpeg with only the decoders AirPlay mirroring needs and no optional system libraries.
#
# Why: MSYS2's FFmpeg links ~100 extra DLLs (libva, libplacebo -> vulkan-1, codecs we never use). On a school PC
# security software blocked libva ("Access is denied") and vulkan-1.dll was missing, so the video decoder failed to
# load and the AirPlay receiver stopped. This build depends only on the bundled GStreamer/GLib and standard Windows.
#
# Usage: build_minimal_libav.sh <work-dir>   → <work-dir>/prefix/bin/*.dll and <work-dir>/libgstlibav.dll
set -euo pipefail
work="$(realpath -m "$1")"
prefix="$work/prefix"
ffmpeg_version=7.1.1
gst_version=$(pkg-config --modversion gstreamer-1.0)
mkdir -p "$work"
cd "$work"

curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz" | tar xJ
(
  cd "ffmpeg-$ffmpeg_version"
  ./configure --prefix="$prefix" --enable-shared --disable-static \
    --disable-programs --disable-doc --disable-network --disable-autodetect --disable-everything \
    --enable-w32threads \
    --enable-decoder=h264,hevc,aac,aac_latm,alac \
    --enable-parser=h264,hevc,aac,aac_latm \
    --enable-filter=buffer,buffersink,abuffer,abuffersink,format,aformat,yadif
  make -j"$(nproc)"
  make install
)

curl -fsSL "https://gstreamer.freedesktop.org/src/gst-libav/gst-libav-$gst_version.tar.xz" | tar xJ
PKG_CONFIG_PATH="$prefix/lib/pkgconfig:${PKG_CONFIG_PATH:-}" \
  meson setup gst-libav-build "gst-libav-$gst_version" --buildtype=release -Ddoc=disabled -Dtests=disabled
meson compile -C gst-libav-build
cp "$(find gst-libav-build -name libgstlibav.dll | head -1)" "$work/libgstlibav.dll"
echo "Built gst-libav $gst_version against FFmpeg $ffmpeg_version:"
ls -la "$prefix/bin"/*.dll "$work/libgstlibav.dll"
