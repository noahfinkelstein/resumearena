# Pause and resume submissions

`settings.json` on the `data` branch is the kill switch (spec §3.3). While `paused` is true the SPA refuses to
dispatch and shows `pause_message`; anything that still arrives (stale clients, the Issue form) is stored as a
`queued (paused)` stub plus `queue/analysis/<id>.json` with the key blanked, at no LLM cost. Reranks and deploys
keep running; the ladders stay live.

## Pause

```bash
R=noahfinkelstein/resumearena
tmp=$(mktemp -d)
git clone --quiet --depth 1 --filter=blob:none --sparse -b data "https://github.com/$R.git" "$tmp"
cd "$tmp" && git sparse-checkout set --no-cone /settings.json
node -e '
  const fs = require("node:fs");
  const s = JSON.parse(fs.readFileSync("settings.json", "utf8"));
  s.paused = true;
  s.pause_message = process.argv[1];
  fs.writeFileSync("settings.json", JSON.stringify(s, Object.keys(s).sort(), 2) + "\n");
' "Entries are paused while we fix something. The ladders still work."
git commit -am "settings: pause" && git push origin HEAD:data
```

`scripts/data-push.sh` wraps the same edit in the fetch-reset-reapply loop if a bot push lands at the same time.
The next deploy (within ~10 minutes of the next rerank, or `gh workflow run deploy.yml --ref main -f reason=pause`
right away) publishes the paused flag to `status.json`/`settings.json` on Pages; browsers see it within a minute.

## Resume

Set `paused` back to `false` (and `pause_message` to `""`) the same way, then drain anything that queued:

```bash
ts=$(date -u +%Y%m%d-%H%M)
printf '{\n  "action": "drain-queue"\n}\n' > "ops/commands/$ts-drain-queue.json"
git add ops/commands && git commit -m "ops: drain queue after pause" && git push
```

The next rerank drains up to `max_deferred_analyses_per_run` per run anyway; the command file only speeds it up.

## Related knobs in settings.json

| key | effect |
|---|---|
| `daily_budget_usd` | the daily analysis + judge ceiling; the hard stop is 1.15× |
| `max_submissions_per_hour` | runs above this are dropped without writing anything (D-43) |
| `refine_budget_share` | share of the budget refinement may spend |

Every edit is validated by the engine on its next load; a bad key fails the run naming it, so check the next
rerank's summary after an edit.
