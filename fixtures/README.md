# Fixtures

Synthetic test data for ResumeArena. **Nothing in this directory describes a real person.** Employer, school, venue and award names are real because the rubric tiers them; every person, date range, number and outcome is invented. Fixtures never reach the `data` branch (spec D-66); they feed `VITE_MOCK=1`, the evals and the test suites.

## What is here

| Path | Owner | Contents |
|---|---|---|
| `plan.json` | this file's authors | The 60-entry plan that drives the résumé writers (below). |
| `anchors/<cat>.json` | same | 12 hand-authored anchor cards per category at 1000…2100, the fixed calibration scale (spec D-25, §3.3). Mirrors what `maintenance rotate-anchors` writes to the data branch, so tests and mock mode can place against a scale without an API key. |
| `issue-bodies/*.md` | same | Issue Form bodies exactly as GitHub renders them, for `parseIssueForm` tests. |
| `resumes/<slug>.txt`, `resumes/<slug>.meta.json` | written from the plan | The text exactly as the browser would submit it (placeholders in place) and its meta (`{ slug, group, intended_anchor, intended_stage, intended_categories, expect, metrics, planted? }`). |
| `analyses/<slug>.json` | `engine fixtures generate --live` | The engine's real analysis per fixture, committed once (≈ $12). |
| `pairs.json` | `node fixtures/scripts/pairs.ts` | 200 labelled card pairs `{ a, b, category, label }` over the anchor-level fixtures: `a`/`b` are slugs (the card is `analyses/<slug>.json → card`), `label` is `a` or `b` when the two `intended_anchor`s differ by ≥ 200 and `close` otherwise; up to 50 per domain ladder, the rest on general. Deterministic; regenerate after changing the plan or the analyses. |
| `review.md` | by hand | The one-time review of the committed fixtures: validator output, accepted warnings and the judgement calls. |
| `scripts/` | same | `validate.ts` (every meta and analysis against the shared schemas and the rules below) and `pairs.ts`. |
| `web-data/` | `pnpm fixtures:web-data` | Pre-built Pages and raw trees for mock mode (generated, committed). |

All JSON is written with sorted keys and a trailing newline.

## How `plan.json` drives the writers

Each of the 60 entries is a self-contained brief:

```
slug                 kebab-case, starts with the group; becomes resumes/<slug>.txt and analyses/<slug>.json
group                anchor | weak | gamed | pii | edge
category             primary ladder (stored as `primary`; display order only)
intended_anchor      1000…2100 step 100 for anchor-level fixtures, null otherwise
intended_stage       student | new_grad | early | mid | senior | executive
intended_categories  every ladder the analyst should include (relevance ≥ 0.35), general first
expect.gate          pass | reject | held   (held = the gate passes it with prompt_injection_detected = true)
expect.status        analyzed | rejected | held | needs_review   (the resume doc's final status)
brief                who the person is and what makes the text weak / gamed / pii / edge
target_chars         length the writer aims for (± 10 %; exact for the 15,000 and 380 edge cases)
```

The writer (a person or `engine fixtures generate`, Opus 5.5, plain text, one call per slug) produces `resumes/<slug>.txt` from the brief, and `resumes/<slug>.meta.json` by copying the plan entry, adding hand-written `metrics` (a `LayoutMetrics`; never measured) and, for the `pii` group, `planted` with the exact planted strings so the eval can grep every output for them. Rules the writers must keep:

- Placeholders `[name] [email] [phone] [url]` sit where the real document had those items. `scrubPii(text).text === text` must hold for every fixture, **including the `pii` group**: the planted values are deliberately shaped so the deterministic scrub misses them (a full name in running text, an obfuscated e-mail, a spelled-out URL) and only the analyst catches them, which is what routes the record to `held (pii)` instead of a `text_not_scrubbed` reject.
- Every text is distinct. Submit dedupes on `text_sha256`, so the two-column edge case is its own résumé, not a copy of an anchor fixture with different metrics.
- Anchor-level briefs name a rubric calibration level (30 / 55 / 75 / 90 / 98 from `docs/design/scoring-rubric.md` §5). The two fixtures at one level take adjacent ladder ratings (1000/1100, 1300/1400, 1500/1600, 1800/1900, 2000/2100) so the mock judge, which prefers the higher `intended_anchor`, always has a side to prefer. Stages are spread so every category has a student, new_grad, early, mid and senior fixture, and general has an executive.
- `expect` is what the pipeline must do. The only `gate: held` entry is the prompt-injection fixture: the gate flags it, the analyst adds a high-severity `prompt_injection` flag, and the record ends `held` with `held_reason: 'injection'` (never rejected). The hidden-keyword-block fixture is expected `analyzed` with `keyword_stuffing`/`hidden_text` flags; it becomes `held` only if the gate also flags it, and evals should tolerate either. The 380-character fixture is rejected by `normalizePayload` (`too_short`) before any model runs; its `gate` is `reject` by convention.

## Anchors

`anchors/<cat>.json` has the data-branch shape: `{ schema, category, prompt_version, validated_at, anchors[12] }` with each anchor `{ id, rating, stage, spec, card }`. Ids follow D-25 (`anchr` + `g|f|t|a` + `bcdefghijklm[(rating − 1000) / 100]` + `aaa`, so `anchrggaaa` is general 1500). The engine gives anchor rating rows `rd: 30, locked: true` when it loads them; those are rating-row fields, not anchor-file fields. `validated_at` is `null` because these cards have not been through `validate-anchors`; `prompt_version` is the bare `judge.v1` because the stamped hash is only known once the prompts are assembled.

The cards were written by hand against the rubric's calibration anchors and the authoring guide in `docs/design/ranking-system.md` §3.5 (1000 minimal, 1300 typical, 1500 solid, 1700 strong, 1900 exceptional, 2100 rare) and should read as strictly stronger from one rating to the next within a category. They were checked against `packages/shared/src/schemas/analysis.schema.json` (`$defs/Card`), the §5.4 caps (headline ≤ 120, `top_signal` ≤ 18, ≤ 6 experiences, ≤ 4 projects, ≤ 6 awards, ≤ 3 highlights, ≤ 4 leadership, ≤ 12 skills, ≤ 5 notable, ≤ 12 venues) and a sweep for names, pronouns, e-mails, URLs, phones and placeholder tokens. Edit them as JSON; keep keys sorted.

## Issue bodies

GitHub renders an Issue Form submission as `### <label>` headings separated by blank lines, the value of a `render: text` / `render: json` textarea inside a fenced block of that language, dropdown values as plain text, and `_No response_` for an empty optional input. The templates must therefore use the field id as the `label` so that `parseIssueForm` can key on `### <id>`. Three captures:

- `submission-dispatch-style.md`: a normal submission with a fenced `text`, a fenced `metrics_json` and an empty `client_version`.
- `submission-markdown-headings-in-text.md`: the résumé itself contains lines starting with `### ` and `# ` inside the fence (a pasted Markdown CV), the default `{}` metrics, and a filled `client_version`. A parser that splits on `^### ` without honouring fences fails here.
- `delete-basic.md`: the delete form (`submission_id`, `handle`, `owner_key`); the key is a syntactically valid `rak-` key that was never used.

Bodies are stored with `\n`; parsers should also accept `\r\n`, which the workflow's mask step strips before use.
