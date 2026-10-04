// Formatting rules (product-ux.md §5.2–§5.3). `Num` is the only component that renders numbers; these
// are the pure functions behind it and behind copy interpolations.
import type { CareerStage, Category } from '@resumearena/shared';

const MINUS = '−';
const THIN = ' ';

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const fmtRating = (r: number): string => String(Math.round(r));
export const fmtRd = (rd: number): string => `±${Math.round(rd)}`;
export const fmtRatingWithRd = (r: number, pm: number): string => `${fmtRating(r)}${THIN}${fmtRd(pm)}`;
export const fmtRank = (rank: number): string => `#${fmtInt(rank)}`;

export function fmtDelta(d: number): string {
  const v = Math.round(d);
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : `${MINUS}${Math.abs(v)}`;
}

export const deltaClass = (d: number): 'win' | 'loss' | 'draw' => (Math.round(d) > 0 ? 'win' : Math.round(d) < 0 ? 'loss' : 'draw');

export const fmtRecord = (w: number, l: number, d: number): string => `${w}-${l}-${d}`;

/** `top` is rank / total (small = better). Floors at 0.1 %; never divides. */
export function fmtTopPct(top: number, opts: { own?: boolean } = {}): string {
  const pct = Math.max(top * 100, 0.1);
  if (pct > 50 && opts.own) return `bottom ${Math.round(100 - pct)}%`;
  if (pct < 10) return `top ${(Math.floor(pct * 10) / 10).toFixed(1)}%`;
  return `top ${Math.round(pct)}%`;
}

export const fmtPct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return fmtInt(n);
}

export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

export function fmtFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 24-hour clock in the viewer's zone, no seconds. */
export function fmtClock(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtClockUtc(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function fmtDateTimeUtc(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${fmtClockUtc(d)}`;
}

/** Relative under 7 days (`2 h ago`, `yesterday`, `4 d ago`), else the absolute date. */
export function fmtRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} d ago`;
  return fmtDate(iso);
}

/** `updated just now` under 45 s, `updated 4 min ago` under 60 min, `updated 2 h ago` under 24 h, else absolute UTC. */
export function fmtUpdatedAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'updated —';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'updated just now';
  if (s < 3600) return `updated ${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `updated ${Math.round(s / 3600)} h ago`;
  return `updated ${fmtDateTimeUtc(iso)}`;
}

/** `0:42`, `12:05`, `1:02:09`. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const fmtRange = (a: number, b: number): string => `${a}–${b}`;

export const STAGE_LABEL: Record<CareerStage, string> = {
  student: 'student',
  new_grad: 'new grad',
  early: 'early',
  mid: 'mid',
  senior: 'senior',
  executive: 'exec',
};

export const STAGE_LONG: Record<CareerStage, string> = {
  student: 'student',
  new_grad: 'new grad',
  early: 'early career',
  mid: 'mid career',
  senior: 'senior',
  executive: 'executive',
};

export const CATEGORY_LABEL: Record<Category, string> = { general: 'General', finance: 'Finance', tech: 'Tech', academia: 'Academia' };

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Middle-truncate for the redaction panel (28 chars). */
export function middleTruncate(s: string, max = 28): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export function truncateEllipsis(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);
