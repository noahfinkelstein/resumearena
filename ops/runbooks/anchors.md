# Anchors

Twelve fixed reference cards per category at 1000…2100 (RD 30, locked, hidden from every index) pin the rating
scale (spec D-25). Placement works without them, but the scale drifts until they exist, and the drift guard
(D-54) and judge-health monitors need them. Ids are `anchr` + `g|f|t|a` + one of `bcdefghijklm` + `aaa`.

## Generate (once per category, ≈ $2 each)

```bash
for cat in general finance tech academia; do
  ts=$(date -u +%Y%m%d-%H%M)
  printf '{\n  "action": "rotate-anchors",\n  "args": {\n    "category": "%s",\n    "generate": true\n  }\n}\n' "$cat" > "ops/commands/$ts-rotate-anchors.json"
  git add ops/commands && git commit -m "ops: generate $cat anchors" && git push
  gh run watch --repo noahfinkelstein/resumearena     # wait; one command per push
  sleep 60                                           # distinct timestamps
done
```

`rotate-anchors` writes `anchors/<cat>.json` on the data branch and runs `validate-anchors` afterwards.

## Review

Read all 48 cards: `https://raw.githubusercontent.com/noahfinkelstein/resumearena/data/anchors/<cat>.json`.
Each should read as a plausible, stage-appropriate record at its level, with no names, employers that would
identify a real person, or contact details. If one is off, write a replacement card by hand and run
`rotate-anchors` with `"cards": [ … ]` (the full list of twelve) instead of `generate`.

## Validate

```bash
ts=$(date -u +%Y%m%d-%H%M)
printf '{\n  "action": "validate-anchors",\n  "args": {\n    "category": "tech"\n  }\n}\n' > "ops/commands/$ts-validate-anchors.json"
git add ops/commands && git commit -m "ops: validate tech anchors" && git push
```

Adjacent pairs are judged five times in both orderings. Pass criteria: the higher anchor wins ≥ 60 % of its
games and no pair ≥ 300 apart loses. The report lands in `audits/anchor-validation-<cat>-<date>.json` and the
run summary; failures appear in `status.health.alerts` after the next nightly.

## When to rotate

- A judge prompt change (`docs/prompts/judge.md`): re-validate every category; regenerate if validation fails.
- `anchor_accuracy_7d < 0.85` for a category with `anchor_n_7d ≥ 40`, three nights running.
- `drift_persistent:<cat>` in alerts after a review finds the anchors, not the population, at fault.

Rotating anchors does not reset user ratings; the drift guard brings the population back to the new scale in
bounded ±10 steps per night.
