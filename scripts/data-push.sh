#!/usr/bin/env bash
# Shell version of the engine's fetch-reset-reapply-push loop (spec §9.2) for one-off edits to the data branch.
#
#   scripts/data-push.sh <data-dir> "<commit message>" <command that (re)writes files inside data-dir>...
#
# <data-dir> is a clone with `origin` pointing at the repository (a sparse, blobless one is fine; see
# ops/runbooks/pause.md). On every attempt the tree is reset to the remote tip, the command runs again on the
# fresh tree, and the result is pushed. Never pull --rebase, never --force. Exit 0 with `noop` when the command
# changed nothing, `pushed` on success, 1 after eight rejected pushes.
set -euo pipefail

if [ $# -lt 3 ]; then
  sed -n '2,9p' "$0" >&2
  exit 2
fi
dir=$1
msg=$2
shift 2

if [ ! -d "$dir/.git" ] && ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  echo "data-push: $dir is not a git checkout" >&2
  exit 1
fi

git -C "$dir" config user.name >/dev/null 2>&1 || git -C "$dir" config user.name "resumearena-bot"
git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for i in 1 2 3 4 5 6 7 8; do
  git -C "$dir" fetch --quiet --depth=1 origin data
  git -C "$dir" reset --quiet --hard FETCH_HEAD
  # The command sees the data dir as its working directory, like a mutation's apply(root).
  (cd "$dir" && "$@")
  git -C "$dir" add --sparse -A
  if git -C "$dir" diff --cached --quiet; then
    echo noop
    exit 0
  fi
  git -C "$dir" commit --quiet -m "$msg"
  if out=$(git -C "$dir" push --quiet origin HEAD:data 2>&1); then
    echo pushed
    exit 0
  fi
  case "$out" in
    *non-fast-forward*|*"fetch first"*|*rejected*|*"cannot lock ref"*)
      delay=$(( (400 * (1 << (i - 1)) + RANDOM % 400) ))
      echo "data-push: push rejected (attempt $i/8), retrying in ${delay} ms" >&2
      sleep "$(awk "BEGIN { print $delay / 1000 }")"
      ;;
    *)
      echo "$out" >&2
      exit 1
      ;;
  esac
done
echo "data-push: gave up after 8 attempts for \"$msg\"" >&2
exit 1
