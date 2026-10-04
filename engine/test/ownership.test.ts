// D-27 / §3.1: submit and the manage actions never write an engine-owned prefix.
import { describe, expect, it } from 'vitest';
import { buildPayload } from '@resumearena/shared';
import { ENGINE_OWNED_PREFIXES, isEngineOwned } from '../src/store/paths.ts';
import { createHarness, trackWrites } from './helpers/harness.ts';

describe('ownership', () => {
  it('submit outcomes and manage actions touch only submit-owned paths', async () => {
    const h = await createHarness();
    const tracker = trackWrites(h.store);
    const a = await h.submitSlug('anchor-tech-1500-mid-senior-eng-b-tier-saas');
    await h.submitSlug('pii-name-in-running-text');
    await h.submitSlug('edge-cover-letter-not-a-resume');
    await h.submitSlug('anchor-tech-1500-mid-senior-eng-b-tier-saas', { id: 'dupdupdupa', handle: 'dup-handle' });
    await h.manage(buildPayload({ action: 'set_visibility', id: a.input.id, handle: a.input.handle, owner_hash: a.input.owner_hash, visibility: 'handle', owner_key: a.ownerKey }));
    await h.manage(buildPayload({ action: 'delete', id: a.input.id, handle: a.input.handle, owner_hash: a.input.owner_hash, owner_key: a.ownerKey }));
    const paused = await createHarness({ settings: { paused: true } });
    const t2 = trackWrites(paused.store);
    await paused.submitSlug('anchor-tech-1300-early-junior-dev-logistics');
    const all = [...tracker.paths, ...t2.paths];
    expect(all.length).toBeGreaterThan(10);
    const offending = all.filter(isEngineOwned);
    expect(offending).toEqual([]);
    for (const p of ENGINE_OWNED_PREFIXES) expect(all.some((x) => x.startsWith(p))).toBe(false);
  });
});
