// The submit command's input boundary: nothing unvalidated reaches the data branch (SEC-01), a key that
// was public in an issue body is redacted first and burnt whatever the outcome (SEC-02), the Issue path
// cannot resubmit (SEC-03), and commands that never call a model need no API key (F01).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResumeDocZ, UserDocZ, formatOwnerKey, type ResumeDoc, type SubmissionPayload } from '@resumearena/shared';
import { submitCommand } from '../src/commands/submit.ts';
import { createContext } from '../src/context.ts';
import { createGithub } from '../src/github/api.ts';
import { LlmConfigError } from '../src/llm/client.ts';
import { openMemoryStore } from '../src/store/store.ts';
import { resumePath, userPath } from '../src/store/paths.ts';
import { createHarness, prompts, testEnv } from './helpers/harness.ts';

const OWNER_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

async function tempJson(name: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ra-submit-'));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

/** A GitHub client that records every call instead of making it. */
function recordingGithub() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const gh = createGithub(testEnv({ raEnv: 'production', githubToken: 'x' }), {
    force: true,
    fetch: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
  });
  return { gh, calls };
}

const issueBody = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `### ${k}\n\n${v}\n`)
    .join('\n');

describe('submit command: rejected stubs carry only validated input (SEC-01)', () => {
  it('a 5,000-character handle and a garbage client_version never reach the stub', async () => {
    const h = await createHarness();
    const payload: SubmissionPayload = {
      action: 'submit', submission_id: 'abcdefghij', handle: 'x'.repeat(5000), owner_hash: OWNER_HASH, visibility: 'anonymous',
      text: 'short', metrics_json: '{}', ladder_hint: '', client_version: 'A B C!! <script>', owner_key: '',
    };
    const r = await submitCommand(h.ctx, { payload: await tempJson('p.json', payload) });
    expect(r.outcome).toBe('rejected');
    const doc = ResumeDocZ.parse(await h.store.readJson(resumePath('abcdefghij'))) as ResumeDoc;
    expect(doc.status).toBe('rejected');
    expect(doc.rejected_reason).toBe('handle_taken');
    expect(doc.handle).toBe('invalid');
    expect(doc.source.client_version).toBe('');
    expect(doc.text).toBeUndefined();
  });

  it('a valid handle survives into the stub when another field is at fault', async () => {
    const h = await createHarness();
    const payload: SubmissionPayload = {
      action: 'submit', submission_id: 'abcdefghik', handle: 'fine-handle', owner_hash: OWNER_HASH, visibility: 'anonymous',
      text: 'x'.repeat(500), metrics_json: 'not json', ladder_hint: '', client_version: 'mock.1', owner_key: '',
    };
    const r = await submitCommand(h.ctx, { payload: await tempJson('p.json', payload) });
    expect(r.outcome).toBe('rejected');
    const doc = ResumeDocZ.parse(await h.store.readJson(resumePath('abcdefghik'))) as ResumeDoc;
    expect(doc.rejected_reason).toBe('bad_payload');
    expect(doc.handle).toBe('fine-handle');
    expect(doc.source.client_version).toBe('mock.1');
  });

  it('the document schema refuses a malformed handle or client_version', () => {
    const base = { schema: 1, id: 'abcdefghij', kind: 'user', status: 'rejected', handle: 'ok-handle', visibility: 'anonymous', owner_hash: OWNER_HASH, primary: 'general', created_at: 'x', updated_at: 'x', source: { kind: 'dispatch', run_id: 1, issue_number: null, client_version: 'mock.1' }, text_sha256: '0'.repeat(64) };
    expect(ResumeDocZ.safeParse(base).success).toBe(true);
    expect(ResumeDocZ.safeParse({ ...base, handle: 'x'.repeat(21) }).success).toBe(false);
    expect(ResumeDocZ.safeParse({ ...base, handle: 'Has Spaces' }).success).toBe(false);
    expect(ResumeDocZ.safeParse({ ...base, source: { ...base.source, client_version: 'A B!' } }).success).toBe(false);
  });
});

