import { describe, expect, it } from 'vitest';
import { ResumeDocZ, UserDocZ, buildPayload, type ResumeDoc, type RowsShard, type UserDoc } from '@resumearena/shared';
import { createHarness } from './helpers/harness.ts';
import { placementTicketPath, resumePath, rowsPath, userPath, analysisQueuePath, deleteRequestPath, cardsPath } from '../src/store/paths.ts';
import { IdCollisionError } from '../src/submit/pipeline.ts';

const doc = async (h: Awaited<ReturnType<typeof createHarness>>, id: string): Promise<ResumeDoc> => ResumeDocZ.parse(await h.store.readJson(resumePath(id))) as ResumeDoc;
const user = async (h: Awaited<ReturnType<typeof createHarness>>, handle: string): Promise<UserDoc | null> => {
  const raw = await h.store.readJson(userPath(handle));
  return raw ? UserDocZ.parse(raw) : null;
};

describe('submit outcomes (mock mode)', () => {
  it('analyzes an anchor fixture and writes the full set', async () => {
    const h = await createHarness();
    const { report, input } = await h.submitSlug('anchor-tech-1500-mid-senior-eng-b-tier-saas');
    expect(report.outcome).toBe('analyzed');
    const d = await doc(h, input.id);
    expect(d.status).toBe('analyzed');
    expect(d.text).toBe(input.text);
    expect(d.scores?.general).toBeTypeOf('number');
    expect(d.card_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.versions?.gate_prompt).toMatch(/^gate\.v1\+[0-9a-f]{8}$/);
    const rows = (await h.store.readJson<RowsShard>(rowsPath(input.id))) as RowsShard;
    expect(rows[input.id]?.s).toBe('analyzed');
    expect(Object.keys(rows[input.id]?.ss ?? {})).toContain('tech');
    expect(await h.store.exists(placementTicketPath(input.id))).toBe(true);
    expect(await h.store.exists(cardsPath(input.id))).toBe(true);
    const u = await user(h, input.handle);
    expect(u?.resumes).toEqual([{ id: input.id, created_at: d.created_at, current: true }]);
    const usage = await h.store.readLines('usage/2026-10-03.jsonl');
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(report.usd).toBeGreaterThan(0);
  });

  it('holds on residual PII and on prompt injection without claiming the handle', async () => {
    const h = await createHarness();
    const pii = await h.submitSlug('pii-name-in-running-text');
    expect(pii.report.outcome).toBe('held');
    expect(pii.report.code).toBe('pii');
    const d = await doc(h, pii.input.id);
    expect(d.text).toBeUndefined();
    expect(d.analysis).toBeDefined();
    expect(d.held_reason).toBe('pii');
    expect(await user(h, pii.input.handle)).toBeNull();
    expect(await h.store.exists(rowsPath(pii.input.id))).toBe(false);
    const inj = await h.submitSlug('gamed-prompt-injection-ai-reviewer-paragraph');
    expect(inj.report.outcome).toBe('held');
    expect(inj.report.code).toBe('injection');
  });

  it('rejects the gate failures with the right codes and no text', async () => {
    const h = await createHarness();
    const german = await h.submitSlug('edge-german-language-resume');
    expect(german.report.code).toBe('unsupported_language');
    const cover = await h.submitSlug('edge-cover-letter-not-a-resume');
    expect(cover.report.code).toBe('not_a_resume');
    const d = await doc(h, cover.input.id);
    expect(d.status).toBe('rejected');
    expect(d.text).toBeUndefined();
    expect(d.gate?.verdict.is_resume).toBe(false);
  });

  it('too-short text never reaches the pipeline', async () => {
    const h = await createHarness();
    await expect(h.submitSlug('edge-too-short-380-chars')).rejects.toThrow(/too_short/);
  });

  it('dedupes identical text (free) and identical cards (paid) with duplicate_of only for the same owner', async () => {
    const h = await createHarness();
    // Placeholder texts carry the fixture marker, so a trivially edited copy still maps to the same mock analysis.
    const { placeholderText } = await import('../src/fixtures/texts.ts');
    const base = placeholderText(h.plan.find((e) => e.slug === 'anchor-general-1500-early-big4-consultant-eagle-scout')!);
    const first = await h.submitSlug('anchor-general-1500-early-big4-consultant-eagle-scout', { text: base });
    const sameOwnerOtherId = await h.submitSlug('anchor-general-1500-early-big4-consultant-eagle-scout', { id: 'zzzzzzzzz2', handle: 'other-handle', text: base });
    expect(sameOwnerOtherId.report.outcome).toBe('duplicate');
    expect(sameOwnerOtherId.report.code).toBe('text');
    expect((await doc(h, 'zzzzzzzzz2')).duplicate_of).toBe(first.input.id);
    expect(sameOwnerOtherId.report.usd).toBe(0);
    const otherOwner = await h.submitSlug('anchor-general-1500-early-big4-consultant-eagle-scout', { id: 'zzzzzzzzz3', handle: 'third-handle', ownerKey: 'b'.repeat(52), text: base });
    expect(otherOwner.report.outcome).toBe('duplicate');
    expect((await doc(h, 'zzzzzzzzz3')).duplicate_of).toBeNull();
    // Card dedupe: a trivially edited text with the same mock analysis.
    const edited = await h.submitSlug('anchor-general-1500-early-big4-consultant-eagle-scout', { id: 'zzzzzzzzz4', handle: 'fourth-handle', ownerKey: 'c'.repeat(52), text: `${base}\nMinor edit.` });
    expect(edited.report.outcome).toBe('duplicate');
    expect(edited.report.code).toBe('card');
    expect(edited.report.usd).toBeGreaterThan(0);
  });

  it('queues when the budget is exhausted and when paused, storing the payload without the key', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 0.1 } });
    const r = await h.submitSlug('anchor-tech-1300-early-junior-dev-logistics');
    expect(r.report.outcome).toBe('queued');
    expect(r.report.code).toBe('budget');
    const q = await h.store.readJson<{ payload: { owner_key: string; text: string } }>(analysisQueuePath(r.input.id));
    expect(q?.payload.owner_key).toBe('');
    expect(q?.payload.text).toBe(r.input.text);
    expect((await doc(h, r.input.id)).text).toBeUndefined();
    const paused = await createHarness({ settings: { paused: true } });
    const p = await paused.submitSlug('anchor-tech-1300-early-junior-dev-logistics');
    expect(p.report.code).toBe('paused');
  });

  it('resubmission needs the key, supersedes the current entry and refuses while placement is pending', async () => {
    const h = await createHarness();
    const first = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail');
    // Same handle, same key, while the ticket is still there → resubmit_too_soon.
    const tooSoon = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail', { id: 'rsrsrsrsr2', text: `${first.input.text}\n\nUpdated.` });
    expect(tooSoon.report.code).toBe('resubmit_too_soon');
    // Simulate rerank consuming the ticket.
    await h.store.remove(placementTicketPath(first.input.id));
    const again = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail', { id: 'rsrsrsrsr3', text: `${first.input.text}\n\nUpdated again.` });
    expect(again.report.outcome).toBe('analyzed');
    expect(again.report.supersedes).toBe(first.input.id);
    const old = await doc(h, first.input.id);
    expect(old.status).toBe('superseded');
    expect(old.superseded_by).toBe('rsrsrsrsr3');
    const rows = (await h.store.readJson<RowsShard>(rowsPath(first.input.id))) ?? {};
    expect(rows[first.input.id]).toBeUndefined();
    const u = await user(h, first.input.handle);
    expect(u?.resumes.map((r) => [r.id, r.current])).toEqual([[first.input.id, false], ['rsrsrsrsr3', true]]);
    const ticket = await h.store.readJson<{ supersedes: string | null }>(placementTicketPath('rsrsrsrsr3'));
    expect(ticket?.supersedes).toBe(first.input.id);
    // Wrong key → handle_taken.
    const wrongKey = await h.submitSlug('anchor-tech-1000-student-regional-cs-retail', { id: 'rsrsrsrsr4', ownerKey: 'd'.repeat(52), text: `${first.input.text}\nX` });
    expect(wrongKey.report.code).toBe('handle_taken');
  });

  it('is idempotent: a re-run with the same id and owner is a noop, another owner is an id collision', async () => {
    const h = await createHarness();
    const first = await h.submitSlug('anchor-finance-1500-mid-mm-bank-associate');
    const rerun = await h.submitSlug('anchor-finance-1500-mid-mm-bank-associate');
    expect(rerun.report.outcome).toBe('noop');
    await expect(h.submitSlug('anchor-finance-1500-mid-mm-bank-associate', { ownerKey: 'e'.repeat(52), handle: 'someone-else' })).rejects.toBeInstanceOf(IdCollisionError);
    expect((await doc(h, first.input.id)).status).toBe('analyzed');
  });

  it('manage actions: set_visibility flips the doc and row; delete tombstones and leaves a delete request', async () => {
    const h = await createHarness();
    const { input, ownerKey } = await h.submitSlug('anchor-academia-1500-student-phd-first-author-strong-venue', { visibility: 'anonymous' });
    const vis = await h.manage(buildPayload({ action: 'set_visibility', id: input.id, handle: input.handle, owner_hash: input.owner_hash, visibility: 'handle', owner_key: ownerKey }));
    expect(vis.outcome).toBe('visibility_set');
    expect((await doc(h, input.id)).visibility).toBe('handle');
    expect(((await h.store.readJson<RowsShard>(rowsPath(input.id))) as RowsShard)[input.id]?.v).toBe('handle');
    const bad = await h.manage(buildPayload({ action: 'delete', id: input.id, handle: input.handle, owner_hash: '', owner_key: 'f'.repeat(52) }));
    expect(bad.outcome).toBe('key_mismatch');
    const del = await h.manage(buildPayload({ action: 'delete', id: input.id, handle: input.handle, owner_hash: input.owner_hash, owner_key: ownerKey }));
    expect(del.outcome).toBe('deleted');
    const d = await doc(h, input.id);
    expect(d.status).toBe('deleted');
    expect(d.text).toBeUndefined();
    expect(await h.store.exists(deleteRequestPath(input.id))).toBe(true);
    expect(await h.store.exists(placementTicketPath(input.id))).toBe(false);
    const u = await user(h, input.handle);
    expect(u?.state).toBe('tombstone');
    expect(u?.owner_hash).toBe(input.owner_hash);
    // The handle stays reserved for the key holder.
    const stranger = await h.submitSlug('anchor-academia-1500-student-phd-first-author-strong-venue', { id: 'strangerra', ownerKey: 'g'.repeat(52), text: `${input.text}\nZ` });
    expect(stranger.report.code).toBe('handle_taken');
  });

  it('exposed keys may only delete', async () => {
    const h = await createHarness();
    const { input, ownerKey } = await h.submitSlug('anchor-general-1800-mid-army-captain-mbb-manager');
    await h.store.writeJson(userPath(input.handle), { ...(await user(h, input.handle)), key_exposed: true });
    const vis = await h.manage(buildPayload({ action: 'set_visibility', id: input.id, handle: input.handle, owner_hash: input.owner_hash, visibility: 'handle', owner_key: ownerKey }));
    expect(vis.outcome).toBe('key_mismatch');
    const del = await h.manage(buildPayload({ action: 'delete', id: input.id, handle: input.handle, owner_hash: input.owner_hash, owner_key: ownerKey }));
    expect(del.outcome).toBe('deleted');
  });

  it('handle race: two writers for one handle, the second becomes handle_taken on the fresh tree', async () => {
    const h = await createHarness();
    const a = await h.submitSlug('anchor-tech-1400-student-t2-junior-b-tier-intern', { handle: 'shared-handle' });
    expect(a.report.outcome).toBe('analyzed');
    const b = await h.submitSlug('anchor-tech-1600-early-t1-new-grad-a-tier', { handle: 'shared-handle', ownerKey: 'h'.repeat(52) });
    expect(b.report.code).toBe('handle_taken');
  });
});
