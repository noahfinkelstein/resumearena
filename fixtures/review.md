# Fixture review

One-time hand review of the committed fixtures (spec §13.1), 2026-10-03. Re-run `node fixtures/scripts/validate.ts` after any edit; this file records what the validator cannot decide.

## Validator result

`60 fixture(s) checked, 60 clean, 0 failing, 6 with warnings, 0 plan entries pending`. Every text passes `scrubPii(text).text === text`, every meta has the §13.1 shape with `char_count`/`word_count`/`redactions` derived from the text, and every analysis passes the JSON schema (ajv, `packages/shared/test/fixtures.test.ts`) and the Zod mirror with zero repairs.

## Accepted warnings

All six warnings are `card.publications_summary.count_total ≠ publications[].length` and are deliberate:

| slug | count_total | parsed | why |
|---|---|---|---|
| anchor-academia-1100-new-grad-ms-thesis-no-pub | 0 | 1 | the one entry is the MS thesis (`kind: thesis`), not a publication |
| anchor-academia-1900-senior-associate-prof-career-award | 50 | 11 | the CV lists selected publications; the total is stated in the text |
| anchor-academia-2100-executive-full-prof-nas-member | 200 | 10 | same: selected list, stated total |
| anchor-tech-1800-senior-staff-a-tier-platform | 1 | 3 | two of the three entries are patents |
| anchor-tech-2100-senior-principal-s-tier-research | 23 | 8 | selected list, stated total |
| weak-no-headings-at-all | 2 | 3 | one entry is a thesis |

## Judgement calls kept as written

- **Career stage of the finance 1800 and 2100 anchors** is `senior` (plan) although the rubric's definition puts an MD or a founding partner under `executive`. The plan was followed so `intended_stage`, `signals.career_stage` and `card.career_stage` agree; change all three together if the rubric reading is preferred.
- **anchor-academia-1800 (postdoc)** sits at the rubric's early/mid year boundary (PhD years at 0.5×); `early` was kept to match the plan and the convention that a second-year postdoc is early-career.
- **Institution tiers follow the rubric taxonomy over the briefs** where they disagreed (Penn/Wharton T2 for finance-1900; UNSW, Pittsburgh, Penn State, Nebraska T3; regional schools T4).
- **gamed-hidden-keyword-block-at-end** carries a high-severity `hidden_text` flag plus `keyword_stuffing` and expects `analyzed`; it becomes `held (injection)` only if the gate also sets `prompt_injection_detected`, and evaluations tolerate either.
- **gamed-fabricated** keeps `analysis_confidence` 0.45 (above the 0.3 `needs_review` line) with high-severity `implausible_claim`, `date_inconsistency` and `overlapping_fulltime_roles` flags, and scores discounted to the mid-30s.
- **Analyses are hand-authored to the rubric's calibration anchors**, not model output. `engine fixtures generate --live` remains the way to replace them with Opus baselines; the validator and the fixtures test keep checking whatever is committed.
- **Text files have no trailing newline** so the file bytes equal the text the browser submits (`char_count`, `text_sha256` and the exactly-15,000-character case hold on the raw file).
- **Issue bodies** are hand-written in GitHub's rendered form; `submission-markdown-headings-in-text.md` carries the spec's example id `f0ps22nd1q`, which is not base32, so tests that normalize it substitute a valid id.

## pairs.json

200 pairs over the 40 anchor-level fixtures: 50 each on tech, academia and finance where both sides list the ladder (finance has exactly 45 such pairs, so general takes 55), labelled from `intended_anchor` with the 200-point `close` band. Mix at generation: see the counts printed by `node fixtures/scripts/pairs.ts`.
