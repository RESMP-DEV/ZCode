#!/usr/bin/env bash
set -euo pipefail
root="build/rollback-diagnostic-probe"
lib="${root}/lib"
mkdir -p "${lib}/packages/new/ZCode Preview.app/Contents/MacOS" "${lib}/packages/old/ZCode Preview.app/Contents/MacOS"
for snap in new old; do
  plist="${lib}/packages/${snap}/ZCode Preview.app/Contents/Info.plist"
  printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string></dict></plist>' > "$plist"
  printf '%s-binary' "$snap" > "${lib}/packages/${snap}/ZCode Preview.app/Contents/MacOS/ZCode Preview"
done
ln -sfn packages/new "${lib}/current"
ln -sfn packages/old "${lib}/previous-good"
rm "${lib}/packages/old/ZCode Preview.app/Contents/MacOS/ZCode Preview"
set +e
out="$(scripts/build-and-link-zcode.sh --rollback --no-install --lib-root "${lib}" 2>&1)"
no_install_rc=$?
out2="$(scripts/build-and-link-zcode.sh --rollback --lib-root "${lib}" --app-install-path "${root}/install.app" 2>&1)"
install_rc=$?
set -e
printf 'no_install_rc=%s current=%s\n' "$no_install_rc" "$(readlink "${lib}/current")"
printf 'install_rc=%s diagnostic=' "$install_rc"
printf '%s\n' "$out2" | tail -1
[[ "$no_install_rc" -eq 0 && "$(readlink "${lib}/current")" == "packages/old" ]]
[[ "$install_rc" -ne 0 && "$(printf '%s' "$out2" | tail -1)" == *'cannot checksum main binary of rollback target'* ]]
echo 'ROLLBACK-DIAGNOSTIC-OK'
