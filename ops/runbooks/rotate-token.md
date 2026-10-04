# Rotate the submission token

The site embeds a fine-grained PAT (`SUBMIT_TOKEN`) that can only trigger, cancel and tidy workflows in this
repository (spec §12). Rotate it on expiry (calendar reminder 30 days before the date in `ops/token.json`), on
signs of abuse the caps do not already contain (`ops/runbooks/cancel-flood.md`), or after any accidental commit
of the token (GitHub's secret scanning usually revokes it first).

Rotation causes no downtime: clients holding the old bundle fall back to the Issue form until they reload.

## Steps

1. Create the new token. github.com → Settings → Developer settings → Personal access tokens → Fine-grained →
   Generate new token.
   - Name: `resumearena-submit-YYYY-MM`
   - Resource owner: `noahfinkelstein`
   - Expiration: 366 days (the maximum)
   - Repository access: Only select repositories → `noahfinkelstein/resumearena`
   - Repository permissions: **Actions: Read and write**. Nothing else (Metadata: Read is added automatically).
2. Store it as the repository variable (a variable, not a secret; it is public by design):
   ```bash
   gh variable set SUBMIT_TOKEN --repo noahfinkelstein/resumearena --body "github_pat_…"
   ```
3. Record the expiry on `main` (D-59; the build reads it into `VITE_TOKEN_EXPIRES`):
   ```bash
   # ops/token.json
   { "expires": "YYYY-MM-DD", "rotated_at": "YYYY-MM-DD" }
   git add ops/token.json && git commit -m "ops: rotate submit token" && git push
   ```
   The push to `main` already triggers a deploy. If you only changed the variable, dispatch one:
   ```bash
   gh workflow run deploy.yml --repo noahfinkelstein/resumearena --ref main -f reason="token rotation"
   gh run watch --repo noahfinkelstein/resumearena
   ```
4. Verify in a private window: open `/upload`; the direct channel should be available (no fallback banner).
   `/about#status` shows "direct channel" healthy and the new expiry date.
5. Revoke the old token on the same settings page. Pages caches the old bundle for up to 10 minutes; browsers
   keep hashed assets until reload. Both degrade to the Issue form, never to an error.
6. Log it in `ops/runbooks/rotation-log.md` (date, token name, reason).

## Dry run (release recipe step 9)

Do steps 1–6 once before launch with a second token so the first real rotation is not the first attempt. Revoke
the dry-run token at the end and leave the original in place.

## If the token leaks into git

GitHub revokes it automatically within minutes. The site falls back to the Issue form. Rotate as above; nothing
else needs to change because the token could never read or write repository contents.
