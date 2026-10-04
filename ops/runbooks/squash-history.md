# Squash the data branch history

The `data` branch is a snapshot, not a log. Every Sunday the nightly maintenance rewrites it to a single commit
(spec D-29) so deleted text leaves the repository's history within 7 days and the clone stays small. This
runbook is for doing it on demand: after a takedown, or when the repository size line in the nightly summary
passes 2 GB.

## On demand

```bash
ts=$(date -u +%Y%m%d-%H%M)
printf '{\n  "action": "squash-data-history"\n}\n' > "ops/commands/$ts-squash-data-history.json"
git add ops/commands && git commit -m "ops: squash data history" && git push
```

What the engine does: `git fetch origin data` (blobless) → `tree=$(git rev-parse FETCH_HEAD^{tree})` →
`new=$(git commit-tree "$tree" -m "data: snapshot <date>")` → `git push --force-with-lease=refs/heads/data:<old>
origin "$new:refs/heads/data"`, retrying on lease failure. Seconds, no checkout, no working-tree rewrite. Writers
that race it survive because every writer uses the fetch-reset-reapply loop, never `pull --rebase`.

## By hand (if Actions is unavailable)

```bash
R=noahfinkelstein/resumearena
tmp=$(mktemp -d) && git clone --quiet --bare --filter=blob:none "https://github.com/$R.git" "$tmp" && cd "$tmp"
old=$(git rev-parse refs/heads/data)
tree=$(git rev-parse "$old^{tree}")
new=$(git -c user.name=resumearena-bot -c user.email=41898282+github-actions[bot]@users.noreply.github.com commit-tree "$tree" -m "data: snapshot $(date -u +%F)")
git push --force-with-lease=refs/heads/data:$old origin "$new:refs/heads/data"
```

Do not use `--force` without the lease: a submit could land between your fetch and your push.

## Afterwards

- Old objects remain reachable on GitHub's side for a while (unreachable-object GC is theirs, not ours). For a
  takedown that must be complete, contact GitHub support with the commit SHAs; the privacy copy promises "within
  7 days" of removal from history, not of GitHub's storage.
- Forks made before the squash keep their copy; the copy says so.
- Workflows are unaffected: every clone is `--depth=1`.
