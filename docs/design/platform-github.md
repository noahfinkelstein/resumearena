# ResumeArena — GitHub-native platform design

Status: design v2 · Owner: Noah Finkelstein · Date: 2026-10-03
Supersedes: `platform-security.md` (Supabase). Companion docs: `ranking-system.md` (math, unchanged), `scoring-rubric.md` (analysis schema and prompts; §1.1–1.2 of that doc change input from PDF to text, see §K), `product-ux.md` (voice, IA, components; flows revised in §K).

Everything runs on GitHub (Pages, Actions, the repository, Issues) plus the Anthropic API. There is no server, no database vendor, no auth vendor, nobody signs in.

---

## 0. Platform facts this design relies on

The owner waived the documentation-verification pass for this revision ("no need for verification"). Every row below is therefore an **assumption from memory, not verified this run**; each carries the official page the implementer should confirm before the first deploy, and the design states what breaks if the assumption is wrong.

| # | Fact assumed | Source to confirm | If wrong |
|---|---|---|---|
| 1 | `workflow_dispatch` accepts at most 25 top-level inputs (older REST page says 10) and the whole `inputs` payload is capped at 65,535 characters. | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_dispatch and https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event | Design uses exactly 10 inputs and ≤ 22,000 characters, so it fits either reading. If the cap is smaller, `text` moves to two inputs. |
| 2 | The REST endpoint `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` requires the fine-grained PAT repository permission **Actions: write** (Metadata: read is implied). It returns `204 No Content`. | https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event (section "Fine-grained access tokens") | If `Contents: read` were also required the token scope grows by one read permission; threat model in §D is unchanged. |
| 3 | Concurrency: at most one running and one **pending** run per group; a newer pending run cancels the older pending one; `cancel-in-progress: true` also cancels the running one. Group names are repository-scoped, so two workflows can share a group. | https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs | Rerank coalescing (§C) relies on the "one pending" rule; if several runs could queue, rerank would still be correct (serialized) but would run more often. |
| 4 | `schedule`: shortest interval 5 minutes; runs may be delayed or skipped under load; only the default branch's workflow file is scheduled; in a public repo, scheduled workflows are **disabled after 60 days without repository activity** (activity = commits/pushes by a user; whether `github-actions[bot]` pushes count is not documented). | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule | Design does not depend on cron: every submission also triggers rerank via `workflow_run`, and rerank re-enables its own schedule with `PUT .../workflows/rerank.yml/enable` on every run. |
| 5 | GitHub Pages: published site ≤ 1 GB, soft bandwidth 100 GB/month, soft limit 10 builds/hour **which does not apply to sites deployed with a custom Actions workflow** (`actions/deploy-pages`). | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | Deploys run up to ~150 times/day. If the 10/hour limit did apply, deploy would be rate-limited to one per 6 minutes inside `deploy.yml` (a `sleep` guard keyed on the last deploy time in `status.json`). |
| 6 | `raw.githubusercontent.com` responds with `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=300`; the CDN may also cache 404s for the same window; whether the query string is part of the cache key is not documented. | https://docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files#viewing-or-copying-the-raw-file-content (behaviour observed in practice, not formally documented) | Freshness of per-resume reads is 5 minutes in the worst case; the UI copy already says "a few minutes". If CORS were absent the SPA would read per-resume files from Pages instead, at the artifact-size cost discussed in §A.4. |
| 7 | REST rate limits: `GITHUB_TOKEN` in Actions 1,000 requests/hour/repository; a user's PAT 5,000 requests/hour (shared by every browser that holds the embedded token); unauthenticated 60/hour/IP; secondary limit of 500 content-creating requests/hour and 80/minute per token. | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api | The 500/hour content-creating limit is a hard global ceiling on dispatch-channel submissions; the engine's own hourly cap (default 60) sits far below it. |
| 8 | Free accounts: 20 concurrent jobs (5 macOS); standard runners are free on public repositories; job timeout max 6 h; at most 500 workflow runs queued per 10-second window per repository. | https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration | The repo being **public** is load-bearing for cost: ~20–30 runner-hours/day at 1,000 submissions/day would cost ~$300/month on a private repo. |
| 9 | Secret scanning in public repositories detects GitHub tokens (`ghp_`, `github_pat_`) in commits, issues, pull requests, discussions and wikis and **automatically revokes** them; it does not scan Pages artifacts or Actions variables. | https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning and https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns | The token lives only in a repository variable and the built bundle, never in git. Anyone pasting it into an issue triggers automatic revocation, which the SPA treats as the expected degradation path (§D.6). |
| 10 | `actions/upload-pages-artifact` produces a single tar artifact; `actions/deploy-pages` rejects artifacts over 10 GB and times out after 10 minutes; file names may not contain `:` or `*`. | https://github.com/actions/upload-pages-artifact#readme and https://github.com/actions/deploy-pages#readme | Our artifact is ≤ ~120 MB at 100k resumes (§A.4). Ids are base32 lowercase, so no forbidden characters. |

Two further behaviours the design depends on, also from memory: (a) pushes and issue comments made with `GITHUB_TOKEN` **do not trigger** `push`/`issues` workflows (they do trigger `workflow_dispatch` and `workflow_run`), so `deploy.yml` is dispatched explicitly rather than listening on `push: data`; (b) the `github-pages` environment created by "Source: GitHub Actions" only accepts deployments from the default branch, so every deploy run must be on `ref: main`.

---

## 1. Architecture in one page

```
 Browser (static SPA on GitHub Pages, /resumearena/)
 ───────────────────────────────────────────────────────────────────────────
 PDF/DOCX/paste ─▶ pdfjs/mammoth ─▶ layout metrics ─▶ PII scrub ─▶ editable preview
   "exactly this text becomes public"
   handle + owner key (32 random bytes, kept in localStorage, shown once) ─▶ owner_hash = sha256(key)
   id = 10-char base32 from crypto.getRandomValues
        │
        │ primary: POST api.github.com/repos/noahfinkelstein/resumearena/actions/workflows/submit.yml/dispatches
        │          Authorization: Bearer <fine-grained PAT, Actions: read/write on this repo only, baked at build>
        │ fallback: GitHub Issue Form (same fields) when the token probe fails
        ▼
 GitHub Actions
   submit.yml   (one run per submission, parallel-safe, ~2–3 min)
     validate → caps/budget → dedupe → haiku gate → opus analysis (structured output)
     → write resumes/<ab>/<id>.json, users/<h2>/<handle>.json, rows/<ab>.json, dedupe/<hh>/<sha>.json,
       queue/placement/<id>.json, usage/<day>.jsonl   (fetch-reset-reapply-push loop)
     → workflow_run ─────────────────────────────────────────────┐
   rerank.yml   (cron */10 + after every submit, concurrency group `rerank`, serialized)
     placement rounds (sonnet judge, both orderings, realtime) → refinement (Message Batches, 50% price)
     → Glicko updates → ratings/<cat>.json, history/<cat>/<ab>/<id>.json, matches/<yyyy-mm>/<dd>/<cat>.jsonl,
       arena/<cat>.json, status.json → `gh workflow run deploy.yml` when anything changed
   deploy.yml   (push to main, dispatch; concurrency `pages`, cancel-in-progress)
     vite build (token + build id injected) + engine build-indexes → /resumearena/data/** → actions/deploy-pages
   maintenance.yml (nightly: RD inflation, drift check, snapshots, compaction; dispatch: reanalyze, rebuild-indexes,
                    rotate-anchors, squash-data-history; shares concurrency group `rerank`)
        │
        ▼
 Data branch `data` (orphan, JSON files, source of truth)        Pages artifact (derived read model)
   settings.json status.json anchors/ resumes/ users/ rows/        data/manifest.json data/status.json
   ratings/ history/ matches/ queue/ usage/ dedupe/ arena/          data/ladder/<cat>/<page>.json  data/rank/<ab>.json
                                                                   data/arena/<cat>.json data/stats.json
 Reads from the SPA
   indexes, ranks, status  ─▶ Pages (same origin, max-age 600)
   one resume, one profile, one history ─▶ raw.githubusercontent.com/noahfinkelstein/resumearena/data/<path> (CORS *, max-age 300)
```

Design principles, in order:

1. **One secret, one public token.** `ANTHROPIC_API_KEY` is the only credential that must stay secret, and it never leaves Actions. The submission token is public by design and can do nothing but trigger, cancel and tidy workflows in this one repository (§D.5).
2. **Append-only where writers are parallel, serialized where state is shared.** Submissions only ever *create* files or append JSONL lines; everything that mutates shared state (ratings, queue, status) runs under one concurrency group.
3. **The data branch is a snapshot, not a log.** Its git history is disposable (squashed on request); the audit trail is the `matches/` and `usage/` JSONL files inside the snapshot.
4. **Volatile data is served by Pages, stable data by raw.** A resume document changes a handful of times in its life; its rank changes every ten minutes. They are stored and fetched separately so neither write path has to touch 100k files.
5. **Honest latency.** Nothing in the UI pretends to be realtime. The result page says "a few minutes" and means it.

---

## A. Repository and data layout

### A.1 Code repository (`main`)

```
resumearena/
  .github/
    workflows/
      submit.yml            # workflow_dispatch + issues:opened  → engine submit
      rerank.yml            # schedule + workflow_run + dispatch → engine rerank
      deploy.yml            # push main + dispatch               → vite build + engine build-indexes + deploy-pages
      maintenance.yml       # nightly schedule + guarded dispatch → engine maintenance <action>
    actions/
      setup/action.yml      # composite: pnpm + Node 24 + cached install
      data-checkout/action.yml  # composite: partial, sparse checkout of the data branch into ./data
    ISSUE_TEMPLATE/
      submission.yml        # fallback submission form (same fields as the dispatch inputs)
      delete.yml            # fallback delete form (id + owner key)
      config.yml            # blank_issues_enabled: false, contact link to /about
  web/                      # Vite + React 19 + TypeScript SPA (pnpm workspace member)
    public/404.html         # SPA redirect stub (product-ux.md §2.3)
    src/
      lib/github.ts         # dispatch(), probeToken(), issueFormUrl()
      lib/data.ts           # fetchers for Pages indexes and raw documents, cache-busting, polling
      lib/ownerKey.ts       # generate, store, export, sha256
      lib/ingest/{pdf.ts,docx.ts,metrics.ts,pii.ts}
      pages/...             # routes from product-ux.md, revised in §K
  engine/                   # Node 24 CLI, run with native type stripping (no build step)
    src/cli.ts
    src/commands/{submit,rerank,build-indexes,maintenance,fixtures,data}.ts
    src/adapters/{dispatch.ts,issue.ts}      # both triggers → SubmissionInput
    src/store/{git.ts,paths.ts,commit.ts}    # sparse materialize, fetch-reset-reapply-push loop
    src/llm/{client.ts,gate.ts,analyst.ts,judge.ts,batches.ts,pricing.ts}
    src/rank/{placement.ts,refine.ts,glicko-apply.ts,anchors.ts}
    src/index/{ladder.ts,rank-shards.ts,arena.ts}
    prompts/                # analyst.v1.md, judge.<category>.v1.md, gate.v1.md (byte-stable, versioned)
    schemas/                # resume-analysis.v1.json, pairwise-verdict.v1.json, gate.v1.json
  packages/shared/src/      # pure, dependency-free TypeScript used by web and engine
    types.ts  glicko.ts  tiers.ts  ids.ts  handles.ts  pii.ts  issue-form.ts  hash.ts  constants.ts
    handles/blocklist.ts    # vendored profanity + reserved words (see §D.3)
  fixtures/
    synthetic/              # 60 synthetic resumes with real analyses (generated once, committed)
    web-data/               # a pre-built /data tree for VITE_MOCK=1
  ops/runbooks/             # rotate-token.md, pause.md, squash-history.md, delete-issue.md
  docs/design/
  package.json pnpm-workspace.yaml .nvmrc(24) tsconfig.base.json
```

