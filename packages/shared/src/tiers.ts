// Tiers (§6.4). Code is the source of truth; build-indexes publishes TIERS into Pages settings.json.
import type { Tier, TierKey } from './types.ts';

/** Stands in for −∞ on the lowest tier so the table survives JSON. No rating can get near it. */
export const TIER_FLOOR = -1e9;

export const TIERS: readonly Tier[] = [
  { key: 'entrant', label: 'Entrant', numeral: 'I', min: TIER_FLOOR, blurb: 'Below 1200. Where most placements start.' },
  { key: 'contender', label: 'Contender', numeral: 'II', min: 1200, blurb: '1200–1399. Preferred by the judge more often than not.' },
  { key: 'challenger', label: 'Challenger', numeral: 'III', min: 1400, blurb: '1400–1599. Consistently preferred by the judge.' },
  { key: 'candidate', label: 'Candidate', numeral: 'IV', min: 1600, blurb: '1600–1799. Above anything the rubric alone can award.' },
  { key: 'expert', label: 'Expert', numeral: 'V', min: 1800, blurb: '1800–1999. Wins against strong fields.' },
  { key: 'master', label: 'Master', numeral: 'VI', min: 2000, blurb: '2000–2199. Beats records a recruiter would mention unprompted.' },
  { key: 'grandmaster', label: 'Grandmaster', numeral: 'VII', min: 2200, blurb: '2200–2399. Rarely loses to anyone outside this tier.' },
  { key: 'laureate', label: 'Laureate', numeral: 'VIII', min: 2400, blurb: '2400 and above. Seldom more than a few dozen at a time.' },
];

export const PROVISIONAL_BLURB = 'Not yet placed. The rating is a guess until placement finishes.';

export const TIER_BY_KEY: Readonly<Record<TierKey, Tier>> = Object.fromEntries(TIERS.map((t) => [t.key, t])) as Record<TierKey, Tier>;

/** Tier of a rating after rounding to the displayed integer; 1199.5 therefore reads as Contender. */
export function tierFor(rating: number, tiers: readonly Tier[] = TIERS): TierKey {
  const r = Math.round(rating);
  let found: TierKey = tiers[0]?.key ?? 'entrant';
  for (const t of tiers) if (r >= t.min) found = t.key;
  return found;
}

export function tierOf(rating: number, tiers: readonly Tier[] = TIERS): Tier {
  const key = tierFor(rating, tiers);
  return tiers.find((t) => t.key === key) ?? (tiers[0] as Tier);
}

/** Provisional is purely "placement unfinished" (D-53); RD is shown as ± instead. */
export const isProvisional = (placed: boolean | 0 | 1): boolean => !placed;
