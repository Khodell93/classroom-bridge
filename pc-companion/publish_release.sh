#!/usr/bin/env bash
# Uploads build files to the public downloads repository as release build-<commit time>.
# The Windows and Mac workflows run this in parallel, so whichever runs first creates the release.
set -euo pipefail
repo=Khodell93/classroom-bridge-downloads
if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::DOWNLOADS_TOKEN secret is not set; skipping publishing to $repo."
  exit 0
fi
version=$(cat pc-companion/version.txt)
tag="build-$version"
title="Classroom Bridge – $(TZ=UTC git log -1 --format=%cd --date=format-local:'%d %b %Y, %H:%M UTC')"
notes="Companion apps for the Classroom Bridge iPad controller.

- Windows: download ClassroomBridge-Windows-x64.zip, extract it, and open ClassroomBridge.exe (keep the airplay folder beside it).
- Mac (M-series): ClassroomBridge-macOS-Apple-Silicon-arm64.zip. Older Intel Macs: ClassroomBridge-macOS-Intel-x64.zip.

Installed companions install this update automatically. The apps are unsigned; school IT may need to approve them."
for attempt in 1 2 3 4 5; do
  if gh release view "$tag" -R "$repo" >/dev/null 2>&1 || gh release create "$tag" -R "$repo" --title "$title" --notes "$notes" >/dev/null 2>&1; then
    if gh release upload "$tag" "$@" -R "$repo" --clobber; then
      echo "Published $* to https://github.com/$repo/releases/tag/$tag"
      exit 0
    fi
  fi
  sleep $((attempt * 5))
done
echo "::error::Could not publish to $repo. Check that the DOWNLOADS_TOKEN secret can write to it."
exit 1
