#!/usr/bin/env bash
set -euo pipefail
root="build/preview-probe3"
lib="${root}/lib"
install="${root}/ZCode Preview.app"
before_c="$(readlink "${lib}/current")"
before_p="$(readlink "${lib}/previous-good")"
mv "${install}" "${root}/saved-preview.app"
set +e
scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${install}"
rc=$?
set -e
echo "install_failure_exit=${rc}"
after_c="$(readlink "${lib}/current")"
after_p="$(readlink "${lib}/previous-good")"
if [[ "$before_c" == "$after_c" && "$before_p" == "$after_p" ]]; then
  echo "POINTERS-UNCHANGED-OK"
else
  echo "POINTERS-MOVED-BADLY before=$before_c/$before_p after=$after_c/$after_p"
  exit 1
fi
echo "--- non-preview install target must be refused ---"
mv "${root}/saved-preview.app" "${root}/Other.app"
set +e
out="$(scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${root}/Other.app" 2>&1)"
rc=$?
set -e
echo "refuse_exit=${rc}"
printf '%s\n' "$out" | tail -2
[[ "$rc" -ne 0 ]] && echo "REFUSE-OK"
