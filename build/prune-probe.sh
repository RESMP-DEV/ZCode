#!/usr/bin/env bash
set -euo pipefail
root="build/preview-probe3"
lib="${root}/lib"
install="${root}/ZCode Preview.app"
mk_app() {
  local dir="$1" payload="$2"
  mkdir -p "${dir}/ZCode Preview.app/Contents/MacOS"
  printf '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app.preview</string><key>CFBundleExecutable</key><string>ZCode Preview</string><key>CFBundleShortVersionString</key><string>3.14.3</string></dict></plist>' \
    > "${dir}/ZCode Preview.app/Contents/Info.plist"
  printf 'payload-%s' "${payload}" > "${dir}/ZCode Preview.app/Contents/MacOS/ZCode Preview"
}
for s in 1 2 3 4 5; do
  mk_app "${lib}/packages/20260101-00000${s}-snap${s}" "${s}"
  sleep 1
done
ln -sfn "packages/20260101-000001-snap1" "${lib}/current"
ln -sfn "packages/20260101-000002-snap2" "${lib}/previous-good"
mkdir -p build/dist-probe
cp -R "${lib}/packages/20260101-000005-snap5/ZCode Preview.app" build/dist-probe/
echo "--- before ---"
scripts/build-and-link-zcode.sh --list --lib-root "${lib}"
echo "--- run snapshot+install, keep 2 ---"
scripts/build-and-link-zcode.sh --no-build --lib-root "${lib}" --app-install-path "${install}" --keep-snapshots 2
echo "--- after ---"
scripts/build-and-link-zcode.sh --list --lib-root "${lib}"
echo "current=$(readlink "${lib}/current")"
echo "previous-good=$(readlink "${lib}/previous-good")"
for t in "$(readlink "${lib}/current")" "$(readlink "${lib}/previous-good")"; do
  [[ -d "${lib}/${t}" ]] && echo "PROTECTED-OK ${t}" || { echo "PROTECTED-MISSING ${t}"; exit 1; }
done
[[ -d "${install}" ]] && echo "INSTALL-OK"
