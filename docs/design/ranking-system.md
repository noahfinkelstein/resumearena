# ResumeArena — Rating & Ranking System

Status: design, v1 · Owner: Noah Finkelstein · Date: 2026-10-03
Scope: how a resume gets a number, how that number moves, how the ladder stays honest, and what it costs.
Depends on: `docs/design/analysis-pipeline.md` (deep analysis → rubric scores + anonymized card) and `docs/design/data-model.md` (resumes, profiles, storage). This doc owns everything in the `rank` schema.

---

## 0. Summary of decisions

| Question | Decision |
|---|---|
| Rating system | **Glicko** (rating + rating deviation), updated per match, implemented in plpgsql. Glicko-2's volatility term is stored but frozen (τ = 0) in v1. |
| Scale | Chess-style. Center 1500, start RD 250 (with rubric prior) / 350 (without), RD floor 50, RD ceiling 350. |
| Judge | `claude-sonnet-5-5` via structured outputs, **both orderings** per match; disagreement = draw. Model and prompt version are settings, recorded on every match. |
| Placement | Rubric score → provisional rating by interpolation against a locked **anchor ladder**. Then 8 matches in `general` (rounds of 3, 3, 2), then 6 per domain category (rounds of 3, 3), each round applied as one Glicko rating period. |
| Continuous refinement | pg_cron every 2 min: priority = uncertainty + staleness + ladder position + attention + volatility. Refinement matches go through the Message Batches API (50% off); placements are realtime. Spend is capped by `ranking_settings.daily_budget_usd`. |
| Drift control | Locked anchor resumes (12 per category) hold the scale; nightly anchor-residual check applies a bounded global shift; `mean1500` re-centering is available as a setting. |
| Categories | Everyone in `general`; plus `finance` / `tech` / `academia` where analysis relevance ≥ 0.35. Separate rating row and judge prompt per category. |
| Tiers | Bronze · Silver · Gold · Platinum · Diamond · Master · Grandmaster (absolute thresholds), plus a "provisional" state. |
| Reuploads | New resume version inherits rating with RD bumped to ≥ 180 and plays a short revision placement; history is continuous across versions. |

---

## 1. Choice of rating system

### 1.1 The setting is not chess

Three things differ from a chess ladder and drive the choice:

1. **The "player" doesn't learn.** A resume's latent strength is fixed between uploads. Every comparison is a noisy *measurement* of a constant, not a contest between two changing agents. Therefore we care about convergence speed and a well-calibrated uncertainty, not about tracking skill changes.
2. **We pick the matchups.** Opponents are chosen by us, continuously, with full knowledge of every rating. This is active learning; a system that exposes uncertainty lets us spend tokens where they reduce the most error.
3. **Comparisons cost money.** Roughly $0.016 per match with Sonnet 5.5 (section 7). The system must extract maximum information per match and must be happy with a sparse comparison graph (~15–40 matches per resume, not thousands).

### 1.2 Candidates

| System | What it is | Fit here | Verdict |
|---|---|---|---|
| **Elo** | Single number, fixed K. | Familiar. But a fixed K either converges slowly (K=16) or never settles (K=40). "Provisional" handling needs hacks (K schedules by game count), and there's no uncertainty to drive match selection. | No — strictly dominated by Glicko at near-zero extra complexity. |
| **Glicko / Glicko-2** | Rating + RD (uncertainty) + (Glicko-2) volatility σ. Natural per-period update; opponents with high RD count less. | RD gives us: fast placement (large RD → large steps), stable established ratings (small RD → small steps), a ± to display, and the uncertainty signal for scheduling. Multi-game "rating periods" fit placement rounds exactly. Volatility only matters when true skill changes — ours doesn't except on reupload, which we handle explicitly. | **Yes.** Glicko with σ frozen (equivalently Glicko-1). Column kept so σ can be enabled later without migration. |
| **TrueSkill** | Bayesian factor graph, Gaussian skill, handles teams/multiplayer, draws via margin. | Excellent math, but μ/σ in a 25/8.33 scale is unfamiliar, the draw-margin parameter is awkward, and there is no plpgsql-friendly closed form for the update (needs the truncated-Gaussian V/W functions — doable, but more code for no gain in a 1v1 setting). | No. |
| **Bradley-Terry / MLE batch fit** | Fit all strengths jointly from the full comparison graph (MM / logistic regression). Statistically the best estimate given the data. | Best use of information, but (a) ratings only move when the batch runs, which kills the "my number went up" moment, (b) a 100k-node fit every few minutes is wasteful, (c) new entrants need a separate online estimator anyway. | Not as the primary. **Kept as a nightly audit** (section 3.6, phase 2) to detect systematic online-vs-batch disagreement, not to overwrite ratings. |

### 1.3 Scale and constants

Standard Glicko scale (chess numbers), so users recognize it.

| Constant | Value | Setting key |
|---|---|---|
| Center | 1500 | — (definitional) |
| Initial RD, with rubric prior | 250 | `rd_initial_with_prior` |
| Initial RD, no prior (fallback) | 350 | `rd_initial` |
| RD floor | 50 | `rd_floor` |
| RD ceiling | 350 | `rd_ceiling` |
| RD inflation constant *c* | 6 per √day | `rd_inflation_c` |
| Revision RD reset | max(RD, 180) | `rd_revision_min` |
| Provisional display threshold | RD > 130 | `provisional_rd` |
| q | ln(10)/400 ≈ 0.0057565 | — |

### 1.4 Update equations (what `rank.glicko_update()` computes)

For a resume with rating *r*, deviation *RD*, playing games *j = 1..m* in one period against opponents (*r_j*, *RD_j*) with scores *s_j* ∈ {0, 0.5, 1} and weights *w_j* (1.0 for LLM judge; 0.3 reserved for future community votes):

```
q      = ln(10) / 400
g(RD)  = 1 / sqrt(1 + 3 q² RD² / π²)
E_j    = 1 / (1 + 10^( -g(RD_j) (r - r_j) / 400 ))
d²     = 1 / ( q² Σ_j w_j g(RD_j)² E_j (1 - E_j) )
r'     = r + ( q / (1/RD² + 1/d²) ) Σ_j w_j g(RD_j) (s_j - E_j)
RD'    = max( sqrt( 1 / (1/RD² + 1/d²) ), RD_floor )
```

Both sides of a match are updated from **pre-match** values. For a placement round, the subject's update uses all *m* games as one period; each opponent's update is a one-game period against the subject's pre-round values.

**Effective K-factor.** The step per game at even odds is `q / (1/RD² + 1/d²) × 0.5`. With established opponents (d² ≈ 1.2×10⁵):

