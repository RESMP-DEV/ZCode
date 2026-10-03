#!/usr/bin/env bash
# consolidate-branches.sh — 把「就绪」的分支合并回 alphaheng/main。
# 就绪 = tip 已推到 resmp 远端、能干净合并、合并后 typecheck 通过。
# 安全边界：绝不触碰主工作树（worktree 隔离）；绝不 push origin（zai-org 只读）；
# 绝不 force-push；typecheck 失败只回退该分支的合并并记为 skipped。
# 退出码：0 = 正常结束（无论是否有合并发生）；1 = 基础设施故障（worktree/push 失败）。
set -u

# REPO_ROOT 可被 ZCODE_REPO_ROOT 覆盖：让 cron 从 /tmp 物化最新版脚本也能正确寻址仓库。
if [ -n "${ZCODE_REPO_ROOT:-}" ]; then
  REPO_ROOT="$ZCODE_REPO_ROOT"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
WORKTREE="/tmp/zcode-consolidate"
INTEGRATION_BRANCH="alphaheng/main"
REMOTE="resmp"

log() { printf '[consolidate] %s\n' "$*"; }

cd "$REPO_ROOT" || { log "ERROR: cannot enter $REPO_ROOT"; exit 1; }

# 刷新远端引用；失败不致命（用本地已有引用继续）。
git fetch "$REMOTE" --prune >/dev/null 2>&1 || log "WARN: git fetch $REMOTE failed; continuing with local refs"

# ---- 候选收集：resmp 远端分支中领先 alphaheng/main 的（本地未推送分支视为 WIP，只报告）----
candidates=()
for ref in $(git for-each-ref --format='%(refname:short)' refs/remotes/"$REMOTE"/); do
  branch="${ref#"$REMOTE"/}"
  [ "$branch" = "HEAD" ] && continue
  # 集成分支自身的远端 ref 不是候选：本地 ref 落后由基准选择处理，
  # 同 tip 的 no-op merge 不应计为「已合并」。
  [ "$branch" = "$INTEGRATION_BRANCH" ] && continue
  ahead=$(git rev-list --count "$INTEGRATION_BRANCH..$ref" 2>/dev/null) || continue
  if [ "$ahead" -gt 0 ] 2>/dev/null; then
    candidates+=("$branch")
  fi
done

wip_locals=()
for ref in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  [ "$ref" = "$INTEGRATION_BRANCH" ] && continue
  ahead=$(git rev-list --count "$INTEGRATION_BRANCH..$ref" 2>/dev/null) || continue
  [ "$ahead" -gt 0 ] 2>/dev/null || continue
  remote_ref="refs/remotes/$REMOTE/$ref"
  # 远端分支已存在时本地仍可能领先（含分叉）：有未推送提交就要报告，
  # 否则脚本会谎报「nothing to consolidate」而隐藏未推送的工作。
  if git show-ref --verify --quiet "$remote_ref"; then
    if ! git merge-base --is-ancestor "$ref" "$remote_ref" 2>/dev/null; then
      wip_locals+=("$ref ($ahead ahead of $INTEGRATION_BRANCH, has unpushed commits)")
    fi
  else
    wip_locals+=("$ref ($ahead ahead, unpushed)")
  fi
done

for w in ${wip_locals[@]+"${wip_locals[@]}"}; do
  log "wip-local (not merged): $w"
done

