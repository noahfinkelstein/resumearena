// ranking-engine.md §7.3: WAL fault injection at waves 1/3/5 and the refinement wave. A restarted run
// (same run id, same seed) reproduces byte-identical ratings, history, cursors and match-line sets.
import { describe, expect, it } from 'vitest';
import { runRerank } from '../src/commands/rerank.ts';
import { PushRejectedError, commitWithRetry, type CommitFn } from '../src/store/commit.ts';
import { MS_PER_HOUR } from '../src/clock.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW, type Harness } from './helpers/harness.ts';

const SETTINGS = { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100 } } as const;
const RUN1 = 'run-1';
const RUN2 = 'run-2';

async function seeded(): Promise<Harness> {
  const h = await createHarness({ settings: SETTINGS, seed: 'idem' });
  await seedResumes(h.store, Array.from({ length: 10 }, (_, i) => ({ id: idFor(i, 'idem'), ownerHash: ownerFor(i), scores: { general: 40 + i * 5, ...(i % 2 ? { tech: 50 + i } : {}), ...(i % 3 === 0 ? { finance: 55 } : {}) }, queuedAt: FROZEN_NOW })));
  return h;
}

const judge = () => createSyntheticJudge({ strength: strengthFromId('idem'), seed: 'idem', judgeNoise: 0.3 });

/** Files that must agree: everything the engine owns except status.json (run metadata) and usage (ledger timing). */
function relevant(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of files) if (/^(ratings|history|matches|arena)\//.test(k)) out.set(k, v);
  return out;
}

function matchIds(files: Map<string, string>): string[] {
  const ids: string[] = [];
  for (const [k, v] of files) if (k.startsWith('matches/')) for (const line of v.trim().split('\n')) if (line) ids.push((JSON.parse(line) as { id: string }).id);
  return ids;
}

/** Reference: run 1 (placement) then run 2 seven hours later (refinement). */
async function reference(): Promise<{ afterRun1: Map<string, string>; afterRun2: Map<string, string> }> {
  const h = await seeded();
  const r1 = await runRerank(h.fork({ runId: RUN1 }), { judge: judge(), trigger: 't' });
  expect(r1.state).toBe('ok');
  expect(r1.matches).toBeGreaterThan(0);
  const afterRun1 = h.store.snapshot();
  h.clock.advance(7 * MS_PER_HOUR);
  const r2 = await runRerank(h.fork({ runId: RUN2 }), { judge: judge(), trigger: 't' });
  expect(r2.state).toBe('ok');
  expect(r2.refineMatches).toBeGreaterThan(0);
  return { afterRun1, afterRun2: h.store.snapshot() };
}

describe('idempotency under WAL faults', () => {
  it('push rejected at waves 1, 3 and 5: the restarted run reproduces the reference byte for byte', async () => {
    const ref = await reference();
    for (const faultWave of [1, 3, 5]) {
      const h = await seeded();
      const message = `[wal] run ${RUN1} wave ${faultWave}:`;
      const faulty: CommitFn = async (msg, muts) => {
        if (msg.startsWith(message)) throw new PushRejectedError(msg, 8);
        return commitWithRetry(h.store, msg, muts);
      };
      const b = await runRerank(h.fork({ runId: RUN1, commit: faulty }), { judge: judge(), trigger: 't' });
      expect(b.state).toBe('failed');
      const c = await runRerank(h.fork({ runId: RUN1 }), { judge: judge(), trigger: 't' });
      expect(c.state).toBe('ok');
      expect(relevant(h.store.snapshot())).toEqual(relevant(ref.afterRun1));
      const ids = matchIds(h.store.snapshot());
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('WAL pushed but the process died before applying: no double append, identical result', async () => {
    const ref = await reference();
    for (const faultWave of [2, 4]) {
      const h = await seeded();
      const message = `[wal] run ${RUN1} wave ${faultWave}:`;
      const dying: CommitFn = async (msg, muts) => {
        const r = await commitWithRetry(h.store, msg, muts);
        if (msg.startsWith(message)) throw new Error('process died after push');
        return r;
      };
      await expect(runRerank(h.fork({ runId: RUN1, commit: dying }), { judge: judge(), trigger: 't' })).rejects.toThrow('process died');
      const c = await runRerank(h.fork({ runId: RUN1 }), { judge: judge(), trigger: 't' });
      expect(c.state).toBe('ok');
      expect(c.replayed).toBeGreaterThan(0);
      expect(relevant(h.store.snapshot())).toEqual(relevant(ref.afterRun1));
      const ids = matchIds(h.store.snapshot());
      expect(new Set(ids).size).toBe(ids.length);
      // cursor[file] === lineCount(file) for every log file
      for (const cat of ['general', 'tech', 'finance', 'academia'] as const) {
        const file = JSON.parse(h.store.files.get(`ratings/${cat}.json`) ?? '{}') as { cursor: Record<string, number> };
        for (const [path, n] of Object.entries(file.cursor ?? {})) expect((await h.store.readLines(path)).length).toBe(n);
      }
    }
  });

  it('fault at the refinement wave of a later run', async () => {
    const ref = await reference();
    const h = await seeded();
    const r1 = await runRerank(h.fork({ runId: RUN1 }), { judge: judge(), trigger: 't' });
    expect(r1.state).toBe('ok');
    h.clock.advance(7 * MS_PER_HOUR);
    const faulty: CommitFn = async (msg, muts) => {
      if (msg.startsWith(`[wal] run ${RUN2} wave 6:`)) throw new PushRejectedError(msg, 8);
      return commitWithRetry(h.store, msg, muts);
    };
    const b = await runRerank(h.fork({ runId: RUN2, commit: faulty }), { judge: judge(), trigger: 't' });
    expect(b.state).toBe('failed');
    const c = await runRerank(h.fork({ runId: RUN2 }), { judge: judge(), trigger: 't' });
    expect(c.state).toBe('ok');
    expect(relevant(h.store.snapshot())).toEqual(relevant(ref.afterRun2));
  });
});
