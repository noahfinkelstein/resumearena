# Monthly check (≈ 10 minutes)

Spec §14 step 6. Do this on the first of the month.

1. **Open `/about#status`.** Expect: `schedule enabled`, no alerts, `last_rerank` within 30 minutes, spend
   today below the budget, `direct channel healthy`.
2. **Schedules.** If `schedule_enabled` is false (red), push an empty commit to `main` so GitHub counts user
   activity again, then re-enable:
   ```bash
   R=noahfinkelstein/resumearena
   git commit --allow-empty -m "chore: keep schedules alive" && git push
   for w in rerank.yml maintenance.yml; do gh workflow enable $w --repo $R; done
   ```
   Every run re-enables the schedules itself (D-57), so a red flag means nothing has run; look at
   `gh run list --repo $R --limit 10` for why.
3. **Token expiry.** `ops/token.json` → `expires`. Rotate when within 60 days (`ops/runbooks/rotate-token.md`).
   The status block turns amber at 14 days; do not wait for that.
4. **Repository size.** The nightly summary (latest `maintenance` run → Summary) prints `du` of a full clone.
   Above 2 GB: commit a `squash-data-history` command (`ops/runbooks/squash-history.md`); above 2 GB after a
   squash, archive `matches/` older than 180 days (spec §12, a command file).
5. **Spend.** Anthropic console: month-to-date against expectations (≈ `daily_budget_usd` × days, less in quiet
   months). Check the console's own spend limit is still set.
6. **Judge health.** `per_category.*` on the status block: `disagreement_rate_7d ≤ 0.40`,
   `anchor_accuracy_7d ≥ 0.85` where `anchor_n_7d ≥ 40`, `|anchor_residual_7d| ≤ 0.08`. Persistent misses:
   `ops/runbooks/anchors.md`.
7. **Issues.** Delete processed `ra:delete` issues older than 7 days (`ops/runbooks/delete-issue.md`); close
   any stray non-form issues with a pointer to `/about#contact`.
8. **Dependencies.** Dependabot or `pnpm outdated` at the root; action majors in `.github/workflows/*.yml`
   (`actions/checkout`, `setup-node`, `pnpm/action-setup`, `configure-pages`, `upload-pages-artifact`,
   `deploy-pages`). CI must stay green after a bump.

Note anything unusual in `ops/runbooks/rotation-log.md` under a "Monthly" heading with the date.