Engine and shared code use only erasable TypeScript syntax (`erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, explicit `.ts` import specifiers) so `node engine/src/cli.ts` runs directly on Node 24 with no compile step in the workflows. Vite handles the same files for the web bundle.

### A.2 Data branch (`data`, orphan)

```
data (orphan branch; no shared history with main)
  .gitattributes                 # usage/**/*.jsonl merge=union · matches/**/*.jsonl merge=union · failures/**/*.jsonl merge=union
  settings.json                  # operator knobs; edited by the owner by hand or via maintenance
  status.json                    # written by rerank/maintenance only
  anchors/<category>.json        # locked anchor ladder + score→rating map
  resumes/<ab>/<id>.json         # one document per entry; ab = first two chars of id (1,024 shards)
  users/<h2>/<handle>.json       # one document per handle; h2 = first two chars of handle
  rows/<ab>.json                 # compact leaderboard rows, map id → row (denormalized read model)
  dedupe/<hh>/<sha256>.json      # content-hash → id; hh = first two hex chars (256 shards)
  ratings/<category>.json        # map id → {r, rd, vol, n, w, l, d, last, placed, r7, peak}
  history/<category>/<ab>/<id>.json   # compacted sparkline + last 10 matches for one (resume, category)
  matches/<yyyy-mm>/<dd>/<category>.jsonl   # append-only match log
  arena/<category>.json          # rolling pool of 80 decided matches with both cards and the judge's reasons
  queue/placement/<id>.json      # placement/revision state machine, one file per queued resume
  queue/analysis/<id>.json       # analyses deferred by budget or hourly cap
  queue/batches/<batch_id>.json  # open Message Batches jobs (refinement, reanalysis)
  usage/<yyyy-mm-dd>.jsonl       # spend ledger, one line per LLM call
  failures/<yyyy-mm-dd>.jsonl    # one line per failed run step (for status + triage)
```

Sharding rule, everywhere: a per-id file lives under a directory named by the first two characters of the id (base32 alphabet → 32 × 32 = 1,024 shards). At 100k resumes a shard holds ~100 files. This keeps every git tree object small (a 100k-entry directory would be a 4 MB tree rewritten on every commit) and lets a workflow materialize one shard (~2.5 MB) instead of everything.

### A.3 File schemas

**`settings.json`** (operator-owned; the engine reads it at the start of every run and never writes it except through `maintenance set`):

```json
{
  "schema": 1,
  "paused": false,
  "pause_message": "",
  "daily_budget_usd": 25,
  "refine_budget_share": 0.30,
  "analysis_reserve_usd": 5,
  "max_submissions_per_hour": 60,
  "max_text_chars": 15000,
  "min_text_chars": 400,
  "models": {
    "gate": "claude-haiku-4-5",
    "analyst": "claude-opus-5-5",
    "judge": "claude-sonnet-5-5",
    "analyst_effort": "high",
    "judge_effort": "low"
  },
  "prompts": { "gate": "v1", "analyst": "v1", "judge": "v1", "schema": "v1", "taxonomy": "v1" },
  "prices_usd_per_mtok": {
    "claude-haiku-4-5":  { "input": 1.00, "cache_read": 0.10, "cache_write_5m": 1.25, "cache_write_1h": 2.00, "output": 5.00,  "batch": 0.5 },
    "claude-sonnet-5-5": { "input": 2.00, "cache_read": 0.20, "cache_write_5m": 2.50, "cache_write_1h": 4.00, "output": 10.00, "batch": 0.5 },
    "claude-opus-5-5":   { "input": 4.00, "cache_read": 0.20, "cache_write_5m": 5.00, "cache_write_1h": 8.00, "output": 20.00, "batch": 0.5 }
  },
  "rating": {
    "rd_initial": 350, "rd_initial_with_prior": 250, "rd_initial_domain": 220,
    "rd_floor": 50, "rd_ceiling": 350, "rd_inflation_c": 6, "rd_revision_min": 180, "provisional_rd": 130,
    "placement_rounds_general": [3, 3, 2], "placement_rounds_domain": [3, 3],
    "revision_rounds_general": [3, 2], "revision_rounds_domain": [3],
    "category_relevance_min": 0.35,
    "opponent_mix": { "local": 0.70, "crosscheck": 0.20, "anchor": 0.10 },
    "drift_mode": "anchors", "drift_max_shift": 10, "drift_alert_residual": 0.08,
    "refine_transport": "batch",
    "max_refine_matches_per_run": 120,
    "max_placement_concurrency": 10,
    "est_cost_per_match_usd": 0.0165
  },
  "tiers": [
    { "key": "entrant",     "label": "Entrant",     "numeral": "I",    "min": -1e9, "blurb": "Below 1200. Most placements start here." },
    { "key": "contender",   "label": "Contender",   "numeral": "II",   "min": 1200, "blurb": "1200–1399. Clears the median on at least one ladder." },
    { "key": "challenger",  "label": "Challenger",  "numeral": "III",  "min": 1400, "blurb": "1400–1599. Consistently preferred by the judge." },
    { "key": "candidate",   "label": "Candidate",   "numeral": "IV",   "min": 1600, "blurb": "1600–1799. Top quarter on its ladder." },
    { "key": "expert",      "label": "Expert",      "numeral": "V",    "min": 1800, "blurb": "1800–1999. Top tenth." },
    { "key": "master",      "label": "Master",      "numeral": "VI",   "min": 2000, "blurb": "2000–2199. Top 2 percent." },
    { "key": "grandmaster", "label": "Grandmaster", "numeral": "VII",  "min": 2200, "blurb": "2200–2399. Top half-percent." },
    { "key": "laureate",    "label": "Laureate",    "numeral": "VIII", "min": 2400, "blurb": "2400 and above. Rarely more than a few dozen at a time." }
  ],
  "provisional_blurb": "Not yet placed. The rating is a guess until placement finishes.",
  "retention": { "deleted_text_purge_days": 90, "arena_pool_size": 80, "history_points": 60, "history_recent": 10 }
}
```

**`status.json`** (engine-owned; copied verbatim into the Pages artifact):

```json
{
  "schema": 1,
  "updated_at": "2026-10-03T14:20:11Z",
  "paused": false,
  "budget": { "day": "2026-10-03", "daily_usd": 25, "spent_usd": 7.12, "refine_spent_usd": 1.90, "exhausted": false },
  "queue": { "placement": 3, "analysis": 0, "open_batches": 1, "oldest_queued_at": "2026-10-03T14:12:40Z" },
  "last_rerank": { "run_id": 123456789, "at": "2026-10-03T14:20:00Z", "trigger": "workflow_run", "matches": 42, "placements_completed": 3, "duration_s": 311, "changed": true },
  "last_submission_at": "2026-10-03T14:11:02Z",
  "last_deploy_requested_at": "2026-10-03T14:20:10Z",
  "counts": { "resumes": 1234, "rated": 1180, "placing": 3, "queued": 0, "rejected": 40, "duplicate": 9, "deleted": 12, "users": 900, "matches": 23456, "anchors": 48 },
  "per_category": {
    "general":  { "rated": 1180, "mean": 1512, "sd": 196, "anchor_residual_7d": 0.012, "disagreement_rate_7d": 0.21 },
    "finance":  { "rated": 210,  "mean": 1498, "sd": 188, "anchor_residual_7d": -0.030, "disagreement_rate_7d": 0.24 },
    "tech":     { "rated": 640,  "mean": 1520, "sd": 201, "anchor_residual_7d": 0.004, "disagreement_rate_7d": 0.19 },
    "academia": { "rated": 150,  "mean": 1490, "sd": 210, "anchor_residual_7d": 0.051, "disagreement_rate_7d": 0.27 }
  },
  "health": {
    "schedule_enabled": true,
    "token_expires": "2027-10-01",
    "failed_runs_24h": 1,
    "cancelled_runs_24h": 0,
    "issue_path_24h": 0,
    "dispatch_path_24h": 96,
    "alerts": []
  },
  "versions": { "engine": "0.3.0", "analyst_prompt": "v1", "judge_prompt": "v1", "schema": "v1", "taxonomy": "v1" }
}
```

**`resumes/<ab>/<id>.json`** — the entry document. The rating is deliberately *not* in it (it lives in `ratings/` and the Pages rank shard), so the document changes only on status transitions, visibility toggles, re-analysis and deletion.

```json
{
  "schema": 1,
  "id": "k7q2m3xw5a",
  "kind": "user",
  "status": "rated",
  "handle": "priya-n",
  "visibility": "anonymous",
  "owner_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "created_at": "2026-10-03T14:11:02Z",
  "updated_at": "2026-10-03T14:13:40Z",
  "source": { "kind": "dispatch", "run_id": 123456700, "client_version": "web-0.3.0" },
  "text": "…the anonymized text exactly as the user approved it…",
  "text_sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
  "metrics": { "source": "pdf", "pages": 2, "columns": 1, "fonts": 3, "images": 0, "chars": 4210, "words": 640, "extraction_quality": 0.96, "has_text_layer": true, "scrubbed": { "emails": 1, "phones": 1, "urls": 2, "addresses": 0, "names": 1 } },
  "gate": { "model": "claude-haiku-4-5", "prompt": "v1", "is_resume": true, "spam": false, "injection_suspected": false, "language": "en" },
  "analysis": { "…ResumeAnalysis per scoring-rubric.md §2.2, minus detected_pii…": true },
  "card": { "…anonymized card per scoring-rubric.md §2.3…": true },
  "scores": { "general": 71, "tech": 78 },
  "categories": { "general": 1.0, "tech": 0.82, "finance": 0.10, "academia": 0.05 },
  "stage": "mid",
  "top_signal": "40k rps system",
  "versions": { "analyst_model": "claude-opus-5-5", "analyst_prompt": "v1", "schema": "v1", "taxonomy": "v1" },
  "usage": { "gate_usd": 0.0046, "analysis_usd": 0.1880 },
  "supersedes": null,
  "superseded_by": null,
  "rejected_reason": null,
  "duplicate_of": null,
  "deleted_at": null
}
```

`status` is one of `queued | analyzed | placing | rated | needs_review | rejected | duplicate | deleted`. A tombstone (`deleted`) keeps only `schema, id, kind, status, deleted_at, text_sha256` so the id can never be reused and the result page can say "This entry was deleted by its owner."

**`users/<h2>/<handle>.json`**

```json
{
  "schema": 1,
  "handle": "priya-n",
  "owner_hash": "9f86d081…",
  "created_at": "2026-10-03T14:11:02Z",
  "state": "active",
  "resumes": [ { "id": "k7q2m3xw5a", "created_at": "2026-10-03T14:11:02Z", "current": true } ],
  "key_exposed": false
}
```

`state` is `active | tombstone`. A tombstone keeps `owner_hash` so the handle remains reserved for the key holder (anyone else gets `handle_taken`). `key_exposed` is set when a delete arrives via the Issue path (the raw key is then public); the only action an exposed key may still perform is `delete`.

**`rows/<ab>.json`** — map id → compact row used by the index builder; written by submit (insert), manage (visibility, delete) and reanalysis.

```json
{ "k7q2m3xw5a": { "h": "priya-n", "v": "anonymous", "st": "mid", "sig": "40k rps system", "c": { "general": 1.0, "tech": 0.82 }, "t": 1759500662, "k": "user", "s": "rated" } }
```

**`ratings/<category>.json`** — map id → entry. Only rerank and maintenance write it.

```json
{ "k7q2m3xw5a": { "r": 1642.3, "rd": 38.1, "vol": 0.06, "n": 38, "w": 21, "l": 15, "d": 2, "last": 1759500000, "placed": true, "round": 3, "r7": 1630.0, "peak": [1688.2, 1757800000], "anchor": false, "locked": false } }
```

Size: ~160 bytes per entry → 16 MB for `general` at 100k, ~20 MB for the three domain ladders together. Parsed in well under a second. GitHub warns at 50 MB and blocks at 100 MB per file; the single-file layout therefore holds to ~300k entries per category, three times the target. Sharding by `<ab>` is a mechanical change in `store/paths.ts` if that day comes; it is not done now because (a) only one serialized writer touches ratings so there is no conflict pressure, and (b) the index builder reads every entry anyway.

**`history/<category>/<ab>/<id>.json`**

```json
{
  "id": "k7q2m3xw5a", "cat": "tech",
  "points": [[20260920, 1500, 250], [20260921, 1588, 118], [20261003, 1642, 38]],
  "recent": [
    { "t": 1759500000, "opp": "x91pp2a7mq", "s": 1, "d": 9.2, "note": "Broader ownership at the same seniority; the other has stronger education.", "k": "refine", "ra": 1633.1, "ro": 1588.0 }
  ],
  "placed": true
}
```

`points` keeps at most one point per day (the last) for `retention.history_points` days plus the first placement points; `recent` is the last 10 matches. Opponent identity is resolved client-side through the Pages rank shard (so a later anonymity toggle is honoured everywhere, instantly).

**`matches/<yyyy-mm>/<dd>/<category>.jsonl`** — one line per match, append-only, union-merged:

```json
{"id":"m_01J9…","t":1759500000,"cat":"tech","a":"k7q2m3xw5a","b":"x91pp2a7mq","k":"refine","ra":1633.1,"rda":41.0,"rb":1588.0,"rdb":55.2,"p1":{"w":"A","c":0.71,"r":"…≤200 chars…"},"p2":{"w":"B","c":0.66,"r":"…"},"s":1,"da":9.2,"db":-7.8,"m":"claude-sonnet-5-5","v":"v1","via":"batch","run":123456789,"usd":0.0083}
```

`s` is the score for `a` (1, 0.5, 0). `p2` is the swapped pass, already mapped back to A/B. Daily files keep each under ~3 MB even at 16k matches/day; at 100/day a month of one category is ~1 MB.

**`queue/placement/<id>.json`**

```json
{ "id": "k7q2m3xw5a", "kind": "placement", "enqueued_at": "2026-10-03T14:13:40Z", "categories": ["general", "tech"], "stage": { "general": { "round": 1, "done": false }, "tech": { "round": 0, "done": false, "waiting_for": "general" } }, "attempts": 0, "last_error": null }
```

**`anchors/<category>.json`**

```json
{ "version": 1, "locked": [ { "id": "anchrgen10a", "rating": 1000, "score": 22 }, { "id": "anchrgen11a", "rating": 1100, "score": 31 } ], "fallback_slope": [1000, 10] }
```

Anchor resumes are ordinary `resumes/` documents with `kind: "anchor"`, excluded from every ladder, profile and arena pool.

**`usage/<yyyy-mm-dd>.jsonl`**

```json
{"t":1759500662,"run":123456700,"wf":"submit","purpose":"analysis","model":"claude-opus-5-5","in":9012,"cr":6480,"cw":0,"out":7311,"usd":0.1880,"ref":"k7q2m3xw5a"}
```

`purpose ∈ gate | analysis | judge_place | judge_refine | reanalysis | anchor_validate`. Budget arithmetic sums this file; it is the only ledger.

### A.4 Why this granularity (conflicts, git size, Pages size at 100k)

| Concern | Number at 100k resumes (≈275/day for a year) | Consequence |
|---|---|---|
| Parallel submit writers | ≈ 0.2 commits/minute on average, bursts of 5–10 | Submit only creates files (`resumes`, `dedupe`, `queue`), inserts into one 1,024-way shard (`rows`, `users`) or appends to union-merged JSONL (`usage`). Two concurrent submits conflict textually only when they hit the same `rows/<ab>` shard inside the same ~15 s push window: p ≈ 1/1,024 per overlapping pair. The retry loop re-applies the mutation on fresh state rather than merging text, so even that case resolves on the second attempt. Measured expectation: < 1 retry per 500 submissions. |
| Serialized writer | one rerank at a time, ≤ 120 refinement + placement matches per run | No conflicts by construction. Rerank commits once per placement wave and once at the end, so a timeout loses at most one wave. |
| Git repository size | `resumes/`: 100k × ~25 KB = 2.5 GB uncompressed, ~600 MB packed (JSON compresses 4–5×). `matches/`: 4.4k/day × 500 B → 800 MB/yr uncompressed, ~150 MB packed. `history/`: 230k files × ~1 KB. `ratings/`: 36 MB current. Per-commit deltas: ~700 B per match of churn across ratings/history/matches → ~3 MB/day. | ≈ 1.2–1.8 GB packed after year one including delta history. GitHub recommends < 1 GB and strongly recommends < 5 GB. `maintenance squash-data-history` rewrites the branch to a single snapshot commit (drops all deltas, ~700 MB at 100k) and is scheduled quarterly or when `du` of the clone exceeds 2 GB. Every workflow clones with `--filter=blob:none --depth=1` and a sparse pattern list, so clone cost is proportional to the files a run touches (submit ≈ 3 MB, rerank ≈ 20–60 MB, deploy ≈ 70 MB), not to the repository. |
| Pages artifact | ladder pages: 230k rows × 150 B × 3 partitions (all / by stage / by activity window) ≈ 105 MB in ~7,000 files; rank shards: 1,024 × ~12 KB = 12 MB; arena pools 4 × ~350 KB; status/stats/manifest/settings < 100 KB. **≈ 120 MB.** | Under the 1 GB site limit by 8×, upload ≈ 1–2 min, deploy ≈ 1 min. At 10k resumes the artifact is ≈ 12 MB. Per-resume documents are *not* in the artifact: at 7 KB each they would add 700 MB and 100k files per deploy, ten deploys an hour. They are served from raw instead (§F). |
| Pages bandwidth | leaderboard page 15 KB, rank shard 12 KB, resume document 25 KB (raw, not Pages), SPA bundle ~400 KB (pdfjs lazy-loaded, ~1.2 MB only on the upload page) | 100 GB/month soft limit ≈ 200k page views/month at ~500 KB each. Fine for v1; the SPA bundle is cached 10 minutes by Pages and long-term by the browser via hashed asset names. |

### A.5 Ids

```ts
// packages/shared/src/ids.ts
export const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 base32, lowercase; no 0/1/8/9
export const ID_LENGTH = 10;                                   // 50 random bits

export function newId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(8);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) { out = ID_ALPHABET[Number(bits & 31n)] + out; bits >>= 5n; }
  return out;
}
export const ID_RE = /^[a-z2-7]{10}$/;
export const shardOf = (id: string) => id.slice(0, 2);            // resumes/<ab>/, history/<cat>/<ab>/, rows/<ab>.json
export const anonIdOf = (id: string) => `anon-${id.slice(0, 5)}`; // product-ux.md naming
```

Collision policy: 2^50 ≈ 1.1 × 10^15 values; at 100k entries the probability that any two collide is n²/2N ≈ 4.5 × 10^-6, and at 1M it is 4.5 × 10^-4. The engine still checks: if `resumes/<ab>/<id>.json` exists and its `owner_hash` and `text_sha256` match the submission, the run is a re-run of an already-processed submission and exits `noop` (this is also what makes **Re-run jobs** on a finished run harmless). If it exists with a different owner or content, the run fails with `id_collision` and writes nothing. The SPA, while polling, treats a document whose `owner_hash` differs from its own as a collision, mints a new id and resubmits automatically (once).

Anchor ids are the reserved prefix `anchr` followed by 5 base32 characters; `newId()` never produces that prefix in practice but the validator also rejects it from clients.


---

## B. The write channel

### B.1 Payload

Both channels carry the same ten fields. All values are strings (the dispatch API accepts only strings; the Issue Form produces only strings).

| Input | Required | Budget (chars) | Validation (client and engine, identical code in `packages/shared`) |
|---|---|---|---|
| `action` | yes | 14 | `submit` \| `delete` \| `set_visibility` |
| `submission_id` | yes | 10 | `ID_RE`; for `set_visibility`/`delete` it is the id being managed |
| `handle` | yes | 20 | §D.3 regex, not reserved, not in the blocklist |
| `owner_hash` | yes | 64 | lowercase hex sha256 |
| `visibility` | for submit/set_visibility | 9 | `handle` \| `anonymous` |
| `text` | for submit | 15,000 | NFC-normalized, `\r\n`→`\n`, control chars stripped, ≥ 400 chars after trimming; the engine recomputes the PII scrub and refuses if it changes the text (the browser must have scrubbed) |
| `metrics_json` | for submit | 2,000 | JSON object matching `LayoutMetrics`; unknown keys dropped |
| `categories_hint` | no | 40 | comma-separated subset of `finance,tech,academia` (advisory; analysis decides membership) |
| `client_version` | no | 24 | `^[a-z0-9.-]{0,24}$` |
| `owner_key` | for delete/set_visibility | 64 | base64url of 32 bytes (43 chars) or hex (64); the engine hashes and compares with the stored `owner_hash` using constant-time comparison |

Total worst case ≈ 17.3k characters before JSON escaping, ≈ 19k after (newlines become `\n`). Well under the 65,535-character payload cap and under the 10-input limit on the conservative reading of the docs.

```ts
// packages/shared/src/types.ts (excerpt)
export type Category = 'general' | 'finance' | 'tech' | 'academia';
export type Visibility = 'handle' | 'anonymous';
export type SubmitAction = 'submit' | 'delete' | 'set_visibility';