| Subject RD | Max rating swing per game | Chess-equivalent K |
|---|---|---|
| 250 (fresh) | ≈ ±117 | ~235 |
| 150 | ≈ ±53 | ~105 |
| 100 | ≈ ±26 | ~51 |
| 75 | ≈ ±15 | ~30 |
| 50 (floor) | ≈ ±7 | ~14 |

That *is* the K schedule: aggressive while uncertain, chess-stable once settled, derived rather than hand-tuned.

**RD after n even games from RD₀ = 250** (opponents at RD ≈ 100, so g² ≈ 0.91): 1/RD'² = 1/250² + n × 7.5×10⁻⁶.

| n | 0 | 4 | 8 | 14 | 20 | 40 |
|---|---|---|---|---|---|---|
| RD | 250 | 147 | 115 | 91 | 78 | 56 |

So 8 placement games bring a resume to RD ≈ 115 (95% interval ≈ ±225), and refinement to ~40 games brings it near the floor.

**RD inflation (nightly).** Rows idle > 7 days: `rd := least(sqrt(rd² + c²), rd_ceiling)` once per day. From the floor: 60 after a month, 95 after six months, 125 after a year. This keeps old ratings honest as the judge, the prompt, and the population shift, and it feeds the staleness term in scheduling.

---

## 2. Cold start and placement

### 2.1 Rubric score → provisional rating

The deep analysis (Opus 5.5, see analysis doc) produces `scores jsonb` with a 0–100 score per category it assigns, e.g. `{"general": 71, "tech": 78}`.

The map from score to rating is **not** a fixed formula; it is read off the anchor ladder (section 3.5): each category has 12 anchor resumes with locked ratings 1000, 1100, …, 2100, and each anchor has been run through the same analysis, so we hold 12 (score, rating) pairs per category. `rank.initial_rating(category, score)` piecewise-linearly interpolates between the two neighbouring anchors (extrapolating linearly past the ends, clamped to [800, 2400]).

Before anchors exist (local dev), the fallback is `r0 = 1000 + 10 × score` (50 → 1500, 80 → 1800).

Domain categories get a better prior because the general rating already exists by the time domain placement starts:

```
r0_domain  = 0.5 * r_general_after_placement + 0.5 * initial_rating(domain, score_domain)
RD0_domain = 220
```

### 2.2 Placement sequence

Placement is a short Swiss-style ladder run as **rounds**, each round applied as one Glicko rating period. Rounds are sequential (the estimate improves between them); matches within a round run in parallel.

| Category | Rounds | Games | Target RD after |
|---|---|---|---|
| general | 3, 3, 2 | 8 | ≈ 115 |
| each domain | 3, 3 | 6 | ≈ 123 (from RD0 220) |

Wall clock: 5 sequential rounds × ~8 s (two Sonnet calls in parallel, ~5–8 s) ≈ 40–60 s from "analysis done" to "placed in all categories". The UI shows the rubric-based provisional rating instantly with the placement progress ("Placement 4/8"), then the settled number.

**Opponent choice within a round.** Opponents are spread across the current uncertainty window so the round brackets the estimate rather than re-asking the same question:

```
offsets(3 games) = [-0.7, 0, +0.7] * RD      -- pre-round RD
offsets(2 games) = [-0.5, +0.5] * RD
target_j = r + offsets[j]
```

For each target, `rank.pick_opponent()` samples from eligible rows in the same category where:

- `|rating - target| <= max(60, 0.35 * RD_subject)`, widened ×2 if fewer than 5 candidates;
- `placement_done` (established opponents give more information: g(RD_j) is higher) — relaxed if < 5 candidates;
- not the same owner, not a previous opponent of this resume in this category, not a flagged duplicate;
- weighted by `1/RD_opp` and by `1/(1 + matches_last_24h)` to spread load.

One anchor per placement: game 2 of round 1 is always the anchor whose locked rating is nearest `r0`. This gives every resume one measurement against the fixed scale and continuously validates the rubric→rating map.

### 2.3 Both orderings and the draw rule

Every match is two judge calls: cards (A, B) and cards (B, A). The judge is forced to pick `first` or `second`. Mapped back to resumes:

```
if  winner_pass1 == A and winner_pass2 == A:  outcome_a = 1.0   (agreement, A wins)
elif winner_pass1 == B and winner_pass2 == B:  outcome_a = 0.0   (agreement, B wins)
else:                                           outcome_a = 0.5   (disagreement → draw)
```

Position bias cancels by construction; a pair the judge can't separate reliably lands on 0.5, which is exactly the right score for "too close to call". Expected disagreement rate is 15–30% (higher among close pairs, which is where we schedule most matches). The judge's `confidence` is stored but unused in v1 updates.

### 2.4 `place_resume()` flow

```
place_resume(resume_id):
  a := analysis for resume_id (scores, card_text, categories with relevance)
  upsert ratings(resume_id, 'general', rating = initial_rating('general', a.scores.general),
                 rd = rd_initial_with_prior, rubric_score = a.scores.general, placement_round = 0)
  for each domain d in a.categories where relevance >= 0.35:
     upsert ratings(resume_id, d, rating = NULL -- set when general placement completes
                    rd = 220, rubric_score = a.scores[d], placement_round = -1 /* waiting */)
  enqueue_placement_round(resume_id, 'general')      -- round 1: 3 games, incl. nearest anchor

apply_placement_round(group_id):
  all matches in group judged → one glicko_update for the subject with m games
  opponents: one-game updates each
  write rating_history rows (reason 'placement')
  if more rounds: enqueue_placement_round(next)
  else:
     placement_done = true
     if category = 'general': for each waiting domain row: set r0_domain, enqueue its round 1
```

If a placement match fails three times (API error) it is voided and the round is applied with the games that succeeded (minimum 1). If the subject resume is deleted mid-placement, queued matches are voided.

---

## 3. Continuous reranking

### 3.1 Loop shape

```
pg_cron */2 min  → rank.select_matches(limit)          enqueue refinement matches by priority
trigger on insert → pg_net POST /judge-worker            realtime path (placements, revisions)
pg_cron */30 min → rank.flush_batch() → /judge-batch-submit   refinement matches → one Batches API job
pg_cron */5 min  → /judge-batch-poll                     collect finished batches, record results
pg_cron */5 min  → rank.recompute_percentiles(all)       ranks, percentiles
pg_cron 04:15 UTC→ rank.nightly()                        rd inflation, drift check, rank_prev_day, history compaction
```

### 3.2 Priority formula

Computed per `(resume, category)` row over eligible, placed, non-anchor rows:

