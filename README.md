# ResumeArena

Submit a resume, get an arena rating. Entries are compared head to head by an LLM judge on four ladders
(general, tech, finance, academia) and rated with Glicko. Everything runs on GitHub (Pages, Actions, the
repository, Issues) plus the Anthropic API: no server, no database vendor, no sign-in.

Site: https://noahfinkelstein.github.io/resumearena/ · Spec: [`docs/SPEC.md`](docs/SPEC.md) (the contract) ·
Rationale: [`docs/design/`](docs/design/)

## How it works

**In the browser.** You drop a PDF or DOCX (or paste text). `pdfjs`/`mammoth` extract the text in a worker and
measure the layout. A pattern-based scrub replaces names, emails, phones, URLs and addresses with `[name]`,
`[email]`, `[phone]`, `[url]`, `[address]`. You edit the preview under the sentence "Exactly this text becomes
public", pick a handle and get an owner key (shown once, kept in your browser). The file never leaves the
browser; only the approved text does.

**The write channel.** The page calls `workflow_dispatch` on `submit.yml` with a public, repository-scoped token
that can only start, cancel and tidy workflows here. If the token is dead or rate-limited, the same ten fields go
through a GitHub Issue Form instead.

**Two-stage pipeline in Actions.**

1. `submit` (one run per entry, parallel-safe, 2–3 minutes): validate → hourly cap and daily budget → text
   dedupe → Haiku gate (is it a resume, is it English, is it spam) → Opus analysis with a structured output
   (scores, card, ATS notes) → write the entry to the `data` branch and queue it for placement.
2. `rerank` (every 10 minutes and after every submit, serialized): placement rounds (8 games on general, 6 per
   domain ladder) against similar-rated entries and fixed anchor cards, then a budgeted refinement wave. The judge
   (Sonnet) sees two anonymized cards in both orders; disagreement across the two orders is a draw. Ratings are
   Glicko with a rubric-seeded start. Match lines land in an append-only log first, so a killed run loses at most
   one wave.
3. `deploy`: Vite build + `build-indexes` → ladder pages, rank shards and arena pools → GitHub Pages.
   `maintenance` runs nightly (snapshots, RD inflation, drift guard against the anchors, history compaction, a
   weekly history squash).

**The data.** The orphan `data` branch is the database: one JSON document per entry, per handle, per ladder,
plus JSONL logs for matches and spend. The SPA reads indexes from Pages and single documents from
`raw.githubusercontent.com`. No GitHub API traffic from the browser except the dispatch and a cached probe.

**Ratings.** Glicko (RD shown as ±), eight tiers from Entrant (below 1200) to Laureate (2400+), rank and
percentile per ladder, a 7-day delta, and the arena: guess which of two cards the judge preferred.

**Privacy.** Public by design. The approved text, the analysis, the card, the judge's notes and every match are
public on the site and in this repository. Anonymity is a display choice (`anon-k7q2m3x` instead of a handle).
Not retained anywhere: the file, your name, contact details, IP addresses, browser identifiers, the raw key.
Deleting removes an entry from the site within minutes and from the repository's history within 7 days (Sunday
squash). There are four PII backstops: the browser scrub, the engine's scrub re-check (it rejects rather than
rewrites), the analyst's residual-PII flags (entry held, nothing published), and a sweep over every model output.

## Repository layout

```
.github/workflows/   submit · rerank · deploy · maintenance · ci
.github/actions/     setup (pnpm + Node 24) · data-checkout (sparse, blobless checkout of `data`)
.github/ISSUE_TEMPLATE/  submission.yml · delete.yml (fallback channel) · config.yml
packages/shared/     types, ids, owner key, scrub, rating math, scoring, schemas (zod); used by web and engine
engine/              Node 24 CLI, no build step: submit, rerank, build-indexes, maintenance, fixtures
web/                 Vite + React SPA served at /resumearena/
fixtures/            60 synthetic resumes with real analyses; mock-mode data
docs/                SPEC.md, prompts (canonical), design rationale
ops/                 token.json (expiry), commands/ (owner-committed maintenance), runbooks/
scripts/             lint, maintenance planner, bootstrap-data, data-push, verify-assumptions, prompts-sync
```

## Local development

Node 24 (`.nvmrc`), pnpm (`packageManager` in `package.json`).

```bash
pnpm install
VITE_MOCK=1 pnpm dev            # the SPA against fixtures/web-data; dispatch and polling are simulated
pnpm typecheck && pnpm lint && pnpm test
```

In mock mode `dispatch()` writes a fake document after 3 s and a rank entry after 10 s, and the token probe
reads `localStorage['resumearena.mockProbe']` (`ok` | `dead` | `limited`) so the fallback panel is testable.

The engine runs directly on Node 24 (native type stripping, no flags):

```bash
node engine/src/cli.ts --help
node engine/src/cli.ts data init /tmp/ra-data                       # a fresh data tree with default settings
RA_DATA_DIR=/tmp/ra-data RA_NO_GIT=1 node engine/src/cli.ts submit --payload payload.json --llm mock
RA_DATA_DIR=/tmp/ra-data RA_NO_GIT=1 node engine/src/cli.ts rerank --llm mock
node engine/src/cli.ts build-indexes --data /tmp/ra-data --out /tmp/ra-pages --build-id local
```

`--llm mock` is the default outside Actions: the gate accepts anything resume-shaped, the analyst returns the
committed fixture analysis when the text matches one (else a deterministic synthetic one), the judge prefers the
stronger fixture with realistic noise. `--llm record` / `--llm replay` capture and serve real responses; CI runs
with `RA_LLM_MODE=replay` and never calls the live API. `RA_NOW` freezes the clock and `RA_SEED` seeds every
random choice.

