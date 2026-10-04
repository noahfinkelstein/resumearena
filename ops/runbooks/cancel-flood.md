# Cancel floods and other token abuse

The embedded PAT can dispatch, cancel, re-run, enable/disable workflows and read logs in this repository, and
nothing else (spec §12). Everything expensive is bounded by controls inside the workflows, so abuse shows up as
nuisance, not as cost: cancelled runs, pointless deploys, disabled schedules, a burned hourly rate limit.

## Recognize it

On `/about#status` (`status.health`):

| signal | meaning |
|---|---|
| `cancelled_runs_24h > 10` → alert `cancelled_runs_high` | someone is cancelling runs |
| `failed_runs_24h > 5` → alert `failed_runs_high` | runs failing (could be us, could be them) |
| `schedule_enabled = false` in red | the schedules were disabled; every run re-enables them, so this means no run has happened since |
| `dispatch_path_24h` spike with few new entries | dispatch flood hitting the hourly cap |
| `last_rerank.at` older than 30 min (amber) | reranks are being cancelled or the queue is starved |
| site stale while reranks succeed | deploy flood: `concurrency: pages, cancel-in-progress: true` lets a newer deploy cancel the current one |

Confirm with the API:

```bash
R=noahfinkelstein/resumearena
gh run list --repo $R --status cancelled --limit 30 --json workflowName,event,createdAt,actor
gh run list --repo $R --workflow deploy.yml --limit 30 --json status,conclusion,event,createdAt
gh api repos/$R/actions/workflows --jq '.workflows[] | {name, state}'
```

Every dispatch and cancel made with the public token shows `noahfinkelstein` as the actor, so the actor tells you
nothing; timing and volume do.

## Respond

1. **Rotate the token** (`ops/runbooks/rotate-token.md`). The old token stops working the moment it is revoked;
   the new bundle is live after one deploy. This ends the flood. Clients holding the old bundle fall back to the
   Issue form until they reload.
2. **Re-enable schedules** if they are off: `for w in rerank.yml maintenance.yml submit.yml deploy.yml; do gh workflow enable $w --repo $R; done`.
3. **Deploy floods that persist** (rare: only possible while the old token still works): flip
   `cancel-in-progress` to `false` under `concurrency: pages` in `deploy.yml` for the day, push, revert tomorrow.
   This is the owner's explicit exception to D-20.
4. **Cancelled submits** lost at most one analysis each ($0.20) and wrote nothing; the person's result page offers
   "Resubmit" after 30 minutes with the same id (idempotent). Nothing to clean up.
5. **Cancelled reranks** lost at most one wave; the WAL already pushed is replayed by the next run.
6. **Hourly rate limit burned** (5,000 requests/h on the PAT): browsers fall back to the Issue form for the rest
   of the hour; nothing to do.

## What the token cannot do

It cannot read or write contents, secrets, variables, issues, Pages settings, or any other repository. If you see
commits, variable changes or settings changes you did not make, that is not this token; rotate your own
credentials and review the audit log.
