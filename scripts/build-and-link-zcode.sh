#!/usr/bin/env bash
# 个人定制构建管线：构建 Preview 身份桌面版并发布为不可变快照。
# 行为契约见 specs/custom-preview-build.md；接口对齐 ~/codex 的 build_and_link_codex.sh。
set -euo pipefail

usage() {
  cat <<'EOF'
Build a personal ZCode desktop release and publish it as a versioned package snapshot.

The custom build uses the Preview identity (dev.zcode.app.preview / "ZCode Preview"):
auto-update is disabled at compile time for this flavor, and it uses its own Electron
userData, so it runs side-by-side with the official /Applications/ZCode.app while
sharing ~/.zcode business state. Rollback = flip `current` back to `previous-good`.

Layout:
  <lib-root>/packages/<yyyymmdd-HHMM>-<gitsha>[-dirty]/   snapshot dirs (app + manifest.json)
  <lib-root>/current                        -> packages/<newest snapshot>
  <lib-root>/previous-good                  -> packages/<prior build>
  /Applications/ZCode Preview.app            installed copy of `current`

Usage:
  scripts/build-and-link-zcode.sh [options]

Options:
  --no-build                 Reuse the most recent bundle in packages/desktop/dist.
  --no-install               Snapshot only; do not touch the install path.
  --rollback                 Swap current/previous-good and reinstall.
  --list                     List snapshots and exit.
  --app-install-path <path>  App bundle to update (default: /Applications/ZCode Preview.app).
  --lib-root <path>          Snapshot root (default: ~/.local/lib/alphaheng/zcode).
  --keep-snapshots <count>   Non-protected snapshots to retain (default: 3).
  -h, --help                 Show this help text.

Environment:
  ZCODE_LIB_ROOT             Default for --lib-root.
  ZCODE_APP_INSTALL_PATH     Default for --app-install-path.
  ZCODE_KEEP_SNAPSHOTS       Default for --keep-snapshots.
EOF
}

PREVIEW_BUNDLE_ID="dev.zcode.app.preview"
APP_BASENAME="ZCode Preview.app"

do_build=1
do_install=1
do_rollback=0
do_list=0
app_install_path="${ZCODE_APP_INSTALL_PATH:-/Applications/ZCode Preview.app}"
lib_root="${ZCODE_LIB_ROOT:-${HOME}/.local/lib/alphaheng/zcode}"
keep_snapshots="${ZCODE_KEEP_SNAPSHOTS:-3}"

