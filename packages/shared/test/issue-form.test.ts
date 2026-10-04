import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIssueForm, payloadFromIssueFields } from '../src/issue-form.ts';
import { normalizePayload } from '../src/payload.ts';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseIssueForm', () => {
  it('parses a submission body with a fenced text field and _No response_', () => {
    const f = parseIssueForm(read('issue-submission.md'));
    expect(Object.keys(f)).toEqual(['submission_id', 'handle', 'owner_hash', 'visibility', 'ladder_hint', 'text', 'metrics_json', 'client_version']);
    expect(f.submission_id).toBe('k7q2m3xw5a');
    expect(f.handle).toBe('priya-n');
    expect(f.visibility).toBe('anonymous');
    expect(f.ladder_hint).toBe('tech');
    expect(f.client_version).toBe('');
    expect(f.text?.startsWith('[name]\n[email] · [phone] · [url]\n\nExperience\n')).toBe(true);
    expect(f.text?.endsWith('Go, Rust, Kubernetes, Postgres, Kafka, Terraform')).toBe(true);
    expect(f.text).not.toContain('```');
    expect(JSON.parse(f.metrics_json ?? '')).toMatchObject({ source: 'pdf', pages: 2 });
  });
  it('parses a delete body', () => {
    const f = parseIssueForm(read('issue-delete.md'));
    expect(f).toEqual({ submission_id: 'k7q2m3xw5a', handle: 'priya-n', owner_key: 'rak-abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567-abcd-efgh-ijkl-mnop-qrst' });
  });
  it('tolerates CRLF, empty fences, missing values and trailing noise', () => {
    expect(parseIssueForm('### a\r\n\r\nx\r\n\r\n### b\r\n\r\n```json\r\n{}\r\n```\r\n')).toEqual({ a: 'x', b: '{}' });
    expect(parseIssueForm('### a\n\n```text\n```\n')).toEqual({ a: '' });
    expect(parseIssueForm('### a\n')).toEqual({ a: '' });
    expect(parseIssueForm('')).toEqual({});
    expect(parseIssueForm('no headings here')).toEqual({});
    expect(parseIssueForm('### text\n\n```text\nline 1\n\nline 3\n```')).toEqual({ text: 'line 1\n\nline 3' });
  });
  it('does not split on headings inside a fenced value', () => {
    const body = '### handle\n\npriya-n\n\n### text\n\n```text\n[name]\n\n### Education\nBS, 2020.\n\n# Skills\nR\n```\n\n### client_version\n\n_No response_\n';
    expect(parseIssueForm(body)).toEqual({ handle: 'priya-n', text: '[name]\n\n### Education\nBS, 2020.\n\n# Skills\nR', client_version: '' });
    // A longer closing run is required when the opening run is longer (CommonMark); tildes work too.
    expect(parseIssueForm('### text\n\n````\n```\n### not a heading\n````\n\n### b\n\nv\n')).toEqual({ text: '````\n```\n### not a heading\n````', b: 'v' });
    expect(parseIssueForm('### text\n\n~~~\n### inner\n~~~\n\n### b\n\nv\n')).toEqual({ text: '~~~\n### inner\n~~~', b: 'v' });
  });
});

describe('payloadFromIssueFields + normalizePayload', () => {
  const source = { kind: 'issue', run_id: 1, issue_number: 7, client_version: 'issue', author: 'octocat', node_id: 'I_abc' } as const;
  it('a submission issue becomes a valid SubmissionInput', async () => {
    const payload = payloadFromIssueFields(parseIssueForm(read('issue-submission.md')), false);
    expect(payload.action).toBe('submit');
    expect(payload.client_version).toBe('');
    const r = await normalizePayload(payload, source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.id).toBe('k7q2m3xw5a');
    expect(r.input.ladder_hint).toBe('tech');
    expect(r.input.metrics.pages).toBe(2);
    expect(r.input.metrics.redactions.email).toBe(1);
    expect(r.input.owner_key).toBeNull();
    expect(r.input.source).toEqual(source);
    expect(r.input.text_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a delete issue becomes a delete input with the parsed key', async () => {
    const payload = payloadFromIssueFields(parseIssueForm(read('issue-delete.md')), true);
    expect(payload).toMatchObject({ action: 'delete', visibility: '', text: '', metrics_json: '{}', client_version: 'issue' });
    const r = await normalizePayload(payload, source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.owner_key).toBe('abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst');
    expect(r.input.visibility).toBe('anonymous');
    expect(r.input.text).toBe('');
  });
});