export interface LayoutMetrics {
  source: 'pdf' | 'docx' | 'paste';
  pages: number; columns: 1 | 2 | 3; fonts: number; images: number;
  chars: number; words: number; extraction_quality: number; // 0..1, share of glyphs that mapped to text
  has_text_layer: boolean;
  scrubbed: { emails: number; phones: number; urls: number; addresses: number; names: number };
}

export interface SubmissionPayload {              // what the browser sends, both channels
  action: SubmitAction; submission_id: string; handle: string; owner_hash: string;
  visibility: Visibility; text: string; metrics_json: string; categories_hint: string;
  client_version: string; owner_key: string;
}

export interface SubmissionInput {                 // what the engine works with after the adapter
  action: SubmitAction; id: string; handle: string; ownerHash: string; ownerKey: string | null;
  visibility: Visibility; text: string; metrics: LayoutMetrics; categoriesHint: Category[];
  clientVersion: string;
  source: { kind: 'dispatch'; runId: number } | { kind: 'issue'; number: number; author: string; nodeId: string };
}
```

### B.2 The browser call

```ts
// web/src/lib/github.ts
const REPO = import.meta.env.VITE_REPO;                 // "noahfinkelstein/resumearena"
const TOKEN = import.meta.env.VITE_SUBMIT_TOKEN ?? '';  // public by design; may be empty or revoked
const API = `https://api.github.com/repos/${REPO}`;

export type DispatchResult =
  | { ok: true }
  | { ok: false; kind: 'token_dead' | 'rate_limited' | 'invalid' | 'paused' | 'network'; retryAfterS?: number; status?: number };

export async function dispatch(payload: SubmissionPayload): Promise<DispatchResult> {
  if (!TOKEN) return { ok: false, kind: 'token_dead' };
  let res: Response;
  try {
    res = await fetch(`${API}/actions/workflows/submit.yml/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: payload }),
    });
  } catch { return { ok: false, kind: 'network' }; }

  if (res.status === 204) return { ok: true };
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
  const retryAfter = Number(res.headers.get('retry-after') ?? 0);
  switch (res.status) {
    case 401: case 404:                       // bad credentials, or a fine-grained token that no longer sees the repo
      return { ok: false, kind: 'token_dead', status: res.status };
    case 403:
      if (remaining === '0' || retryAfter) return { ok: false, kind: 'rate_limited', retryAfterS: retryAfter || Math.max(1, reset - Math.floor(Date.now() / 1000)) };
      return { ok: false, kind: 'token_dead', status: 403 };  // token lacks Actions: write (rotated with wrong scope)
    case 429:
      return { ok: false, kind: 'rate_limited', retryAfterS: retryAfter || 60 };
    case 422:
      return { ok: false, kind: 'invalid', status: 422 };  // unknown input, missing required, oversize, bad ref: a client bug
    default:
      return { ok: false, kind: res.status >= 500 ? 'network' : 'invalid', status: res.status };
  }
}

/** Cheap liveness probe for the embedded token: Actions: read is enough to GET the workflow. */
export async function probeToken(): Promise<'ok' | 'dead' | 'limited' | 'unknown'> {
  if (!TOKEN) return 'dead';
  const cached = sessionStorage.getItem('ra.probe');
  if (cached) { const { at, v } = JSON.parse(cached); if (Date.now() - at < 10 * 60_000) return v; }
  try {
    const r = await fetch(`${API}/actions/workflows/submit.yml`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    const v = r.status === 200 ? 'ok' : r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0' ? 'limited' : [401, 403, 404].includes(r.status) ? 'dead' : 'unknown';
    sessionStorage.setItem('ra.probe', JSON.stringify({ at: Date.now(), v }));
    return v;
  } catch { return 'unknown'; }
}
```

The probe runs once when `/upload` mounts and once more right before dispatch if the cached result is older than ten minutes. `api.github.com` sends `Access-Control-Allow-Origin: *`, so no proxy is needed.

Error → UI mapping (copy follows product-ux.md §1.4: what went wrong, then what to do):

| Result | What the page does |
|---|---|
| `ok` | navigates to `/r/<id>?pending=1`; stores `{id, handle, owner_hash, at}` in `localStorage.ra.mine`; starts polling (§F.3) |
| `token_dead` | banner **Direct submission is unavailable.** "The site's submission key is being rotated. You can still enter through the GitHub form; it needs a GitHub account and takes the same few minutes." Button "Open the GitHub form" → §B.3 with fields prefilled; the composed text is also shown in a read-only textarea with "Copy text" for pasting. The banner persists for the session (`ra.probe = dead`). |
| `rate_limited` | **The arena is busy.** "Too many entries in the last hour. Try again in {retryAfterS → minutes}." The button re-enables when the timer ends. The payload stays in memory. |
| `invalid` (422) | **Could not submit.** "Something in this entry does not fit the form. Reload and try again; if it happens twice, use the GitHub form." plus the status code in mono. A 422 is a client/workflow mismatch (e.g. the SPA is newer than `submit.yml`), so the fallback link is shown too. |
| `paused` (from `status.json`, checked before any dispatch) | **Entries are paused.** `settings.pause_message` or "The owner has paused new entries. The ladders still work." No dispatch is made. |
| `network` | **Lost the connection.** "Nothing was sent. Retrying." with exponential backoff (2, 4, 8, 16 s; four attempts), then the fallback link. |

A `204` only means "GitHub accepted the request to start a run"; it does not mean the entry was accepted. Everything after that is visible on the result page.

### B.3 Fallback: the Issue Form

`.github/ISSUE_TEMPLATE/submission.yml` — identical fields, same ids as the dispatch inputs:

```yaml
name: Submit a resume (fallback channel)
description: Used by the site when direct submission is unavailable. Everything you enter here is public, exactly like the direct channel.
title: "submission: "
labels: ["ra:submission"]
body:
  - type: markdown
    attributes:
      value: |
        This form is the backup way into ResumeArena. The site fills most fields for you; paste the approved text into the text box.
        Everything in this issue is public the moment you press Submit. Do not paste anything you removed in the preview.
  - type: input
    id: submission_id
    attributes: { label: submission_id, description: "10 lowercase letters/digits, generated by the site" }
    validations: { required: true }
  - type: input
    id: handle
    attributes: { label: handle, description: "3–20 characters, a–z 0–9 and hyphens" }
    validations: { required: true }
  - type: input
    id: owner_hash
    attributes: { label: owner_hash, description: "64 hex characters, generated by the site. Never paste the key itself." }
    validations: { required: true }
  - type: dropdown
    id: visibility
    attributes: { label: visibility, options: ["anonymous", "handle"] }
    validations: { required: true }
  - type: textarea
    id: text
    attributes: { label: text, description: "The anonymized text from the preview, up to 15,000 characters.", render: text }
    validations: { required: true }
  - type: textarea
    id: metrics_json
    attributes: { label: metrics_json, description: "Generated by the site.", render: json, value: "{}" }
    validations: { required: true }
  - type: input
    id: categories_hint
    attributes: { label: categories_hint, description: "Optional: finance, tech, academia (comma separated)" }
  - type: input
    id: client_version
    attributes: { label: client_version }
```

`.github/ISSUE_TEMPLATE/delete.yml` carries `submission_id`, `handle`, `owner_key` (input, description "This reveals your key. After a delete through this form the key can only ever delete again; it cannot change visibility.") and label `ra:delete`. `config.yml` sets `blank_issues_enabled: false` and a contact link to `/about#contact` so the issue tracker stays a channel, not a forum.

Prefill URL built by the SPA (field ids are query parameters; the text is left for the user to paste because very long URLs are unreliable):

```ts
export function issueFormUrl(p: SubmissionPayload) {
  const q = new URLSearchParams({
    template: 'submission.yml', title: `submission: ${p.submission_id}`,
    submission_id: p.submission_id, handle: p.handle, owner_hash: p.owner_hash, visibility: p.visibility,
    metrics_json: p.metrics_json, categories_hint: p.categories_hint, client_version: p.client_version,
  });
  return `https://github.com/${REPO}/issues/new?${q}`;
}
```

### B.4 One adapter for both triggers

```ts
// engine/src/adapters/dispatch.ts
export function fromDispatch(event: { inputs: Record<string, string> }, runId: number): SubmissionInput {
  return normalize(event.inputs as SubmissionPayload, { kind: 'dispatch', runId });
}

// engine/src/adapters/issue.ts
export function fromIssue(event: { issue: { number: number; node_id: string; body: string; labels: { name: string }[]; user: { login: string } } }): SubmissionInput {
  const fields = parseIssueForm(event.issue.body);          // label → value
  const isDelete = event.issue.labels.some(l => l.name === 'ra:delete');
  const payload: SubmissionPayload = {
    action: isDelete ? 'delete' : 'submit',
    submission_id: fields.submission_id ?? '', handle: fields.handle ?? '', owner_hash: fields.owner_hash ?? '',
    visibility: (fields.visibility as Visibility) ?? 'anonymous', text: fields.text ?? '',
    metrics_json: fields.metrics_json ?? '{}', categories_hint: fields.categories_hint ?? '',
    client_version: fields.client_version ?? 'issue', owner_key: fields.owner_key ?? '',
  };
  return normalize(payload, { kind: 'issue', number: event.issue.number, author: event.issue.user.login, nodeId: event.issue.node_id });
}

// packages/shared/src/issue-form.ts — Issue Forms render as "### <label>\n\n<value>\n\n"; textareas with `render:` are fenced.
export function parseIssueForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sections = body.replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const s of sections) {
    const nl = s.indexOf('\n');
    const label = s.slice(0, nl).trim();
    let value = s.slice(nl + 1).trim();
    const fence = value.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
    if (fence) value = fence[1];
    if (value === '_No response_') value = '';
    out[label] = value;
  }
  return out;
}

