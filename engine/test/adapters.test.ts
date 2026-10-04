import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueFieldsCarryKey, normalizePayload, parseIssueForm } from '@resumearena/shared';
import { fromDispatch } from '../src/adapters/dispatch.ts';
import { fromIssue, redactOwnerKeyLine } from '../src/adapters/issue.ts';
import { FIXTURES_DIR } from './helpers/harness.ts';

const issueBody = (name: string): string => readFileSync(join(FIXTURES_DIR, 'issue-bodies', name), 'utf8');

describe('adapters', () => {
  it('dispatch and issue produce identical SubmissionInput for the same fields', async () => {
    const body = issueBody('submission-dispatch-style.md');
    const fields = parseIssueForm(body);
    const issueEvent = { issue: { number: 7, node_id: 'I_1', body, labels: [{ name: 'ra:submission' }], user: { login: 'someone' } } };
    const issue = fromIssue(issueEvent, 42);
    const dispatch = fromDispatch({ inputs: { ...issue.payload } }, 42);
    const a = await normalizePayload(issue.payload, issue.source);
    const b = await normalizePayload(dispatch.payload, dispatch.source);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const { source: sa, ...restA } = a.input;
    const { source: sb, ...restB } = b.input;
    expect(restA).toEqual(restB);
    expect(sa.kind).toBe('issue');
    expect(sb.kind).toBe('dispatch');
    expect(fields.submission_id).toBe(restA.id);
  });

  it('issue path keeps a pasted-Markdown CV whole through the fenced text field', async () => {
    // The résumé carries its own `### ` and `# ` lines inside the fence; parseIssueForm splits only
    // on headings outside an open fence, so the text round-trips and the later fields still parse.
    const body = issueBody('submission-markdown-headings-in-text.md');
    const issue = fromIssue({ issue: { number: 8, node_id: 'I_2', body, labels: [{ name: 'ra:submission' }], user: { login: 'x' } } }, 1);
    expect(issue.payload.submission_id).toBe('f0ps22nd1q');
    expect(issue.payload.handle).toBe('tfarrow');
    expect(issue.payload.ladder_hint).toBe('academia');
    expect(issue.payload.client_version).toBe('412345678.1');
    expect(issue.payload.metrics_json).toBe('{}');
    expect(issue.payload.text.startsWith('[name]\nPostdoctoral Researcher')).toBe(true);
    expect(issue.payload.text).toContain('### Research Interests');
    expect(issue.payload.text).toContain('### Service');
    expect(issue.payload.text.endsWith('# Skills\nR, Python, causal inference, experimental design, scientific writing.')).toBe(true);
    expect(issue.payload.text).not.toContain('```');
    // The captured body carries the spec's example id f0ps22nd1q, which is not base32 (0 and 1); the
    // text is what this test is about, so normalize with a valid id in its place.
    const r = await normalizePayload({ ...issue.payload, submission_id: 'f2ps22nd3q' }, issue.source);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.text).toBe(issue.payload.text);
  });

  it('delete issue carries the key and derives owner_hash from it', async () => {
    const body = issueBody('delete-basic.md');
    const issue = fromIssue({ issue: { number: 9, node_id: 'I_3', body, labels: [{ name: 'ra:delete' }], user: { login: 'x' } } }, 1);
    expect(issue.payload.action).toBe('delete');
    const r = await normalizePayload(issue.payload, issue.source);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.owner_hash).toMatch(/^[0-9a-f]{64}$/);
    const redacted = redactOwnerKeyLine(body);
    expect(redacted).toContain('[redacted]');
    expect(redacted).not.toContain(issue.payload.owner_key.trim());
  });

  it('a hand-added owner_key on a submission body is dropped from the payload but still detected', async () => {
    const body = `${issueBody('submission-dispatch-style.md').trimEnd()}\n\n### owner_key\n\nrak-mk7q-2xdp-h4vb-3nrt-c6wz-5yfa-j2lq-7gbs-e4mn-k3pd-u5xw-a6rz-t2cq\n`;
    const fields = parseIssueForm(body);
    expect(issueFieldsCarryKey(fields)).toBe(true);
    const submission = fromIssue({ issue: { number: 10, node_id: 'I_4', body, labels: [{ name: 'ra:submission' }], user: { login: 'x' } } }, 1);
    expect(submission.payload.owner_key).toBe('');
    const r = await normalizePayload(submission.payload, submission.source);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.owner_key).toBeNull();
    // The delete template is the only one that carries a key.
    const del = fromIssue({ issue: { number: 11, node_id: 'I_5', body, labels: [{ name: 'ra:delete' }], user: { login: 'x' } } }, 1);
    expect(del.payload.owner_key).toContain('rak-');
    expect(redactOwnerKeyLine(body)).not.toContain('rak-mk7q');
  });

  it('unknown inputs are dropped and missing ones become empty strings', () => {
    const { payload } = fromDispatch({ inputs: { action: 'submit', extra: 'x' } }, 1);
    expect(Object.keys(payload).sort()).toEqual(['action', 'client_version', 'handle', 'ladder_hint', 'metrics_json', 'owner_hash', 'owner_key', 'submission_id', 'text', 'visibility']);
    expect(payload.handle).toBe('');
  });
});
