// All time goes through here. RA_NOW freezes the clock; the simulation advances it by hand.

export interface Clock {
  now(): Date;
  /** ISO-8601 UTC without milliseconds, the on-disk timestamp format. */
  iso(): string;
  /** YYYY-MM-DD (UTC). */
  day(): string;
  /** YYYY-MM (UTC). */
  month(): string;
  /** Milliseconds since the clock was created (wall-clock budget checks). */
  elapsedMs(): number;
}

export interface MutableClock extends Clock {
  set(d: Date | string): void;
  advance(ms: number): void;
}

export const isoOf = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);

export function parseIso(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp "${s}"`);
  return d;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)));
}

export const hoursBetween = (a: Date, b: Date): number => Math.abs(b.getTime() - a.getTime()) / 3_600_000;
export const daysBetween = (a: Date, b: Date): number => Math.abs(b.getTime() - a.getTime()) / 86_400_000;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * A frozen clock when `frozen` is given (RA_NOW), otherwise a clock that advances with wall time.
 * Both expose `set`/`advance`, which only the simulation and tests use.
 */
export function createClock(frozen?: string | Date | null): MutableClock {
  const start = Date.now();
  let offset = 0;
  let fixed: Date | null = frozen ? (typeof frozen === 'string' ? parseIso(frozen) : new Date(frozen.getTime())) : null;
  const now = (): Date => (fixed ? new Date(fixed.getTime() + offset) : new Date(Date.now() + offset));
  return {
    now,
    iso: () => isoOf(now()),
    day: () => dayOf(now()),
    month: () => monthOf(now()),
    // Wall time of this process, never the simulated offset: the soft wall clock guards runner minutes.
    elapsedMs: () => Date.now() - start,
    set(d) {
      fixed = typeof d === 'string' ? parseIso(d) : new Date(d.getTime());
      offset = 0;
    },
    advance(ms) {
      offset += ms;
    },
  };
}