// engine/src/adapters/normalize.ts — the single validation path (throws SubmissionError with a user-facing code)
export function normalize(p: SubmissionPayload, source: SubmissionInput['source']): SubmissionInput
```

`normalize` applies the table in §B.1, parses `metrics_json`, NFC-normalizes `text`, re-runs `scrubPII(text)` from `packages/shared/src/pii.ts` and rejects with `text_not_scrubbed` if the scrub changes anything (the engine never silently rewrites what the user approved; the UI could not have shown it). Error codes are the same strings the SPA maps to copy (§D.8).


---

## C. Workflows

Conventions used by all four: explicit least-privilege `permissions` blocks (the repository default can stay read-only); Node 24 from `.nvmrc`; pnpm from `package.json#packageManager` with the pnpm store cached by `actions/setup-node`; the code checkout is shallow; the data checkout is a shallow, blobless, sparse checkout into `./data`; every step that could print user input runs after the masking step; `timeout-minutes` on every job. Action majors below are the ones known at writing (`checkout@v5`, `setup-node@v5`, `pnpm/action-setup@v4`, `configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`); bump to current majors at implementation.

### C.1 Composite actions

`.github/actions/setup/action.yml`

```yaml
name: setup
description: pnpm + Node 24 + cached install
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4            # version comes from package.json "packageManager"
    - uses: actions/setup-node@v5
      with:
        node-version-file: .nvmrc
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      shell: bash
```

`.github/actions/data-checkout/action.yml` — a blobless, shallow, non-cone sparse checkout of the data branch; the engine extends the pattern list at runtime with `git sparse-checkout add` (one batched blob fetch per call).

```yaml
name: data-checkout
description: Partial, sparse checkout of the data branch into ./data
inputs:
  patterns:
    description: newline-separated sparse-checkout patterns (non-cone)
    required: true
runs:
  using: composite
  steps:
    - uses: actions/checkout@v5
      with:
        ref: data
        path: data
        fetch-depth: 1
        filter: blob:none
        sparse-checkout: ${{ inputs.patterns }}
        sparse-checkout-cone-mode: false
        persist-credentials: true           # GITHUB_TOKEN is used for the push
    - run: |
        git -C data config user.name  "resumearena-bot"
        git -C data config user.email "41898282+github-actions[bot]@users.noreply.github.com"
        git -C data config fetch.negotiationAlgorithm noop
      shell: bash
```

### C.2 `submit.yml`

```yaml
name: submit
run-name: "submit · ${{ inputs.action || 'issue' }} · ${{ inputs.submission_id || github.event.issue.number }}"

on:
  workflow_dispatch:
    inputs:
      action:          { description: "submit | delete | set_visibility", type: string, required: true, default: "submit" }
      submission_id:   { description: "10-char base32 id",                 type: string, required: true }
      handle:          { description: "3-20 chars [a-z0-9-]",              type: string, required: true }
      owner_hash:      { description: "hex sha256 of the owner key",       type: string, required: true }
      visibility:      { description: "handle | anonymous",                type: string, required: false, default: "anonymous" }
      text:            { description: "anonymized text, <= 15000 chars",   type: string, required: false, default: "" }
      metrics_json:    { description: "LayoutMetrics as JSON",             type: string, required: false, default: "{}" }
      categories_hint: { description: "comma-separated domain hints",      type: string, required: false, default: "" }
      client_version:  { description: "SPA build id",                      type: string, required: false, default: "" }
      owner_key:       { description: "raw owner key (manage actions)",    type: string, required: false, default: "" }
  issues:
    types: [opened]

permissions:
  contents: write        # push to the data branch
  issues: write          # comment, label, close, lock on the Issue path
  actions: read          # count recent runs for the hourly cap

# One run per submission id at a time: a "Re-run" of a finished run queues behind nothing and exits noop.
concurrency:
  group: submit-${{ inputs.submission_id || github.event.issue.number }}
  cancel-in-progress: false

jobs:
  intake:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      contains(github.event.issue.labels.*.name, 'ra:submission') ||
      contains(github.event.issue.labels.*.name, 'ra:delete')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      RA_DATA_DIR: ${{ github.workspace }}/data
      RA_EVENT_PATH: ${{ github.event_path }}
      RA_RUN_ID: ${{ github.run_id }}
      RA_ENV: production
    steps:
      - name: Mask the owner key before anything can print it
        env:
          OWNER_KEY: ${{ inputs.owner_key }}
          ISSUE_BODY: ${{ github.event.issue.body }}
        run: |
          if [ -n "$OWNER_KEY" ]; then echo "::add-mask::$OWNER_KEY"; fi
          # Issue path: mask whatever follows the owner_key heading, if present
          if [ -n "$ISSUE_BODY" ]; then
            printf '%s' "$ISSUE_BODY" | awk '/^### owner_key/{getline; getline; print; exit}' | tr -d '\r' | while read -r k; do [ -n "$k" ] && echo "::add-mask::$k"; done
          fi

      - uses: actions/checkout@v5
        with: { fetch-depth: 1 }

      - uses: ./.github/actions/setup

      - uses: ./.github/actions/data-checkout
        with:
          patterns: |
            /settings.json
            /status.json
            /.gitattributes
            /usage/

      - name: Intake
        id: intake
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node engine/src/cli.ts submit --event "$RA_EVENT_PATH" --summary "$GITHUB_STEP_SUMMARY"
        # The engine: adapts the event → SubmissionInput; checks paused / hourly cap / budget; materializes the shards it
        # needs (resumes/<ab>, users/<h2>, rows/<ab>, dedupe/<hh>, queue/placement); dedupes; runs gate → analysis;
        # commits with the retry loop; on the Issue path comments, labels, closes and locks the issue (see C.6).

      - name: Record failure for status
        if: failure()
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node engine/src/cli.ts record-failure --workflow submit --event "$RA_EVENT_PATH" --run "$RA_RUN_ID" || true
        # Appends to failures/<day>.jsonl (union-merged) and, on the Issue path, labels the issue ra:failed and comments.
```

What the engine does in `submit`, in order, with the exit codes it uses (every non-infrastructure outcome is a *successful* run that wrote a document with a status; only infrastructure errors fail the run):

1. `adapt` → `SubmissionInput` or `rejected(code)` written as a stub document (`status: rejected, rejected_reason: code`), so the result page can explain.
2. Reserved and blocked handles, id format, text length, scrub check.
3. `paused` → stub `queued` + `queue/analysis/<id>.json` (the queue drains when unpaused). The SPA normally prevents dispatch while paused; this covers stale clients.
4. Hourly cap: `GET /repos/{r}/actions/workflows/submit.yml/runs?created=>=<now-1h>&per_page=1` → `total_count`; above `max_submissions_per_hour` → stub `queued` (reason `rate`) + `queue/analysis`. Costs nothing.
5. Budget: `spent_today = Σ usage/<today>.jsonl`; if `spent_today + 0.25 > daily_budget_usd − analysis_reserve_usd`… more precisely `if spent_today + est_submission_cost > daily_budget_usd` → stub `queued` (reason `budget`).
6. Materialize shards; **idempotency / collision** check on `resumes/<ab>/<id>.json` (§A.5); handle ownership check against `users/<h2>/<handle>.json` (new handle → claim with `owner_hash`; existing with equal hash → ok; different → `rejected(handle_taken)`).
7. Dedupe: `sha256(normalizedText)` → `dedupe/<hh>/<sha>.json`. Hit with the same owner → `status: duplicate, duplicate_of` (no cost; the UI links to the original). Hit with another owner → `duplicate` too, with the copy `"This exact text is already in the arena."` (not revealing whose).
8. Gate (Haiku 4.5, ≈ $0.005): `{is_resume, spam, injection_suspected, language}`. `is_resume=false` or `spam` → `rejected(not_a_resume | spam)`; `injection_suspected` is passed to the analyst as a flag and recorded.
9. Analysis (Opus 5.5, structured output, server-side refusal fallback, 1-hour prompt cache on the system prompt): per scoring-rubric.md §1.2 but with `text` + `metrics` in place of the PDF. Refusal after fallback → `needs_review`. `max_tokens` → one retry at 24,000. Validation (§8.1 of the rubric doc) with the PII sweep over the card.
10. Write set, applied inside `commitWithRetry` (C.5): `resumes/<ab>/<id>.json` (`status: analyzed`), `users/<h2>/<handle>.json` (insert/append id), `rows/<ab>.json` (insert), `dedupe/<hh>/<sha>.json` (create), `queue/placement/<id>.json` (create), `usage/<today>.jsonl` (append 2 lines). One commit, message `submit <id> (<handle>)`.
11. Step summary (§I.3). Issue path: comment + close + lock (C.6).

`delete` and `set_visibility` share steps 1, 2, 6 (ownership via `owner_key` → hash compare) and then apply their write set (§E.3).

### C.3 `rerank.yml`

```yaml
name: rerank
run-name: "rerank · ${{ github.event_name }}"

on:
  schedule:
    - cron: "*/10 * * * *"                       # may be delayed under load; submissions also trigger it
  workflow_run:
    workflows: [submit]
    types: [completed]
  workflow_dispatch:
    inputs:
      reason: { description: "why", type: string, required: false, default: "manual" }

permissions:
  contents: write        # ratings, history, matches, queue, status
  actions: write         # re-enable the schedule; dispatch deploy

# Serialized. A burst of submissions collapses into one running + one pending run.
concurrency:
  group: rerank
  cancel-in-progress: false

jobs:
  rerank:
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 28                           # leaves room before the next cron tick queues
    env:
      RA_DATA_DIR: ${{ github.workspace }}/data
      RA_RUN_ID: ${{ github.run_id }}
      RA_TRIGGER: ${{ github.event_name }}
      RA_ENV: production
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 1 }
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/data-checkout
        with:
          patterns: |
            /settings.json
            /status.json
            /.gitattributes
            /anchors/
            /ratings/
            /queue/
            /arena/
            /usage/
            /failures/
          # resumes/<ab>/<id>.json for the cards and history/<cat>/<ab>/<id>.json for touched ids are added by the
          # engine with `git sparse-checkout add` once it knows which ids this run will touch.

      - name: Rerank
        id: rerank
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node engine/src/cli.ts rerank --summary "$GITHUB_STEP_SUMMARY" --out "$GITHUB_OUTPUT"
        # writes `changed=true|false` and `matches=<n>` to $GITHUB_OUTPUT

      - name: Keep the schedule enabled
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh api --silent -X PUT "repos/${{ github.repository }}/actions/workflows/rerank.yml/enable" || true

      - name: Deploy indexes
        if: steps.rerank.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh workflow run deploy.yml --ref main -f reason="rerank ${{ github.run_id }}"

      - name: Record failure for status
        if: failure()
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node engine/src/cli.ts record-failure --workflow rerank --run "$RA_RUN_ID" || true
```

