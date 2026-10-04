# ResumeArena — Ranking Engine (TypeScript, GitHub Actions, JSON on the `data` branch)

Status: design, v1 · Owner: Noah Finkelstein · Date: 2026-10-03
Scope: the port of `ranking-system.md` from plpgsql-on-Supabase to a TypeScript engine that runs inside the serialized `rerank` GitHub Actions workflow and reads/writes JSON files on the orphan `data` branch. This doc owns: rating math and policy (unchanged where noted), the on-disk data structures, the engine's module layout and signatures, the exact per-run algorithm, budget accounting, tests, scale limits, and the static index files the SPA reads.
Depends on: `scoring-rubric.md` (the `ResumeAnalysis`/`Card` schemas, the judge system prompt, `seed_rating`), `product-ux.md` (tier names, display rules, the `ResultView`/`LadderRow` shapes this doc now serves as static JSON). Supersedes the `rank` schema, Edge Functions and pg_cron loop in `ranking-system.md` §3.1, §6, §6.5; the math in §1–§3 of that doc is kept and restated here only where the port changes its shape.

---

## 0. Summary of decisions

| Question | Decision |
|---|---|
| Rating system | Glicko (rating + RD), volatility stored and frozen. Same constants: center 1500, RD₀ 250 with prior / 350 without, floor 50, ceiling 350, inflation c = 6/√day, revision RD ≥ 180, provisional at RD > 130, q = ln 10 / 400. Unchanged. |
| Seed | `seed = 1200 + 8 × (score − 50)` (800..1600) from the rubric's per-category score. Anchor-ladder interpolation from the old §2.1 is dropped as the seed source; anchors remain for the fixed scale and drift control. |
| Placement | general 8 games in rounds 3/3/2; each domain 6 games in rounds 3/3; one round = one Glicko rating period; game 2 of round 1 is always the nearest anchor. Domain seed `0.5 × r_general + 0.5 × seed(domain)`, RD₀ 220. Unchanged. |
| Judge | `claude-sonnet-5-5`, both orderings per match, forced choice FIRST/SECOND, disagreement = draw. All realtime inside the run. Message Batches API is **not used in v1** (a run would have to outlive the batch; see §10). |
| Transport | Two-stage pipeline. The submission workflow writes new files only; the `rerank` workflow (concurrency group, cron `*/10` + `workflow_run`) is the only writer of ratings/history/matches/status. |
| Durability | Write-ahead log. Judged matches are appended to `matches/<category>/<YYYY-MM>.jsonl` and pushed **before** any rating changes. `ratings/<category>.json` is a materialized fold over the log with a per-file line cursor; a restarted run replays unapplied lines. Every line carries the run id. |
| Refinement scheduling | Same priority formula (uncertainty, staleness, ladder position, recent movement, jitter); attention term weight 0 in v1 (no analytics without a third party). 70/20/10 local / cross-check / anchor opponent mix. |
| Drift | 12 locked anchors per category (ratings 1000..2100, RD 30). Nightly anchor-residual shift clamped to ±10; `mean1500` mode retained as a setting. |
| Categories | `general` for everyone; `finance` / `tech` / `academia` at relevance ≥ 0.35. |
| Reupload | Same handle + owner key + `supersedes` → new row inherits rating, RD = max(RD, 180), short revision placement (general 3/2, domain 3); history continues under one `lineage`. |
| Tiers | Entrant < 1200 · Contender 1200–1399 · Challenger 1400–1599 · Candidate 1600–1799 · Expert 1800–1999 · Master 2000–2199 · Grandmaster 2200–2399 · Laureate ≥ 2400; **Provisional** modifier when placement is unfinished or RD > 130. |
| Budget | Daily cap (default $25 UTC), refinement share 0.40, hard stop at 1.15×. Cost computed per call from `usage` and a price table keyed by `response.model`. |
| Runtime | Node 24 with native type stripping (`erasableSyntaxOnly`), `node --test` for tests, `@anthropic-ai/sdk` for the judge, no other runtime dependencies in `engine/`. |

---

## 1. Where the engine runs

### 1.1 Workflow

`.github/workflows/rerank.yml`:

```yaml
name: rerank
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_run:
    workflows: [submit]            # the submission workflow, after each run
    types: [completed]
  workflow_dispatch:
    inputs:
      mode:
        description: "normal | nightly | anchors-validate | replay-only"
        default: normal

concurrency:
  group: rerank                    # one engine run at a time, queued runs collapse to one
  cancel-in-progress: false

permissions:
  contents: write                  # push to the data branch
  actions: read

jobs:
  rerank:
    runs-on: ubuntu-latest
    timeout-minutes: 55            # hard wall; the engine's own soft cap is 40 min (§6.4)
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}
      MODE: ${{ inputs.mode || 'normal' }}
    steps:
      - uses: actions/checkout@v5
        with: { ref: main, path: src, sparse-checkout: "engine\npackages\npnpm-workspace.yaml\npackage.json\npnpm-lock.yaml" }
      - uses: actions/checkout@v5
        with:
          ref: data
          path: data
          fetch-depth: 1
          filter: blob:none          # partial clone; the engine materializes only the paths it touches (§8.3)
          sparse-checkout: |
            status.json
            ratings
            anchors
            queue
            config
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version-file: src/.nvmrc, cache: pnpm, cache-dependency-path: src/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile
        working-directory: src
      - run: |
          git config user.name  "resumearena-engine"
          git config user.email "engine@users.noreply.github.com"
        working-directory: data
      - run: node --experimental-strip-types src/engine/src/cli.ts rerank --data ./data --run-id "$RUN_ID" --mode "$MODE"
```

`deploy.yml` (owned by the platform doc) listens to `push` on `data` and `main`; the engine's write-ahead commits carry `[wal]` in the message and the deploy job has `if: ${{ !contains(github.event.head_commit.message, '[wal]') }}` so a run with six waves triggers one deploy, not seven.

### 1.2 Run lifecycle in one picture

```
load ─► ingest queue ─► plan wave ─► judge wave (parallel, ≤8 in flight) ─► APPEND to WAL ─► commit+push "[wal]"
  ▲                                                                                              │
  │                                                 apply wave in memory (Glicko fold) ◄─────────┘
  │                                                            │
  └──── next wave (until placement rounds are done and refinement allowance is spent) ◄──────────┘
                                                               │
                                             finalize: ranks/percentiles, nightly tasks if due,
                                             write ratings/history/cards/status, commit+push, done
```

Two kinds of commits leave the run:

- **WAL commit** (`[wal] run <id> wave <n>: <k> matches`): touches only `matches/**` and `status.json` (heartbeat). Pushed after every wave. If the run dies after this, nothing paid for is lost.
- **Apply commit** (`rerank run <id>: <k> matches, <p> placed`): touches `ratings/**`, `history/**`, `cards/**`, `queue/**`, `status.json`. Pushed once at the end (and additionally every 10 waves on long drains). Triggers deploy.

The ratings files are a *fold* over the match log. That is the whole idempotency story: `ratings/<cat>.json` records how many lines of each log file it has consumed; the apply step is deterministic given the log and the pre-cursor state; replaying lines past the cursor reconstructs exactly the state the dead run had in memory (§4.1 step 2).

---

## 2. Data on the `data` branch

### 2.1 File layout

```
data (orphan branch)
├── status.json                              engine status, spend ledger, cursors summary        (engine)
├── config/
│   └── ranking.json                         settings (§2.9); edited by hand, read every run     (owner)
├── queue/
│   └── placement/<resumeId>.json            one file per queued resume; created by submit,      (submit → engine)
│                                            deleted by the engine when ingested
├── resumes/<resumeId>.json                  analysis + card + owner hash; NEW files only        (submit, delete/toggle workflows)
├── users/<handle>.json                      handle → resume ids, created-at                     (submit)
├── cards/<xx>.json                          resumeId → judge card text; copied in by the engine (engine)
├── ratings/<category>.json                  all rating rows of a category + log cursors         (engine)  → sharded at 20 MB (§8.4)
├── history/<category>/<xx>.json             per-resume history points + recent matches          (engine)
├── matches/<category>/<YYYY-MM>.jsonl       write-ahead log, append-only                        (engine)
├── anchors/<category>.json                  12 synthetic anchor cards with locked ratings       (owner, validated by engine)
└── audits/<YYYY-MM-DD>.json                 nightly drift + judge-health report                  (engine)
```

`<xx>` is the first two hex characters of `sha256(resumeId)`: 256 shards, uniform regardless of the id alphabet. Resume ids are opaque to the engine (the submission doc defines them; the UX doc wants lowercase base32, 10–12 chars).

### 2.2 Types shared by engine and SPA (`packages/shared/src/types.ts`)