Prompts: `docs/prompts/*.md` are canonical; `pnpm prompts:sync` regenerates `engine/prompts/` and CI checks they
match. Other scripts: `node scripts/lint.ts` (upload components never fetch, no `console.log` in the engine,
every workflow job has `permissions` and `timeout-minutes`, prompts exist) and
`node scripts/plan-maintenance.ts --event push` (what the next maintenance push would run).

## Owner setup

Two things only the owner can do. Everything else is files on `main` or `gh` commands.

1. **The Anthropic key** (the only secret). Set a spend limit in the Anthropic console as well.
   ```bash
   gh secret set ANTHROPIC_API_KEY --repo noahfinkelstein/resumearena
   ```
2. **The submission token** (the only variable; public by design). GitHub → Settings → Developer settings →
   Fine-grained tokens → Generate: name `resumearena-submit-YYYY-MM`, resource owner `noahfinkelstein`,
   expiration 366 days, repository access **only** `noahfinkelstein/resumearena`, repository permissions
   **Actions: Read and write** and nothing else. Then:
   ```bash
   gh variable set SUBMIT_TOKEN --repo noahfinkelstein/resumearena --body "github_pat_…"
   ```
   Put the expiry date in `ops/token.json` (`{ "expires": "YYYY-MM-DD", "rotated_at": "YYYY-MM-DD" }`), commit,
   and put a reminder in the calendar 30 days before. The build reads it; `/about#status` shows it.
3. **A contact mailbox** (optional; spec §14 step 7). `gh variable set CONTACT_EMAIL --repo noahfinkelstein/resumearena --body "<mailbox you read>"`.
   The build reads it into `VITE_CONTACT_EMAIL` for `/about#contact`; unset, the page points at the repository's issue tracker.

Also worth confirming once: Pages source is "GitHub Actions"
(`gh api repos/noahfinkelstein/resumearena/pages --jq '{build_type,html_url}'`), branch protection is **off** on
`data`, and the notification "Actions: send notifications for failed workflows you triggered" is on (every
dispatch counts as triggered by the owner, so failures reach you by email).

## Release recipe

```bash
R=noahfinkelstein/resumearena
# 0. main: code, workflows, templates, fixtures, docs committed; CI green.
# 1. data branch (orphan; runs `engine data init` in a temporary worktree, pushes, never touches your checkout)
scripts/bootstrap-data.sh
# 2. labels
for l in "ra:submission#0e8a16" "ra:delete#b60205" "ra:processed#c2e0c6" "ra:failed#d93f0b"; do
  gh label create "${l%%#*}" --color "${l##*#}" --repo $R --force
done
# 3. owner setup above
# 4. first deploy (empty ladders; fallback-only until SUBMIT_TOKEN exists)
gh workflow run deploy.yml --repo $R --ref main -f reason=bootstrap && gh run watch --repo $R
# 5. verify the platform assumptions (spec §16): PASS/FAIL per row; --dispatch sends one real 15,000-char entry
node scripts/verify-assumptions.ts --dispatch
# 6. manage-action check (D-60): --dispatch above also checks that inputs are not readable through the run
#    UI/API/logs. If that row FAILS, set VITE_MANAGE: "0" in deploy.yml until the hash-chain variant ships.
# 7. anchors: ops/runbooks/anchors.md (≈ $2 per category), validate, confirm status.json health.alerts is empty
# 8. smoke: one real PDF through /upload in a private window → pending → analysed → placed;
#    /arena shows pairs after the first reranks (needs ≥ 20)
# 9. rotate-token dry run (ops/runbooks/rotate-token.md) so the first real rotation is not the first attempt
# 10. announce; set daily_budget_usd on the data branch's settings.json (25 ≈ 35 entries/day; 65 ≈ 100/day)
```

Day to day: `ops/runbooks/` (rotate-token, pause, anchors, squash-history, delete-issue, cancel-flood,
monthly-check) and `ops/commands/README.md` for the owner-committed maintenance commands.

## Cost expectations

Default settings, Anthropic list prices: gate ≈ $0.005, analysis ≈ $0.19, a judge match ≈ $0.0165. A placed
entry costs ≈ $0.46 (analysis + 8 general games + about 1.3 domain ladders × 6 games). Refinement spends a share
of the daily budget (≈ 600 matches/day at $25). Prompt-cache writes add ≈ $1.25/day for the analyst and
≈ $0.90/day for the judge at 1-hour TTLs. `daily_budget_usd` is the ceiling; the hard stop is 1.15× it plus at
most 20 × $0.20 of concurrent-run overshoot. Everything on GitHub is $0 while the repository is public.

## Limits

- 20 entries an hour across the whole site (runs above the cap are dropped without writing anything), a daily
  budget after which entries queue to the next day, 15,000 characters of text, English only.
- The PII scrub is pattern-based. It misses all-caps names and names in running text; the preview exists so you
  can catch what it missed. The engine holds entries where the analyst still sees identifying details.
- The judge is a language model. Ratings are a game, not hiring advice. Position bias is cancelled by judging
  both orders; calibration is monitored against fixed anchors, not guaranteed.
- Latency is honest: analysis usually lands in 3 to 6 minutes, the rating usually within 20 minutes after that.
  GitHub's schedulers can delay or skip runs; every submission also triggers a rerank directly.
- The public token is a doorbell, not a key. Anyone can use it to cancel runs or disable schedules; every run
  re-enables the schedules and `ops/runbooks/cancel-flood.md` covers the rest. It cannot read or change anything.
- Deleted text persists in CDN caches for up to 10 minutes, in branch history until the next Sunday squash, and
  in forks or copies made by others, which are outside our control.
