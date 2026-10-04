# Delete a processed `ra:delete` issue

A delete through the Issue form puts the owner key in a public issue. The engine redacts the body, labels
`ra:processed`, closes and locks it, and marks the key `key_exposed` so it can only ever delete again. GitHub
keeps issue edit history visible to everyone, and `GITHUB_TOKEN` cannot delete an issue; only the owner can.

The nightly summary lists processed `ra:delete` issues older than 7 days. Delete them:

```bash
R=noahfinkelstein/resumearena
gh issue list --repo $R --label ra:delete --state closed --json number,title,closedAt,id --limit 50
# for each number N:
id=$(gh issue view N --repo $R --json id --jq .id)
gh api graphql -f query='mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }' -f id="$id"
```

Or in bulk, everything closed more than 7 days ago:

```bash
gh issue list --repo $R --label ra:delete --state closed --limit 100 \
  --json id,closedAt --jq '.[] | select(.closedAt < (now - 7*86400 | todate)) | .id' |
while read -r id; do
  gh api graphql -f query='mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }' -f id="$id"
done
```

Deleting the issue does not undo the delete it requested, and does not clear `key_exposed` on the user document
(that is correct: the key was public for a while).

## Other issues

Issues opened without a form label are ignored by `submit.yml` and left for the owner. Close them with a pointer
to `/about#contact`. `ra:failed` issues (a run failed mid-way) carry a comment with the code; the person can open
a new form issue to retry once the cause is fixed.
