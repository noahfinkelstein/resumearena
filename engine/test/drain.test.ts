// Draining queue/analysis completes the id's own queued stub (F02) and bills the analysis exactly once
// in the only ledger (F06).
import { describe, expect, it } from 'vitest';
import { RatingsFileZ, ResumeDocZ, type ResumeDoc, type UsageLine } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { loadSettings } from '../src/settings.ts';
import { analysisQueuePath, placementTicketPath, ratingsPath, resumePath } from '../src/store/paths.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { createHarness } from './helpers/harness.ts';

const usageLines = async (h: Awaited<ReturnType<typeof createHarness>>): Promise<UsageLine[]> => (await h.store.readLines('usage/2026-10-03.jsonl')).filter(Boolean).map((l) => JSON.parse(l) as UsageLine);

describe('analysis queue drain', () => {
  it('a budget-queued submission is analyzed once the budget allows, with one gate and one analysis line', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 0.1 } });
    const q = await h.submitSlug('anchor-tech-1300-early-junior-dev-logistics');
    expect(q.report.outcome).toBe('queued');
    const id = q.input.id;
    expect(await h.store.exists(analysisQueuePath(id))).toBe(true);
    expect(await usageLines(h)).toHaveLength(0);

    // The owner raises the budget; the next rerank drains the queue through the same pipeline.
    const settings = await loadSettings(h.store);
    await h.store.writeJson('settings.json', { ...settings, daily_budget_usd: 100 });
    const r = await runRerank(h.fork({ runId: 'test-2' }), { drainOnly: true, trigger: 't' });
    expect(r.state).toBe('ok');
    expect(r.drained).toBe(1);
    const doc = ResumeDocZ.parse(await h.store.readJson(resumePath(id))) as ResumeDoc;
    expect(doc.status).toBe('analyzed');
    expect(doc.text).toBe(q.input.text);
    expect(await h.store.exists(placementTicketPath(id))).toBe(true);
    expect(await h.store.exists(analysisQueuePath(id))).toBe(false);
    const lines = await usageLines(h);
    expect(lines.filter((l) => l.purpose === 'gate')).toHaveLength(1);
    expect(lines.filter((l) => l.purpose === 'analysis')).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(r.usd).toBeCloseTo(lines.reduce((a, l) => a + l.usd, 0), 6);

    // A second run finds nothing to drain and appends nothing.
    const again = await runRerank(h.fork({ runId: 'test-3' }), { drainOnly: true, trigger: 't' });
    expect(again.drained).toBe(0);
    expect(await usageLines(h)).toHaveLength(2);

    // The ticket places normally afterwards.
    const judge = createSyntheticJudge({ strength: strengthFromId('drain'), seed: 'drain' });
    const placed = await runRerank(h.fork({ runId: 'test-4' }), { judge, trigger: 't' });
    expect(placed.ingested).toBe(1);
    const general = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    expect(general.rows[id]?.g).toBeGreaterThan(0);
    expect(await h.store.exists(placementTicketPath(id))).toBe(false);
  });

  it('a drained payload whose handle was claimed meanwhile is handle_taken (the stored payload carries no key)', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 0.1 } });
    const q = await h.submitSlug('anchor-tech-1300-early-junior-dev-logistics', { handle: 'contested' });
    expect(q.report.outcome).toBe('queued');
    const settings = await loadSettings(h.store);
    await h.store.writeJson('settings.json', { ...settings, daily_budget_usd: 100 });
    const other = await h.submitSlug('anchor-general-1500-early-big4-consultant-eagle-scout', { handle: 'contested', ownerKey: 'b'.repeat(52) });
    expect(other.report.outcome).toBe('analyzed');
    const r = await runRerank(h.fork({ runId: 'test-2' }), { drainOnly: true, trigger: 't' });
    expect(r.drained).toBe(1);
    const doc = ResumeDocZ.parse(await h.store.readJson(resumePath(q.input.id))) as ResumeDoc;
    expect(doc.status).toBe('rejected');
    expect(doc.rejected_reason).toBe('handle_taken');
    expect(await h.store.exists(analysisQueuePath(q.input.id))).toBe(false);
  });
});