describe('submit command: keys in issue bodies (SEC-02, SEC-03)', () => {
  it('a delete issue with a mistyped handle still gets its key line redacted, the issue locked and the key burnt', async () => {
    const h = await createHarness();
    const { input, ownerKey } = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail', { handle: 'priya-test' });
    expect(input.handle).toBe('priya-test');
    const { gh, calls } = recordingGithub();
    const ctx = h.fork({ github: gh });
    const shown = formatOwnerKey(ownerKey);
    const body = issueBody({ submission_id: input.id, handle: 'Priya-Test', owner_key: shown });
    const event = { action: 'opened', issue: { number: 31, node_id: 'I_31', body, labels: [{ name: 'ra:delete' }], user: { login: 'someone' } } };
    const r = await submitCommand(ctx, { event: await tempJson('event.json', event) });
    expect(r.outcome).toBe('rejected');
    // The body edit is the first GitHub call and carries no key in either form.
    const edit = calls[0];
    expect(edit?.method).toBe('PATCH');
    expect(edit?.url).toMatch(/\/issues\/31$/);
    const edited = (edit?.body as { body: string }).body;
    expect(edited).toContain('[redacted]');
    expect(edited).not.toContain(shown);
    expect(edited).not.toContain(ownerKey);
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/issues/31/lock'))).toBe(true);
    const user = UserDocZ.parse(await h.store.readJson(userPath('priya-test')));
    expect(user.key_exposed).toBe(true);
    // The document is untouched: a failed delete writes nothing to the entry.
    expect((ResumeDocZ.parse(await h.store.readJson(resumePath(input.id))) as ResumeDoc).status).toBe('analyzed');
  });

  it('a submission issue that smuggles an owner_key is handle_taken, not a resubmission, and burns the key', async () => {
    const h = await createHarness();
    const { input, ownerKey } = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail', { handle: 'priya-test' });
    const { gh, calls } = recordingGithub();
    const ctx = h.fork({ github: gh });
    const body = issueBody({
      submission_id: 'resubmitab', handle: 'priya-test', owner_hash: input.owner_hash, visibility: 'anonymous', ladder_hint: 'general',
      text: `\`\`\`text\n${input.text}\n\nUpdated through the form.\n\`\`\``, metrics_json: '```json\n{}\n```', client_version: '_No response_', owner_key: formatOwnerKey(ownerKey),
    });
    const event = { action: 'opened', issue: { number: 32, node_id: 'I_32', body, labels: [{ name: 'ra:submission' }], user: { login: 'someone' } } };
    const r = await submitCommand(ctx, { event: await tempJson('event.json', event) });
    expect(r.outcome).toBe('rejected');
    const doc = ResumeDocZ.parse(await h.store.readJson(resumePath('resubmitab'))) as ResumeDoc;
    expect(doc.status).toBe('rejected');
    expect(doc.rejected_reason).toBe('handle_taken');
    expect(doc.text).toBeUndefined();
    // The original entry was not superseded and the key is now exposed.
    expect((ResumeDocZ.parse(await h.store.readJson(resumePath(input.id))) as ResumeDoc).status).toBe('analyzed');
    expect(UserDocZ.parse(await h.store.readJson(userPath('priya-test'))).key_exposed).toBe(true);
    expect((calls[0]?.body as { body: string }).body).not.toContain(ownerKey);
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/issues/32/lock'))).toBe(true);
  });
});

describe('context: the model client is built on first use (F01)', () => {
  it('live mode without an API key creates a context; only a model call fails', async () => {
    const ctx = createContext({ env: testEnv({ llmMode: 'live', anthropicKey: null, inActions: true }), store: openMemoryStore(), prompts: prompts() });
    expect(ctx.transport.mode).toBe('live');
    await expect(
      ctx.transport.call({ purpose: 'gate', model: 'claude-haiku-4-5', max_tokens: 10, system: 's', cache_ttl: '5m', user: 'u', thinking: false, fallbacks: false, stream: false }),
    ).rejects.toBeInstanceOf(LlmConfigError);
  });
});
