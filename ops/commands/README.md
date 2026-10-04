# ops/commands

Owner-committed maintenance commands (spec §8.5, D-58). There is no `workflow_dispatch` on `maintenance.yml`
because the public submission token could call it; instead, anything costly or destructive runs from a file
committed here. Only the owner can push to `main`, so a command file is the authorization.

## How it works

1. Commit a file named `<YYYYMMDD-HHMM>-<action>.json` to `main` under this directory.
2. The push triggers `maintenance.yml`. Its `plan` job picks the **newest** file whose name is not listed in
   `.done` and runs that one action. One push, one command.
3. When the run finishes (success or failure) the bot appends `<file> <outcome> <run id>` to `.done` and pushes
   that commit. Bot pushes do not trigger workflows, so there is no loop.

A failed command is still marked done, so a costly action is never re-run by accident. To retry, commit a new
file with a later timestamp. The nightly schedule ignores this directory entirely; it always runs `nightly`.

## File shape

```json
{ "action": "rotate-anchors", "args": { "category": "tech", "generate": true } }
```

`args` is optional and must be an object. Keys are sorted, two-space indent, trailing newline, like every JSON
file in the repository.

| action | concurrency group | args | what it does |
|---|---|---|---|
| `nightly` | `rerank` | none | the 04:17 UTC job, on demand: snapshots, RD inflation, drift, compaction, audits (spec §9.5) |
| `drain-queue` | `rerank` | none | processes `queue/analysis/*` without the per-run cap; the daily budget still applies |
| `squash-data-history` | `rerank` | none | rewrites the `data` branch to one snapshot commit (also runs every Sunday night) |
| `rebuild-indexes` | `rerank` | none | no-op in the engine; the workflow's deploy step rebuilds the Pages tree |
| `reanalyze` | `maintenance-long` | `{ "ids"?: [...], "all"?: true, "since"?: "YYYY-MM-DD", "rebump"?: true }` | re-runs the analyst on the selection (≤ 200 per run, budget-gated); ratings untouched unless `rebump` |
| `rotate-anchors` | `maintenance-long` | `{ "category": "<cat>", "generate"?: true, "cards"?: [...] }` | writes `anchors/<cat>.json` (≈ $2 per category when generating), then validates |
| `validate-anchors` | `maintenance-long` | `{ "category": "<cat>" }` | adjacent-pair judging; report under `audits/`, failures into `health.alerts` |

The `rerank` group shares the writer lock with `rerank.yml`, so none of those actions overlaps a rerank.
`maintenance-long` actions can run next to a rerank; they only touch `resumes/`, `rows/`, `cards/`, `anchors/`
and `audits/`.

## Examples

```bash
ts=$(date -u +%Y%m%d-%H%M)
printf '{\n  "action": "rotate-anchors",\n  "args": {\n    "category": "tech",\n    "generate": true\n  }\n}\n' > "ops/commands/$ts-rotate-anchors.json"
git add ops/commands && git commit -m "ops: rotate tech anchors" && git push
gh run watch --repo noahfinkelstein/resumearena   # pick the maintenance run
```

To check what would run without pushing: `node scripts/plan-maintenance.ts --event push`.
