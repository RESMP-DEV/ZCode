#!/usr/bin/env bash
set -euo pipefail
lib="build/atomic-probe/lib"
mkdir -p "${lib}/packages"
sha="$(git rev-parse --short=8 HEAD)-dirty"
snap="${lib}/packages/$(date +%Y%m%d-%H%M%S)-${sha}"
mkdir "${snap}"
set +e
out="$(scripts/build-and-link-zcode.sh --no-build --no-install --lib-root "${lib}" 2>&1)"
rc=$?
set -e
echo "collision_exit=${rc}"
printf '%s\n' "$out" | tail -2
[[ "$rc" -ne 0 ]] && echo "ATOMIC-MKDIR-REFUSED-OK"
