#!/usr/bin/env bash
set -euo pipefail
root="build/preview-probe3"
lib="${root}/lib"
install="${root}/ZCode Preview.app"
echo "--- rollback (installs previous-good, verifies checksum) ---"
scripts/build-and-link-zcode.sh --rollback --lib-root "${lib}" --app-install-path "${install}"
echo "current=$(readlink "${lib}/current")"
echo "previous-good=$(readlink "${lib}/previous-good")"
echo "--- installed binary must match previous-good snapshot ---"
a="$(shasum -a 256 "${install}/Contents/MacOS/ZCode Preview" | awk '{print $1}')"
b="$(shasum -a 256 "${lib}/$(readlink "${lib}/current")/ZCode Preview.app/Contents/MacOS/ZCode Preview" | awk '{print $1}')"
[[ "$a" == "$b" ]] && echo "ROLLBACK-CHECKSUM-OK" || { echo "ROLLBACK-CHECKSUM-MISMATCH"; exit 1; }
echo "--- install failure must not flip pointers ---"
before_c="$(readlink "${lib}/current")"
before_p="$(readlink "${lib}/previous-good")"
printf 'not-an-app' > "${install}"
set +e
scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${install}"
rc=$?
set -e
echo "install_failure_exit=${rc}"
after_c="$(readlink "${lib}/current")"
after_p="$(readlink "${lib}/previous-good")"
[[ "$before_c" == "$after_c" && "$before_p" == "$after_p" ]] && echo "POINTERS-UNCHANGED-OK" || { echo "POINTERS-MOVED-BADLY"; exit 1; }
