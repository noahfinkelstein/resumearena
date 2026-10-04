// Seed synthetic analyzed résumés straight into a store (rows/, cards/, queue/placement/) so rerank can
// be exercised without the LLM pipeline. Shared by the simulation and the engine tests.
import { seedRating, type Card, type CareerStage, type CardsShard, type Category, type PlacementTicket, type RowEntry, type RowsShard } from '@resumearena/shared';
import { createHash } from 'node:crypto';
import type { Store } from '../src/store/store.ts';
import { cardsShardPath, placementTicketPath, rowsShardPath } from '../src/store/paths.ts';

export interface SeedSpec {
  id: string;
  ownerHash: string;
  handle?: string;
  stage?: CareerStage;
  /** Headline rubric score per included category; general is required. */
  scores: Partial<Record<Category, number>> & { general: number };
  queuedAt: string;
  supersedes?: string | null;
  visibility?: 'handle' | 'anonymous';
  primary?: Category;
}

export function minimalCard(stage: CareerStage, headline: string): Card {
  return {
    card_version: '1.0',
    headline,
    top_signal: 'synthetic',
    career_stage: stage,
    years_fulltime: stage === 'student' ? 0 : 4,
    education: [],
    experiences: [],
    projects: [],
    publications_summary: { count_total: 0, first_author_count: 0, top_venue_count: 0, strong_venue_count: 0, venues: [], citation_signal: 'not stated' },
    awards: [],
    leadership: [],
    skills_top: [],
    notable: [],
  };
}

/** Writes the rows/cards entries and a placement ticket; batches many seeds per shard write. */
export async function seedResumes(store: Store, specs: readonly SeedSpec[]): Promise<void> {
  const rowsByShard = new Map<string, RowsShard>();
  const cardsByShard = new Map<string, CardsShard>();
  for (const s of specs) {
    const ab = s.id.slice(0, 2);
    const rows = rowsByShard.get(ab) ?? ((await store.readJson<RowsShard>(rowsShardPath(ab))) ?? {});
    const cards = cardsByShard.get(ab) ?? ((await store.readJson<CardsShard>(cardsShardPath(ab))) ?? {});
    const stage = s.stage ?? 'mid';
    const c: Partial<Record<Category, number>> = {};
    const ss: RowEntry['ss'] = {};
    for (const [cat, score] of Object.entries(s.scores) as [Category, number][]) {
      c[cat] = cat === 'general' ? 1 : 0.8;
      ss[cat] = [score, score, score, score, score, score];
    }
    rows[s.id] = { h: s.handle ?? `h-${s.id}`, v: s.visibility ?? 'anonymous', p: s.primary ?? 'general', st: stage, sig: 'synthetic', s: 'analyzed', c, sc: { ...s.scores }, ss, ch: s.id.repeat(7).slice(0, 64), t: Math.floor(Date.parse(s.queuedAt) / 1000) };
    cards[s.id] = { card: minimalCard(stage, `synthetic ${s.id} seed ${seedRating(s.scores.general)}`), st: stage };
    rowsByShard.set(ab, rows);
    cardsByShard.set(ab, cards);
    const ticket: PlacementTicket = { schema: 1, id: s.id, handle: s.handle ?? `h-${s.id}`, owner_hash: s.ownerHash, primary: s.primary ?? 'general', supersedes: s.supersedes ?? null, queued_at: s.queuedAt };
    await store.writeJson(placementTicketPath(s.id), ticket);
  }
  for (const [ab, rows] of rowsByShard) await store.writeJson(rowsShardPath(ab), rows);
  for (const [ab, cards] of cardsByShard) await store.writeJson(cardsShardPath(ab), cards);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Deterministic 10-char base32 ids from sha256(salt|i): unique in practice and spread across shards. */
export function idFor(i: number, salt = ''): string {
  const digest = createHash('sha256').update(`${salt}|${i}`).digest();
  let out = '';
  for (let k = 0; k < 10; k++) out += ALPHABET[(digest[k] as number) % 32];
  return out;
}

export const ownerFor = (i: number): string => (i.toString(16).padStart(4, '0') + 'f').repeat(13).slice(0, 64);
