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
  <lib-root>/packages/<yyyymmdd-HHMMSS>-<gitsha>[-dirty]/  snapshot dirs (app + manifest.json)
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

validate_keep_snapshots() {
  # 上限 18 位：bash 算术不做溢出检查，更大的值会回绕成 0，
  # 让修剪比较把所有未保护快照都判定为超限。
  [[ "${keep_snapshots}" =~ ^(0|[1-9][0-9]{0,17})$ ]] || {
    echo "error: --keep-snapshots must be a non-negative integer of at most 18 digits" >&2
    exit 1
  }
}

# 快照枚举：只用 POSIX 结构剥掉目录前缀。
# 不用 `find -exec basename {} +`：basename 一次收到多条路径时，
# 第二个会被当成 suffix 丢掉，3 个以上直接 usage error，而 find 仍返回 0。
list_snapshot_names() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r dir; do
    printf '%s\n' "${dir##*/}"
  done
}

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
validate_keep_snapshots

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

remove_install_target() {
  local installed_id
  if [[ ! -e "${app_install_path}" && ! -L "${app_install_path}" ]]; then
    return 0
  fi
  if ! installed_id="$(plist_print "${app_install_path}" CFBundleIdentifier)"; then
    echo "error: cannot read identity from existing install target: ${app_install_path}" >&2
    return 1
  fi
  if [[ -z "${installed_id}" ]]; then
    echo "error: existing install target has no readable bundle identity: ${app_install_path}" >&2
    return 1
  fi
  if [[ "${installed_id}" != "${PREVIEW_BUNDLE_ID}" ]]; then
    echo "error: refusing to overwrite ${app_install_path} (CFBundleIdentifier=${installed_id})" >&2
    return 1
  fi
  rm -rf "${app_install_path:?}"
}

if ((do_list)); then
  mkdir -p "${packages_root}"
  echo "snapshots under ${packages_root}:"
  list_snapshot_names "${packages_root}" | sort -r | while IFS= read -r snap; do
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
  rollback_sha="$(app_binary_sha "${rollback_app}")"
  echo "Rolling back: ${current_snap} -> ${previous_snap}"
  if ((do_install)); then
    if ! remove_install_target; then
      exit 1
    fi
    # 安装成功后再翻指针：失败退出时 current 仍指向最近一次成功安装的快照，
    # 重试不会把 previous-good 顶成从未安装过的目标。
    ditto "${rollback_app}" "${app_install_path}"
    installed_sha="$(app_binary_sha "${app_install_path}")"
    if [[ "${installed_sha}" != "${rollback_sha}" ]]; then
      echo "error: rolled-back installed binary checksum does not match snapshot" >&2
      exit 1
    fi
    echo "Installed: ${app_install_path} (snapshot ${previous_snap})"
  fi
  ln -sfn "packages/${previous_snap}" "${lib_root}/current"
  ln -sfn "packages/${current_snap}" "${lib_root}/previous-good"
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

app_path="$(find "${dist_mac_dir}" -mindepth 1 -maxdepth 1 -type d -name '*.app' -print 2>/dev/null | sort | head -n 1 || true)"
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
snapshot_name="$(date +%Y%m%d-%H%M%S)-${git_sha}"
snapshot_dir="${packages_root}/${snapshot_name}"
if [[ -d "${snapshot_dir}" ]]; then
  echo "error: snapshot already exists: ${snapshot_dir}" >&2
  exit 1
fi

echo "Assembling snapshot ${snapshot_name}..."
if ! mkdir "${snapshot_dir}"; then
  echo "error: snapshot already exists or cannot be created: ${snapshot_dir}" >&2
  exit 1
fi
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

publish_pointers() {
  ln -sfn "packages/${snapshot_name}" "${lib_root}/current"
  if [[ -n "${previous_target}" \
    && "${previous_target}" != "${snapshot_name}" \
    && -d "${packages_root}/${previous_target}" ]]; then
    ln -sfn "packages/${previous_target}" "${lib_root}/previous-good"
  fi
}

# --- install ----------------------------------------------------------------------
# 指针只在安装与校验成功后翻转（--no-install 无安装步骤，快照落盘即发布）：
# 安装失败退出时 current/previous-good 仍指向最近一次成功安装的快照对，
# 重试不会把 previous-good 顶成从未安装过的新快照。
if ((do_install)); then
  if pgrep -fq "${APP_BASENAME}/Contents/MacOS" 2>/dev/null; then
    echo "warning: ZCode Preview is running; the installed copy updates on disk, restart it manually when convenient." >&2
  fi
  remove_install_target
  ditto "${snapshot_dir}/${APP_BASENAME}" "${app_install_path}"
  installed_sha="$(app_binary_sha "${app_install_path}")"
  if [[ "${installed_sha}" != "${binary_sha}" ]]; then
    echo "error: installed binary checksum does not match snapshot" >&2
    exit 1
  fi
  publish_pointers
  echo "Installed: ${app_install_path}"
else
  publish_pointers
fi

echo "Snapshot: ${snapshot_name}"
echo "Release SHA: ${binary_sha}"

# --- prune old snapshots -----------------------------------------------------------
# 修剪保护读取 previous-good 链接的实际解析目标：previous_target 可能因首次构建
# （无链接）或守卫跳过翻转而与链接指向不一致，漏保护会让 --rollback 失去回滚点。
protected_prev=""
prev_link_target="$(readlink "${lib_root}/previous-good" 2>/dev/null || true)"
[[ -n "${prev_link_target}" ]] && protected_prev="$(basename "${prev_link_target}")"

kept=0
while IFS= read -r snap; do
  [[ -n "${snap}" ]] || continue
  [[ "${snap}" == "${snapshot_name}" || "${snap}" == "${previous_target}" || "${snap}" == "${protected_prev}" ]] && continue
  kept=$((kept + 1))
  if ((kept > keep_snapshots)); then
    rm -rf "${packages_root:?}/${snap}"
    echo "Pruned old snapshot: ${snap}"
  fi
done < <(list_snapshot_names "${packages_root}" | sort -r)

if ((do_install)); then
  echo "Smoke check: scripts/smoke-test-zcode-preview.sh"
fi