```ts
export type Category = 'general' | 'finance' | 'tech' | 'academia';
export const CATEGORIES: readonly Category[] = ['general', 'finance', 'tech', 'academia'];
export type Domain = Exclude<Category, 'general'>;
export type CareerStage = 'student' | 'new_grad' | 'early' | 'mid' | 'senior';
export type TierKey =
  | 'entrant' | 'contender' | 'challenger' | 'candidate'
  | 'expert' | 'master' | 'grandmaster' | 'laureate';
export type Outcome = 1 | 0.5 | 0;                    // from side A's point of view
export type MatchKind = 'placement' | 'revision' | 'refine' | 'crosscheck' | 'anchor';

/** One row of ratings/<category>.json. Short keys on purpose: there are up to 100k of these per file. */
export interface RatingRow {
  id: string;            // resumeId
  own: string;           // first 12 hex of the owner key hash; same-owner pairs never meet
  lin: string;           // lineage id: equals the first resumeId of this handle's lineage; history is continuous across reuploads
  r: number;             // rating, 2 dp
  rd: number;            // rating deviation, 2 dp
  vol: number;           // volatility, stored, frozen at 0.06 in v1
  seed: number;          // rubric seed (general: 1200 + 8(score-50); domain: blended, §5.2)
  score: number;         // rubric score 0..100 for this category
  g: number; w: number; d: number; l: number;    // games, wins, draws, losses
  round: number;         // placement rounds completed; -1 = domain row waiting for general placement
  placed: boolean;       // placement finished
  kind: 'user' | 'anchor';
  locked: boolean;       // anchors: rating/rd never move
  elig: boolean;         // false: superseded, deleted, opted out, dup suspect
  dup: boolean;          // flagged duplicate of another owner's card; hidden from boards
  stage: CareerStage;
  sig: string;           // top_signal from the analysis, <= 18 chars, for the ladder's signal chip
  vis: 'handle' | 'anon';
  rank: number | null;   // dense rank among board rows, recomputed every run
  pct: number | null;    // percentile 0..1 (1 = top), recomputed every run
  peak: number; peakAt: string;        // ISO date
  last: string | null;   // last match ISO timestamp
  day: { date: string; r: number; rank: number | null } | null;   // snapshot at the first run after 00:00 UTC
  opp: string[];         // ring of the last 10 opponent ids in this category (anti-repeat)
  mv: number;            // |r - day.r| at last update; feeds the V term of priority
  created: string;       // ISO
}

export interface RatingsFile {
  schema: 1;
  category: Category;
  updatedAt: string;
  runId: string;                              // last run that wrote this file
  cursor: Record<string, number>;             // "2026-10.jsonl" -> number of lines applied; keys sorted
  shift: number;                              // cumulative drift shift applied (audit only)
  rows: RatingRow[];                          // sorted by id; the engine builds Maps on load
}

/** One line of matches/<category>/<YYYY-MM>.jsonl. Append-only; never edited. */
export interface MatchLine {
  v: 1;
  id: string;            // sha256(runId|wave|seq) first 16 hex: deterministic, so a double append is detectable
  run: string;           // runId that judged it
  wave: number;
  seq: number;           // position inside the wave
  at: string;            // ISO timestamp of judging
  cat: Category;
  kind: MatchKind;
  period: string;        // rating-period key. placement/revision: `${subject}:${cat}:r${round}`; refine/crosscheck/anchor: = id
  subj: string;          // whose scheduling created the match (the placement subject or the refinement row)
  a: string; b: string;  // resume ids, a < b lexicographically (pass order is recorded separately)
  pre: { ar: number; ard: number; br: number; brd: number };   // ratings when the match was planned
  p1: Verdict;           // pass 1 saw (a=FIRST, b=SECOND)
  p2: Verdict;           // pass 2 saw (b=FIRST, a=SECOND)
  o: Outcome;            // outcome for a: 1 both picked a, 0 both picked b, 0.5 disagreement
  agree: boolean;
  model: string;         // response.model of pass 1 (fallback may change it; pass 2 model in p2.model if different)
  pv: string;            // judge prompt version, e.g. "judge.v1"
  tok: { in: number; cr: number; cw: number; out: number };   // summed over both passes
  usd: number;           // 6 dp
}

export interface Verdict {
  winner: 'first' | 'second';
  confidence: number;    // 0.5..1, stored, unused in v1 updates
  factors: string[];     // 1..3 items, <= 80 chars each
  reason: string;        // <= 320 chars
  model?: string;        // only when it differs from MatchLine.model
}

/** history/<category>/<xx>.json: { [resumeId]: HistoryEntry } */
export interface HistoryEntry {
  pts: HistoryPoint[];   // chronological; compacted per §5.8
  recent: RecentMatch[]; // last 10 matches, newest first; what the result page shows
}
export type HistoryPoint = [at: string, r: number, rd: number, reason: 'p' | 'm' | 'v' | 'd' | 's'];
//  p placement · m match · v revision placement · d drift · s daily snapshot (compaction output)
export interface RecentMatch {
  id: string;            // match id
  at: string;
  o: 'W' | 'D' | 'L';
  opp: string;           // opponent resume id ('anchor:<cat>:<n>' for anchors)
  oppR: number;          // opponent rating before the match
  dr: number;            // rating delta for this side
  note: string;          // pass-1 reason, trimmed to 140 chars, from the winner's perspective
  kind: MatchKind;
}

/** queue/placement/<resumeId>.json — written by the submission workflow. */
export interface PlacementTicket {
  v: 1;
  resumeId: string;
  handle: string;
  ownerKeyHash: string;  // sha256 hex of the raw owner key
  supersedes: string | null;      // previous resume id when this is a reupload under the same handle
  queuedAt: string;
  analysisCostUsd: number;        // gate + analysis spend, so the engine's ledger sees it (§6.2)
}

/** anchors/<category>.json */
export interface AnchorsFile {
  schema: 1;
  category: Category;
  promptVersion: string;          // judge version the anchors were validated against
  validatedAt: string | null;
  anchors: Anchor[];              // exactly 12, ratings 1000..2100 step 100
}
export interface Anchor {
  id: string;                     // `anchor:<category>:<rating>`
  rating: number;                 // locked
  spec: string;                   // the authoring brief (§3.5 of ranking-system.md)
  card: string;                   // judge card text, same renderer as user cards
  stage: CareerStage;
}

/** status.json */
export interface Status {
  schema: 1;
  updatedAt: string;
  run: {
    id: string; mode: string; startedAt: string; finishedAt: string | null;
    state: 'running' | 'ok' | 'failed' | 'aborted_budget' | 'aborted_judge';
    waves: number; matches: number; placed: number; usd: number; error: string | null;
  };
  queue: { pending: number; oldestQueuedAt: string | null };
  spend: {
    day: string;                                  // UTC date the counters belong to
    usd: number;                                  // all purposes today
    byPurpose: Record<'analysis' | 'judge_place' | 'judge_refine' | 'judge_anchor', number>;
    calls: number;
    month: { ym: string; usd: number };
  };
  judge: {
    model: string; promptVersion: string;
    healthy: boolean;                             // false after the circuit breaker trips (§6.4)
    lastError: string | null;
    disagreementRate7d: number | null;
    anchorAccuracy7d: number | null;
  };
  nightlyDoneFor: string | null;                  // UTC date
  counts: { resumes: number; rated: Record<Category, number>; matchesTotal: number };
}
```

### 2.3 What the submission workflow must write (contract, owned by the platform doc)

The engine reads these and never writes them:

- `resumes/<id>.json` with at least: `{ id, handle, ownerKeyHash, state: 'analyzed' | 'deleted', visibility: 'handle' | 'anon', createdAt, supersedes, analysis: ResumeAnalysis, cardText: string, cardHash: string }`. `cardText` is the rendered judge card (rubric §2.3 rules applied); `cardHash = sha256(normalized cardText)`.
- `queue/placement/<id>.json` as `PlacementTicket`. The ticket is the trigger; a resume file without a ticket is never placed.
- Toggle-anonymous and delete workflows rewrite `resumes/<id>.json` (`visibility`, `state`). Those are the only non-new-file writes outside the engine, and they touch a file the engine only reads, so the fetch-rebase-push loops never conflict.

### 2.4 `cards/<xx>.json`

`{ [resumeId]: { t: string /* card text */, h: string /* cardHash */, st: CareerStage } }`. The engine copies a card here when it ingests the ticket, so a refinement wave can load opponents' cards without materializing thousands of `resumes/*.json` files from a partial clone. Anchors are not in here; they come from `anchors/`.

### 2.5 Settings (`config/ranking.json`)

```json
{
  "schema": 1,
  "judgeModel": "claude-sonnet-5-5",
  "judgePromptVersion": "judge.v1",
  "dailyBudgetUsd": 25,
  "refineBudgetShare": 0.40,
  "hardStopMultiplier": 1.15,
  "maxPlacementsPerRun": 25,
  "maxRefineMatchesPerRun": 120,
  "minRefineBatch": 12,
  "runsPerDay": 144,
  "softWallClockMinutes": 40,
  "judgeConcurrency": 8,
  "placementRoundsGeneral": [3, 3, 2],
  "placementRoundsDomain": [3, 3],
  "revisionRoundsGeneral": [3, 2],
  "revisionRoundsDomain": [3],
  "rdInitial": 350, "rdInitialWithPrior": 250, "rdInitialDomain": 220,
  "rdFloor": 50, "rdCeiling": 350, "rdInflationC": 6, "rdRevisionMin": 180, "provisionalRd": 130,
  "categoryRelevanceMin": 0.35,
  "opponentMix": { "local": 0.70, "crosscheck": 0.20, "anchor": 0.10 },
  "priorityWeights": { "U": 3.0, "S": 1.0, "T": 1.5, "A": 0.0, "V": 0.75, "J": 0.25 },
  "refineCooldownHours": 6,
  "driftMode": "anchors", "driftMaxShift": 10, "driftAlertResidual": 0.08,
  "estCostPerMatchUsd": 0.016,
  "prices": {
    "claude-sonnet-5-5": { "in": 2.00, "cacheRead": 0.20, "cacheWrite": 2.50, "out": 10.00 },
    "claude-haiku-4-5":  { "in": 1.00, "cacheRead": 0.10, "cacheWrite": 1.25, "out": 5.00 },
    "claude-opus-5-5":   { "in": 4.00, "cacheRead": 0.20, "cacheWrite": 5.00, "out": 20.00 },
    "claude-opus-4-8":   { "in": 5.00, "cacheRead": 0.50, "cacheWrite": 6.25, "out": 25.00 }
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
  ]
}
```

