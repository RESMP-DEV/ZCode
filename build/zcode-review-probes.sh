#!/usr/bin/env bash
set -euo pipefail
root="build/zcode-review-probes"
lib="${root}/lib"
install="${root}/ZCode Preview.app"
dist="packages/desktop/dist/mac-arm64/ZCode Preview.app"
dist_bin="${dist}/Contents/MacOS/ZCode Preview"
mkdir -p "${lib}/packages/old/ZCode Preview.app/Contents/MacOS" "${root}/dist-parent"
if [[ ! -d "$dist" ]]; then
  mkdir -p "packages/desktop/dist/mac-arm64/ZCode Preview.app/Contents/MacOS"
  printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string><key>CFBundleShortVersionString</key><string>3.14.3</string></dict></plist>' > "packages/desktop/dist/mac-arm64/ZCode Preview.app/Contents/Info.plist"
  printf 'new-binary' > "packages/desktop/dist/mac-arm64/ZCode Preview.app/Contents/MacOS/ZCode Preview"
fi
printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string><key>CFBundleShortVersionString</key><string>3.14.3</string></dict></plist>' > "${lib}/packages/old/ZCode Preview.app/Contents/Info.plist"
printf 'old-binary' > "${lib}/packages/old/ZCode Preview.app/Contents/MacOS/ZCode Preview"
ln -sfn packages/old "${lib}/current"
ln -sfn packages/old "${lib}/previous-good"
mkdir -p "${install}"
printf 'partial-debris' > "${install}/broken"
scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${install}" --keep-snapshots 1
cmp "$dist_bin" "${install}/Contents/MacOS/ZCode Preview"
[[ -e "${install}.rollback-new" ]] && { echo "UNEXPECTED-ROLLBACK-TEMP"; exit 1; }
echo "PARTIAL-TARGET-RECOVERY-OK"
mkdir -p "${root}/enum-fail/lib/packages"
chmod 000 "${root}/enum-fail/lib/packages"
set +e
out="$(scripts/build-and-link-zcode.sh --list --lib-root "${root}/enum-fail/lib" 2>&1)"
rc=$?
set -e
chmod 700 "${root}/enum-fail/lib/packages"
[[ "$rc" -ne 0 && "$(printf '%s' "$out" | tail -1)" == *'cannot enumerate snapshots under'* ]]
echo "ENUM-FAILURE-PROPAGATED-OK"
