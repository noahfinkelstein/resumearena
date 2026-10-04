// Placement planning (§6.2, §9.4 step 6): one round per subject per wave; general in waves 1–3, domains
// in waves 4–5; game 2 of round 1 is the anchor nearest the rating when an anchors file exists.
import { placementOffsets, placementWindow, type Category, type RatingRow } from '@resumearena/shared';
import type { MatchRequest } from '../llm/judge.ts';
import { nearestAnchor } from './anchors.ts';
import { pairKey, pickOpponent, type PairingContext } from './pairing.ts';
import { matchKindFor, roundsSpecFor, type CardLookup, type EngineState } from './state.ts';

export const isPlacementCandidate = (row: RatingRow): boolean => row.kind === 'user' && row.elig && !row.placed && row.round >= 0 && row.r !== null;

export const periodKey = (subj: string, cat: Category, round: number): string => `${subj}:${cat}:r${round}`;

export const GENERAL_WAVES = 3;

/** Which categories a wave serves: general rounds first, then every domain. */
export function categoriesForWave(wave: number): Category[] {
  return wave <= GENERAL_WAVES ? ['general'] : ['finance', 'tech', 'academia'];
}

export async function planPlacementRound(state: EngineState, ctx: PairingContext, subject: RatingRow, cards: CardLookup): Promise<MatchRequest[]> {
  const spec = roundsSpecFor(state.settings, ctx.cat, subject);
  const games = spec[subject.round];
  if (!games || subject.r === null) return [];
  const subjCard = await cards(ctx.cat, subject.id);
  if (!subjCard) return [];
  const r = subject.r;
  const rd = subject.rd;
  const targets = placementOffsets(games, rd).map((o) => r + o);
  const window = placementWindow(rd);
  // Never meet the same opponent twice inside one placement, even once the 10-slot opp ring has rolled over.
  const chosen = new Set<string>(state.placementOpps.get(`${ctx.cat}:${subject.id}`) ?? []);
  const out: MatchRequest[] = [];
  const kind = matchKindFor(subject);
  const period = periodKey(subject.id, ctx.cat, subject.round);

  for (let i = 0; i < targets.length; i++) {
    let opp: RatingRow | null = null;
    if (subject.round === 0 && i === 1 && ctx.anchors.length) {
      const anchor = nearestAnchor(ctx.anchors, r, new Set([...subject.opp, ...chosen]));
      // The anchor slot never falls back to an anchor already met: the ordinary pick below handles that.
      opp = anchor ? (ctx.rows.get(anchor.id) ?? null) : null;
    }
    opp ??= pickOpponent(ctx, { subject, target: targets[i] as number, window, requirePlaced: true, exclude: chosen });
    if (!opp || opp.r === null) continue;
    const oppCard = await cards(ctx.cat, opp.id);
    if (!oppCard) continue;
    chosen.add(opp.id);
    ctx.pendingPairs.add(pairKey(subject.id, opp.id));
    const [a, b] = subject.id < opp.id ? [subject, opp] : [opp, subject];
    out.push({
      cat: ctx.cat,
      kind,
      period,
      subj: subject.id,
      a: a.id,
      b: b.id,
      cardA: a.id === subject.id ? subjCard.card : oppCard.card,
      cardB: b.id === subject.id ? subjCard.card : oppCard.card,
      pre: { ar: a.r as number, ard: a.rd, br: b.r as number, brd: b.rd },
    });
  }
  return out;
}
