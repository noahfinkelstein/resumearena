#!/usr/bin/env bash
# Create the orphan `data` branch (spec §15 step 1): a tree from `engine data init`, committed and pushed.
#
#   scripts/bootstrap-data.sh [--remote origin] [--force]
#
# Works in a temporary git worktree so the main working tree, its index and any uncommitted changes are never
# touched. Refuses to run when the remote already has a `data` branch unless --force is given (which replaces it;
# everything on the old branch is lost).
set -euo pipefail

remote=origin
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) remote=$2; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"

if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "bootstrap-data: remote '$remote' is not configured" >&2
  exit 1
fi
if git ls-remote --exit-code --heads "$remote" data >/dev/null 2>&1; then
  if [ "$force" -ne 1 ]; then
    echo "bootstrap-data: '$remote' already has a data branch; pass --force to replace it (destructive)" >&2
    exit 1
  fi
  echo "bootstrap-data: replacing the existing data branch on '$remote'"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/resumearena-data.XXXXXX")
cleanup() {
  git worktree remove --force "$work" >/dev/null 2>&1 || rm -rf "$work"
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# A detached worktree gives us a second index and working tree; the orphan checkout then empties it.
git worktree add --quiet --detach "$work" HEAD
git -C "$work" checkout --quiet --orphan data
git -C "$work" rm -rfq --cached . >/dev/null
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

echo "bootstrap-data: engine data init"
node "$root/engine/src/cli.ts" data init "$work"

test -f "$work/settings.json" || { echo "bootstrap-data: engine did not write settings.json" >&2; exit 1; }
test -f "$work/.gitattributes" || { echo "bootstrap-data: engine did not write .gitattributes" >&2; exit 1; }

git -C "$work" add -A
git -C "$work" \
  -c user.name=resumearena-bot \
  -c user.email=41898282+github-actions[bot]@users.noreply.github.com \
  commit --quiet -m "data: init"

if [ "$force" -eq 1 ]; then
  git -C "$work" push --force "$remote" HEAD:refs/heads/data
else
  git -C "$work" push "$remote" HEAD:refs/heads/data
fi
git fetch --quiet "$remote" data
echo "bootstrap-data: pushed $(git -C "$work" rev-parse --short HEAD) to $remote/data"
echo "next: labels, then the owner checklist (README.md → Owner setup), then the first deploy"