```
U  = ((rd - rd_floor) / (rd_ceiling - rd_floor))²          -- uncertainty, 0..1 (quadratic: focus on the really uncertain)
S  = least(days_since_last_match / 45, 1)                   -- staleness
T  = exp(-8 * (1 - percentile))                             -- ladder position: 1.0 at the top, 0.45 at p90, 0.02 at p50
A  = least(profile_views_7d / 200, 1)                       -- attention: people are looking at this one
V  = 1 if |rating - rating_24h_ago| > 60 else 0             -- just moved a lot; verify it
J  = random() * 0.25                                        -- jitter, so ties don't starve

priority = 3.0*U + 1.0*S + 1.5*T + 0.5*A + 0.75*V + J
```

Selection: take the top `3 × limit` by priority, then sample `limit` of them weighted by priority (weighted reservoir via `order by -ln(random())/priority`). This keeps the top of the ladder sharp (it's what people look at, and small rank differences there matter) without starving the middle.

Constraints: at most one queued refinement match per `(resume, category)` at a time; a resume is not selected again within 6 hours of its last refinement match unless `V = 1`.

### 3.3 Opponent choice for refinement

```
roll := random()
if roll < 0.70:  -- local: sharpen the neighbourhood
    window = max(80, 1.5 * rd_subject); target = rating_subject
elif roll < 0.90:  -- cross-check: test ladder consistency across distance
    delta = 150 + random()*250; sign = ±1 at random; target = rating + sign*delta; window = 60
else:              -- anchor: re-measure against the fixed scale
    opponent = anchor with locked rating nearest rating_subject (skip if played within 30 days)
```

Within the window, prefer an opponent that itself has high priority (two refinements for one match), exclude pairs played in the last 60 days in this category and same-owner pairs.

Why cross-checks: with only local matches the ladder can develop locally-consistent but globally-skewed regions (a "tech-cluster inflation"). 20% long-range matches plus anchors tie the regions together; this is also what the nightly BT audit checks.

### 3.4 Batch sizes and spend bounding

All knobs in `ranking_settings` (section 6.4). Defaults:

| Key | Default | Meaning |
|---|---|---|
| `daily_budget_usd` | 25 | Total LLM spend cap for the day (UTC), all purposes |
| `refine_budget_share` | 0.40 | Fraction of the daily budget reserved for refinement; the rest is for analysis + placement |
| `max_placement_matches_per_tick` | 60 | Realtime matches claimed per worker invocation |
| `max_refine_matches_per_tick` | 40 | Refinement matches enqueued per 2-min tick |
| `tick_minutes` | 2 | |
| `judge_model` | `claude-sonnet-5-5` | Pairwise judge |
| `refine_transport` | `batch` | `batch` (50% off, results within hours) or `realtime` |
| `est_cost_per_match_usd` | 0.016 | Used for allowance maths; the real number is measured from `usage` |
| `max_uploads_per_user_per_day` | 3 | Bounds placement spend per user |
| `max_new_resumes_per_day` | 1000 | Global placement cap; beyond it, uploads are analyzed and placed via batch overnight |

Per tick:

```
spent          = sum(llm_spend.cost_usd where day = today)
refine_cap     = daily_budget_usd * refine_budget_share
refine_spent   = sum(llm_spend.cost_usd where day = today and purpose = 'judge_refine')
ticks_left     = ceil(minutes_until_utc_midnight / tick_minutes)
cost_per_match = est_cost_per_match_usd * (0.5 if refine_transport = 'batch' else 1.0)
allowance      = least(max_refine_matches_per_tick,
                       floor((refine_cap - refine_spent) / cost_per_match / greatest(ticks_left, 1)))
if spent >= daily_budget_usd: allowance = 0
select_matches(allowance)
```

Placements are not throttled per tick (they are user-facing), but they are bounded upstream by the upload caps, and when `spent >= daily_budget_usd` new placements are routed to the batch path (user sees the provisional rating and "Placement completes overnight"). Hard stop: the worker refuses to call the API when `spent >= 1.15 × daily_budget_usd`, whatever the kind.

`llm_spend` is written from the actual `usage` object of every response (input, cache read, cache write, output tokens) priced with `ranking_settings.model_prices`.

### 3.5 Anchors and drift control

**Anchors** are 12 synthetic resumes per category (48 total, generated once with Opus 5.5 from written specifications, reviewed by hand) with ratings locked at 1000, 1100, …, 2100. They are regular rows in `resumes` (kind = `anchor`, hidden from leaderboards and profiles) and in `ratings` (`is_anchor = true, locked = true, rd = 30`). Their ratings never change; everyone else's are measured against them. This is what makes a 1900 in October mean the same as a 1900 in March, and it is what calibrates the rubric→rating map (section 2.1).

Authoring guide for anchors (per category, one card each): 1000 "minimal: coursework, one unrelated job"; 1300 "typical: one relevant internship at a non-selective firm, a class project"; 1500 "solid: competitive internship, concrete outcomes"; 1700 "strong: top firm, measurable scope, one independent signal"; 1900 "exceptional: multiple top-tier roles, leadership, awards"; 2100 "rare: founder with outcome / first-author at top venue / IMO-level competition". Fill the gaps monotonically. Validation before enabling: run each adjacent anchor pair through the judge 5× both orderings; the higher anchor must win ≥ 60% (expected score for a 100-pt gap is 0.64) and no pair ≥ 300 apart may lose.

**Drift check (nightly, per category).** Over the last 7 days of matches involving an anchor, compute the mean residual of the population side: `res = avg(s_pop - E_pop)`. If the population systematically beats anchors more than predicted, population ratings are too low (and vice versa).

```
shift = clamp(400/ln(10) * res * 0.5, -10, +10)      -- half-correct, at most 10 points per night
if |shift| >= 2: update ratings set rating = rating + shift where not locked and category = c;
                 insert rating_history (reason 'drift', delta = shift) for affected rows -- one row per resume, cheap
if |res| > 0.08 for 3 consecutive nights: raise an alert (log + email); do not auto-correct further
```

`drift_mode = 'mean1500'` is the alternative: shift so that the mean rating of established non-anchor rows equals 1500. It is simpler but makes the number relative to whoever happens to have uploaded; it exists as a fallback if anchors are ever disabled.

### 3.6 Batch Bradley-Terry audit (phase 2, not required for launch)

Weekly Edge Function: load matches from the last 180 days per category, fit BT strengths by MM (Zermelo) for 50 iterations, convert to the Elo scale (`r = 1500 + 400 log10(π/π_anchor1500)`), and report the RMS difference between BT and online ratings for rows with RD < 80, plus the 50 largest disagreements. Output is a report in `rank.audits`, never a write to `ratings`. If RMS > 60, we investigate the scheduler (usually too few cross-checks).

---

## 4. Categories

### 4.1 Membership

| Category | Who | Prompt focus |
|---|---|---|
| `general` | every resume | overall impressiveness to a sharp generalist hiring committee |
| `finance` | analysis relevance ≥ 0.35 | IB / PE / HF / quant recruiting committee |
| `tech` | analysis relevance ≥ 0.35 | staff engineer + recruiter at a top technology company |
| `academia` | analysis relevance ≥ 0.35 | PhD admissions / faculty search committee |

`resume_categories(resume_id, category, relevance)` is written by the analysis pipeline. A resume is in 1–4 rows of `ratings` (general + up to 3 domains). Membership changes on reupload only; the user may also opt out of a domain (row kept, `eligible = false`).

### 4.2 Judge input: the anonymized card

The judge never sees the PDF. It sees `resume_cards.card_text`, a ~600-token structured rendering produced by the analysis pipeline: education (institution, program, degree, GPA if given, honors), experience (organization, role, dates → duration, 2–3 impact bullets normalized to concrete outcomes), projects, publications/venues, awards/competitions, selected skills. Stripped: name, contact, photos, links, pronouns, addresses, demographic cues, and formatting. Two consequences: (1) rankings measure substance, not typesetting; (2) the main source of demographic bias in human and ATS screening (names) is removed.

ATS/HR-system friendliness (keyword coverage, parseability, section conventions) is a separate displayed sub-score from the analysis and contributes 10% to the rubric prior. It does not enter pairwise judging: being "cracked" is about what you did, and presentation advice is coaching, not ranking.

### 4.3 Judge prompt, `general` (v1, exact copy)

System prompt (cached; one block per category):

> You are the comparison judge for ResumeArena. You will be shown two anonymized candidate summaries, labelled FIRST and SECOND. Decide which record is more impressive overall: the one a sharp, well-calibrated hiring committee would be more eager to interview.
>
> Weigh, in roughly this order: (1) the selectivity and reputation of the organizations and programs the candidate was admitted to or hired by; (2) the scope, difficulty and verified outcomes of what they actually did there; (3) trajectory: how quickly responsibility grew relative to career stage; (4) independent signals: awards, publications, competitions, things built that other people use, money raised or returned; (5) depth over breadth.
>
> Judge substance, not presentation. Ignore length, prose quality and keyword density except where they reveal substance. Do not reward vague claims ("worked on", "helped with"); reward concrete, verifiable outcomes. Compare candidates at the stage they are at, but absolute accomplishment still counts most: a senior with more done beats a sophomore with more potential.
>
> You must choose one. If they are genuinely close, choose the one with the stronger single best accomplishment. Respond only with the JSON object described by the schema.

User message: `FIRST\n<card A>\n\nSECOND\n<card B>\n\nWhich candidate is more impressive overall?`

Category deltas (replace the weighting paragraph):

- **finance**: "Weigh: (1) target-school status and GPA as the industry actually screens them; (2) firm tier (bulge bracket, elite boutique, mega-fund, top quant shop) and group; (3) deal, portfolio or research exposure with sizes and outcomes; (4) quantitative rigor and competitions (IMO/Putnam, trading competitions, CFA progress); (5) early signal: sophomore diversity programs, spring weeks, leadership in investment clubs with real AUM."
- **tech**: "Weigh: (1) companies and teams by selectivity and by what they ship; (2) scope and technical depth of systems built, with numbers (scale, latency, users, revenue); (3) independent evidence: open-source adoption, competitive programming (ICPC/Codeforces rating), research at top venues, hackathon wins at serious events, startups with real users; (4) trajectory and ownership relative to stage; (5) breadth of stack matters far less than depth of one hard thing."
- **academia**: "Weigh: (1) publications by venue tier and authorship position; (2) advisor/lab pedigree and the selectivity of the program; (3) fellowships and awards (NSF GRFP, Goldwater, best-paper); (4) research independence: first-authored work, grants written, talks given; (5) teaching and service as secondary signals. Industry prestige matters only insofar as it produced research output."

### 4.4 Judge output schema (`output_config.format`, JSON schema)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["winner", "confidence", "decisive_factors", "reasoning"],
  "properties": {
    "winner": { "type": "string", "enum": ["first", "second"] },
    "confidence": { "type": "number", "minimum": 0.5, "maximum": 1.0,
                    "description": "Probability that the chosen candidate is the more impressive one." },
    "decisive_factors": { "type": "array", "minItems": 1, "maxItems": 3, "items": { "type": "string", "maxLength": 80 } },
    "reasoning": { "type": "string", "maxLength": 320 }
  }
}
```

Request shape (Deno, `npm:@anthropic-ai/sdk`): `model = settings.judge_model`, `max_tokens: 1024`, `thinking: {type: "adaptive"}`, `output_config: {effort: "low", format: {type: "json_schema", schema}}`, system block with `cache_control: {type: "ephemeral"}`, `betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"` (refusals are unlikely on resumes, but the fallback is free insurance). The worker processes matches grouped by category so the cached system prefix stays warm (5-minute TTL). Pad the system prompt with the full written rubric so it clears the model's minimum cacheable prefix.