while (($# > 0)); do
  case "$1" in
    --no-build) do_build=0; shift ;;
    --no-install) do_install=0; shift ;;
    --rollback) do_rollback=1; shift ;;
    --list) do_list=1; shift ;;
    --app-install-path)
      (($# >= 2)) || { echo "error: --app-install-path requires a value" >&2; exit 1; }
      app_install_path="$2"; shift 2 ;;
    --lib-root)
      (($# >= 2)) || { echo "error: --lib-root requires a value" >&2; exit 1; }
      lib_root="$2"; shift 2 ;;
    --keep-snapshots)
      (($# >= 2)) || { echo "error: --keep-snapshots requires a value" >&2; exit 1; }
      keep_snapshots="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
packages_root="${lib_root}/packages"
dist_mac_dir="${repo_root}/packages/desktop/dist/mac-arm64"

# mise.toml 锁 node 24.x；本机无 mise 时优先用 nvm 的 24 系列驱动构建子进程。
node_bin_dir=""
for candidate in "${HOME}/.nvm/versions/node/v24.14.0/bin" "${HOME}/.nvm/versions/node/v24.11.1/bin"; do
  if [[ -x "${candidate}/node" ]]; then node_bin_dir="${candidate}"; break; fi
done
if [[ -n "${node_bin_dir}" ]]; then
  export PATH="${node_bin_dir}:${PATH}"
fi
node_major="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/' || echo 0)"
if (( node_major < 24 )); then
  echo "error: node >=24 required (mise.toml pins 24.x), found $(node -v 2>/dev/null || echo none)" >&2
  exit 1
fi

plist_print() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null
}

app_binary_sha() {
  local app_path="$1" exe
  exe="$(plist_print "${app_path}" CFBundleExecutable)"
  [[ -n "${exe}" && -f "${app_path}/Contents/MacOS/${exe}" ]] || return 1
  shasum -a 256 "${app_path}/Contents/MacOS/${exe}" | awk '{print $1}'
}

verify_preview_identity() {
  local app_path="$1" bundle_id
  [[ -d "${app_path}" ]] || { echo "error: app bundle not found: ${app_path}" >&2; return 1; }
  bundle_id="$(plist_print "${app_path}" CFBundleIdentifier)"
  if [[ "${bundle_id}" != "${PREVIEW_BUNDLE_ID}" ]]; then
    echo "error: refusing non-preview bundle (CFBundleIdentifier=${bundle_id:-missing}); a production-identity build would be clobbered by the official auto-updater" >&2
    return 1
  fi
}

if ((do_list)); then
  mkdir -p "${packages_root}"
  echo "snapshots under ${packages_root}:"
  ls -1 "${packages_root}" | sort -r | while IFS= read -r snap; do
    local_marker=""
    [[ "$(readlink "${lib_root}/current" 2>/dev/null)" == "packages/${snap}" ]] && local_marker="${local_marker} [current]"
    [[ "$(readlink "${lib_root}/previous-good" 2>/dev/null)" == "packages/${snap}" ]] && local_marker="${local_marker} [previous-good]"
    echo "  ${snap}${local_marker}"
  done
  exit 0
fi

command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git not found" >&2; exit 1; }

if ((do_rollback)); then
  if [[ ! -L "${lib_root}/current" || ! -L "${lib_root}/previous-good" ]]; then
    echo "error: rollback needs both current and previous-good pointers" >&2
    exit 1
  fi
  current_snap="$(basename "$(readlink "${lib_root}/current")")"
  previous_snap="$(basename "$(readlink "${lib_root}/previous-good")")"
  rollback_app="${packages_root}/${previous_snap}/${APP_BASENAME}"
  verify_preview_identity "${rollback_app}"
  echo "Rolling back: ${current_snap} -> ${previous_snap}"
  ln -sfn "packages/${previous_snap}" "${lib_root}/current"
  ln -sfn "packages/${current_snap}" "${lib_root}/previous-good"
  if ((do_install)); then
    if [[ -e "${app_install_path}" ]]; then
      installed_id="$(plist_print "${app_install_path}" CFBundleIdentifier || true)"
      if [[ -n "${installed_id}" && "${installed_id}" != "${PREVIEW_BUNDLE_ID}" ]]; then
        echo "error: refusing to overwrite ${app_install_path} (CFBundleIdentifier=${installed_id})" >&2
        exit 1
      fi
      rm -rf "${app_install_path:?}"
    fi
    ditto "${rollback_app}" "${app_install_path}"
    echo "Installed: ${app_install_path} (snapshot ${previous_snap})"
  fi
  echo "Rollback complete."
  exit 0
fi

if ((do_build)); then
  echo "Building preview-identity desktop bundle..."
  (
    cd "${repo_root}"
    COREPACK_ENABLE_PROJECT_SPEC=0 \
    ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
    ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 \
      pnpm bundle:desktop
  )
fi

app_path="$(ls -d "${dist_mac_dir}/"*.app 2>/dev/null | head -1 || true)"
if [[ -z "${app_path}" ]]; then
  echo "error: no bundled app found under ${dist_mac_dir}; run without --no-build first" >&2
  exit 1
fi
verify_preview_identity "${app_path}"

mkdir -p "${packages_root}"

git_sha="$(git -C "${repo_root}" rev-parse --short=8 HEAD 2>/dev/null || echo nogit)"
if [[ -n "$(git -C "${repo_root}" status --porcelain 2>/dev/null | head -1)" ]]; then
  git_sha="${git_sha}-dirty"
fi
snapshot_name="$(date +%Y%m%d-%H%M)-${git_sha}"
snapshot_dir="${packages_root}/${snapshot_name}"
if [[ -d "${snapshot_dir}" ]]; then
  echo "error: snapshot already exists: ${snapshot_dir}" >&2
  exit 1
fi

echo "Assembling snapshot ${snapshot_name}..."
mkdir -p "${snapshot_dir}"
ditto "${app_path}" "${snapshot_dir}/${APP_BASENAME}"
verify_preview_identity "${snapshot_dir}/${APP_BASENAME}"
binary_sha="$(app_binary_sha "${snapshot_dir}/${APP_BASENAME}")"
app_version="$(plist_print "${snapshot_dir}/${APP_BASENAME}" CFBundleShortVersionString)"
cat > "${snapshot_dir}/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitSha": "${git_sha}",
  "version": "${app_version}",
  "bundleIdentifier": "${PREVIEW_BUNDLE_ID}",
  "productName": "ZCode Preview",
  "mainBinarySha256": "${binary_sha}",
  "buildEnv": { "ZCODE_ENV": "production", "ZCODE_PREVIEW_IDENTITY": "1" }
}
EOF

# --- select the snapshot ---------------------------------------------------------
previous_target=""
if [[ -L "${lib_root}/current" ]]; then
  previous_target="$(basename "$(readlink "${lib_root}/current")")"
fi
ln -sfn "packages/${snapshot_name}" "${lib_root}/current"
if [[ -n "${previous_target}" \
  && "${previous_target}" != "${snapshot_name}" \
  && -d "${packages_root}/${previous_target}" ]]; then
  ln -sfn "packages/${previous_target}" "${lib_root}/previous-good"
fi

# --- install ----------------------------------------------------------------------
if ((do_install)); then
  if pgrep -fq "${APP_BASENAME}/Contents/MacOS" 2>/dev/null; then
    echo "warning: ZCode Preview is running; the installed copy updates on disk, restart it manually when convenient." >&2
  fi
  if [[ -e "${app_install_path}" ]]; then
    installed_id="$(plist_print "${app_install_path}" CFBundleIdentifier || true)"
    if [[ -n "${installed_id}" && "${installed_id}" != "${PREVIEW_BUNDLE_ID}" ]]; then
      echo "error: refusing to overwrite ${app_install_path} (CFBundleIdentifier=${installed_id})" >&2
      exit 1
    fi
    rm -rf "${app_install_path:?}"
  fi
  ditto "${snapshot_dir}/${APP_BASENAME}" "${app_install_path}"
  installed_sha="$(app_binary_sha "${app_install_path}")"
  if [[ "${installed_sha}" != "${binary_sha}" ]]; then
    echo "error: installed binary checksum does not match snapshot" >&2
    exit 1
  fi
  echo "Installed: ${app_install_path}"
fi

echo "Snapshot: ${snapshot_name}"
echo "Release SHA: ${binary_sha}"

# --- prune old snapshots -----------------------------------------------------------
kept=0
while IFS= read -r snap; do
  [[ -n "${snap}" ]] || continue
  [[ "${snap}" == "${snapshot_name}" || "${snap}" == "${previous_target}" ]] && continue
  kept=$((kept + 1))
  if ((kept > keep_snapshots)); then
    rm -rf "${packages_root:?}/${snap}"
    echo "Pruned old snapshot: ${snap}"
  fi
done < <(ls -1 "${packages_root}" | sort -r)

if ((do_install)); then
  echo "Smoke check: scripts/smoke-test-zcode-preview.sh"
fi
