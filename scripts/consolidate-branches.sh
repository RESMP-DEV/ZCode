#!/usr/bin/env bash
# consolidate-branches.sh — merge ready branches back into alphaheng/main.
# Ready means the tip is on the resmp remote, merges cleanly, installs from the
# frozen lockfile, and typechecks. Never touch the primary worktree or origin.
set -u -o pipefail

if [ -n "${ZCODE_REPO_ROOT:-}" ]; then
  REPO_ROOT="$ZCODE_REPO_ROOT"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
INTEGRATION_BRANCH="alphaheng/main"
REMOTE="resmp"

log() { printf '[consolidate] %s\n' "$*"; }

cd "$REPO_ROOT" || { log "ERROR: cannot enter $REPO_ROOT"; exit 1; }
git fetch "$REMOTE" --prune >/dev/null 2>&1 || log "WARN: git fetch $REMOTE failed; continuing with local refs"

candidates=()
while IFS= read -r ref; do
  branch="${ref#"$REMOTE"/}"
  [ "$branch" = "HEAD" ] && continue
  [ "$branch" = "$INTEGRATION_BRANCH" ] && continue
  ahead=$(git rev-list --count "$INTEGRATION_BRANCH..$ref" 2>/dev/null) || continue
  if [ "$ahead" -gt 0 ] 2>/dev/null; then
    candidates+=("$branch")
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$REMOTE/")

wip_locals=()
while IFS= read -r ref; do
  [ "$ref" = "$INTEGRATION_BRANCH" ] && continue
  ahead=$(git rev-list --count "$INTEGRATION_BRANCH..$ref" 2>/dev/null) || continue
  [ "$ahead" -gt 0 ] 2>/dev/null || continue
  remote_ref="refs/remotes/$REMOTE/$ref"
  unpushed=$ahead
  if git show-ref --verify --quiet "$remote_ref"; then
    unpushed=$(git rev-list --count "$REMOTE/$ref..$ref" 2>/dev/null || echo 0)
  fi
  [ "$unpushed" -gt 0 ] 2>/dev/null || continue
  wip_locals+=("$ref ($unpushed ahead, unpushed)")
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

for w in ${wip_locals[@]+"${wip_locals[@]}"}; do
  log "wip-local (not merged): $w"
done

if [ ${#candidates[@]} -eq 0 ]; then
  log "nothing to consolidate"
  exit 0
fi

base_ref="$INTEGRATION_BRANCH"
remote_ref="refs/remotes/$REMOTE/$INTEGRATION_BRANCH"
if git show-ref --verify --quiet "$remote_ref"; then
  if git merge-base --is-ancestor "$INTEGRATION_BRANCH" "$remote_ref"; then
    base_ref="$remote_ref"
    log "note: basing on $REMOTE/$INTEGRATION_BRANCH (local ref is behind)"
  fi
fi

worktree_root="$(mktemp -d "${TMPDIR:-/tmp}/zcode-consolidate.XXXXXX")"
run_token=$(basename "$worktree_root")
WORKTREE="$worktree_root"
RUN_BRANCH="consolidate/run-$run_token"
rmdir "$WORKTREE"

cleanup() {
  status=$?
  trap - EXIT
  git -C "$REPO_ROOT" worktree remove "$WORKTREE" --force >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" branch -D "$RUN_BRANCH" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! git worktree add "$WORKTREE" -b "$RUN_BRANCH" "$base_ref" >/dev/null 2>&1; then
  log "ERROR: worktree setup failed"
  exit 1
fi
cd "$WORKTREE" || { log "ERROR: cannot enter $WORKTREE"; exit 1; }

if ! pnpm install --frozen-lockfile >/dev/null 2>&1; then
  log "ERROR: pnpm install failed in consolidation worktree"
  exit 1
fi

merged=()
skipped=()
last_good=$(git rev-parse HEAD)
for b in ${candidates[@]+"${candidates[@]}"}; do
  ref="refs/remotes/$REMOTE/$b"
  if git merge --no-ff "$ref" -m "merge: consolidate $b into $INTEGRATION_BRANCH" >/dev/null 2>&1; then
    if ! pnpm install --frozen-lockfile >/dev/null 2>&1; then
      git reset --hard "$last_good" >/dev/null 2>&1
      skipped+=("$b (install)")
      continue
    fi
    if pnpm typecheck >/dev/null 2>&1; then
      if [ "$(git rev-parse HEAD)" != "$last_good" ]; then
        last_good=$(git rev-parse HEAD)
        merged+=("$b")
      fi
    else
      git reset --hard "$last_good" >/dev/null 2>&1
      skipped+=("$b (typecheck)")
    fi
  else
    git merge --abort >/dev/null 2>&1 || true
    skipped+=("$b (conflict)")
  fi
done

if [ ${#merged[@]} -eq 0 ]; then
  for s in ${skipped[@]+"${skipped[@]}"}; do log "skipped: $s"; done
  log "no branches merged"
  exit 0
fi

push_output=""
if ! push_output="$(git push "$REMOTE" HEAD:"$INTEGRATION_BRANCH" 2>&1)"; then
  printf '%s\n' "$push_output" | sed 's/^/[consolidate] push: /'
  log "ERROR: push to $REMOTE failed; nothing published"
  exit 1
fi
if [ -n "$push_output" ]; then
  printf '%s\n' "$push_output" | sed 's/^/[consolidate] push: /'
fi
git branch -f "$INTEGRATION_BRANCH" HEAD 2>/dev/null \
  || log "note: local $INTEGRATION_BRANCH not updated (checked out elsewhere); remote is authoritative"

for m in ${merged[@]+"${merged[@]}"}; do log "merged: $m"; done
for s in ${skipped[@]+"${skipped[@]}"}; do log "skipped: $s"; done
log "published $INTEGRATION_BRANCH -> $REMOTE"
