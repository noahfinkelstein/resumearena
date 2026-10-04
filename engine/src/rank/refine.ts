// Refinement (§9.4 step 7, §6.2): priority, weighted sampling, and the 70/20/10 local/crosscheck/anchor mix.
import { glickoConstantsFrom, priority, type Category, type RatingRow, type Settings } from '@resumearena/shared';
import { daysBetween, hoursBetween, parseIso } from '../clock.ts';
import type { MatchRequest } from '../llm/judge.ts';
import type { Rng } from '../rng.ts';
import { nearestAnchor } from './anchors.ts';
import { pairKey, pickOpponent, type PairingContext } from './pairing.ts';
import type { CardLookup, EngineState } from './state.ts';

export interface RefineCandidate {
  cat: Category;
  row: RatingRow;
  priority: number;
}

export const isRefineCandidate = (row: RatingRow, settings: Settings, now: Date): boolean => {
  if (!(row.elig && row.placed && !row.locked && row.kind === 'user' && row.r !== null)) return false;
  const cooledDown = row.last === null || hoursBetween(parseIso(row.last), now) >= settings.rating.refine_cooldown_hours;
  return cooledDown || row.mv > 60;
};

/** Candidates across categories with their priority; `pct` comes from the engine's own rank/top (1 = top). */
export function refinementCandidates(state: EngineState, now: Date, rng: Rng, totals: Record<Category, number>): RefineCandidate[] {
  const consts = glickoConstantsFrom(state.settings.rating);
  const out: RefineCandidate[] = [];
  for (const cat of ['general', 'finance', 'tech', 'academia'] as const) {
    for (const row of state.cats[cat].rows.values()) {
      if (!isRefineCandidate(row, state.settings, now)) continue;
      const n = totals[cat];
      const pct = row.rank === null || n <= 1 ? null : 1 - (row.rank - 1) / (n - 1);
      out.push({
        cat,
        row,
        priority: priority(
          { rd: row.rd, daysSinceLast: row.last ? daysBetween(parseIso(row.last), now) : 45, pct, moved: row.mv > 60, jitter: rng.next() },
          state.settings.rating.priority_weights,
          consts,
        ),
      });
    }
  }
  return out;
}

/** Top 3 × allowance by priority, then `allowance` of them sampled by −ln(u)/priority ascending. */
export function sampleRefinement(cands: RefineCandidate[], allowance: number, rng: Rng): RefineCandidate[] {
  const top = [...cands].sort((x, y) => y.priority - x.priority || (x.row.id < y.row.id ? -1 : 1)).slice(0, 3 * allowance);
  const keyed = top.map((c) => ({ c, key: -Math.log(Math.max(rng.next(), 1e-12)) / Math.max(c.priority, 1e-9) }));
  keyed.sort((x, y) => x.key - y.key);
  return keyed.slice(0, allowance).map((k) => k.c);
}

export async function planRefinement(state: EngineState, ctx: PairingContext, row: RatingRow, cards: CardLookup, busy: Set<string>, now: Date): Promise<MatchRequest | null> {
  if (row.r === null) return null;
  const mix = state.settings.rating.opponent_mix;
  const roll = ctx.rng.next();
  const subjCard = await cards(ctx.cat, row.id);
  if (!subjCard) return null;
  const exclude = new Set(busy);
  let opp: RatingRow | null = null;
  let kind: MatchRequest['kind'] = 'refine';

  const local = (): RatingRow | null => pickOpponent(ctx, { subject: row, target: row.r as number, window: Math.max(80, 1.5 * row.rd), requirePlaced: true, exclude });

  if (roll < mix.local) opp = local();
  else if (roll < mix.local + mix.crosscheck) {
    const delta = 150 + ctx.rng.next() * 250;
    const sign = ctx.rng.next() < 0.5 ? -1 : 1;
    kind = 'crosscheck';
    opp = pickOpponent(ctx, { subject: row, target: row.r + sign * delta, window: 60, requirePlaced: true, exclude });
  } else {
    const recentAnchors = new Set<string>();
    const doc = state.history.peek(ctx.cat, row.id);
    for (const m of doc?.recent ?? []) if (m.opp.startsWith('anchr') && daysBetween(parseIso(m.at), now) < 30) recentAnchors.add(m.opp);
    const anchor = nearestAnchor(ctx.anchors, row.r, recentAnchors);
    const anchorRow = anchor ? ctx.rows.get(anchor.id) : undefined;
    if (anchorRow && anchorRow.r !== null) {
      kind = 'anchor';
      opp = anchorRow;
    } else {
      kind = 'refine';
      opp = local();
    }
  }
  if (!opp || opp.r === null) return null;
  const oppCard = await cards(ctx.cat, opp.id);
  if (!oppCard) return null;
  ctx.pendingPairs.add(pairKey(row.id, opp.id));
  const [a, b] = row.id < opp.id ? [row, opp] : [opp, row];
  const id = `${row.id}`;
  return {
    cat: ctx.cat,
    kind,
    period: id, // replaced by the match id once assigned (see wal.buildMatchLine)
    subj: row.id,
    a: a.id,
    b: b.id,
    cardA: a.id === row.id ? subjCard.card : oppCard.card,
    cardB: b.id === row.id ? subjCard.card : oppCard.card,
    pre: { ar: a.r as number, ard: a.rd, br: b.r as number, brd: b.rd },
  };
}