---

## 5. Anti-noise, duplicates, history, display

### 5.1 Judge inconsistency

- **Within a match**: both orderings; disagreement → draw (section 2.3).
- **Across matches**: Glicko already treats each result as a noisy sample. Per-model/prompt-version monitors in `rank.judge_health` (hourly view): disagreement rate (alert > 40%), anchor accuracy (pairs of anchors ≥ 200 apart must be called correctly ≥ 85%; alert otherwise), mean |rating delta| on refinement matches (should trend down).
- **Model or prompt change**: bump `judge_prompts.version`, run the anchor validation (section 3.5), then enable. Ratings are not reset; the version is on every match, and RD inflation plus continuing refinement absorbs small calibration shifts. A large change (new model family) can be followed by a one-time `rd := greatest(rd, 120)` on all rows to let the ladder re-settle faster.
- **Sampling**: Sonnet 5.5 rejects non-default `temperature`, so we don't fight randomness at the sampler; both-orderings + Glicko is the noise model.

### 5.2 Duplicates and reuploads

- `resume_cards.content_hash = sha256(normalized card_text)`. Exact match within the same owner → treated as a reupload of the same content: no new placement; the previous ratings are kept and the new file replaces the stored PDF.
- Near-duplicate: `pg_trgm` `similarity(card_text) ≥ 0.92` within the same owner → **revision** (section 5.3). `≥ 0.95` across different owners → both flagged `dup_suspect`, hidden from leaderboards pending review (profile still works). Same-owner pairs are never matched against each other.

### 5.3 Revision flow (`rank.supersede_resume(old, new)`)