if [ ${#candidates[@]} -eq 0 ]; then
  log "nothing to consolidate"
  exit 0
fi

# ---- worktree 隔离合并 ----
# 基准选择：本地 ref 可能落后远端（alphaheng/main 被主树 checkout 时无法 branch -f）。
# 取两者的领先者做合并基准，避免基于过期 ref 合并导致 push 被拒。
base_ref="$INTEGRATION_BRANCH"
remote_ref="refs/remotes/$REMOTE/$INTEGRATION_BRANCH"
if git show-ref --verify --quiet "$remote_ref"; then
  if git merge-base --is-ancestor "$INTEGRATION_BRANCH" "$remote_ref"; then
    base_ref="$remote_ref"
    log "note: basing on $REMOTE/$INTEGRATION_BRANCH (local ref is behind)"
  fi
fi
# 所有权标记：只有本脚本创建的 worktree（带 .zcode-consolidate-owner）才允许
# 强制清理；路径被外部占用且不干净时中止，绝不吞掉别人的未提交工作。
owner_marker="$WORKTREE/.zcode-consolidate-owner"
if [ -e "$WORKTREE" ]; then
  if git worktree list --porcelain 2>/dev/null | grep -qx "worktree $WORKTREE"; then
    if [ -n "$(git -C "$WORKTREE" status --porcelain 2>/dev/null)" ] && [ ! -f "$owner_marker" ]; then
      log "ERROR: $WORKTREE has uncommitted changes and no ownership marker; preserving it"
      exit 1
    fi
    git worktree remove "$WORKTREE" --force >/dev/null 2>&1
  else
    log "ERROR: $WORKTREE exists but is not a registered worktree; preserving it"
    exit 1
  fi
fi
# -B 复位残留的 consolidate/run：上次运行中断后分支仍在时，-b 会拒绝创建。
if ! git worktree add "$WORKTREE" -B consolidate/run "$base_ref" >/dev/null 2>&1; then
  log "ERROR: worktree setup failed"
  exit 1
fi
: > "$owner_marker"
# 中断安全的清理：注册 EXIT 陷阱，成功与失败路径统一回收本轮资源。
# shellcheck disable=SC2329
cleanup() {
  git -C "$REPO_ROOT" worktree remove "$WORKTREE" --force >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" branch -D consolidate/run >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "$WORKTREE" || { log "ERROR: cannot enter worktree"; exit 1; }

# 依赖安装是基础设施前提：失败继续跑会让每个候选都因缺依赖被误判 typecheck 失败。
if ! pnpm install --frozen-lockfile >/dev/null 2>&1; then
  log "ERROR: pnpm install failed; aborting before candidate evaluation"
  exit 1
fi

merged=()
skipped=()
last_good=$(git rev-parse HEAD)
for b in ${candidates[@]+"${candidates[@]}"}; do
  ref="refs/remotes/$REMOTE/$b"
  if git merge --no-ff "$ref" -m "merge: consolidate $b into $INTEGRATION_BRANCH" >/dev/null 2>&1; then
    # 候选改了 lockfile 时必须按合并后的 lockfile 重装，否则用基准依赖树
    # typecheck 会把引入新依赖的合法合并误判为失败。
    install_ok=1
    if ! git diff --quiet "$last_good" HEAD -- pnpm-lock.yaml 2>/dev/null; then
      install_ok=0
      pnpm install --frozen-lockfile >/dev/null 2>&1 && install_ok=1
    fi
    if [ "$install_ok" -eq 1 ] && pnpm typecheck >/dev/null 2>&1; then
      if [ "$(git rev-parse HEAD)" != "$last_good" ]; then
        last_good=$(git rev-parse HEAD)
        merged+=("$b")
      fi
    elif [ "$install_ok" -eq 0 ]; then
      # 合并后依赖装不上：回退并单列原因，与 typecheck 失败区分。
      git reset --hard "$last_good" >/dev/null 2>&1
      skipped+=("$b (install)")
    else
      # 该分支合并破坏 typecheck：回退到上一个绿色点，只跳过这一支。
      git reset --hard "$last_good" >/dev/null 2>&1
      skipped+=("$b (typecheck)")
    fi
  else
    git merge --abort >/dev/null 2>&1
    skipped+=("$b (conflict)")
  fi
done

if [ ${#merged[@]} -eq 0 ]; then
  for s in ${skipped[@]+"${skipped[@]}"}; do log "skipped: $s"; done
  log "no branches merged"
  # worktree/branch 回收由 EXIT 陷阱统一处理。
  exit 0
fi

# push 状态必须单独捕获：管道会让 bash 取最后一个命令的退出码，push 失败被
# sed/grep 掩盖成「发布成功」；失败时打印完整输出便于诊断。
if push_output="$(git push "$REMOTE" HEAD:"$INTEGRATION_BRANCH" 2>&1)"; then
  printf '%s\n' "$push_output" | grep -v '^remote:' | grep -v '^To ' | sed 's/^/[consolidate] push: /' || true
else
  printf '%s\n' "$push_output" | sed 's/^/[consolidate] push: /'
  log "ERROR: push to $REMOTE failed; nothing published"
  exit 1
fi
git branch -f "$INTEGRATION_BRANCH" HEAD 2>/dev/null \
  || log "note: local $INTEGRATION_BRANCH not updated (checked out elsewhere); remote is authoritative"

for m in ${merged[@]+"${merged[@]}"}; do log "merged: $m"; done
for s in ${skipped[@]+"${skipped[@]}"}; do log "skipped: $s"; done
log "published $INTEGRATION_BRANCH -> $REMOTE"

# worktree/branch 回收由 EXIT 陷阱统一处理。
exit 0
