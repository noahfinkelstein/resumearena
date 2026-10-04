// The write-ahead log (D-03): matches/<cat>/<YYYY-MM>[.N].jsonl, 8 MB rollover, per-file cursors, replay.
import { MatchLineZ, type Category, type MatchLine } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { matchesDir } from '../store/paths.ts';
import { sha256Hex } from '../rng.ts';
import type { MatchRequest, MatchResult } from '../llm/judge.ts';
import { applyLines } from './fold.ts';
import type { EngineState } from './state.ts';

export const WAL_ROLLOVER_BYTES = 8 * 1024 * 1024;

export const matchId = (run: string, wave: number, seq: number): string => sha256Hex(`${run}|${wave}|${seq}`).slice(0, 16);

export function buildMatchLine(req: MatchRequest, res: Extract<MatchResult, { ok: true }>, meta: { run: string; wave: number; seq: number; at: string; pv: string }): MatchLine {
  const id = matchId(meta.run, meta.wave, meta.seq);
  const isPeriod = req.kind === 'placement' || req.kind === 'revision';
  return {
    v: 1, id, run: meta.run, wave: meta.wave, seq: meta.seq, at: meta.at,
    cat: req.cat, kind: req.kind, period: isPeriod ? req.period : id, subj: req.subj,
    a: req.a, b: req.b, pre: req.pre, p1: res.p1, p2: res.p2, o: res.o, agree: res.agree,
    model: res.model, pv: meta.pv, tok: res.tok, usd: res.usd,
  };
}

/** `2026-10.jsonl` < `2026-10.1.jsonl` < `2026-10.2.jsonl` < `2026-11.jsonl`. */
export function walFileOrder(a: string, b: string): number {
  const parse = (f: string): [string, number] => {
    const m = /^(\d{4}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(f.split('/').pop() ?? f);
    return [m?.[1] ?? f, m?.[2] ? Number(m[2]) : 0];
  };
  const [ma, na] = parse(a);
  const [mb, nb] = parse(b);
  return ma < mb ? -1 : ma > mb ? 1 : na - nb;
}

export async function listWalFiles(store: Store, cat: Category): Promise<string[]> {
  const dir = matchesDir(cat);
  await store.materialize([dir]);
  const names = (await store.list(dir)).filter((n) => /^\d{4}-\d{2}(?:\.\d+)?\.jsonl$/.test(n));
  return names.map((n) => `${dir}${n}`).sort(walFileOrder);
}

/** The file this month's lines go to: the newest part for the month, or the next part once it passes 8 MB. */
export async function currentWalFile(store: Store, cat: Category, month: string): Promise<string> {
  const files = (await listWalFiles(store, cat)).filter((f) => f.includes(`/${month}`));
  const newest = files[files.length - 1];
  if (!newest) return `${matchesDir(cat)}${month}.jsonl`;
  if ((await store.size(newest)) < WAL_ROLLOVER_BYTES) return newest;
  const m = /\.(\d+)\.jsonl$/.exec(newest);
  const next = m ? Number(m[1]) + 1 : 1;
  return `${matchesDir(cat)}${month}.${next}.jsonl`;
}

export function parseMatchLines(lines: readonly string[], file: string): MatchLine[] {
  const out: MatchLine[] = [];
  for (const [i, l] of lines.entries()) {
    if (!l.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      throw new Error(`${file}:${i + 1}: unparsable WAL line`);
    }
    const r = MatchLineZ.safeParse(raw);
    if (!r.success) throw new Error(`${file}:${i + 1}: malformed WAL line (${r.error.issues[0]?.path.join('.')})`);
    out.push(r.data as MatchLine);
  }
  return out;
}

export interface ReplayReport {
  applied: number;
  /** Highest wave number written by this run id already in the log (a restarted run continues after it). */
  ownMaxWave: number;
  ownIds: Set<string>;
}

/** §9.4 step 2: apply every line beyond the cursors, skipping duplicate ids within the replayed window. */
export async function replayWal(state: EngineState, store: Store): Promise<ReplayReport> {
  let applied = 0;
  let ownMaxWave = 0;
  const ownIds = new Set<string>();
  for (const cat of ['general', 'finance', 'tech', 'academia'] as const) {
    const cs = state.cats[cat];
    const files = await listWalFiles(store, cat);
    const cursorKeys = Object.keys(cs.cursor).sort(walFileOrder);
    const oldest = cursorKeys[0];
    const seen = new Set<string>();
    for (const file of files) {
      if (oldest && walFileOrder(file, oldest) < 0) continue;
      const from = cs.cursor[file] ?? 0;
      const all = await store.readLines(file);
      // A restarted run continues its wave numbering after what it already logged, applied or not.
      const ownMarker = `"run":${JSON.stringify(state.runId)}`;
      for (const l of all) {
        if (!l.includes(ownMarker)) continue;
        const parsed = JSON.parse(l) as MatchLine;
        if (parsed.run !== state.runId) continue;
        ownMaxWave = Math.max(ownMaxWave, parsed.wave);
        ownIds.add(parsed.id);
      }
      const raw = all.slice(from);
      if (raw.length === 0) continue;
      const lines = parseMatchLines(raw, file).filter((l) => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
      applied += await applyLines(state, lines);
      cs.cursor[file] = from + raw.length;
    }
  }
  return { applied, ownMaxWave, ownIds };
}

/** Lines dated at or after `sinceIso` for one category (drift and judge health read the last 7 days). */
export async function readLinesSince(store: Store, cat: Category, sinceIso: string): Promise<MatchLine[]> {
  const sinceMonth = sinceIso.slice(0, 7);
  const out: MatchLine[] = [];
  for (const file of await listWalFiles(store, cat)) {
    const month = /(\d{4}-\d{2})/.exec(file)?.[1] ?? '';
    if (month < sinceMonth) continue;
    for (const l of parseMatchLines(await store.readLines(file), file)) if (l.at >= sinceIso) out.push(l);
  }
  return out;
}

export async function countAllLines(store: Store): Promise<number> {
  let n = 0;
  for (const cat of ['general', 'finance', 'tech', 'academia'] as const) for (const file of await listWalFiles(store, cat)) n += (await store.readLines(file)).length;
  return n;
}