```
for each ratings row of old:
   new row: rating = old.rating, rd = greatest(old.rd, rd_revision_min /*180*/), games/wins/draws/losses carried,
            placement_done = false, placement_round = 0
   old row: eligible = false (kept for history; never shown again)
resumes.version_group_id links old and new; rating_history is read by version_group_id so the chart is continuous,
with a marker at the revision timestamp.
enqueue revision placement: general 2 rounds (3, 2); domains 1 round (3)  -- kind = 'revision'
```

Domain membership is recomputed from the new analysis; a dropped category keeps its old row with `eligible = false`.

### 5.4 Rating history

One `rating_history` row per applied match per side (`reason = 'match' | 'placement' | 'revision'`), plus `'drift'` rows when a shift is applied. No rows for nightly RD inflation (noise). After 180 days rows are compacted to one per day per `(resume, category)` (last value), keeping the first placement rows. Sparkline = last 30 points, read through `rank.history(resume_id, category, limit)`.

Volume: 100k resumes × 2.3 categories × ~30 matches × 2 sides ≈ 14M rows/yr before compaction; identity bigint PK + `(resume_id, category, created_at desc)` btree + BRIN on `created_at`. Fine.

### 5.5 What is displayed

| Element | Rule | Example |
|---|---|---|
| Rating | `round(rating)`; while `placement_done = false` show the provisional number with "placing" state; while `rd > provisional_rd` (130) append `?` | `1612`, `1612?` |
| Plus-minus | `± round(1.96 × rd)` | `± 230` → settles to `± 100` |
| Percentile | `percentile` among eligible, placed rows in the category; display as ordinal | `87th percentile` |
| Rank | `#rank of N` with thousands separators; `▲ 3` / `▼ 1` vs `rank_prev_day` | `#1,204 of 41,338` |
| Tier | from rating (5.6); small-caps text, no badge art | `Platinum` |
| Record | `wins–draws–losses` and win rate = `(wins + 0.5 draws) / games` | `14–3–9 · 60%` |
| Form | last 10 outcomes as a row of three glyphs (win/draw/loss) | |
| Peak | `peak_rating` with date | `Peak 1688 · Sep 12` |
| Sparkline | last 30 history points, category switcher | |

Leaderboards sort by `rating` and include only `placement_done and eligible and not is_anchor and not dup_suspect`. Profiles always show the user's own numbers, including provisional. Display names on leaderboards are opt-in; the default is the user's chosen handle.

### 5.6 Tiers

Absolute thresholds on the anchor-defined scale (like chess classes), so a tier means the same thing over time. Approximate population share assumes a roughly normal ladder with σ ≈ 200 around a mean near 1550.

| Tier | Rating | ≈ share |
|---|---|---|
| Bronze | < 1300 | bottom ~12% |
| Silver | 1300 – 1499 | ~28% |
| Gold | 1500 – 1699 | ~35% |
| Platinum | 1700 – 1849 | ~16% |
| Diamond | 1850 – 1999 | ~7% |
| Master | 2000 – 2199 | ~2% |
| Grandmaster | ≥ 2200 | < 0.5% |

Plus the state **Provisional** (placement not done, or `rd > 130`), rendered as a modifier, not a tier. Tier is hysteresis-free in v1 (it follows the rating exactly); if flicker at thresholds annoys people, add a 10-point band later. Copy guidance: tiers are set in small caps in the serif display face; no shields, gems or confetti.

---

## 6. Data model

All ranking objects live in schema `rank` (not exposed through PostgREST). The client reads via views in `public` (`leaderboard`, `my_ratings`, `rating_sparkline`) and RPCs. Assumed from the data-model doc: `public.resumes(id uuid pk, owner_id uuid, kind text check in ('user','anchor'), status text, version_group_id uuid, is_current bool, created_at)`, `public.resume_cards(resume_id uuid pk, card_text text, card_json jsonb, content_hash bytea, token_estimate int)`, `public.resume_analyses(resume_id uuid pk, scores jsonb, categories jsonb, ats_score numeric)`, `public.profile_stats(resume_id, views_7d int)`.

### 6.1 DDL