What one rerank run does (`engine/src/commands/rerank.ts`), with checkpoints:

```
load settings, status, anchors, ratings/*, queue/*; day = UTC date; spent = Σ usage/<day>.jsonl
1. ingest finished Message Batches (queue/batches/*): for each batch with processing_status = ended → results keyed by
   custom_id "<match_id>:1|:2" → apply Glicko when both passes present → delete the batch file. Checkpoint commit.
2. deferred analyses (queue/analysis/*): while budget allows, up to 6 in parallel, run gate+analysis exactly as submit
   does (same code path) and move the entry to queue/placement. Checkpoint commit.
3. placement waves: all queued placements advance one round per wave (rounds from settings; opponents per
   ranking-system.md §2.2; anchor in game 2 of round 1); matches run realtime with concurrency
   max_placement_concurrency (2 calls each); each round is one Glicko period. Up to 5 waves per run; a resume that
   finishes general placement starts its domain rounds in the next wave. Checkpoint commit after every wave
   (ratings, history, matches, queue state, usage).
4. refinement: allowance = min(max_refine_matches_per_run,
     floor((daily_budget_usd × refine_budget_share − refine_spent_today) / (est_cost_per_match_usd × 0.5) / runs_left_today))
   select by the priority formula (ranking-system.md §3.2; `A` attention term is 0 in v1, there are no view counts),
   choose opponents (§3.3), submit ONE Message Batches job with 2 requests per match, write queue/batches/<id>.json.
   Results land in a later run (step 1).
5. arena pool: append this run's decided realtime matches to arena/<cat>.json, trim to 80.
6. status.json: queue depths, spend, counts, per-category stats, health (schedule state via API, failed/cancelled run
   counts via `gh run list --created ">=24h"`, token_expires from vars). Final commit. changed = any commit happened.
```

Hard stop: the engine refuses any LLM call once `spent ≥ 1.15 × daily_budget_usd`, whatever the purpose, and writes `budget.exhausted = true` into status.

### C.4 `deploy.yml`

```yaml
name: deploy
run-name: "deploy · ${{ github.event_name }} · ${{ inputs.reason || github.ref_name }}"

on:
  push:
    branches: [main, data]          # `data` only fires for human pushes (bot pushes do not trigger workflows)
    paths-ignore: ["docs/**", "ops/**", "**/*.md"]
  workflow_dispatch:
    inputs:
      reason: { description: "why", type: string, required: false, default: "manual" }

concurrency:
  group: pages
  cancel-in-progress: true          # a cancelled deploy-pages step is harmless: the swap is atomic on GitHub's side

jobs:
  # A human push to `data` cannot deploy from that ref (the github-pages environment only accepts the default
  # branch), so it re-dispatches on main.
  redispatch:
    if: github.event_name == 'push' && github.ref == 'refs/heads/data'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: { actions: write }
    steps:
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh workflow run deploy.yml --repo "${{ github.repository }}" --ref main -f reason="data push ${{ github.sha }}"

  build:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions: { contents: read }
    env:
      VITE_BASE: /resumearena/
      VITE_REPO: ${{ github.repository }}
      VITE_SUBMIT_TOKEN: ${{ vars.SUBMIT_TOKEN }}             # public by design (§D.5)
      VITE_TOKEN_EXPIRES: ${{ vars.SUBMIT_TOKEN_EXPIRES }}
      VITE_BUILD_ID: ${{ github.run_id }}.${{ github.run_attempt }}
      VITE_COMMIT: ${{ github.sha }}
      RA_DATA_DIR: ${{ github.workspace }}/data
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 1 }
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/data-checkout
        with:
          patterns: |
            /settings.json
            /status.json
            /anchors/
            /ratings/
            /rows/
            /arena/
      - run: pnpm --filter web build                           # vite build --base=/resumearena/
      - run: node engine/src/cli.ts build-indexes --out web/dist/data --build-id "$VITE_BUILD_ID"
      - name: Guard the artifact
        run: |
          du -sh web/dist
          test "$(du -sm web/dist | cut -f1)" -lt 800 || { echo "::error::artifact over 800 MB"; exit 1; }
          ! grep -rl "github_pat_" web/dist --include='*.map' >/dev/null || true   # token in JS is expected; source maps are not shipped
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: web/dist }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions: { pages: write, id-token: write }
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

`vite.config.ts` sets `base: process.env.VITE_BASE ?? '/'`, `build.sourcemap: false`, and `optimizeDeps`/`manualChunks` so `pdfjs-dist` and `mammoth` load only on `/upload`. The index builder writes into `web/dist/data/` after the Vite build so the artifact is one directory.

### C.5 The fetch-reset-reapply-push loop

The loop is semantic, not textual: a writer describes its change as an idempotent function over the working tree, and on every attempt the tree is reset to the remote tip before the function runs again. Git's own merge machinery is only relied on for the union-merged JSONL files, and even those are re-appended by the function rather than merged.

```ts
// engine/src/store/commit.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export interface Mutation { paths: string[]; apply(root: string): Promise<void>; }   // paths: sparse patterns the mutation touches

export async function commitWithRetry(root: string, message: string, mutations: Mutation[], opts = { attempts: 8, branch: 'data' }): Promise<'pushed' | 'noop'> {
  const git = (...a: string[]) => run('git', ['-C', root, ...a], { maxBuffer: 64 << 20 });
  const patterns = [...new Set(mutations.flatMap(m => m.paths))];
  if (patterns.length) await git('sparse-checkout', 'add', '--no-cone', ...patterns);   // one batched blob fetch
  for (let i = 0; i < opts.attempts; i++) {
    await git('fetch', '--depth=1', 'origin', opts.branch);
    await git('reset', '--hard', 'FETCH_HEAD');                 // discard our previous attempt, keep sparse paths
    for (const m of mutations) await m.apply(root);              // re-apply on fresh state (read → modify → write)
    await git('add', '--sparse', '-A');
    const { stdout } = await git('status', '--porcelain');
    if (!stdout.trim()) return 'noop';
    await git('commit', '-q', '-m', message, '--author', 'resumearena-bot <41898282+github-actions[bot]@users.noreply.github.com>');
    try { await git('push', '--quiet', 'origin', `HEAD:${opts.branch}`); return 'pushed'; }
    catch (e: unknown) {
      const msg = String((e as { stderr?: string }).stderr ?? e);
      if (!/non-fast-forward|fetch first|rejected|cannot lock ref/i.test(msg)) throw e;
      await new Promise(r => setTimeout(r, 400 * 2 ** i + Math.random() * 400));   // 0.4 s … 51 s + jitter
    }
  }
  throw new Error(`data: push rejected ${opts.attempts} times for "${message}"`);
}
```

Typical mutations:

```ts
export const upsertJson = <T>(path: string, f: (cur: T | undefined) => T): Mutation => ({
  paths: [path], apply: async (root) => { const p = join(root, path); const cur = await readJsonOrUndefined<T>(p); await writeJsonAtomic(p, f(cur)); } });
export const createJson = <T>(path: string, value: T): Mutation => ({
  paths: [path], apply: async (root) => { const p = join(root, path); if (await exists(p)) throw new ConflictError(path); await writeJsonAtomic(p, value); } });
export const appendLines = (path: string, lines: object[]): Mutation => ({
  paths: [path], apply: async (root) => appendFile(join(root, path), lines.map(l => JSON.stringify(l) + '\n').join('')) });
export const removeFile = (path: string): Mutation => ({ paths: [path], apply: async (root) => rm(join(root, path), { force: true }) });
```

`appendLines` is idempotent across attempts because `reset --hard` removes the previous attempt's lines before it runs again; it is idempotent across *re-runs of the whole job* because every line carries `run` and `ref` and the submit path exits `noop` when its document already exists.

Shell equivalent for one-off use in a workflow step (`scripts/data-push.sh`):

```bash
#!/usr/bin/env bash
# usage: data-push.sh <data-dir> "<message>" <command that (re)writes files inside data-dir...>
set -euo pipefail
dir=$1; msg=$2; shift 2
for i in 1 2 3 4 5 6 7 8; do
  git -C "$dir" fetch --depth=1 origin data
  git -C "$dir" reset --hard FETCH_HEAD
  "$@"
  git -C "$dir" add --sparse -A
  git -C "$dir" diff --cached --quiet && { echo noop; exit 0; }
  git -C "$dir" commit -q -m "$msg"
  git -C "$dir" push -q origin HEAD:data && { echo pushed; exit 0; }
  sleep $(( (RANDOM % 3) + i * i ))
done
echo "gave up" >&2; exit 1
```

### C.6 The Issue path: comment back, close, lock

Only `submit.yml` talks to issues. With `GITHUB_TOKEN` (`issues: write`) and the `gh` CLI on the runner:

```
on start      gh issue comment N --body "Received. The entry will appear at https://noahfinkelstein.github.io/resumearena/r/<id> in a few minutes. This issue closes automatically."
on success    gh issue edit N --add-label ra:processed [--remove-label ra:submission]
              gh issue comment N --body "Done: <status line, e.g. 'analyzed; placement queued' | 'rejected: not a resume' | 'duplicate of /r/<id>'>"
              gh issue close N --reason completed
              gh issue lock N --reason resolved
on delete     gh issue edit N --body "<body with the owner_key value replaced by [redacted]>"   # edit history remains; see §E.3
              ... then the same label/comment/close/lock sequence with label ra:processed
on failure    gh issue edit N --add-label ra:failed ; gh issue comment N --body "The run failed: <code>. Nothing was recorded. Open a new issue to retry, or wait for the direct channel."
              gh issue close N --reason "not planned"
```

Locking stops further comments; edits to a closed issue do not trigger anything because the workflow listens to `opened` only. Issues opened without the form labels are ignored by the `if:` and left to the owner.

### C.7 `maintenance.yml`

```yaml
name: maintenance
run-name: "maintenance · ${{ inputs.action || 'nightly' }}"

on:
  schedule:
    - cron: "17 4 * * *"            # nightly, 04:17 UTC: rd inflation, drift check, daily snapshot, history compaction
  workflow_dispatch:
    inputs:
      action:
        description: what to run
        type: choice
        required: true
        options: [status, rebuild-indexes, nightly, reanalyze, rotate-anchors, validate-anchors, squash-data-history, set, drain-queue]
      args:
        description: 'JSON args, e.g. {"ids":["k7q2m3xw5a"]} or {"key":"paused","value":true}'
        type: string
        required: false
        default: "{}"
      key:
        description: maintenance key (required for everything except status and rebuild-indexes)
        type: string
        required: false
        default: ""

permissions:
  contents: write
  actions: write
  issues: write

# Shares the writer lock with rerank: nightly maintenance never overlaps a rerank.
concurrency:
  group: rerank
  cancel-in-progress: false

jobs:
  maintenance:
    runs-on: ubuntu-latest
    timeout-minutes: 350
    env:
      RA_DATA_DIR: ${{ github.workspace }}/data
      RA_RUN_ID: ${{ github.run_id }}
      RA_ACTION: ${{ inputs.action || 'nightly' }}
      RA_ARGS: ${{ inputs.args || '{}' }}
      RA_ENV: production
    steps:
      - name: Mask and authorize
        # The embedded public token acts as the owner (`github.actor` is noahfinkelstein for every dispatch), so actor
        # checks cannot distinguish the owner from the SPA. Costly or destructive actions therefore require a secret.
        if: github.event_name == 'workflow_dispatch' && inputs.action != 'status' && inputs.action != 'rebuild-indexes'
        env:
          KEY: ${{ inputs.key }}
          SECRET: ${{ secrets.MAINTENANCE_KEY }}
        run: |
          [ -n "$KEY" ] && echo "::add-mask::$KEY"
          if [ -z "$SECRET" ] || [ "$KEY" != "$SECRET" ]; then echo "::error::maintenance key missing or wrong"; exit 1; fi

      - uses: actions/checkout@v5
        with: { fetch-depth: 1 }
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/data-checkout
        with:
          patterns: |
            /settings.json
            /status.json
            /.gitattributes
            /anchors/
            /ratings/
            /queue/
            /usage/
            /failures/
            /rows/
          # squash-data-history replaces this with a full (still blobless) checkout inside the engine

      - name: Run
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node engine/src/cli.ts maintenance "$RA_ACTION" --args "$RA_ARGS" --summary "$GITHUB_STEP_SUMMARY"

      - name: Deploy if anything changed
        if: success() && env.RA_ACTION != 'status'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh workflow run deploy.yml --ref main -f reason="maintenance ${{ env.RA_ACTION }}"