Prices are USD per million tokens from the Claude API price table as of 2026-09 (Sonnet 5.5 $2/$10, cache read $0.20, cache write 1.25× input; Haiku 4.5 $1/$5; Opus 5.5 $4/$20, cache read $0.20). `claude-opus-4-8` is listed only because the server-side refusal fallback can serve a response from another model, and cost is priced by `response.model` (§6.1). Re-check before launch.

---

## 3. Module layout and signatures

```
packages/shared/src/
  types.ts        the types in §2.2 plus the index-file types in §9
  rating.ts       pure Glicko math, tiers, percentiles, seeds, priority — no I/O, no Date.now()
  prices.ts       PriceTable type + costOf(usage, model, prices)
  index.ts        re-exports
engine/
  package.json    { "type": "module", deps: @anthropic-ai/sdk; devDeps: typescript }
  tsconfig.json   erasableSyntaxOnly, module nodenext, noEmit
  src/
    cli.ts        `rerank`, `index-build`, `anchors validate`, `sim`, `replay` subcommands
    rerank.ts     orchestration of one run (§4)
    store.ts      data-branch I/O: load/save JSON, shard paths, WAL append, commit+push with fetch-rebase retry
    pairing.ts    opponent selection
    judge.ts      Anthropic calls, concurrency, retries, token accounting
    budget.ts     ledger + allowance + stop conditions
    anchors.ts    anchor loading, nearest anchor, drift check, validation
    index-build.ts leaderboard pages, views, meta.json → web/public/data
    prompts/judge.v1.ts  the four category system prompts (verbatim from scoring-rubric.md §6.2)
    rng.ts        mulberry32 seeded PRNG
  test/           node --test; unit tests for shared math live in packages/shared/test
  sim/            simulation harness (§7)
```

### 3.1 `packages/shared/src/rating.ts`

```ts
export const Q = Math.LN10 / 400;                         // 0.0057565

export interface GlickoConstants {
  rdFloor: number; rdCeiling: number; rdInflationC: number;
  rdInitial: number; rdInitialWithPrior: number; rdInitialDomain: number;
  rdRevisionMin: number; provisionalRd: number;
}
export const DEFAULT_CONSTANTS: GlickoConstants; // 50, 350, 6, 350, 250, 220, 180, 130

export function g(rd: number): number;             // 1 / sqrt(1 + 3 q² rd² / π²)
export function expected(r: number, oppR: number, oppRd: number): number;   // 1 / (1 + 10^(-g(oppRd)(r-oppR)/400))

export interface Game { oppR: number; oppRd: number; score: Outcome; weight?: number }   // weight defaults to 1
export interface GlickoResult { r: number; rd: number }
/** One rating period. Returns the input unchanged when games is empty. Rounds to 2 dp like the plpgsql original. */
export function glickoUpdate(r: number, rd: number, games: readonly Game[], rdFloor?: number): GlickoResult;

/** Two-sided single match from pre-match values; both results computed from `pre`, never sequentially. */
export function applyMatch(pre: { ar: number; ard: number; br: number; brd: number }, outcomeA: Outcome, rdFloor?: number)
  : { a: GlickoResult; b: GlickoResult };

/** Placement round: subject gets one m-game period; each opponent a 1-game period against the subject's pre-round values. */
export function applyPeriod(subject: GlickoResult, games: readonly (Game & { oppId: string; oppLocked: boolean })[], rdFloor?: number)
  : { subject: GlickoResult; opponents: Map<string, GlickoResult> };

export function inflateRd(rd: number, idleDays: number, c: GlickoConstants): number;   // sqrt(rd² + c²) once per idle day > 7, capped

export function seedRating(score: number): number;                                      // 1200 + 8*(score-50), clamped 800..1600
export function seedDomain(generalRating: number, domainScore: number): number;        // 0.5*general + 0.5*seedRating(domainScore)

export function tierFor(rating: number, tiers: TierConfig[]): TierKey;
export function isProvisional(row: Pick<RatingRow, 'placed' | 'rd'>, provisionalRd: number): boolean;
export function plusMinus(rd: number): number;                                           // round(1.96 * rd)

/** Dense ranks and percentiles over board rows (elig && placed && kind==='user' && !dup). Order: r desc, rd asc, id asc. pct = 1 - (rank-1)/(n-1); n==1 → 1. */
export function rankAndPercentile(rows: readonly RatingRow[]): Map<string, { rank: number; pct: number }>;

export interface PriorityInput { rd: number; daysSinceLast: number; pct: number | null; views7d: number; moved: boolean; jitter: number /* 0..1 from the run's PRNG */ }
export function priority(p: PriorityInput, w: PriorityWeights, c: GlickoConstants): number;
//  U = ((rd - floor)/(ceiling - floor))²; S = min(days/45, 1); T = exp(-8 (1 - pct)); A = min(views/200, 1); V = moved ? 1 : 0; J = jitter * wJ
//  = wU*U + wS*S + wT*T + wA*A + wV*V + J

export function placementOffsets(games: 3 | 2, rd: number): number[];   // 3 → [-0.7, 0, 0.7]*rd ; 2 → [-0.5, 0.5]*rd
export function outcomeFromPasses(p1: 'first' | 'second', p2: 'first' | 'second'): { o: Outcome; agree: boolean };
//  p1 'first' means a; p2 'first' means b. both→a: 1; both→b: 0; else 0.5
```

Everything here is pure and total; the simulation and the unit tests import only this file and `prices.ts`.

### 3.2 `engine/src/store.ts`

```ts
export interface Store {
  root: string;                                            // path of the data checkout
  readJson<T>(rel: string): Promise<T | null>;             // materializes the blob from the partial clone if needed (git sparse-checkout add)
  writeJson(rel: string, value: unknown): Promise<void>;   // stable key order, trailing newline, atomic rename
  appendLines(rel: string, lines: string[]): Promise<void>;
  readLines(rel: string, fromLine: number): AsyncIterable<string>;
  list(relDir: string): Promise<string[]>;
  remove(rel: string): Promise<void>;
  shardOf(resumeId: string): string;                        // first 2 hex of sha256(id)
  /** git add -A on the given paths, commit, then push with fetch --rebase retry (up to 6 tries, 2^n s backoff). Throws StoreConflict on a non-rebaseable conflict. */
  commitAndPush(message: string, paths: string[]): Promise<{ sha: string }>;
}
export function openStore(root: string): Store;
```

`commitAndPush` never force-pushes. The submission workflow only adds new files and the toggle/delete workflows only edit `resumes/<id>.json`, so a rebase onto their commits is always clean. A conflict means two engine runs overlapped, which the concurrency group makes impossible; it is treated as fatal (`run.state = 'failed'`) and the next run replays from the WAL.

### 3.3 `engine/src/judge.ts`

```ts
import Anthropic from '@anthropic-ai/sdk';

export interface JudgeOptions {
  client: Anthropic;                 // new Anthropic({ maxRetries: 2, timeout: 60_000 })  (ms)
  model: string;                     // settings.judgeModel
  promptVersion: string;             // settings.judgePromptVersion
  concurrency: number;               // in-flight API calls; a match consumes two slots, one per pass
  prices: PriceTable;
  onUsage: (purpose: SpendPurpose, usd: number, tok: TokenCounts, model: string) => void;   // budget ledger hook
  shouldStop: () => boolean;         // budget/wall-clock gate consulted before each call
  rng: () => number;
}
export interface MatchRequest {
  cat: Category; kind: MatchKind; period: string; subj: string;
  a: string; b: string; cardA: string; cardB: string;
  pre: MatchLine['pre'];
}
export type MatchResult =
  | { ok: true; line: Omit<MatchLine, 'id' | 'run' | 'wave' | 'seq'> }
  | { ok: false; req: MatchRequest; reason: 'refusal' | 'max_tokens' | 'invalid_json' | 'api_error' | 'stopped'; detail: string };

export interface Judge {
  /** Judges all requests with bounded parallelism; results are returned in request order. Never throws for per-match failures. Throws JudgeFatal on auth/billing/bad-request errors or when the circuit breaker trips. */
  judgeMany(reqs: MatchRequest[]): Promise<MatchResult[]>;
  stats(): { calls: number; retries: number; failures: number; consecutiveFailures: number; concurrencyNow: number };
}
export function createJudge(opts: JudgeOptions): Judge;

export const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['winner', 'confidence', 'decisive_factors', 'reasoning'],
  properties: {
    winner: { type: 'string', enum: ['first', 'second'] },
    confidence: { type: 'number', minimum: 0.5, maximum: 1 },
    decisive_factors: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 80 } },
    reasoning: { type: 'string', maxLength: 320 },
  },
} as const;
```

