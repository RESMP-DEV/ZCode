#!/usr/bin/env bash
set -euo pipefail
root="build/preview-probe3"
lib="${root}/lib"
before_c="$(readlink "${lib}/current")"
before_p="$(readlink "${lib}/previous-good")"
set +e
out2="$(scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${root}/Broken.app" 2>&1)"
rc2=$?
set -e
echo "broken_exit=${rc2}"
printf '%s\n' "$out2" | tail -1
after_c="$(readlink "${lib}/current")"
after_p="$(readlink "${lib}/previous-good")"
if [[ "$rc2" -ne 0 && -d "${root}/Broken.app" && "$before_c" == "$after_c" && "$before_p" == "$after_p" ]]; then
  echo "BROKEN-TARGET-PRESERVED-AND-POINTERS-UNCHANGED-OK"
else
  echo "UNEXPECTED rc=${rc2} c=${after_c} p=${after_p}"
  exit 1
fi
