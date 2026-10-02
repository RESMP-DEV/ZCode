#!/usr/bin/env bash
set -euo pipefail
root="build/preview-probe3"
lib="${root}/lib"
install="${root}/Other.app"
mkdir -p "${install}/Contents/MacOS"
printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app</string><key>CFBundleExecutable</key><string>ZCode</string></dict></plist>' > "${install}/Contents/Info.plist"
printf 'production-binary' > "${install}/Contents/MacOS/ZCode"
before_c="$(readlink "${lib}/current")"
before_p="$(readlink "${lib}/previous-good")"
set +e
out="$(scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${install}" 2>&1)"
rc=$?
set -e
echo "refuse_exit=${rc}"
printf '%s\n' "$out" | tail -2
after_c="$(readlink "${lib}/current")"
after_p="$(readlink "${lib}/previous-good")"
[[ "$rc" -ne 0 ]] && echo "REFUSE-OK"
[[ "$before_c" == "$after_c" && "$before_p" == "$after_p" ]] && echo "POINTERS-UNCHANGED-OK" || { echo "POINTERS-MOVED-BADLY"; exit 1; }
[[ -d "${install}" ]] && echo "PRODUCTION-APP-INTACT-OK"
echo "--- unreadable identity must refuse rather than delete ---"
mkdir -p "${root}/Broken.app/Contents"
set +e
out2="$(scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${root}/Broken.app" 2>&1)"
rc2=$?
set -e
echo "broken_exit=${rc2}"
printf '%s\n' "$out2" | tail -1
[[ "$rc2" -ne 0 && -d "${root}/Broken.app" ]] && echo "BROKEN-TARGET-PRESERVED-OK"