One pass is one call:

```ts
const res = await client.beta.messages.create({
  model,
  max_tokens: 1536,                                   // ~150 JSON + low-effort thinking
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',                               // a policy decline is re-run server-side on a fallback model; priced by res.model
  system: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT[cat], cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: `FIRST\n${first}\n\nSECOND\n${second}\n\nWhich candidate is more impressive overall?` }],
  thinking: { type: 'adaptive' },                     // Sonnet 5.5 default; `disabled` is rejected on this model
  output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
});
```

Rules the implementation follows:

- **Ordering.** Pass 1 sends (a, b), pass 2 sends (b, a); both are fired together and awaited with `Promise.allSettled`. If exactly one pass fails after retries, the match is a failure (we never score on one ordering).
- **Validation.** Read the single `text` block, `JSON.parse`, check the four fields and enum by hand (no schema library in the engine). Check `stop_reason` first: `refusal` → failure `'refusal'` (the `fallbacks: 'default'` route has already been tried server-side); `max_tokens` → one retry with `max_tokens: 3072`, then failure.
- **Retries.** The SDK's `maxRetries: 2` handles brief 429/5xx jitter. On top of it the judge retries up to 5 times with `min(60s, 2s × 2^n) + U(0, 1s)` when the error is `Anthropic.RateLimitError` (429), `Anthropic.InternalServerError` with `status` 500 or 529 (overloaded), or `Anthropic.APIConnectionError` (checked before the base `Anthropic.APIError`, of which it is a subclass in the TypeScript SDK). A `retry-after` header, when present on the error, overrides the computed delay. `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError` are configuration errors and throw `JudgeFatal` immediately.
- **Adaptive concurrency.** Start at `concurrency` (8). On a 429 halve the limiter (min 2); after 20 consecutive successes add 1 back (max 8). The limiter is a counting semaphore around individual calls.
- **Circuit breaker.** 10 consecutive match failures with `api_error` → `JudgeFatal('judge_unavailable')`; the run finalizes what it has (§4.1 step 9) and sets `status.judge.healthy = false`. The SPA shows the UX doc's "Placement is paused" copy while that flag is false; the next run resets it on the first success.
- **Cache warmth.** Requests are grouped by category inside a wave so the ~2,400-token system prompt is read from cache (Sonnet 5.5's minimum cacheable prefix is 512 tokens; the 5-minute TTL is refreshed by every hit). A wave is never longer than a few minutes, so the cache stays warm across waves of the same run.
- **Accounting.** For each response: `usage.input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` → `costOf(usage, res.model, prices)` → `onUsage(purpose, usd, tok, res.model)`. Purpose is `judge_place` for placement/revision kinds, `judge_refine` for the rest, `judge_anchor` for validation runs.
- **No sampler fights.** Sonnet 5.5 rejects non-default `temperature`; both orderings plus Glicko are the noise model.

### 3.4 `engine/src/pairing.ts`

```ts
export interface PairingContext {
  cat: Category;
  rows: Map<string, RatingRow>;                   // all rows in the category
  byRating: RatingRow[];                          // eligible, non-dup rows sorted by r asc (anchors included, flagged by kind)
  anchors: Anchor[];
  playedToday: Map<string, number>;               // resumeId -> matches scheduled in this run + today (load spreading)
  pendingPairs: Set<string>;                      // `${min}|${max}` pairs already planned in this run
  rng: () => number;
}
export interface OpponentQuery {
  subject: RatingRow;
  target: number;                                 // rating to aim at
  window: number;                                 // half-width
  requirePlaced: boolean;
  exclude: ReadonlySet<string>;                   // previous opponents (subject.opp), same-run opponents
  preferHighPriority?: Map<string, number>;       // refinement: opponent priorities, to double up value
}
export function pickOpponent(ctx: PairingContext, q: OpponentQuery): RatingRow | null;
export function nearestAnchor(ctx: PairingContext, rating: number, notPlayedWithinDays?: { since: Map<string, string>; days: number }): Anchor | null;

export interface PlannedMatch { req: MatchRequest; subjRow: RatingRow; oppRow: RatingRow | Anchor }
/** Plans one placement round for a subject: m targets from placementOffsets(); game 2 of round 1 is the nearest anchor. */
export function planPlacementRound(ctx: PairingContext, subject: RatingRow, round: number, roundsSpec: number[], cards: CardLookup): PlannedMatch[];
/** Plans one refinement match for a row: rolls local / crosscheck / anchor per settings.opponentMix. */
export function planRefinement(ctx: PairingContext, row: RatingRow, mix: OpponentMix, cards: CardLookup): PlannedMatch | null;
```

`pickOpponent` algorithm:

1. Binary-search `byRating` for `[target − window, target + window]`.
2. Filter: `id !== subject.id`, `own !== subject.own`, not in `exclude`, not in `subject.opp`, pair key not in `pendingPairs`, `elig && !dup`, `placed` if `requirePlaced`, anchors excluded here (anchors are chosen explicitly).
3. If fewer than 5 candidates: double the window (max 3 doublings); then drop `requirePlaced`; then take the 5 nearest by `|r − target|` ignoring the window. If still none (tiny category), return `null` and the game is skipped.
4. Weight each candidate `w = (1 / rd) × 1 / (1 + playedToday) × (1 + priorityOf(id))` and sample one with the run PRNG.

`planRefinement` roll (settings `opponentMix`):

```
roll < 0.70  local:       window = max(80, 1.5 rd), target = r
roll < 0.90  crosscheck:  delta = 150 + rng()*250, sign ±1 by rng(), target = r + sign*delta, window = 60
else         anchor:      nearestAnchor(r) unless played within 30 days → fall back to local
```

### 3.5 `engine/src/budget.ts`

```ts
export type SpendPurpose = 'analysis' | 'judge_place' | 'judge_refine' | 'judge_anchor';
export interface Ledger {
  record(purpose: SpendPurpose, usd: number, tok: TokenCounts, model: string): void;
  todayUsd(): number; todayUsd(purpose: SpendPurpose): number;
  snapshot(): Status['spend'];
}
export function openLedger(status: Status | null, now: Date): Ledger;     // rolls counters at UTC midnight
export function refineAllowance(l: Ledger, s: Settings, now: Date): number;
export function placementAllowed(l: Ledger, s: Settings): boolean;        // todayUsd < dailyBudget
export function hardStop(l: Ledger, s: Settings): boolean;                // todayUsd >= hardStopMultiplier * dailyBudget
```

Formulas in §6.

### 3.6 `engine/src/anchors.ts`

```ts
export function loadAnchors(store: Store): Promise<Record<Category, AnchorsFile | null>>;
export function anchorRows(file: AnchorsFile): RatingRow[];           // kind 'anchor', locked, rd 30, elig true, placed true
/** Mean residual of the population side over anchor matches in the last 7 days: avg(s_pop - E_pop). */
export function driftResidual(lines: Iterable<MatchLine>, rows: Map<string, RatingRow>): { res: number; n: number };
export function driftShift(res: number, maxShift: number): number;    // clamp(400/ln(10) * res * 0.5, -max, +max); 0 when |shift| < 2
/** Runs each adjacent pair 5x both orderings; higher must win >= 60%, no pair >= 300 apart may lose. Writes audits/. */
export function validateAnchors(judge: Judge, file: AnchorsFile): Promise<{ ok: boolean; report: AnchorValidation }>;
```

### 3.7 `engine/src/rerank.ts`

```ts
export interface RunOptions { dataRoot: string; runId: string; mode: 'normal' | 'nightly' | 'anchors-validate' | 'replay-only'; now?: () => Date; judge?: Judge; store?: Store }
export interface RunReport { state: Status['run']['state']; waves: number; matches: number; placed: number; usd: number; error?: string }
export function runRerank(opts: RunOptions): Promise<RunReport>;

// internal steps, exported for tests
export function loadState(store: Store, settings: Settings): Promise<EngineState>;
export function replayUnapplied(state: EngineState, store: Store): Promise<number>;           // lines applied
export function ingestTickets(state: EngineState, store: Store, max: number): Promise<IngestResult>;
export function planPlacementWave(state: EngineState, drained: DrainedResume[], wave: number): PlannedMatch[];
export function planRefinementWave(state: EngineState, allowance: number): PlannedMatch[];
export function applyLines(state: EngineState, lines: MatchLine[]): void;                      // the fold; pure w.r.t. I/O
export function finalize(state: EngineState, store: Store, ledger: Ledger, report: RunReport): Promise<void>;
```

### 3.8 `engine/src/index-build.ts`

```ts
export interface IndexBuildOptions { dataRoot: string; outDir: string /* web/public/data */; pageSize?: number /* 100 */ }
export function buildIndexes(opts: IndexBuildOptions): Promise<{ files: number; bytes: number }>;
// writes: meta.json, board/<cat>/{index.json, p<N>.json}, board/<cat>/<stage>/..., find/<cat>/<x>.json,
//         r/<xx>/<id>.json, u/<handle>.json, arena/<cat>.json   (formats in §9)
```

---

## 4. One rerank run, exactly

### 4.1 Steps

Everything below is `runRerank`. Wall-clock soft cap and budget gates are checked between steps and between waves.

1. **Load.** Read `config/ranking.json`, `status.json`, `anchors/*.json`, `ratings/*.json` (or shards). Build per-category `Map<id, RatingRow>` and the sorted `byRating` arrays. Open the ledger (rolls the day at UTC midnight). Seed the PRNG with `sha256(runId)`. Write `status.run = { id, state: 'running', startedAt }` locally (not pushed yet).

2. **Replay.** For each category, list `matches/<cat>/*.jsonl`. For each file at or after the newest cursor key, read lines beyond `cursor[file]` (0 for unlisted files). Group consecutive lines by `period`, apply each group with `applyLines` (step 7's fold), advance the cursor. Duplicate ids inside the replayed window (a double-appended wave) are skipped. If anything was replayed, log it; this is the dead-run recovery and it costs no API calls. In `replay-only` mode, skip to step 9.

3. **Nightly, if due.** If `now.date > status.nightlyDoneFor` and `now.hour >= 4` UTC (or `mode === 'nightly'`):
   - **Daily snapshot**: for every row, `day = { date, r, rank }`, `mv = 0`.
   - **RD inflation**: rows idle > 7 days: `rd = min(sqrt(rd² + c²), ceiling)` once (no history point).
   - **Drift check** per category (§5.6): read the last 7 days of anchor lines, compute `res`, apply `shift` to all unlocked rows, append one `d` history point per affected row only when `|shift| ≥ 2`, record in `audits/<date>.json`; raise the alert flag in the audit after 3 consecutive nights with `|res| > 0.08`.
   - **Judge health**: disagreement rate and anchor accuracy over 7 days into `status.judge`.
   - **History compaction** (§5.8) for shards touched in the last 24 h (the rest are compacted lazily when next written).
   - Set `nightlyDoneFor = date`.

4. **Ingest placement tickets.** List `queue/placement/`, sort by `queuedAt`, take the first `maxPlacementsPerRun` (25) if `placementAllowed(ledger)`; otherwise take none and set `status.queue.pending`. For each ticket, read `resumes/<id>.json`:
   - `state !== 'analyzed'` → delete the ticket, skip.
   - Record `ticket.analysisCostUsd` under purpose `analysis` (§6.2).
   - **Duplicate check**: `cardHash` against the in-memory hash index built from `cards/*` (loaded fully; §8.2). Same owner → this is a silent reupload of identical content: no new rows; point `users/<handle>` at the existing id is the submission doc's job; delete the ticket. Different owner → create rows but set `dup = true` on both (hidden from boards; result pages still work; the audit lists them).
   - Copy `{t, h, st}` into `cards/<xx>.json` (marks the shard dirty).
   - **Rows.** If `supersedes` names an existing row of the same `own`: revision flow (§5.7). Else: `general` row with `r = seedRating(score.general)`, `rd = 250`, `round = 0`; one row per domain with `relevance ≥ 0.35` with `r = NaN`, `rd = 220`, `round = -1`, `score = score[domain]`. Anchors never arrive here.
   - Delete the ticket file (the delete is part of the final apply commit; if the run dies first, the next run re-ingests, finds the rows already present and treats it as a no-op).

5. **Placement waves.** Let `D` be the drained resumes. Wave `k` (k = 1..5):
   - General rounds are waves 1–3 (`[3, 3, 2]`); domain rounds are waves 4–5 (`[3, 3]`), with all of a resume's domains planned in the same wave. A resume whose general placement finished seeds its domain rows at the start of wave 4: `r = seedDomain(r_general, score)`, `round = 0`.
   - `planPlacementRound` for every subject that still has a round in this wave → `PlannedMatch[]`. Pre-match ratings are captured now.
   - `judge.judgeMany(reqs)`; failures are dropped (a round applies with the games that succeeded, minimum 1; a round with 0 successful games is retried once in the next wave, then the subject is marked `placed` with whatever RD it has and the audit notes it).
   - **WAL append**: build `MatchLine`s with `id = sha256(runId|wave|seq)`, append to `matches/<cat>/<YYYY-MM>.jsonl` (grouped by period, contiguous), `commitAndPush('[wal] …', ['matches', 'status.json'])`. If the push fails after retries, the run aborts here with `state: 'failed'` and the lines are **not** applied (the next run will not see them either; the money is lost; this is the only loss window and it requires GitHub to be down).
   - **Apply in memory**: `applyLines(lines)` → ratings, counts, `opp` rings, `peak`, `last`, history points and `recent` entries in the touched shards, cursor advanced for the just-appended file. After the subject's last round in a category: `placed = true`.
   - If the wall clock or the hard stop trips mid-drain, remaining rounds simply happen in the next run: the rows carry `round`, and step 5 of the next run picks up any row with `placed === false` (not only freshly drained ones), so a half-placed resume is never stranded.

6. **Refinement wave.** `allowance = refineAllowance(ledger)`; if `allowance < minRefineBatch` (12) skip (budget rolls forward, §6.3). Else:
   - Candidate rows: `elig && placed && !locked && !dup && (last older than refineCooldownHours || mv > 60)`, across all categories.
   - Compute `priority()` for each; take the top `3 × allowance`; weighted-sample `allowance` of them by `−ln(rng()) / priority` (ascending).
   - `planRefinement` per sampled row; `judge.judgeMany`; WAL append + push; apply. One wave only.

7. **The fold (`applyLines`).** For each period group, in log order:
   - Resolve rows for `a` and `b` (anchors come from `anchorRows`). If one side is missing (deleted since), the other side still updates against the recorded `pre` values.
   - Single-game period (refine/crosscheck/anchor): `applyMatch(line.pre, line.o)`; write both sides unless locked.
   - Multi-game period (placement/revision): subject = `subj`; games = each line's opponent at `pre` values with the subject's score (`o` if `subj === a` else `1 − o`); `applyPeriod`; opponents get one-game updates against the subject's pre-period values. **Pre-period values are the `pre` fields in the lines**, not the current row: this is what makes replay deterministic even when a later run holds newer ratings for the opponent.
   - Side effects per updated row: `g/w/d/l`, `last = line.at`, `peak/peakAt`, `mv = |r − day.r|`, `opp` ring push (cap 10), `round++` on the subject when the period closes a placement round, history point `[at, r, rd, 'p'|'m'|'v']`, `recent` unshift (cap 10) with `note = trim(p1.reasoning, 140)`.
   - Advance `cursor[file]` to the last line consumed.

8. **Ranks and percentiles.** `rankAndPercentile(rows)` per category; write `rank`/`pct` into rows (nulls for non-board rows). This runs every run, so `pct` in the priority formula is at most 10 minutes stale.

9. **Finalize.** Write `ratings/*.json` (sorted rows, sorted cursor keys), dirty `history/**` and `cards/**` shards, deleted tickets, `audits/` if nightly, `status.json` with `run.state`, spend snapshot, queue stats, counts. `commitAndPush('rerank run <id>: …', [...])`. If this push fails after retries the run is `failed`; the WAL is already safe and the next run replays. Exit code 0 unless `JudgeFatal` was a configuration error (bad key), which exits 1 so the Actions UI shows red.

### 4.2 Wave sizes and run time at full drain

25 placements per run, 1.3 domains each: waves 1–3 carry 75/75/50 matches, waves 4–5 carry ~100/100, refinement ≤ 120. ≈ 520 matches ≈ 1,040 calls. At 8 in flight and ~6 s per call: ≈ 13 min of judging, plus 6 pushes (~5 s each) and checkout. A run that drains a full queue takes ≈ 15 min and stays within the 40-minute soft cap; a quiet run (no tickets, allowance < 12) takes ≈ 30 s. Submissions that arrive during a run wait for the next one; the UI promise is "a few minutes", honest at this cadence up to ~150 submissions/hour. Beyond that the queue backs up and `status.queue.pending` lets the result page say "n ahead of you".

---

## 5. Math and policies (kept; stated in the engine's terms)

### 5.1 Glicko update (`glickoUpdate`)

For a row with (r, RD) playing games j = 1..m against (r_j, RD_j) with scores s_j and weights w_j (1.0 for the judge; 0.3 reserved for community votes):

```
q      = ln 10 / 400
g(RD)  = 1 / sqrt(1 + 3 q² RD² / π²)
E_j    = 1 / (1 + 10^(−g(RD_j)(r − r_j)/400))
d²     = 1 / (q² Σ w_j g(RD_j)² E_j (1 − E_j))
r'     = r + (q / (1/RD² + 1/d²)) Σ w_j g(RD_j)(s_j − E_j)
RD'    = max(sqrt(1 / (1/RD² + 1/d²)), RD_floor)
```

Results rounded to 2 dp. Both sides of a match update from pre-match values. Effective K: ±117 per game at RD 250, ±26 at RD 100, ±7 at the floor. Eight placement games from RD 250 against established opponents land near RD 115; forty games near the floor. Unchanged from `ranking-system.md` §1.4.

### 5.2 Seeds

```
seedRating(score)                 = clamp(1200 + 8 (score − 50), 800, 1600)        general and domain rubric score
seedDomain(r_general, score_dom)  = 0.5 r_general + 0.5 seedRating(score_dom)     after general placement, RD₀ = 220
```

A resume cannot sit above 1600 on the analyst's word alone; everything above that is won in matches.

### 5.3 Placement rounds and targets

General `[3, 3, 2]`, each domain `[3, 3]`. Round targets `r + offsets × RD_pre` with offsets `[−0.7, 0, +0.7]` for three games and `[−0.5, +0.5]` for two. Opponent window `max(60, 0.35 RD)`, doubled when fewer than 5 candidates; prefer placed opponents. Game 2 of round 1 is the anchor nearest the seed. If a placement match fails (API) the round applies with what succeeded.

### 5.4 Both orderings → outcome

```
p1 = judge(FIRST = a, SECOND = b);  p2 = judge(FIRST = b, SECOND = a)
winner1 = p1 == 'first' ? a : b;    winner2 = p2 == 'first' ? b : a
o(a) = 1 if winner1 == winner2 == a;  0 if both b;  0.5 otherwise   (agree = winner1 == winner2)
```

The judge is forced to choose (`enum: ['first', 'second']`; the rubric prompt's closing rule "You must choose one" is kept). A `tie` option is deliberately absent: disagreement across orderings *is* the tie mechanism and it also cancels position bias by construction. `confidence` is stored for later use (the rubric's `2c − 1` weighting is a v2 experiment that can be replayed from the log without new calls).

### 5.5 Refinement priority and opponent mix

```
U = ((rd − 50)/300)²        S = min(days_since_last / 45, 1)        T = exp(−8 (1 − pct))
A = min(views_7d / 200, 1)  (weight 0 in v1)                         V = mv > 60 ? 1 : 0
priority = 3.0 U + 1.0 S + 1.5 T + 0 A + 0.75 V + 0.25 × rng()
```

Selection: top `3 × allowance` by priority, then weighted sample of `allowance`. Constraints: cooldown 6 h since last match unless `V = 1`; one match per row per run. Opponent mix 70 / 20 / 10 local / cross-check / anchor (§3.4). Cross-checks and anchors are what keep a locally consistent but globally skewed cluster from forming.

### 5.6 Anchors and drift

12 anchors per category at 1000, 1100, …, 2100, RD 30, locked, hidden from every index. Authoring briefs and the validation protocol are in `ranking-system.md` §3.5 and `validateAnchors` implements the test (adjacent pairs 5× both orderings, higher wins ≥ 60%, no pair ≥ 300 apart loses). Nightly, per category, over anchor lines of the last 7 days:

```
res   = mean over population sides of (s_pop − E_pop)
shift = clamp(400/ln 10 × res × 0.5, −10, +10);  apply to all unlocked rows if |shift| ≥ 2
alert if |res| > 0.08 on 3 consecutive nights (audit flag; no further automatic correction)
```

`driftMode: 'mean1500'` recenters so the mean of established non-anchor rows is 1500; kept as the fallback if anchors are ever disabled.

### 5.7 Reupload (revision) inheritance

Ticket with `supersedes = old` where `rows[old].own === ticket.own`:

```
for each category row of old:
  new row: r = old.r, rd = max(old.rd, 180), g/w/d/l copied, lin = old.lin, placed = false, round = 0,
           score = new rubric score, seed = new seed (kept for display; r is inherited, not reseeded)
  old row: elig = false
domain membership recomputed from the new analysis: a dropped domain keeps the old row ineligible and no new row;
a newly qualifying domain gets a fresh domain row (round −1, seeded after general revision placement)
rounds: general [3, 2], each domain [3]  (kind 'revision'); history continues under `lin` with a 'v' point
```

Exact same `cardHash` under the same owner is not a revision: no rows, no matches, the old id stays canonical.

### 5.8 History compaction

Per `(resume, category)`: keep every point from the last 180 days; older points are reduced to the last point per UTC day with reason `s`, always keeping the first placement point. `recent` is a fixed ring of 10 and needs no compaction. Compaction runs in the nightly step for shards written in the last 24 h and lazily whenever a shard is loaded for writing.

### 5.9 Display rules the index files encode

| Field | Rule |
|---|---|
| rating | `round(r)`; `provisional: true` while `!placed || rd > 130` |
| ± | `round(1.96 rd)` |
| percentile | `pct` from `rankAndPercentile`, 1 = top; the SPA prints `top X%` as `(1 − pct) × 100` with the UX doc's rounding |
| rank | dense rank, board rows only (`elig && placed && kind === 'user' && !dup`) |
| tier | `tierFor(r, tiers)`; the SPA renders the provisional modifier separately |
| record | `w-l-d` |
| 7-day delta | `r − r_7d_ago` from history points (nearest point at or before now − 7 d; 0 when none) |

---

## 6. Budget accounting

### 6.1 Cost of a call

```ts
export interface TokenCounts { in: number; cr: number; cw: number; out: number }
export function costOf(u: TokenCounts, model: string, prices: PriceTable): number {
  const p = prices[model] ?? prices[fallbackKey(model)];        // unknown model → nearest family entry, flagged in the audit
  return (u.in * p.in + u.cr * p.cacheRead + u.cw * p.cacheWrite + u.out * p.out) / 1e6;
}
```

`model` is `response.model`, not the requested model, because the server-side refusal fallback may answer from another model. Expected judge call: 1,500 uncached in ($0.0030) + 2,400 cached ($0.00048) + ~450 out including low-effort thinking ($0.0045) ≈ **$0.008**; a match (two calls) ≈ **$0.016**; the first call per category per 5-minute window writes the cache for an extra ≈ $0.006.

### 6.2 Ledger

`status.spend` is the ledger: one record per call via `onUsage`, rolled at UTC midnight, with a month total. The submission workflow cannot update `status.json` (write contention), so its gate + analysis spend travels in the ticket (`analysisCostUsd`) and is recorded when the ticket is ingested. The day it is booked may differ from the day it was spent by at most the queue latency; acceptable. The audit file records both numbers so the month total can be reconciled against the Console.

### 6.3 Allowances and stop conditions

```
spent         = spend.usd (today)
refineCap     = dailyBudgetUsd × refineBudgetShare                       25 × 0.40 = 10
refineSpent   = spend.byPurpose.judge_refine
runsLeft      = max(1, ceil(minutesToUtcMidnight / 10))
allowance     = min(maxRefineMatchesPerRun, floor((refineCap − refineSpent) / estCostPerMatchUsd / runsLeft))
if allowance < minRefineBatch (12): skip refinement this run        (budget rolls forward: runsLeft shrinks, allowance grows)
placementAllowed  = spent < dailyBudgetUsd                            otherwise tickets wait; status.queue says so
hardStop          = spent ≥ 1.15 × dailyBudgetUsd                     no call of any kind; run finalizes what it has
```

At the default $25/day: ≈ 625 refinement matches/day and room for ≈ 45 new resumes/day at $0.33 each (analysis $0.077 + 15.8 placement matches × $0.016). Raising `dailyBudgetUsd` is the only lever needed to scale; the engine's shape does not change.

### 6.4 Other stops

- **Soft wall clock** 40 min (`softWallClockMinutes`): no new wave starts after it; the current wave completes and is written. The job's `timeout-minutes: 55` is the backstop; if it ever fires mid-wave the WAL has the previous waves and the in-flight wave is lost (paid, unrecorded). Keeping the soft cap 15 minutes under the hard one makes that practically unreachable.
- **Judge circuit breaker** (§3.3): 10 consecutive API failures.
- **Store conflict**: fatal, nothing applied beyond the last pushed WAL.

---

## 7. Determinism and tests

### 7.1 Determinism contract

Given (a) the data-branch state, (b) the sequence of judge verdicts, and (c) the run id (PRNG seed), a run is a pure function: same plans, same ids, same lines, same ratings. All randomness goes through `rng.ts` (mulberry32 seeded with `sha256(runId)`), `now()` is injected, JSON is written with sorted keys. The judge is the only impure component and is behind the `Judge` interface, so tests substitute it.

### 7.2 Simulation harness (`engine/sim/`)

```ts
export interface SimConfig {
  n: number;                 // resumes, default 2000
  domainsPerResume: number;  // 1.3
  truthSigma: number;        // latent strength ~ N(1500, 250)
  rubricNoise: number;       // seed = truth mapped through 1200+8(score-50) with score noise sd 10
  judgeNoise: number;        // per-pass logit noise sd 0.6
  positionBias: number;      // +40 rating points for FIRST
  runs: number;              // engine runs to simulate (each = one rerank at the configured allowances)
  seed: number;
}
export function simulate(cfg: SimConfig): SimReport;   // in-memory Store, synthetic Judge, real runRerank
```

The synthetic judge returns `P(first wins) = σ((s_first + bias − s_second) / 400 × ln 10 + ε)`; the two orderings draw independent ε. Report: Spearman ρ between latent strength and rating after placement and after every 5 matches/resume, mean RD trajectory, disagreement rate, total simulated cost, and the ladder's drift against the anchors.

Acceptance (CI, `node --test engine/sim/convergence.test.ts`, ~20 s):

| Check | Threshold |
|---|---|
| ρ after placement only (8 general games) | ≥ 0.80 |
| ρ after 25 matches per resume | **≥ 0.90** |
| ρ in the top decile after 40 matches | ≥ 0.85 |
| mean RD after placement | 105–125 |
| disagreement rate at bias 40 / noise 0.6 | 15–30% |
| anchor residual over the last simulated week | |res| < 0.05 |
| Spearman between judge-order (FIRST/SECOND) and outcome | ≈ 0 (position bias cancelled) |

### 7.3 Idempotency test (`engine/test/idempotency.test.ts`)

Fault-injecting `Store` wrapper: `commitAndPush` throws after the WAL of wave *k* is "pushed" (the in-memory branch has the lines, the process has applied them to its own state, nothing else was written). Then:

1. Run A (reference): same seed, same scripted judge, no faults → final `ratings/*`, `history/*`.
2. Run B: faults at wave k ∈ {1, 3, 5, refinement}; `runRerank` rejects. Run C with a fresh process on the surviving branch, same scripted judge for the remaining waves.
3. Assert: `ratings`, `history`, cursors and match-line sets of A and (B+C) are byte-identical except `runId` fields and timestamps; every match id appears exactly once across the log; `cursor[file] === lineCount(file)` for every log file.
4. Variant: the WAL push *succeeded* but the process died before learning it (simulate by throwing after the write): the restarted run finds its own ids at the tail and does not double-append.

### 7.4 Placement cost test (`engine/test/placement-cost.test.ts`)

100 synthetic tickets (relevance mix giving 1.3 domains on average), judge stubbed with fixed usage `{in: 1500, cr: 2400, cw: 0, out: 450}`. Assert: matches planned = `100 × 8 + Σ domains × 6` exactly (no silent skips when candidates are plentiful), `ledger.todayUsd('judge_place')` equals `matches × 2 × costOf(usage)` within 1e−9, exactly one anchor match per resume per category, and no pair repeats inside a placement.

### 7.5 Unit tests (`packages/shared/test/rating.test.ts`)

`g`, `expected`, `glickoUpdate` against the worked example in Glickman's paper (r 1500 / RD 200 vs 1400/30 W, 1550/100 L, 1700/300 L → 1464.06 / 151.52), empty period no-op, floor clamp, `outcomeFromPasses` all four combinations, `seedRating` clamps, `tierFor` boundaries at 1199/1200/2399/2400, `rankAndPercentile` ties and n = 1, `priority` monotonicity in each term, `placementOffsets`.

---

## 8. Complexity at 100k resumes

### 8.1 Sizes

| Object | Count at 100k | Size | Notes |
|---|---|---|---|
| `ratings/general.json` | 100k rows | ≈ 24 MB (≈ 240 B/row with the `opp` ring) | over the 20 MB line → sharded (§8.4) |
| `ratings/<domain>.json` | 30–60k rows | 7–15 MB | fine unsharded |
| `history/<cat>/<xx>.json` | 256 shards/cat | ≈ 1.2 MB each in general; 300 MB total across categories | 40 points × 16 B + 10 recent × ~110 B per row |
| `cards/<xx>.json` | 256 shards | ≈ 1 MB each, 250 MB total | 2.5 KB per card |
| `matches/<cat>/<YYYY-MM>.jsonl` | ≈ 2.5 M lines/yr at steady state | ≈ 600 B/line → 1.5 GB/yr | the only thing that grows without bound; §8.5 |
| `resumes/<id>.json` | 100k files | ≈ 8 KB each, 800 MB | read only at ingest (engine) and at deploy (views) |

### 8.2 Memory and time per run

Loaded every run: ratings (230k row objects ≈ 90 MB in V8), anchors, status, settings; the cards hash index (`id → h` for 100k ≈ 15 MB) built from `cards/*` (250 MB read, ≈ 2 s). Touched on demand: history shards for updated rows (a full-drain run touches ≈ 1,100 rows → up to 256 shards per category, ≈ 300 MB read worst case, ≈ 3 s), cards for opponents (already loaded). Judging dominates (§4.2). Rank/percentile pass: sort 100k rows ≈ 50 ms. Writing ratings + dirty shards: < 2 s. Total non-judging overhead per run ≈ 20–40 s at 100k, dominated by checkout and pushes. ubuntu-latest runners (4 vCPU, 16 GB) have ample headroom.

### 8.3 Git at this size

The data branch holds ≈ 101k small files plus logs. A full checkout is 30–60 s; `fetch-depth: 1` + `filter: blob:none` + sparse checkout (§1.1) brings the engine's checkout to a few seconds, and `store.readJson` adds paths to the sparse set as needed (`git sparse-checkout add`, batched per step). The deploy workflow needs `resumes/**` for the result views and does a full blob fetch (≈ 1 GB), which is the slowest step of a deploy (≈ 1–2 min). Repository size after a year ≈ 3–4 GB packed; GitHub's soft limit is 5 GB with warnings beyond, so the match log gets archived (§8.5) before then.

### 8.4 Sharding plan for `ratings/<category>.json` beyond 20 MB

Trigger: the serialized file exceeds 20 MB at write time (general crosses it near 80k rows). The engine then writes `ratings/<category>/<x>.json` for `x ∈ 0..f` (first hex digit of `sha256(id)`), each with the same `RatingsFile` shape and its own `cursor` copy (cursors are per category and identical across shards; the engine reads the max and writes all). `ratings/<category>.json` is replaced by a 1-line marker `{ "sharded": 16 }`. Readers (`loadState`, `index-build`) check the marker first. Nothing else changes: the fold, pairing and ranks operate on the merged in-memory map. The threshold and shard count are settings so the change is a config flip plus one run.

### 8.5 Match log growth

Month files roll over at 8 MB (`2026-10.jsonl`, `2026-10.1.jsonl`, …; the cursor keys include the part suffix) so no single file is unwieldy. Lines older than 180 days are no longer needed for anything live (drift uses 7 days, `recent` is in history, pairing uses the `opp` ring): a quarterly `archive` CLI moves them to `matches-archive/<cat>/<YYYY-Qn>.jsonl.gz` in one commit. The cursor entries for archived files are dropped at the same time. Nothing is deleted from history; the raw log remains available for the v2 batch Bradley–Terry audit.

### 8.6 Pages artifact

Index files at 100k (§9): board pages ≈ 1,000 per category per stage view (6 views) ≈ 24k files, ≈ 180 MB; `r/` views 100k files ≈ 500 MB; `u/`, `find/`, `arena/`, `meta` small. ≈ 700 MB total, under the 1 GB Pages site guidance but close; at the realistic 30k target it is ≈ 200 MB. The deploy upload of 125k files takes ≈ 2–3 min. If the 1 GB ceiling approaches, `r/` views drop the breakdown `note` fields (the heaviest part) and the SPA fetches the owner-only detail from the data branch via `raw.githubusercontent.com` (still GitHub) on demand.

---

## 9. What the client reads

All files under `https://noahfinkelstein.github.io/resumearena/data/`, built by `index-build.ts` at deploy, immutable until the next deploy. The SPA never computes a rank or percentile; it formats what it is given (UX doc §5.2). Types live in `packages/shared/src/types.ts` next to the engine's.

### 9.1 `meta.json`

```json
{
  "schema": 1,
  "builtAt": "2026-10-03T14:22:08Z",
  "dataSha": "9f2c1e7",
  "counts": { "resumes": 41338, "matches": 612904, "rated": { "general": 40912, "finance": 9870, "tech": 21455, "academia": 6120 } },
  "engine": {
    "lastRunAt": "2026-10-03T14:10:41Z", "lastRunState": "ok", "queuePending": 3,
    "judgeHealthy": true, "judgeModel": "claude-sonnet-5-5", "promptVersion": "judge.v1",
    "budgetPaused": false
  },
  "tiers": [ { "key": "entrant", "label": "Entrant", "numeral": "I", "min": -1000000000, "blurb": "Below 1200. Most placements start here." } ],
  "categories": [ { "key": "general", "label": "General" }, { "key": "finance", "label": "Finance" }, { "key": "tech", "label": "Tech" }, { "key": "academia", "label": "Academia" } ],
  "board": { "pageSize": 100, "pages": { "general": 410, "finance": 99, "tech": 215, "academia": 62 } }
}
```

`budgetPaused` is `spent ≥ dailyBudget` at the last run: the upload page shows "New placements resume at 00:00 UTC" when true. `queuePending` feeds "n ahead of you".

### 9.2 Leaderboard pages: `board/<category>/index.json`, `board/<category>/p<N>.json`, `board/<category>/<stage>/p<N>.json`

Page `N` (1-based) holds ranks `(N−1)·100 + 1 … N·100` of the `any`-stage board; stage boards (`student`, `new_grad`, `early`, `mid`, `senior`) are filtered views with their own dense `rank` within the view and the global `rankAll`. Rows are compact arrays to keep pages ≈ 8 KB.

```json
{
  "schema": 1, "category": "tech", "stage": "any", "page": 13, "pageSize": 100, "total": 21455, "pages": 215,
  "cols": ["rank", "id", "identity", "tier", "rating", "pm", "w", "l", "d", "stage", "sig", "d7", "provisional"],
  "rows": [
    [1201, "k7q2m3x9ab", "priya.n",    "candidate", 1642, 38, 21, 15, 2, "mid",      "40k rps system", 12, false],
    [1202, "a81hhq0ppz", "anon-a81hh", "candidate", 1641, 44, 18, 12, 4, "early",    "YC founder",     -3, false]
  ]
}
```

`identity` is the handle when `vis === 'handle'`, else `anon-<first 5 chars of id>`. `index.json` per category: `{ total, pages, stages: { student: { total, pages }, ... }, updatedAt }`. The rows carry no `last` timestamp, so the window filters (`this week`, `this month`) cannot be applied client-side; v1 ships them as two more prebuilt views, `board/<category>/active-7d/p<N>.json` and `active-30d/p<N>.json` (rows whose `last` falls inside the window, re-ranked densely within the view). That is 8 views per category; the UX doc's filter bar maps to them one to one.

### 9.3 Find-me: `find/<category>/<x>.json`

16 files per category keyed by the first hex of `sha256(id)`: `{ "<id>": [rank, page, stage, stagePage] }`. The ladder's `?focus=:id` and the result page's rank links resolve rank → page without a search.

### 9.4 Resume view: `r/<xx>/<id>.json`

Served for every resume whose `state !== 'deleted'`. Private fields (ATS fixes, the full analysis) are not here; the owner-only detail is read from `resumes/<id>.json` on the data branch via `raw.githubusercontent.com` after the SPA proves the owner key locally (it hashes the key and compares with the view's `ownerKeyHash`), which is a convenience, not a security boundary: that file is public either way, as the upload page says.

```json
{
  "schema": 1,
  "id": "k7q2m3x9ab",
  "identity": { "kind": "handle", "value": "priya.n" },
  "lineage": "k7q2m3x9ab",
  "supersedes": null,
  "ownerKeyHash": "3b1e…",
  "stage": "mid",
  "primary": "tech",
  "uploadedAt": "2026-10-03T09:41:12Z",
  "card": { "headline": "Mid-career infrastructure engineer; senior at an S-tier company; owned a 40k rps system", "text": "…" },
  "verdict": "A strong mid-career infrastructure resume whose numbers do the work; the education line is the only soft spot.",
  "subscores": [ { "key": "impact", "label": "Impact and outcomes", "score": 78, "weight": 20, "median": 61, "note": "7 of 9 bullets carry a number." } ],
  "strengths": ["Quantified results on 7 of 9 bullets", "Two promotions in 4 years", "Owned a system with named scale (40k rps)"],
  "weaknesses": ["Education sits below the ladder median for this tier", "No open-source or public work", "Summary paragraph repeats the bullets"],
  "ats": { "score": 94, "summary": "Parsers will read this correctly." },
  "ratings": {
    "tech":    { "rating": 1642, "pm": 38, "rd": 19.4, "tier": "candidate", "provisional": false, "placement": { "done": 6, "total": 6 },
                 "rank": 412, "total": 21455, "pct": 0.981, "rankDelta1d": 3, "delta7d": 12, "record": { "w": 21, "l": 15, "d": 2 },
                 "peak": { "rating": 1688, "at": "2026-09-12" }, "lastMatchAt": "2026-10-02T22:14:05Z",
                 "sparkline": [["2026-09-01", 1522], ["2026-09-01", 1570], ["2026-10-02", 1642]],
                 "matches": [
                   { "id": "9a1f…", "at": "2026-10-02T22:14:05Z", "o": "W", "opp": { "id": "x91pp…", "identity": "anon-x91pp", "rating": 1588, "tier": "challenger" },
                     "delta": 9, "note": "Broader ownership at the same company tier; the second record's projects are smaller in scope.", "kind": "refine" }
                 ] },
    "general": { "rating": 1601, "pm": 92, "rd": 47, "tier": "candidate", "provisional": false, "placement": { "done": 8, "total": 8 }, "rank": 1204, "total": 40912, "pct": 0.971, "rankDelta1d": -1, "delta7d": 4, "record": { "w": 14, "l": 9, "d": 3 }, "peak": { "rating": 1610, "at": "2026-09-30" }, "lastMatchAt": "2026-09-30T03:02:10Z", "sparkline": [], "matches": [] }
  },
  "queue": null
}
```

While a resume is queued or mid-placement, `ratings` holds whatever exists (possibly the seed with `provisional: true`, `placement: { done: 1, total: 8 }`) and `queue = { "position": 7, "pending": 12, "asOf": "…" }` so the page can say "Analysis is done. Placement starts within a few minutes; 7 ahead of you." The sparkline is the last 40 history points as `[date, rating]`; `matches` is the `recent` ring (10). Anchor opponents render as `{ "id": null, "identity": "reference resume", "rating": 1500, "tier": "challenger" }`.

### 9.5 User view: `u/<handle>.json`

```json
{
  "schema": 1,
  "handle": "priya.n",
  "joinedAt": "2026-08-14T10:03:55Z",
  "best": { "resumeId": "k7q2m3x9ab", "category": "tech", "rating": 1642, "pm": 38, "tier": "candidate", "rank": 412, "total": 21455 },
  "resumes": [
    { "id": "k7q2m3x9ab", "uploadedAt": "2026-10-03T09:41:12Z", "stage": "mid", "primary": "tech", "visibility": "handle", "current": true,
      "ratings": { "tech": { "rating": 1642, "pm": 38, "tier": "candidate", "rank": 412, "record": { "w": 21, "l": 15, "d": 2 }, "provisional": false },
                   "general": { "rating": 1601, "pm": 92, "tier": "candidate", "rank": 1204, "record": { "w": 14, "l": 9, "d": 3 }, "provisional": false } } },
    { "id": "f0ps22nd1q", "uploadedAt": "2026-08-14T10:05:40Z", "stage": "mid", "primary": "tech", "visibility": "handle", "current": false, "supersededBy": "k7q2m3x9ab", "ratings": {} }
  ]
}
```

The public user page lists resumes with `visibility: 'handle'` only. A handle whose every resume is `anon` still gets a file, with `"resumes": []` and `"best": null`; the owner's own page fills in the rest from `users/<handle>.json` on the data branch, read the same way as the owner-only detail in §9.4.

### 9.6 Arena pool: `arena/<category>.json`

```json
{
  "schema": 1, "category": "tech", "builtAt": "…",
  "pairs": [
    { "id": "9a1f…", "at": "2026-10-02T22:14:05Z",
      "a": { "id": "k7q2m3x9ab", "card": "…", "stage": "mid" },
      "b": { "id": "x91pp…",    "card": "…", "stage": "early" },
      "judge": "a", "reason": "Broader ownership at the same company tier; the second record's projects are smaller in scope.",
      "ratingsAfter": { "a": 1642, "b": 1579 } }
  ]
}
```

The newest 300 refinement/cross-check matches in the category where `agree === true`, both sides are public (`vis` does not matter: cards are anonymized by construction, but deleted or `dup` rows are excluded) and neither side is an anchor. The SPA shuffles locally, shows A/B in random order, reveals `judge` + `reason`, and keeps the streak in `localStorage`. No writes anywhere; community votes are v2.

### 9.7 How index-build produces these

1. Load settings, status, all ratings (merged shards), all history shards, all cards (for the arena and card headlines), `users/*.json`, and `resumes/*.json` (for the result views' analysis fields).
2. Per category: board rows filter + sort (already ranked); emit pages for `any`, each stage, `active-7d`, `active-30d`; emit `find/` maps.
3. Per resume: assemble the view from the resume file + its rating rows + its history entries; write `r/<xx>/<id>.json`.
4. Per handle: `u/<handle>.json` from `users/<handle>.json` + the owner's rows.
5. Arena pools from the current and previous month's log files (tail-read until 300 qualifying lines).
6. `meta.json` last, so a half-written artifact is never served with a new `builtAt` (Pages deploys atomically anyway).

All output is deterministic for a given data commit (sorted keys, sorted rows), which makes the deploy's `concurrency: cancel-in-progress` safe: the newest commit always wins and produces the same artifact regardless of which run built it.

---

## 10. Deferred to v2

- **Message Batches API** for refinement at 50% price. The engine's shape supports it: a `batch-submit` run would plan matches, write *planned* lines to the WAL with `o: null`, and a later run would collect results and append *judged* lines; the fold ignores unjudged lines. Not in v1 because a batch can take hours and GitHub Actions runs should not wait on it; the two-run protocol above is the design when the daily refinement spend justifies the extra moving part.
- **Community votes** (weight 0.3) into the fold: the `weight` field already exists on `Game`.
- **Confidence-weighted outcomes** (rubric §6.4): replayable from stored `confidence`.
- **Batch Bradley–Terry audit** over the match log (ranking-system.md §3.6).
- **Opus 5.5 for top-200 matches** (rubric §6.5): a per-match model override in `planRefinement` plus a second price row; the log already records `model` per line.

---

## 11. Open questions for Noah

1. `maxPlacementsPerRun = 25` makes a burst of 100 submissions take ≈ 40 minutes to clear. Raise `judgeConcurrency` to 12 (faster, more 429 risk) or accept the queue position copy?
2. Anchors: author the 48 cards before launch (an afternoon with Opus 5.5 and `anchors validate`), or launch with placement's anchor game skipped and drift control off for the first two weeks? The engine handles a missing `anchors/<cat>.json` by skipping both.
3. The result page shows `recent` matches with the judge's reason; those reasons mention concrete facts from both cards. Comfortable with that being public for the opponent too (it already is, by way of the card), or trim notes to `decisive_factors` only?
4. `dailyBudgetUsd = 25` is a dev-safe default; the real ceiling sets how many resumes/day can be placed same-day (≈ 45 at $25).
