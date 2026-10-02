#!/usr/bin/env bash
set -euo pipefail
root="build/rollback-no-install-only"
lib="${root}/lib"
mkdir -p "${lib}/packages/new/ZCode Preview.app/Contents/MacOS" "${lib}/packages/old/ZCode Preview.app/Contents/MacOS"
for snap in new old; do
  printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string></dict></plist>' > "${lib}/packages/${snap}/ZCode Preview.app/Contents/Info.plist"
  printf '%s-binary' "$snap" > "${lib}/packages/${snap}/ZCode Preview.app/Contents/MacOS/ZCode Preview"
done
rm "${lib}/packages/old/ZCode Preview.app/Contents/MacOS/ZCode Preview"
ln -sfn packages/new "${lib}/current"
ln -sfn packages/old "${lib}/previous-good"
scripts/build-and-link-zcode.sh --rollback --no-install --lib-root "${lib}"
echo "current=$(readlink "${lib}/current") previous=$(readlink "${lib}/previous-good")"
