#!/usr/bin/env bash
# 冒烟验证安装副本：身份、版本、与 current 快照 manifest 一致；未运行时启动一次再退出。
# 行为契约见 specs/custom-preview-build.md。
set -euo pipefail

usage() {
  cat <<'EOF'
Smoke-test an installed ZCode Preview app bundle.

Static checks: bundle identity (dev.zcode.app.preview), executable present, version
and main-binary sha256 match the `current` snapshot manifest when one exists.
Live check: if ZCode Preview is not already running, launch it, confirm the process
and its userData directory appear, then quit it. The official ZCode.app is never touched.

Usage:
  scripts/smoke-test-zcode-preview.sh [--app <path>] [--lib-root <path>] [--no-launch]

Environment:
  ZCODE_APP_INSTALL_PATH, ZCODE_LIB_ROOT
EOF
}

PREVIEW_BUNDLE_ID="dev.zcode.app.preview"
app_install_path="${ZCODE_APP_INSTALL_PATH:-/Applications/ZCode Preview.app}"
lib_root="${ZCODE_LIB_ROOT:-${HOME}/.local/lib/alphaheng/zcode}"
do_launch=1

while (($# > 0)); do
  case "$1" in
    --app)
      (($# >= 2)) || { echo "error: --app requires a value" >&2; exit 1; }
      app_install_path="$2"; shift 2 ;;
    --lib-root)
      (($# >= 2)) || { echo "error: --lib-root requires a value" >&2; exit 1; }
      lib_root="$2"; shift 2 ;;
    --no-launch) do_launch=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

plist_print() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null
}

fail() { echo "FAIL: $1" >&2; exit 1; }

[[ -d "${app_install_path}" ]] || fail "app bundle not found: ${app_install_path}"

bundle_id="$(plist_print "${app_install_path}" CFBundleIdentifier)"
[[ "${bundle_id}" == "${PREVIEW_BUNDLE_ID}" ]] || fail "CFBundleIdentifier is ${bundle_id:-missing}, expected ${PREVIEW_BUNDLE_ID}"

exe="$(plist_print "${app_install_path}" CFBundleExecutable)"
[[ -n "${exe}" && -f "${app_install_path}/Contents/MacOS/${exe}" ]] || fail "main executable missing"
binary_sha="$(shasum -a 256 "${app_install_path}/Contents/MacOS/${exe}" | awk '{print $1}')"
echo "OK: identity ${bundle_id}, version $(plist_print "${app_install_path}" CFBundleShortVersionString), exe ${exe}"

current_link="${lib_root}/current"
if [[ -L "${current_link}" ]]; then
  manifest="${lib_root}/$(readlink "${current_link}")/manifest.json"
  if [[ -f "${manifest}" ]]; then
    manifest_sha="$(jq -r '.mainBinarySha256' "${manifest}")"
    [[ "${binary_sha}" == "${manifest_sha}" ]] || fail "installed binary sha ${binary_sha} != current snapshot ${manifest_sha}"
    echo "OK: matches current snapshot $(basename "$(readlink "${current_link}")")"
  fi
fi

if ((do_launch)); then
  user_data_dir="${HOME}/Library/Application Support/ZCode Preview"
  lock_file="${user_data_dir}/SingletonLock"
  # 以 SingletonLock 指向的 pid 判定存活；pgrep 对首启慢的实例不可靠。
  preview_pid() {
    local link_target
    link_target="$(readlink "${lock_file}" 2>/dev/null || true)"
    [[ "${link_target}" =~ -([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}"
  }
  preview_running() {
    local pid
    pid="$(preview_pid)"
    [[ -n "${pid}" ]] && ps -p "${pid}" -o comm= 2>/dev/null | grep -q "ZCode Preview"
  }
  if [[ -e "${lock_file}" ]] && ! preview_running; then
    echo "note: removing stale single-instance lock (pid $(preview_pid || echo none) gone)"
    rm -f "${user_data_dir}/SingletonLock" "${user_data_dir}/SingletonSocket" "${user_data_dir}/SingletonCookie"
  fi
  if preview_running; then
    echo "SKIP launch: ZCode Preview is already running (static checks passed)"
    exit 0
  fi
  open -n "${app_install_path}"
  launched=""
  for _ in $(seq 1 90); do
    if preview_running && [[ -d "${user_data_dir}" ]]; then
      launched="1"
      break
    fi
    sleep 1
  done
  if [[ -z "${launched}" ]]; then
    osascript -e 'tell application "ZCode Preview" to quit' >/dev/null 2>&1 || true
    fail "app did not start or userData dir missing after 90s"
  fi
  echo "OK: launched and userData present (${user_data_dir})"
  osascript -e 'tell application "ZCode Preview" to quit' >/dev/null 2>&1 || true
  sleep 3
  if preview_running; then
    echo "warning: app still running after quit request" >&2
  else
    echo "OK: quit cleanly"
  fi
fi

echo "Smoke test passed."