```sql
create schema if not exists rank;
create extension if not exists pg_trgm;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table rank.categories (
  slug        text primary key,            -- 'general' | 'finance' | 'tech' | 'academia'
  name        text not null,
  sort_order  smallint not null,
  is_domain   boolean not null default true
);
insert into rank.categories values
  ('general','General',0,false), ('finance','Finance',1,true), ('tech','Tech',2,true), ('academia','Academia',3,true);

create table rank.resume_categories (
  resume_id   uuid not null references public.resumes(id) on delete cascade,
  category    text not null references rank.categories(slug),
  relevance   numeric(4,3) not null check (relevance between 0 and 1),
  assigned_by text not null default 'analysis',     -- 'analysis' | 'user'
  created_at  timestamptz not null default now(),
  primary key (resume_id, category)
);

create table rank.ratings (
  resume_id        uuid not null references public.resumes(id) on delete cascade,
  category         text not null references rank.categories(slug),
  rating           numeric(7,2),                    -- null while a domain row waits for general placement
  rd               numeric(6,2) not null default 350,
  volatility       numeric(6,4) not null default 0.06,   -- stored, frozen in v1
  rubric_score     numeric(5,2),
  games            integer not null default 0,
  wins             integer not null default 0,
  draws            integer not null default 0,
  losses           integer not null default 0,
  placement_round  smallint not null default 0,     -- -1 waiting, 0..n rounds completed
  placement_done   boolean not null default false,
  is_anchor        boolean not null default false,
  locked           boolean not null default false,  -- never update rating/rd
  eligible         boolean not null default true,   -- false: superseded, opted out, dup_suspect, deleted
  rank             integer,
  percentile       numeric(6,5),
  rank_prev_day    integer,
  rating_prev_day  numeric(7,2),
  rating_24h_ago   numeric(7,2),
  peak_rating      numeric(7,2),
  peak_at          timestamptz,
  last_match_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (resume_id, category),
  check (rd between 1 and 350)
);
-- leaderboard scan and rank computation
create index ratings_board_idx on rank.ratings (category, rating desc)
  where eligible and placement_done and not is_anchor;
-- scheduler scan (priority is computed in-query; this bounds the scan to live rows)
create index ratings_sched_idx on rank.ratings (category, rd desc, last_match_at)
  where eligible and placement_done and not locked;
create index ratings_owner_lookup on rank.ratings (resume_id);

create type rank.match_status as enum ('queued','claimed','judged','applied','failed','void');
create type rank.match_kind   as enum ('placement','revision','refine','crosscheck','anchor');
create type rank.match_source as enum ('llm','community');
create type rank.transport    as enum ('realtime','batch');

create table rank.matches (
  id                uuid primary key default gen_random_uuid(),
  category          text not null references rank.categories(slug),
  a_resume_id       uuid not null references public.resumes(id) on delete cascade,
  b_resume_id       uuid not null references public.resumes(id) on delete cascade,
  subject_resume_id uuid not null,                     -- whose priority scheduled this match
  kind              rank.match_kind not null,
  source            rank.match_source not null default 'llm',
  transport         rank.transport not null default 'realtime',
  placement_group   uuid,                              -- groups the games of one placement round
  status            rank.match_status not null default 'queued',
  priority          real not null default 0,
  attempts          smallint not null default 0,
  lease_until       timestamptz,
  batch_id          text,                              -- Message Batches id when transport = 'batch'
  model             text,
  prompt_version    integer,
  pass1             jsonb,                             -- {winner, confidence, decisive_factors, reasoning, usage}
  pass2             jsonb,
  winner_pass1      uuid,
  winner_pass2      uuid,
  outcome_a         numeric(2,1) check (outcome_a in (0, 0.5, 1)),
  agreement         boolean,
  input_tokens      integer, cache_read_tokens integer, cache_write_tokens integer, output_tokens integer,
  cost_usd          numeric(10,6),
  a_rating_before   numeric(7,2), a_rd_before numeric(6,2), b_rating_before numeric(7,2), b_rd_before numeric(6,2),
  a_rating_after    numeric(7,2), b_rating_after numeric(7,2),
  error             text,
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz, judged_at timestamptz, applied_at timestamptz,
  check (a_resume_id <> b_resume_id)
);
-- the queue: realtime claim order
create index matches_queue_idx on rank.matches (transport, priority desc, created_at)
  where status = 'queued';
create index matches_lease_idx on rank.matches (lease_until) where status = 'claimed';
create index matches_batch_idx on rank.matches (batch_id) where batch_id is not null;
create index matches_group_idx on rank.matches (placement_group) where placement_group is not null;
-- "have these two met?" and per-resume history
create index matches_pair_idx on rank.matches
  (category, least(a_resume_id, b_resume_id), greatest(a_resume_id, b_resume_id), created_at desc);
create index matches_a_idx on rank.matches (a_resume_id, category, created_at desc);
create index matches_b_idx on rank.matches (b_resume_id, category, created_at desc);
create index matches_created_brin on rank.matches using brin (created_at);
-- one live refinement per (resume, category)
create unique index matches_one_live_refine on rank.matches (subject_resume_id, category)
  where status in ('queued','claimed') and kind in ('refine','crosscheck','anchor');

create table rank.rating_history (
  id          bigint generated always as identity primary key,
  resume_id   uuid not null,
  category    text not null,
  match_id    uuid references rank.matches(id) on delete set null,
  rating      numeric(7,2) not null,
  rd          numeric(6,2) not null,
  delta       numeric(7,2) not null,
  reason      text not null check (reason in ('placement','match','revision','drift','snapshot')),
  created_at  timestamptz not null default now()
);
create index rating_history_lookup on rank.rating_history (resume_id, category, created_at desc);
create index rating_history_brin on rank.rating_history using brin (created_at);

create table rank.ranking_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

create table rank.llm_spend (
  day               date not null,
  model             text not null,
  purpose           text not null,       -- 'analysis' | 'judge_place' | 'judge_refine' | 'judge_anchor_test'
  calls             integer not null default 0,
  input_tokens      bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  output_tokens     bigint not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  primary key (day, model, purpose)
);

create table rank.judge_prompts (
  id            serial primary key,
  category      text not null references rank.categories(slug),
  version       integer not null,
  system_prompt text not null,
  output_schema jsonb not null,
  active        boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (category, version)
);
create unique index judge_prompts_one_active on rank.judge_prompts (category) where active;

create table rank.audits (          -- nightly drift checks, weekly BT audits
  id          bigint generated always as identity primary key,
  kind        text not null,        -- 'drift' | 'bt' | 'anchor_validation' | 'judge_health'
  category    text,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
```

Row-level security: `rank` schema is service-role only. Public views:

```sql
create view public.leaderboard as
  select r.category, r.rank, r.resume_id, p.handle, p.display_name_public, round(r.rating) as rating,
         round(1.96*r.rd) as plus_minus, r.percentile, rank.tier_for(r.rating) as tier,
         r.wins, r.draws, r.losses, r.rank_prev_day - r.rank as rank_change
  from rank.ratings r join public.profiles_public p on p.resume_id = r.resume_id
  where r.eligible and r.placement_done and not r.is_anchor and r.rank is not null;
-- plus my_ratings (auth.uid()-filtered, includes provisional) and rating_sparkline(resume_id, category)
```

### 6.2 Function signatures

```sql
-- pure math
rank.g(rd numeric) returns double precision                        immutable
rank.expected(r numeric, opp_r numeric, opp_rd numeric) returns double precision   immutable
rank.glicko_update(r numeric, rd numeric, opp_r numeric[], opp_rd numeric[], score numeric[],
                   weight numeric[] default null, rd_floor numeric default 50)
                   returns table (new_r numeric, new_rd numeric)    immutable
rank.tier_for(rating numeric) returns text                         immutable
rank.initial_rating(p_category text, p_score numeric) returns numeric   stable   -- anchor interpolation

-- settings / budget
rank.setting(p_key text) returns jsonb                             stable
rank.budget_remaining(p_purpose text) returns numeric              stable
rank.record_spend(p_model text, p_purpose text, p_usage jsonb) returns void

-- placement
rank.place_resume(p_resume_id uuid) returns void
rank.enqueue_placement_round(p_resume_id uuid, p_category text) returns uuid   -- returns placement_group
rank.pick_opponent(p_resume_id uuid, p_category text, p_target numeric, p_window numeric,
                   p_require_placed boolean, p_exclude uuid[]) returns uuid
rank.apply_placement_round(p_group uuid) returns void
rank.supersede_resume(p_old uuid, p_new uuid) returns void

-- continuous
rank.select_matches(p_limit integer) returns integer               -- rows enqueued
rank.claim_matches(p_limit integer, p_lease interval default '3 minutes') returns setof rank.matches
rank.record_judge_result(p_match_id uuid, p_pass1 jsonb, p_pass2 jsonb, p_model text, p_prompt_version int)
                   returns void                                    -- sets outcome, spend, then applies
rank.apply_match_result(p_match_id uuid) returns void
rank.fail_match(p_match_id uuid, p_error text) returns void       -- attempts++, requeue or void
rank.reap_leases() returns integer
rank.flush_batch() returns setof rank.matches                      -- queued batch-transport rows → status 'claimed'

-- maintenance
rank.recompute_percentiles(p_category text) returns void
rank.inflate_rd() returns integer
rank.drift_check(p_category text) returns numeric                  -- returns applied shift
rank.snapshot_daily() returns void                                 -- rank_prev_day, rating_prev_day, rating_24h_ago
rank.compact_history(p_older_than interval default '180 days') returns integer
rank.nightly() returns void
```