```

Actions:

| action | what it does | cost |
|---|---|---|
| `status` | prints status.json and the last 24 h of failures to the step summary | 0 |
| `rebuild-indexes` | dispatches deploy (indexes are built there); exists so the SPA/owner can force a refresh | 0 |
| `nightly` | `inflate_rd` (idle > 7 d), `drift_check` per category (bounded shift, alert at residual > 0.08 for 3 nights → `health.alerts`), `snapshot_daily` (`r7`, `peak`), `compact_history` (points → 1/day beyond 30 days, cap 60), rotate `usage/`+`failures/` older than 400 days into `archive/`, recount `counts` | 0 |
| `reanalyze` | `{ids?:[], all?:true, since?:date}` → one Message Batches job over the selected resumes with the current analyst prompt; results ingested by rerank step 1 into `resumes/*` (new `versions`), `rows/*`; ratings untouched (RD bumped to ≥ 120 if `args.rebump`) | 50 % price |
| `rotate-anchors` | `{category, cards:[…]}` or `{generate:true}` → writes new anchor documents (`kind: anchor`), re-fits `score_to_rating`, queues `validate-anchors` | ≈ $2 per category when generating |
| `validate-anchors` | adjacent-pair judging 5× both orderings per ranking-system.md §3.5; writes the report to the summary and `health.alerts` on failure | ≈ $1 per category |
| `squash-data-history` | `git checkout --orphan squash && git add -A && git commit && git push --force origin squash:data` on a full blobless checkout; concurrent submit runs survive it because their retry loop re-bases semantically | 0 |
| `set` | `{key, value}` → `settings.json` (`paused`, `daily_budget_usd`, models, caps); validated against a schema | 0 |
| `drain-queue` | process `queue/analysis` regardless of the hourly cap (budget still applies) | per analysis |


---

## D. Abuse and cost control without identity

### D.1 Layers, cheapest first

| Order | Control | Where | Cost to attacker / to us |
|---|---|---|---|
| 0 | `settings.paused` | SPA refuses to dispatch; engine queues anything that arrives | kill switch; one `maintenance set` |
| 1 | Client validation (length, handle, scrub) | SPA and `normalize()` | none; keeps honest clients honest |
| 2 | Hourly global cap (`max_submissions_per_hour`, default 60) | engine, via the runs API, before any LLM call | a flood costs us ≈ 20 s of free runner time per run and nothing else; legit users see "busy" |
| 3 | Content-hash dedupe | `dedupe/<hh>/<sha>.json` | re-sending the same text costs nothing |
| 4 | Daily budget (`daily_budget_usd`) with an analysis reserve | engine; sum of `usage/<day>.jsonl` | hard ceiling on spend per day; overshoot bounded by concurrent runs × $0.20 |
| 5 | Haiku gate before Opus | engine | junk costs $0.005 instead of $0.19 |
| 6 | Text cap 15,000 chars, output caps | engine | bounds the per-call cost |
| 7 | Owner-key verification for manage actions | engine | no identity, but possession of a 256-bit secret |
| 8 | Hard stop at 1.15 × budget | engine | last line |

What happens when the budget is exhausted: new submissions still land as `status: queued` documents (no LLM cost) with `queue/analysis/<id>.json`; `status.json.budget.exhausted = true`; the SPA shows on `/upload` **The arena is at capacity today.** "New entries are queued and analysed in order when the budget resets at 00:00 UTC. You can still submit; your link works as soon as it is processed." and on the pending result page "Queued, position 41 of 41." (position = order of `queue/analysis` files by `enqueued_at`, published in `status.json.queue`). Rerank's step 2 drains the queue the next day in order, within the budget. Placement for already-analyzed resumes continues until the hard stop.

### D.2 Per-hour cap mechanics

```ts
const since = new Date(Date.now() - 3600_000).toISOString();
const r = await gh(`/repos/${repo}/actions/workflows/submit.yml/runs?created=>=${since}&per_page=1`);
if (r.total_count > settings.max_submissions_per_hour) return queueStub('rate');
```

This counts every submit run, including rejected and queued ones, which is what we want (it measures load, not spend). It needs one API call (`actions: read`) and no shared file.

### D.3 Handles

```ts
// packages/shared/src/handles.ts
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;   // 3–20, no leading/trailing hyphen
export const RESERVED = new Set(['admin','administrator','owner','root','system','support','help','staff','mod','moderator',
  'anon','anonymous','about','arena','upload','leaderboard','ladder','ladders','me','settings','data','api','status','privacy','terms',
  'resumearena','noah','noahfinkelstein','github','judge','anchor','anchors','null','undefined','true','false','test','example']);
export function validateHandle(h: string): 'ok' | 'format' | 'reserved' | 'blocked' {
  if (!HANDLE_RE.test(h)) return 'format';
  if (RESERVED.has(h) || h.startsWith('anon-') || h.startsWith('anchr')) return 'reserved';
  if (isBlocked(h)) return 'blocked';        // packages/shared/src/handles/blocklist.ts
  return 'ok';
}
```

`blocklist.ts` is a vendored copy of the LDNOOBW English list plus the owner's additions, matched against the handle with hyphens and digits-for-letters removed (`l33t` folding). It is a file in the repo, reviewed like any code; nothing is fetched at runtime.

Claiming: the first submission with a handle claims it (`users/<h2>/<handle>.json` with the `owner_hash`). Every later submission with that handle must carry the same `owner_hash` (the SPA has it in `localStorage`) or it is rejected with `handle_taken`. There is no handle release; a tombstoned profile keeps its hash. Before dispatch the SPA reads raw `users/<h2>/<handle>.json` and warns "That handle is taken" early (5-minute cache, so the engine remains authoritative).

### D.4 Owner key

```ts
// web/src/lib/ownerKey.ts
export async function createOwnerKey(): Promise<{ key: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = base64url(bytes);                                    // 43 chars, shown once
  const hash = hex(await crypto.subtle.digest('SHA-256', bytes));  // 64 hex chars, sent with the submission
  localStorage.setItem(`ra.key.${handle}`, key);                   // per handle
  return { key, hash };
}
```

The key is shown exactly once, in a monospace block with "Copy" and "Download as text file", under the heading **Keep this key.** "It is the only way to change or delete this entry later. There is no account and no reset." The engine verifies by hashing the presented key's bytes (base64url or hex accepted) and comparing with `timingSafeEqual`. The raw key travels only inside the dispatch payload (TLS to `api.github.com`, not shown in the run UI or API, masked in logs by the first step) or, on the fallback path, in a public issue, where it is treated as burned (§E.3).

### D.5 Threat model for the embedded PAT

The token is a fine-grained PAT owned by the owner, scoped to the single repository `noahfinkelstein/resumearena`, with **Actions: read and write** (Metadata: read implied) and nothing else. It is public: anyone can read it out of the JS bundle.

**What Actions: write lets a holder do, and what that means here**

| Capability | Impact | Mitigation | Detection |
|---|---|---|---|
| Dispatch any `workflow_dispatch` workflow: `submit`, `rerank`, `deploy`, `maintenance` | Spend: a flood of submits. Nuisance: pointless reranks/deploys. `maintenance` with costly actions. | Hourly cap and budget run before any LLM call; concurrency groups collapse rerank/deploy floods; `maintenance` costly actions need `MAINTENANCE_KEY`; the 500 content-creating requests/hour secondary limit caps the flood rate at the API. Worst-case daily loss ≈ `daily_budget_usd` × 1.15. | `health.dispatch_path_24h` spike; `gh run list --event workflow_dispatch`. |
| Cancel in-progress and queued runs | Denial of service: submissions never land; rerank never finishes. | Checkpoint commits in rerank; a cancelled submit leaves no partial state (one commit at the end); the user's result page shows "still working" and the SPA offers "resubmit" after 30 minutes (same id → idempotent). | `health.cancelled_runs_24h` in status, shown on `/about#status`; owner email from GitHub's failed/cancelled notifications. |
| Re-run completed runs | Double processing. | Every run is idempotent on `submission_id` / batch id; re-running a finished submit exits `noop`. | none needed |
| Enable / disable workflows | DoS by disabling `submit`/`rerank`. | rerank re-enables itself only if it runs; `maintenance nightly` re-enables all four (`PUT .../workflows/<f>/enable`) — but it too can be disabled. Final backstop is the owner: `gh workflow enable` for each. | `health.schedule_enabled` and `last_rerank.at` age on `/about#status`; a run-less 30 minutes turns the widget amber. |
| Delete workflow runs and logs | Hides traces. | Nothing we need lives in logs; the data branch holds `usage/` and `failures/`; GitHub's audit log (owner-visible) records deletions. | none |
| Delete caches and artifacts | Slower builds; a Pages artifact deleted after deployment changes nothing. | none needed | none |
| Download artifacts | Pages artifact = the public site. | none needed | none |
| Change OIDC subject-claim customization (`actions/oidc/customization/sub`) | Could break `deploy-pages` token validation → deploy DoS. | Reset with `gh api -X PUT repos/…/actions/oidc/customization/sub -f use_default=true` (owner runbook). | deploy failures in `failures/`. |
| Read workflow runs, jobs, logs | All public anyway. | none | none |

**What it cannot do:** read or set secrets or variables (separate permissions), push commits or edit workflow files (no Contents), open or edit issues (no Issues), change repository or Pages settings (no Administration), register self-hosted runners (Administration), approve deployments to protected environments (Deployments), or touch any other repository.

**Why a public token is acceptable here:** the write path it opens is exactly the write path the site offers everyone anyway (submit a resume), and every expensive or destructive consequence is bounded by controls that run *inside* the workflow after the trigger, not by who triggered it. The token is a doorbell, not a key.

### D.6 Graceful degradation

1. `/upload` mounts → `probeToken()`. `dead` → the Issue-form banner shows immediately, the direct button is hidden.
2. A dispatch that returns `401/403/404` flips the session to `dead` and shows the banner with the composed payload ready to paste.
3. `status.json.health.token_expires` within 14 days → the `/about#status` widget shows "Submission key expires on {date}" (owner-facing nudge; the public sees the same line, which is fine).
4. If `SUBMIT_TOKEN` is empty at build time, the SPA ships in fallback-only mode (banner always on). The site never breaks; it gets slower.

### D.7 Rotation runbook (`ops/runbooks/rotate-token.md`)

```
1. github.com → Settings → Developer settings → Personal access tokens → Fine-grained → Generate new token
   Name: resumearena-submit-YYYY-MM · Resource owner: noahfinkelstein · Expiration: 366 days (the maximum)
   Repository access: Only select repositories → noahfinkelstein/resumearena
   Repository permissions: Actions → Read and write. Nothing else. (Metadata: Read is added automatically.)
2. gh variable set SUBMIT_TOKEN --repo noahfinkelstein/resumearena --body "github_pat_…"
   gh variable set SUBMIT_TOKEN_EXPIRES --repo noahfinkelstein/resumearena --body "2027-10-03"
3. gh workflow run deploy.yml --ref main -f reason="token rotation"      # new bundle embeds the new token (~3 min)
4. Wait for the deploy to finish (gh run watch), load /upload in a private window, confirm the probe passes.
5. Revoke the old token on the same settings page. Clients still holding the old bundle (Pages cache ≤ 10 min,
   browser cache of hashed assets until reload) fall back to the Issue form on their next dispatch, then pick up
   the new bundle on reload.
6. Note the rotation in ops/runbooks/rotation-log.md (date, reason).
```

Rotate on: expiry (calendar reminder 30 days before `SUBMIT_TOKEN_EXPIRES`), any sign of abuse that the caps do not already contain, or any accidental commit of the token (GitHub will usually have revoked it already).

### D.8 User-facing codes

| code | copy (title · body) |
|---|---|
| `not_a_resume` | **This does not look like a resume.** · "The analysis found no roles, education, or dates. If it is a resume, it is written in a way parsers cannot read, which is itself worth fixing." |
| `spam` | **This entry was not accepted.** · "The gate judged it to be spam or filler." |
| `duplicate` | **This text is already in the arena.** · "See the existing entry." (link when same owner; no link otherwise) |
| `handle_taken` | **That handle belongs to someone else.** · "Pick another, or use the key you saved when you first entered with it." |
| `text_not_scrubbed` | **Personal details slipped through.** · "Re-open the preview; the highlighted items must be removed before the text can be public." |
| `too_short` / `too_long` | **The text is too short to rate.** / **The text is over 15,000 characters.** · "…" |
| `queued` (`rate` / `budget` / `paused`) | **Queued.** · "The arena is at capacity. This entry is number {n} in line and will be analysed in order." |
| `needs_review` | **The analysis did not complete.** · "The model declined this text twice. The owner has been notified; nothing is published." |
| `id_collision` | handled silently by the SPA (new id, one automatic resubmit) |
| `key_mismatch` | **That key does not match this entry.** · "Keys are case-sensitive and cannot be recovered." |

---

## E. Privacy

### E.1 Public by design

The only thing anyone submits is text they have already seen in an editable preview under the sentence **Exactly this text becomes public.** The PDF/DOCX never leaves the browser; the engine never sees a file; the Anthropic API sees the approved text and nothing else. Everything in the data branch is therefore public in the ordinary sense (the repository is public), and the site says so without euphemism.

What is retained, per entry: the approved text, its sha256, layout metrics, the gate verdict, the analysis JSON (minus `detected_pii`, which is dropped before persistence), the card, scores, category relevance, the handle, the visibility flag, the owner hash, timestamps, LLM usage figures, and every match it played (opponent id, outcome, both judge reasons). Not retained anywhere: the file, the name, contact details, IP addresses (GitHub sees the API call; we see nothing), browser identifiers, the raw owner key.

Anonymity on the site is a display choice (`visibility`): the ladder shows `anon-k7q2m` or the handle. The entry text and card are public either way; the UX copy says "anonymous means your handle is not shown, not that the text is hidden."

### E.2 PII scrub (client side, re-checked by the engine)

`packages/shared/src/pii.ts` runs in both places with the same rules: emails, phone numbers (international and US forms), URLs and bare domains, social handles (`@name` at line start or after "linkedin/github/x"), street addresses (number + capitalised words + street suffix), postal codes adjacent to a city line, and the candidate name heuristic: the first line of the document if it is 2–4 capitalised tokens with no digits, plus every later occurrence of that string and its individual tokens of ≥ 3 characters when they appear as whole words. Replacements are visible tokens (`[email]`, `[phone]`, `[link]`, `[address]`, `[name]`) so the user sees what happened and can edit further. The preview highlights every replacement and lets the user add their own.

### E.3 Delete flow

Direct channel: `dispatch({ action: 'delete', submission_id, handle, owner_hash, owner_key })`. The engine verifies the key and, in one commit:

- `resumes/<ab>/<id>.json` → tombstone (`status: deleted, deleted_at`, nothing else);
- `rows/<ab>.json` → entry removed; `dedupe/<hh>/<sha>.json` → removed (the person may resubmit);
- `ratings/<cat>.json` → entries removed; `history/<cat>/<ab>/<id>.json` → removed; `queue/*/<id>.json` → removed;
- `arena/<cat>.json` → any pair containing the id removed;
- `users/<h2>/<handle>.json` → id removed; if no entries remain and `args.profile === true`, `state: tombstone` (handle stays reserved for the key holder);
- `matches/**` lines are **kept**: opponents keep their results; the deleted side shows as "deleted entry" on their pages because the rank shard has no row for it.

The next deploy (dispatched by the rerank that follows, or immediately via `rebuild-indexes`) removes it from every index; raw copies expire within 5 minutes; Pages copies within 10. Git history still contains the old blob until the next `squash-data-history`, and GitHub may keep unreachable objects for a while after that. The privacy note states: "removed from the site within minutes; purged from the repository's history within 90 days."

Issue path (`delete.yml`): the raw key appears in a public issue. The engine verifies, performs the same deletion, edits the issue body to replace the key with `[redacted]`, labels, comments, closes and locks it, and sets `users.key_exposed = true` so that key can never `set_visibility` or resubmit under the handle (it may still delete, which is harmless). GitHub keeps issue edit history visible to everyone; only the repository owner can delete an issue (GraphQL `deleteIssue`), which `GITHUB_TOKEN` cannot do. `maintenance nightly` lists processed `ra:delete` issues older than 7 days in its summary; the owner deletes them with `gh api graphql -f query='mutation{deleteIssue(input:{issueId:"<node_id>"}){clientMutationId}}'` (runbook `ops/runbooks/delete-issue.md`).

### E.4 Visibility toggle and resubmission

`set_visibility` flips `visibility` in the resume document and the row; the next deploy updates every index and every opponent's match list (identity is resolved from the rank shard, never stored in history). Resubmitting under the same handle is an ordinary `submit` with the same `owner_hash`; the engine links `supersedes`/`superseded_by`, marks the old entry `superseded` (kept, hidden from ladders), and queues a *revision* placement per ranking-system.md §5.3 (rating carried, RD ≥ 180). "Replace" in the UI is this flow.

### E.5 Terms copy (`/about#terms`, and one line under the submit button)

> ResumeArena is a public ladder. The text you approve in the preview is published as-is on this site and in the project's public GitHub repository, together with an AI-generated assessment and every comparison it takes part in. We do not receive your file, your name, or your contact details unless you leave them in the text. The text is sent to Anthropic's API to be scored and compared; Anthropic retains API inputs for up to 30 days and does not train on them. There are no accounts: the key shown once after you submit is the only way to change or delete an entry, and we cannot recover it. Deleting removes the entry from the site within minutes and from the repository's history within 90 days. Ratings are a game, not hiring advice. Do not submit someone else's resume.

Under the button: "By submitting you confirm this is your own resume and that the text above may be published."

---

## F. Client data access

### F.1 Two origins, two cache horizons

| What | Where | Cache | Why |
|---|---|---|---|
| `manifest.json`, `status.json`, `stats.json`, `settings.json` | Pages `/resumearena/data/` | `max-age=600`; fetched with `?t=<minute>` so a stale copy is at most ~1 min + CDN | tiny, changes every deploy |
| `ladder/<cat>/<partition>/<page>.json`, `ladder/<cat>/meta.json` | Pages | `?v=<build_id>` from the manifest | changes every deploy; immutable per build |
| `rank/<ab>.json` | Pages | `?v=<build_id>` | rank/rating/handle for every id in the shard |
| `arena/<cat>.json` | Pages | `?v=<build_id>` | pool of decided matches |
| `resumes/<ab>/<id>.json`, `history/<cat>/<ab>/<id>.json`, `users/<h2>/<handle>.json` | `https://raw.githubusercontent.com/noahfinkelstein/resumearena/data/<path>` | `max-age=300` at the CDN; the SPA adds `?r=<minute/5>` | stable documents; not worth 100k files per deploy |

`web/src/lib/data.ts`:

```ts
const PAGES = import.meta.env.BASE_URL + 'data/';
const RAW = `https://raw.githubusercontent.com/${import.meta.env.VITE_REPO}/data/`;

export async function manifest(): Promise<Manifest> { return getJson(`${PAGES}manifest.json?t=${Math.floor(Date.now() / 60_000)}`); }
export async function pagesJson<T>(path: string, buildId: string): Promise<T> { return getJson(`${PAGES}${path}?v=${buildId}`); }
export async function rawJson<T>(path: string): Promise<T | null> {        // null on 404
  const r = await fetch(`${RAW}${path}?r=${Math.floor(Date.now() / 300_000)}`, { cache: 'no-cache' });
  if (r.status === 404) return null; if (!r.ok) throw new DataError(r.status); return r.json();
}
export const resumeDoc  = (id: string) => rawJson<ResumeDoc>(`resumes/${id.slice(0, 2)}/${id}.json`);
export const historyDoc = (cat: Category, id: string) => rawJson<HistoryDoc>(`history/${cat}/${id.slice(0, 2)}/${id}.json`);
export const userDoc    = (h: string) => rawJson<UserDoc>(`users/${h.slice(0, 2)}/${h}.json`);
export const rankShard  = (id: string, buildId: string) => pagesJson<RankShard>(`rank/${id.slice(0, 2)}.json`, buildId);
```

If raw's CDN turns out to ignore the query string, the only effect is that freshness is bounded by 5 minutes instead of ~1; nothing else changes.

### F.2 Index layout (built by `engine build-indexes`)

```
data/
  manifest.json          { build_id, built_at, data_sha, counts, partitions: ["all","stage:student",…,"window:7d","window:30d"] }
  status.json            copy of the data branch status.json + { deployed_at, build_id }
  settings.json          public subset: tiers, provisional_blurb, paused, pause_message, models, prompts, max_text_chars
  stats.json             { resumes, rated, matches, users, updated_at, per_category: {…} }
  ladder/<cat>/meta.json { total, pages, page_size: 100, bounds: [[maxRating, minRating, firstId, lastId], …], updated_at }
  ladder/<cat>/all/<n>.json             rows 100(n-1)+1 … 100n by (rating desc, id asc)
  ladder/<cat>/stage-<stage>/<n>.json   same, restricted to one career stage
  ladder/<cat>/window-7d/<n>.json       rows with last match in the last 7 days; window-30d likewise
  rank/<ab>.json         { "<id>": { h: "handle"|null, v, st, sig, k, s, g?: [rank, total, r, rd, n, w, l, d, delta7, placed], t?: […], f?: […], a?: […] } }
  arena/<cat>.json       { updated_at, pairs: [ { m: match_id, a: Card, b: Card, w: "A"|"B", c: 0.71, reason: "…", stage_a, stage_b } ] }
```

Ladder row (`LadderRow`): `{ id, rank, h, v, tier, r, rd, w, l, d, st, sig, d7 }` ≈ 150 bytes. A page is ≈ 15 KB.

**Keyset pagination over static pages.** The URL cursor is `?after=<rating>.<id>` (product-ux.md §3.4), independent of page numbers so links survive reranks. The client resolves it: fetch `meta.json`, binary-search `bounds` for the page whose `[max, min]` contains the rating (ties broken by id order), fetch that page, and render from the row after the cursor, pulling the next page when fewer than 100 rows remain. "Jump to rank n" is `page = ceil(n / 100)`. "Find me" takes the ids from `localStorage.ra.mine`, reads their rank shards, and jumps. Search by handle fetches `users/<h2>/<handle>.json` from raw and then the rank shards of its entries; search by `anon-xxxxx` resolves the 5-char prefix by scanning the rank shard `xx`.

### F.3 The pending result page

After dispatch the SPA lands on `/r/<id>?pending=1` with everything it knows (handle, visibility, text length, dispatched-at) and shows the honest stage list:

| t since dispatch | shown | mechanism |
|---|---|---|
| 0 – 90 s | "Sent. A worker usually picks this up within a minute; the analysis itself takes one to two." | no network; countdown |
| 90 s → | poll `resumeDoc(id)` every 45 s | raw 404 until the submit commit lands; a cached 404 costs at most one extra interval |
| document appears, `status: analyzed` | the full report renders (verdict, breakdown, strengths, ATS); the rating block reads "Placing. Usually a few minutes; this page updates on its own." | poll `rankShard(id)` on every new `manifest.build_id`, checked every 60 s |
| rank shard has an entry with `placed: true` | **Placed.** reveal (product-ux.md §3.3) | |
| `status: queued` | "Queued, position {n}. The arena is at capacity; entries are analysed in order." | position from `status.json.queue` |
| `status: rejected | duplicate | needs_review` | the matching copy from §D.8 | |
| document's `owner_hash` ≠ ours | id collision: mint a new id, resubmit once, continue | |
| 30 min without a document | "Still nothing. Runs can be delayed; keep this link, it will work when the entry lands. If it does not by tomorrow, resubmit; the same text is recognised and not charged twice." plus a "Resubmit now" button (same id, idempotent) | |

Polling budget: ≤ 40 raw requests + ≤ 30 Pages requests in the first half hour, per submission. No GitHub API calls from the result page.

### F.4 Fast path and cache busting summary

- Pages: hashed asset names for the bundle; `index.html` and `data/**` cached 10 min by the CDN; everything volatile is requested with `?v=<build_id>` or `?t=<minute>`.
- raw: `?r=<5-minute bucket>`; `cache: 'no-cache'` on the request so the browser revalidates; the CDN still serves its copy for up to 300 s.
- The SPA never reads the GitHub API for data. The only API traffic is the dispatch and the probe.

---

## G. Local development and testing without GitHub

### G.1 Engine CLI

```
engine data init <dir>                       # creates a data tree with settings.json defaults, empty status, no anchors
engine data clone <dir>                      # git clone --filter=blob:none --sparse -b data <repo> (owner convenience)
engine submit --event <event.json> [--data <dir>] [--llm mock|live|record|replay]
engine submit --payload <payload.json>        # bypasses the adapter; handy for fixtures
engine rerank [--data <dir>] [--llm …] [--max-waves 5] [--dry-run]
engine build-indexes --out <dir> [--data <dir>] [--build-id local]
engine maintenance <action> --args '<json>'
engine fixtures generate --n 60 --seed 42 --out fixtures/synthetic [--live]   # --live calls Opus once per fixture (~$12 total)
engine fixtures web-data --from fixtures/synthetic --out fixtures/web-data    # runs a mock rerank for 200 matches, builds indexes
engine status                                 # prints status.json + budget math for today
```

Environment: `ANTHROPIC_API_KEY` (only for `--llm live|record`), `RA_DATA_DIR` (default `./data`), `RA_LLM_MODE` (`mock` default outside Actions, `live` in Actions), `RA_NOW` (ISO timestamp; freezes the clock for deterministic tests), `RA_SEED` (seeds every random choice: ids in fixtures, opponent sampling, jitter), `RA_RECORDINGS_DIR` (`record` writes one JSON per LLM call keyed by request hash; `replay` serves them and fails on a miss), `GITHUB_TOKEN` (optional; without it the hourly-cap and health steps are skipped with a warning).

Without a remote, `commitWithRetry` detects `git remote` is empty and degrades to "write files, commit locally" (or, with `--no-git`, just writes files). The retry loop is tested against a local bare repository acting as `origin`, with two engine processes racing on the same shard.

### G.2 Mock LLM

`engine/src/llm/client.ts` exposes `gate()`, `analyze()`, `judge()`, `batchSubmit()`, `batchPoll()`. In `mock` mode: the gate accepts anything with ≥ 400 chars containing a year; the analyst returns a schema-valid analysis synthesized from the text (scores from a hash of the text, so they are stable; a card built from the first lines); the judge prefers the card whose stored fixture score is higher with confidence 0.6–0.8, and flips 20 % of swapped passes to produce realistic draws; `batchSubmit` returns an id and `batchPoll` resolves it on the next call. All deterministic under `RA_SEED`.

### G.3 Web app mock mode

`VITE_MOCK=1 pnpm dev`: a Vite plugin serves `fixtures/web-data/**` at `/resumearena/data/**` and intercepts `raw.githubusercontent.com` paths through a dev proxy to the same tree; `dispatch()` is replaced by a stub that writes a fake document into an in-memory map after 3 s and a rank entry after 10 s, so the pending page's whole state machine can be exercised; `probeToken()` returns a value from `localStorage.ra.mockProbe` (`ok`/`dead`/`limited`) so the fallback banner is testable. The fixture tree holds 60 synthetic resumes across the four ladders with real analyses, 200 mock matches, anchors, and a status.json with one alert.

### G.4 Tests

| Package | Runner | What |
|---|---|---|
| `packages/shared` | vitest | Glicko update against the worked values in ranking-system.md §1.4 (RD after n games table, K-equivalents); tier mapping; `newId` alphabet/length and shard; handle validation incl. blocklist folding; PII scrub corpus (40 positive, 40 negative lines); `parseIssueForm` on real GitHub-rendered bodies (fixtures captured once); sha256 hex equivalence between WebCrypto and Node. |
| `engine` | vitest | adapters (dispatch and issue produce identical `SubmissionInput`); `normalize` error codes; budget math; hourly cap with a stubbed runs API; placement wave scheduler on a fixture ladder (mock judge, seeded) reaching the RD targets within ±10 %; refinement allowance; index builder snapshot tests (`ladder/general/all/1.json`, `rank/k7.json`, `meta.json` bounds monotonic); concurrent `commitWithRetry` against a bare repo (two writers, same shard, both land, file is the union); delete removes every reference; tombstone idempotency. |
| `web` | vitest + testing-library | pending-page state machine with fake timers; dispatch error mapping; owner key create/restore; ingest metrics on three sample PDFs and one DOCX; `/browse`-driven smoke in CI against `vite preview` with `VITE_MOCK=1` (upload → preview → submit → pending → placed). |

CI (`.github/workflows/ci.yml`, not shown: `pnpm -r typecheck lint test` on pull requests, `RA_LLM_MODE=replay`). No test ever calls the live API.

---

## H. Setup checklist

### H.1 Only the owner can do these

1. **Anthropic key**: `gh secret set ANTHROPIC_API_KEY --repo noahfinkelstein/resumearena` (paste from the Anthropic console; keep spend limits set there too).
2. **Submission token**: create the fine-grained PAT exactly as in §D.7 step 1, then `gh variable set SUBMIT_TOKEN --body …` and `gh variable set SUBMIT_TOKEN_EXPIRES --body YYYY-MM-DD`.
3. **Maintenance key** (recommended): `openssl rand -base64 32 | gh secret set MAINTENANCE_KEY`; keep a copy in the password manager. Without it, `reanalyze`, `rotate-anchors`, `squash-data-history`, `set` and `drain-queue` refuse to run.
4. **Anchors**: review the 48 generated anchor cards (`maintenance rotate-anchors {generate:true}` then an afternoon of reading); until then the engine uses the linear fallback map.
5. Confirm the GitHub notification setting "Actions: send notifications for failed workflows you triggered" is on (every dispatch counts as triggered by the owner, so failures email him).

### H.2 The agent can do everything else with `gh`

```bash
R=noahfinkelstein/resumearena
# data branch (orphan) with initial files
git checkout --orphan data && git rm -rf . && node engine/src/cli.ts data init . && git add -A && git commit -m "data: init" && git push -u origin data && git checkout main
# labels
for l in "ra:submission#0e8a16" "ra:delete#b60205" "ra:processed#c2e0c6" "ra:failed#d93f0b" "ra:needs-review#fbca04"; do gh label create "${l%%#*}" --color "${l##*#}" --repo $R --force; done
# variables that are not secrets
gh variable set SITE_URL --repo $R --body "https://noahfinkelstein.github.io/resumearena/"
# Pages: confirm source is Actions (already enabled); the environment github-pages is created on first deploy
gh api repos/$R/pages --jq '{status, build_type, html_url}'
# Actions settings: default token permissions can stay read-only (workflows declare their own); confirm
gh api repos/$R/actions/permissions/workflow
# issue templates, workflows, composites: committed files on main
# first deploy
gh workflow run deploy.yml --repo $R --ref main -f reason=bootstrap && gh run watch --repo $R
# sanity: a submission through the real channel, then the status
node engine/src/cli.ts fixtures payload --n 1 | gh api -X POST repos/$R/actions/workflows/submit.yml/dispatches --input -   # uses the agent's own gh auth, not the public token
gh run list --repo $R --workflow submit.yml --limit 3
```

Branch protection on `data` must stay **off** (bot pushes); on `main` it is optional and must allow the owner's own pushes.

---

## I. Observability

### I.1 `status.json` (schema in §A.3)

Written by every rerank and nightly maintenance; copied into the Pages artifact. The fields that matter operationally: `budget.spent_usd` vs `daily_usd`, `queue.*`, `last_rerank.at`, `health.*` (`schedule_enabled`, `failed_runs_24h`, `cancelled_runs_24h`, `dispatch_path_24h`, `issue_path_24h`, `token_expires`, `alerts[]`), `per_category.anchor_residual_7d` and `disagreement_rate_7d`.

### I.2 `/about#status` widget

A plain definition list in mono, no charts:

```
Status                                  updated 4 min ago
entries        1,234 rated · 3 placing · 0 queued
judge          last ran 4 min ago · 42 matches · next in ≤ 10 min
spend today    $7.12 of $25.00
submissions    open · direct channel healthy · 96 today
schedule       enabled
alerts         none
```

Rules: amber when `last_rerank.at` is older than 30 min or `health.schedule_enabled` is false or `token_expires` is within 14 days; red when `paused`, `budget.exhausted`, or `alerts` is non-empty. The widget is the owner's dashboard too; there is no admin page.

### I.3 Run summaries (`$GITHUB_STEP_SUMMARY`)

`submit`: a one-row table — id, handle (or `anon`), source, outcome, gate verdict, analysis tokens (in / cache read / out), usd, wall time, retries of the push loop. `rerank`: batches ingested, deferred analyses run, placement waves (resumes advanced, matches, draws), refinement matches submitted, spend this run and today, drift residuals, commits made, deploy dispatched or not. `deploy`: artifact size, file count, ids indexed, build id. `maintenance`: per action. Nothing from a resume's text or card is ever printed; the judge's reasons are not printed either.

### I.4 Failures

`failures/<day>.jsonl` lines `{t, wf, run, step, code, ref?}` written by `record-failure` on any failed run (union-merged). Issue-path failures also label the issue `ra:failed`. `needs_review` outcomes label nothing but appear in `counts.needs_review` and in the nightly summary with their ids. GitHub's own failed-run email to the owner is the alert channel in v1; the first automation to add is a nightly comparison of `failures/` against yesterday's.

---

## J. Cost model

Prices (USD per MTok, from the Claude API reference, 2026-09): Haiku 4.5 $1 / $5, cache read $0.10; Sonnet 5.5 $2 / $10, cache read $0.20, 5-min cache write $2.50; Opus 5.5 $4 / $20, cache read $0.20, 1-hour cache write $8. Batches at 50 %. Token figures from scoring-rubric.md §7 (text input replaces the PDF: a 2-page resume is ≈ 3,000–4,000 text tokens).

### J.1 Per call

| Call | Input (uncached) | Cache read | Output (incl. thinking) | Cost |
|---|---|---|---|---|
| Gate, Haiku 4.5 | 4,000 × $1 = $0.0040 | 600 × $0.10 = $0.0001 | 80 × $5 = $0.0004 | **$0.0045** |
| Analysis, Opus 5.5, effort high | text 4,000 + schema 5,500 + framing 100 = 9,600 × $4 = $0.0384 | 6,500 × $0.20 = $0.0013 | 3,500 JSON + ≈ 4,000 thinking = 7,500 × $20 = $0.150 | **$0.19** |
| Analysis, Opus 5.5, effort medium | same | same | ≈ 5,500 × $20 = $0.110 | $0.15 |
| Judge, Sonnet 5.5, effort low, one ordering | cards + framing 1,400 + schema 100 = 1,500 × $2 = $0.0030 | 2,400 × $0.20 = $0.0005 | 70 + ≈ 400 = 470 × $10 = $0.0047 | **$0.0082** |
| Judge match (both orderings) | | | | **$0.0165** realtime · **$0.0083** via Batches |
| Judge match on Haiku 4.5 (lever, not default) | | | | $0.0080 realtime |

Cache writes: analyst system prompt with a 1-hour TTL costs $0.052 per cold hour (≤ $1.25/day regardless of volume); judge prompts at the default 5-minute TTL cost ≈ $0.006 per category per rerank run (≈ $3.5/day at 144 runs).

### J.2 Per submission (default configuration)

| Component | Count | Cost |
|---|---|---|
| Gate | 1 | $0.005 |
| Analysis | 1 | $0.19 |
| Placement: general 8 + 1.3 domains × 6 = 15.8 matches, realtime | 15.8 | $0.26 |
| **Total** | | **≈ $0.46** |

### J.3 Per day

Refinement is a budget share, not a per-submission cost: `refine_budget_share × daily_budget_usd`, spent through Batches at $0.0083 per match.

| Scenario | Submissions | Gate + analysis | Placement | Cache writes | Refinement (share) | **LLM per day** | Per month | Runner time (free on a public repo) |
|---|---|---|---|---|---|---|---|---|
| Default, 100/day | 100 | $19.5 | $26 | $5 | $12 (≈ 1,450 matches) | **≈ $62** | ≈ $1,900 | submit 100 × 3 min + rerank 144 × 4 min ≈ 15 h |
| Default, 1,000/day | 1,000 | $195 | $261 | $5 | $40 (≈ 4,800 matches) | **≈ $500** | ≈ $15,000 | submit 50 h + rerank 144 × 9 min ≈ 72 h (20 concurrent jobs → fine) |
| Frugal levers, 100/day: analyst effort `medium`, judge model `claude-haiku-4-5` for placement, 6 general games | 100 | $15.5 | $11 | $4 | $12 | **≈ $42** | ≈ $1,300 | same |
| Frugal, 1,000/day | 1,000 | $155 | $110 | $4 | $40 | **≈ $310** | ≈ $9,300 | same |

Reading: at 100/day the default configuration needs `daily_budget_usd ≈ 65`; the shipped default of 25 supports ≈ 40 submissions/day with refinement, after which entries queue to the next day. The owner picks the number; the budget, not the traffic, decides the bill. Everything else on the platform (Pages, Actions, storage, Issues) is $0 while the repository is public.

Spend per 100k resumes over their life (for the "sane cost at scale" question): analysis $19k + placement $26k + refinement at the default share for a year ≈ $4k → ≈ $0.49 per rated resume, dominated by placement; moving placement to Haiku halves that term.

---

## K. Interfaces and revisions this doc imposes on the other docs

- **scoring-rubric.md §1.1–1.2**: the analysis input is `text` (≤ 15,000 chars, already scrubbed) plus `LayoutMetrics`, not a PDF; `input_meta` becomes `metrics`; the ATS factors that depended on seeing the page (columns, fonts, images, text layer) now read from `metrics`; everything else (schema, prompts, sub-scores, card rules) is unchanged. The `is_resume`/injection checks move to the Haiku gate; the analyst still receives `injection_suspected` as context.
- **ranking-system.md**: math unchanged. "pg_cron every 2 minutes" becomes "rerank every ≤ 10 minutes, serialized"; the attention term `A` is 0 in v1 (no view counts without a server); refinement transport is Batches, ingested one run later; tiers are the UX doc's eight names with thresholds 1200/1400/…/2400 (that doc's §5.6 table is superseded by `settings.tiers`).
- **product-ux.md**: `/auth`, `/auth/callback` are removed; `/upload` is public; `/me` becomes "Your entries" (reads `localStorage.ra.mine`, shows keys status, offers export of the key file); the upload flow gains the ingestion preview step with the public-text statement and the key-reveal step; the result page gains the pending state machine (§F.3); the Arena is guess-the-judge over `arena/<cat>.json` with streak in `localStorage`, no votes; profile page reads raw `users/*` + rank shards; the ladder's "7d" column comes from `r7`; stage and window filters are static partitions; "find me" uses `ra.mine`. The "Limits" paragraph on `/about` reads: "60 entries an hour across the whole site, a daily analysis budget, 15,000 characters of text, no file is ever uploaded."
- Types shared across the three codebases are the ones in `packages/shared/src/types.ts`: `SubmissionPayload`, `SubmissionInput`, `LayoutMetrics`, `ResumeDoc`, `UserDoc`, `RowEntry`, `RatingEntry`, `HistoryDoc`, `MatchRecord`, `QueueEntry`, `UsageLine`, `Settings`, `Status`, `Manifest`, `LadderRow`, `LadderMeta`, `RankShard`, `ArenaPool`.

## L. Open questions for the owner

1. `daily_budget_usd` for launch (25 → ≈ 40 entries/day; 65 → 100/day at the default configuration).
2. Placement judge: Sonnet 5.5 as mandated, or Haiku 4.5 for rounds 1–2 and Sonnet for the last round (≈ −40 % placement cost, slightly noisier early rounds)?
3. Anchors before launch (an afternoon of review) or week two with the linear fallback map?
4. `MAINTENANCE_KEY`: accept the extra secret, or restrict costly maintenance to commits of `ops/commands/*.json` on `main` (secret-free, slower to operate)?
5. Should the hash-chain variant of the owner key (one-time preimages, which would make the Issue path safe for every manage action) be scheduled for v2?
