#!/usr/bin/env bash
set -euo pipefail
root="build/rollback-install-diagnostic"
lib="${root}/lib"
mkdir -p "${lib}/packages/new/ZCode Preview.app/Contents/MacOS" "${lib}/packages/old/ZCode Preview.app/Contents/MacOS"
for snap in new old; do
  printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string></dict></plist>' > "${lib}/packages/${snap}/ZCode Preview.app/Contents/Info.plist"
  printf '%s-binary' "$snap" > "${lib}/packages/${snap}/ZCode Preview.app/Contents/MacOS/ZCode Preview"
done
rm "${lib}/packages/old/ZCode Preview.app/Contents/MacOS/ZCode Preview"
ln -sfn packages/new "${lib}/current"
ln -sfn packages/old "${lib}/previous-good"
set +e
out="$(scripts/build-and-link-zcode.sh --rollback --lib-root "${lib}" --app-install-path "${root}/install.app" 2>&1)"
rc=$?
set -e
printf 'rc=%s current=%s diagnostic=' "$rc" "$(readlink "${lib}/current")"
printf '%s\n' "$out" | tail -1
[[ "$rc" -ne 0 && "$(readlink "${lib}/current")" == "packages/new" && "$(printf '%s' "$out" | tail -1)" == *'cannot checksum main binary of rollback target'* ]]
echo 'ROLLBACK-INSTALL-DIAGNOSTIC-OK'