### 6.3 Key function bodies (pseudocode / plpgsql sketches)

**`glicko_update`** (the only piece of math that must be exactly right):

```sql
create or replace function rank.glicko_update(
  r numeric, rd numeric, opp_r numeric[], opp_rd numeric[], score numeric[],
  weight numeric[] default null, rd_floor numeric default 50)
returns table (new_r numeric, new_rd numeric) language plpgsql immutable as $$
declare
  q   constant double precision := ln(10) / 400;
  pi2 constant double precision := pi() * pi();
  g double precision; e double precision; w double precision;
  s_d2 double precision := 0; s_num double precision := 0;
  d2 double precision; inv double precision;
begin
  for i in 1 .. coalesce(array_length(opp_r, 1), 0) loop
    w := coalesce(weight[i], 1);
    g := 1 / sqrt(1 + 3 * q * q * opp_rd[i] * opp_rd[i] / pi2);
    e := 1 / (1 + power(10, -g * (r - opp_r[i]) / 400));
    s_d2  := s_d2  + w * g * g * e * (1 - e);
    s_num := s_num + w * g * (score[i] - e);
  end loop;
  if s_d2 = 0 then new_r := r; new_rd := rd; return next; return; end if;
  d2  := 1 / (q * q * s_d2);
  inv := 1 / (rd * rd) + 1 / d2;
  new_r  := round((r + (q / inv) * s_num)::numeric, 2);
  new_rd := round(greatest(sqrt(1 / inv), rd_floor)::numeric, 2);
  return next;
end $$;
```

**`apply_match_result`** (single game; placement rounds use `apply_placement_round`, same shape with arrays):

```
apply_match_result(match_id):
  m := select * from matches where id = match_id and status = 'judged' for update
  lock ratings rows for (m.a, cat) and (m.b, cat) in a fixed order (least uuid first)  -- deadlock-free
  ra, rb := the two rows
  (ra', rda') := glicko_update(ra.rating, ra.rd, [rb.rating], [rb.rd], [m.outcome_a])
  (rb', rdb') := glicko_update(rb.rating, rb.rd, [ra.rating], [ra.rd], [1 - m.outcome_a])
  for each side not locked:
     update ratings set rating = r', rd = rd', games+1, wins/draws/losses, last_match_at = now(),
            peak_rating = greatest(peak_rating, r'), updated_at = now()
     insert rating_history(resume_id, cat, match_id, r', rd', r' - r, 'match')
  update matches set status = 'applied', a_rating_after, b_rating_after, applied_at = now()
```

**`select_matches`** (the scheduler):

```sql
with live as (
  select r.resume_id, r.category, r.rating, r.rd, r.percentile,
         extract(epoch from now() - coalesce(r.last_match_at, r.created_at))/86400 as days,
         coalesce(s.views_7d, 0) as views,
         abs(r.rating - coalesce(r.rating_24h_ago, r.rating)) > 60 as moved
  from rank.ratings r left join public.profile_stats s using (resume_id)
  where r.eligible and r.placement_done and not r.locked
    and coalesce(r.last_match_at, 'epoch') < now() - interval '6 hours'
    and not exists (select 1 from rank.matches m where m.subject_resume_id = r.resume_id
                    and m.category = r.category and m.status in ('queued','claimed'))
), scored as (
  select *, 3.0*power((rd-50)/300.0, 2) + least(days/45.0, 1) + 1.5*exp(-8*(1-coalesce(percentile,0.5)))
            + 0.5*least(views/200.0, 1) + 0.75*moved::int + random()*0.25 as priority
  from live
), top as (
  select * from scored order by priority desc limit 3 * p_limit
)
select * from top order by -ln(random()) / priority limit p_limit;   -- weighted sample
-- then, for each: roll kind (70/20/10), pick_opponent(...), insert into matches (kind, transport = setting refine_transport)
```

The scan touches ~230k live rows every two minutes; on Supabase small compute that is ~100–200 ms. If it ever matters, maintain `priority` as a stored column refreshed by the nightly job plus on-write bumps.

**`claim_matches`** (worker side, concurrency-safe):

```sql
update rank.matches m set status = 'claimed', claimed_at = now(), lease_until = now() + p_lease, attempts = attempts + 1
from (select id from rank.matches where status = 'queued' and transport = 'realtime'
      order by priority desc, created_at limit p_limit for update skip locked) q
where m.id = q.id returning m.*;
```

**`record_judge_result`**:

```
winner_pass1 := case pass1.winner when 'first' then a else b end
winner_pass2 := case pass2.winner when 'first' then b else a end      -- pass 2 is swapped
outcome_a := case when both = a then 1 when both = b then 0 else 0.5 end
agreement := winner_pass1 = winner_pass2
store tokens (sum of both passes), cost via model_prices, record_spend(model, purpose by kind, usage)
status := 'judged'
if placement_group is null: apply_match_result(id)
elif every match in the group is judged/void: apply_placement_round(placement_group)
```

**`recompute_percentiles`** (every 5 min per category; ~100k rows, one window pass):

```sql
with ranked as (
  select resume_id, rank() over (order by rating desc, rd asc, resume_id) as rk,
         1 - (percent_rank() over (order by rating desc)) as pct
  from rank.ratings where category = p_category and eligible and placement_done and not is_anchor)
update rank.ratings r set rank = x.rk, percentile = x.pct
from ranked x where r.resume_id = x.resume_id and r.category = p_category
  and (r.rank is distinct from x.rk or r.percentile is distinct from x.pct);
```

**`tier_for`**: `case when rating >= 2200 then 'Grandmaster' when >= 2000 then 'Master' when >= 1850 then 'Diamond' when >= 1700 then 'Platinum' when >= 1500 then 'Gold' when >= 1300 then 'Silver' else 'Bronze' end`.

### 6.4 Settings defaults (`rank.ranking_settings`)

