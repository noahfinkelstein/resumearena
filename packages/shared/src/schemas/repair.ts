// Repair primitives for the Zod mirrors (§5.4): clamps, word-boundary truncation and array caps.
// Every repair increments a counter that parse* functions report next to the value. The counter is a
// module variable because Zod parsing is synchronous, so no two parses can interleave.
import { z } from 'zod';

let repairs = 0;

export function noteRepair(): void {
  repairs++;
}

/** Run a synchronous parse and report how many repairs it made; nested use restores the outer count. */
export function countRepairs<T>(fn: () => T): { value: T; repairs: number } {
  const outer = repairs;
  repairs = 0;
  try {
    const value = fn();
    return { value, repairs };
  } finally {
    repairs = outer;
  }
}

/** Cut at the last whitespace before `max` when that keeps at least half the budget; strip dangling punctuation. */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max + 1);
  const lastSpace = window.search(/\s\S*$/);
  let cut = lastSpace >= Math.floor(max / 2) ? s.slice(0, lastSpace) : s.slice(0, max);
  cut = cut.replace(/[\s,;:(\-–—/]+$/, '');
  return cut.length > 0 ? cut : s.slice(0, max).trimEnd();
}

export const score100 = () =>
  z.number().transform((n) => {
    const c = Math.min(100, Math.max(0, Math.round(n)));
    if (c !== n) noteRepair();
    return c;
  });

export const unit = () =>
  z.number().transform((n) => {
    const c = Math.min(1, Math.max(0, n));
    if (c !== n) noteRepair();
    return c;
  });

export const clampedNumber = (lo: number, hi: number) =>
  z.number().transform((n) => {
    const c = Math.min(hi, Math.max(lo, n));
    if (c !== n) noteRepair();
    return c;
  });

export const cappedString = (max: number) =>
  z.string().transform((s) => {
    const t = truncateAtWord(s, max);
    if (t !== s) noteRepair();
    return t;
  });

export const cappedArray = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).transform((a) => {
    if (a.length > max) {
      noteRepair();
      return a.slice(0, max);
    }
    return a;
  });

export type ParseResult<T> = { ok: true; value: T; repairs: number } | { ok: false; error: z.ZodError; message: string };

/** safeParse with the repair count; `message` is the flattened Zod error for a retry's validation_note. */
export function parseWithRepairs<S extends z.ZodType>(schema: S, input: unknown): ParseResult<z.output<S>> {
  const { value, repairs: n } = countRepairs(() => schema.safeParse(input));
  if (value.success) return { ok: true, value: value.data as z.output<S>, repairs: n };
  return { ok: false, error: value.error, message: z.prettifyError(value.error) };
}