```json
{
  "judge_model": "claude-sonnet-5-5",
  "analysis_model": "claude-opus-5-5",
  "daily_budget_usd": 25,
  "refine_budget_share": 0.40,
  "refine_transport": "batch",
  "tick_minutes": 2,
  "max_refine_matches_per_tick": 40,
  "max_placement_matches_per_tick": 60,
  "placement_rounds_general": [3, 3, 2],
  "placement_rounds_domain": [3, 3],
  "revision_rounds_general": [3, 2],
  "revision_rounds_domain": [3],
  "rd_initial": 350, "rd_initial_with_prior": 250, "rd_initial_domain": 220,
  "rd_floor": 50, "rd_ceiling": 350, "rd_inflation_c": 6, "rd_revision_min": 180, "provisional_rd": 130,
  "category_relevance_min": 0.35,
  "opponent_mix": {"local": 0.70, "crosscheck": 0.20, "anchor": 0.10},
  "drift_mode": "anchors", "drift_max_shift": 10, "drift_alert_residual": 0.08,
  "max_uploads_per_user_per_day": 3, "max_new_resumes_per_day": 1000,
  "est_cost_per_match_usd": 0.016,
  "model_prices": {
    "claude-sonnet-5-5": {"input": 2.00, "cache_read": 0.20, "cache_write": 2.50, "output": 10.00, "batch_multiplier": 0.5},
    "claude-haiku-4-5":  {"input": 1.00, "cache_read": 0.10, "cache_write": 1.25, "output": 5.00,  "batch_multiplier": 0.5},
    "claude-opus-5-5":   {"input": 4.00, "cache_read": 0.20, "cache_write": 5.00, "output": 20.00, "batch_multiplier": 0.5}
  }
}
```

(Prices are USD per million tokens, from the Claude API reference as of 2026-09; re-check before launch.)

### 6.5 Edge Functions

| Function | Trigger | Does |
|---|---|---|
| `judge-worker` | pg_net POST from an AFTER INSERT trigger on `rank.matches` (realtime rows) and a 1-minute cron safety net | `claim_matches(20)`; for each match, load both cards and the active prompt; fire the two orderings in parallel; `record_judge_result` or `fail_match`. Concurrency 5 matches (10 in-flight calls). Idempotent and safe to run in overlapping instances. |
| `judge-batch-submit` | cron */30 min via `flush_batch()` | Build one Message Batches job with two requests per match (`custom_id = "<match_id>:1" / ":2"`), store `batch_id`. |
| `judge-batch-poll` | cron */5 min | For each open `batch_id`: if `processing_status = 'ended'`, stream results, key by `custom_id`, `record_judge_result` when both passes are present; errored/expired → `fail_match`. |
| `anchor-validate` | manual / on prompt change | Runs the adjacent-anchor test, writes `rank.audits(kind='anchor_validation')`. |
| `bt-audit` | weekly (phase 2) | Section 3.6. |

Realtime latency budget: trigger → worker start ~0.5 s; two Sonnet calls at low effort ~4–8 s; apply < 50 ms. A 3-game round completes in ~8–10 s; full placement in ~45–60 s.

---

## 7. Cost model

Token assumptions per judge call: system prompt 1,800 tokens (cached after the first call in a 5-minute window), two cards at ~600 tokens + 150 framing = 1,350 uncached input, output 500 (≈150 JSON + ≈350 low-effort thinking).

### 7.1 Per call / per match

| Model (realtime) | Uncached in | Cache read | Output | **Per call** | **Per match (2 calls)** | Batch match (×0.5) |
|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 1,350 × $2/M = $0.0027 | 1,800 × $0.20/M = $0.0004 | 500 × $10/M = $0.0050 | **$0.0081** | **$0.016** | $0.008 |
| claude-haiku-4-5 | $0.00135 | $0.00018 | $0.0025 | $0.0040 | $0.008 | $0.004 |

Cache write on the first call per category window adds ~$0.0045 once; negligible at steady state. Without caching, a Sonnet call would cost $0.0113, so grouping by category matters (−28%).

### 7.2 Per placed resume

Average resume: `general` (8 games) + 1.3 domain categories × 6 games = **15.8 matches**.

| Component | Sonnet judge, realtime | Haiku judge, realtime |
|---|---|---|
| Placement matches | 15.8 × $0.016 = **$0.25** | 15.8 × $0.008 = $0.13 |
| Deep analysis (Opus 5.5: ~4k PDF tokens + 3k cached system + 3k output) | $0.016 + $0.0006 + $0.060 = **$0.077** | $0.077 |
| **Total per new resume** | **≈ $0.33** | ≈ $0.21 |

### 7.3 Daily, at 500 new resumes/day (the task's scenario)

| Configuration | Placement + analysis | Refinement (default share) | **Per day** | Per month |
|---|---|---|---|---|
| Spec default: Sonnet realtime placement, Sonnet batch refinement | $165 | $10 (≈1,250 matches) | **≈ $175** | ≈ $5,300 |
| Placement via Batch overnight (users see provisional rating same day) | $100 | $10 | ≈ $110 | ≈ $3,300 |
| Haiku judge, realtime placement | $105 | $10 | ≈ $115 | ≈ $3,500 |
| Haiku judge + batch placement | $70 | $10 | ≈ $80 | ≈ $2,400 |

For scale: at 50 resumes/day (a realistic first few months) the default configuration costs **≈ $17–20/day**, which fits the `daily_budget_usd = 25` default with refinement included. 500/day sustained is 100k resumes in 200 days; the budget cap exists precisely so growth degrades gracefully (placements fall back to batch, refinement pauses) instead of surprising the owner's card.

Refinement economics: $10/day in batch Sonnet buys ~1,250 matches ≈ 2,500 rating updates/day. Over 100k resumes × 2.3 categories that is one refinement per row every ~90 days — enough to keep the top of the ladder (where priority concentrates) near the RD floor, not enough to tighten everyone. That is the intended trade-off; raising `refine_budget_share` is the lever.

### 7.4 Storage and compute

Per 100k resumes: `ratings` ~230k rows (~60 MB with indexes), `matches` ~2.5M rows/yr (~2 GB with jsonb pass payloads; trim `reasoning` to 320 chars and this stays well under the Supabase Pro 8 GB included), `rating_history` ~14M rows/yr before compaction (~1.5 GB, BRIN keeps it cheap). pg_cron workload: the 2-minute scheduler scan and the 5-minute percentile window are the only non-trivial queries; both are sub-second at this size.

---

## 8. Open questions for Noah

1. Anchor authoring: 48 synthetic cards need writing/reviewing. Generate with Opus 5.5 from the section 3.5 specs and have Noah review in an afternoon, or ship v1 with the linear fallback map and add anchors in week 2?
2. Should domain leaderboards require a minimum relevance (e.g., 0.5) to appear publicly, with 0.35–0.5 rated but hidden? Current design shows anyone ≥ 0.35.
3. Default `daily_budget_usd`: 25 is a dev-safe number; what is the real monthly ceiling, so the upload caps can be set to match?
4. Community head-to-head voting (weight 0.3) is designed in but not scheduled. Launch feature or later?
5. Tier names: metals as proposed, or a quieter numeric scheme ("Class I–VII")? The UI doc should settle typography either way.

