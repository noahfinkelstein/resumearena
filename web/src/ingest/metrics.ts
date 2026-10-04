// Pure layout analysis for PDF text items: columns, lines, reading order and the extraction-quality
// number (D-13). No pdfjs types here so the functions are testable with synthetic runs.
//
// Columns are detected on the raw runs before any line grouping, because a two-column résumé usually
// shares baselines across columns and grouping by y first would glue the columns together.
import { countWords, emptyRedactions, type LayoutMetrics, type RedactionKind } from '@resumearena/shared';

export interface TextRun {
  str: string;
  /** Left edge in page units (pdf user space, origin bottom-left). */
  x: number;
  /** Baseline. */
  y: number;
  w: number;
  h: number;
  font: string;
}

export interface PageRuns {
  width: number;
  height: number;
  runs: TextRun[];
}

export interface Line {
  y: number;
  x0: number;
  x1: number;
  text: string;
  /** Column index, or 'span' for a line that crosses a column boundary (headers, rules). */
  col: number | 'span';
}

const BINS = 48;

/**
 * Column boundaries from a coverage histogram over runs: a gutter is a run of near-empty bins in the
 * middle 60 % of the text width with a real share of runs entirely on each side.
 */
export function detectColumns(runs: readonly TextRun[]): { columns: 1 | 2 | 3; boundaries: number[] } {
  const body = runs.filter((r) => r.str.trim().length > 0 && r.w > 0);
  if (body.length < 16) return { columns: 1, boundaries: [] };
  const minX = Math.min(...body.map((r) => r.x));
  const maxX = Math.max(...body.map((r) => r.x + r.w));
  const width = maxX - minX;
  if (!(width > 0)) return { columns: 1, boundaries: [] };
  const cover = new Array<number>(BINS).fill(0);
  for (const r of body) {
    const b0 = Math.max(0, Math.floor(((r.x - minX) / width) * BINS));
    const b1 = Math.min(BINS - 1, Math.ceil(((r.x + r.w - minX) / width) * BINS) - 1);
    for (let b = b0; b <= b1; b++) cover[b] = (cover[b] ?? 0) + 1;
  }
  // A spanning header run covers every bin once; allow a few of those per gutter.
  const empty = Math.max(2, body.length * 0.04);
  const lo = Math.floor(BINS * 0.2);
  const hi = Math.ceil(BINS * 0.8);
  const candidates: number[] = [];
  let run = 0;
  for (let b = lo; b <= hi + 1; b++) {
    const c = b <= hi ? (cover[b] ?? 0) : Number.POSITIVE_INFINITY;
    if (c <= empty) run++;
    else {
      if (run >= 2) candidates.push(minX + ((b - run / 2) / BINS) * width);
      run = 0;
    }
  }
  const confirmed = candidates.filter((x) => {
    const left = body.filter((r) => r.x + r.w <= x).length;
    const right = body.filter((r) => r.x >= x).length;
    return left >= body.length * 0.2 && right >= body.length * 0.2;
  });
  const boundaries = confirmed.slice(0, 2);
  return { columns: (boundaries.length + 1) as 1 | 2 | 3, boundaries };
}

const colOf = (r: TextRun, boundaries: readonly number[]): number | 'span' => {
  for (const b of boundaries) if (r.x < b - 2 && r.x + r.w > b + 2) return 'span';
  let i = 0;
  for (const b of boundaries) if (r.x >= b) i++;
  return i;
};

/** Group runs into lines by baseline (tolerance half the median run height), per column, left to right. */
export function linesOf(runs: readonly TextRun[], boundaries: readonly number[] = []): Line[] {
  const items = runs.filter((r) => r.str.length > 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
  if (items.length === 0) return [];
  const heights = items.map((r) => r.h).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 10;
  const tol = Math.max(1, medianH * 0.5);
  const groups = new Map<number | 'span', TextRun[]>();
  for (const r of items) {
    const c = colOf(r, boundaries);
    const g = groups.get(c) ?? [];
    g.push(r);
    groups.set(c, g);
  }
  const lines: Line[] = [];
  for (const [col, members] of groups) {
    const sorted = [...members].sort((a, b) => b.y - a.y || a.x - b.x);
    const buckets: { y: number; runs: TextRun[] }[] = [];
    for (const r of sorted) {
      const last = buckets[buckets.length - 1];
      if (last && Math.abs(last.y - r.y) <= tol) {
        last.runs.push(r);
        // Running mean keeps a slanted baseline from drifting the whole group.
        last.y = (last.y * (last.runs.length - 1) + r.y) / last.runs.length;
      } else buckets.push({ y: r.y, runs: [r] });
    }
    for (const b of buckets) {
      const rs = [...b.runs].sort((a, c) => a.x - c.x);
      let text = '';
      let prevEnd: number | null = null;
      for (const r of rs) {
        if (prevEnd !== null) {
          const gap = r.x - prevEnd;
          if (gap > Math.max(1, r.h * 0.2) && !text.endsWith(' ') && !r.str.startsWith(' ')) text += ' ';
        }
        text += r.str;
        prevEnd = r.x + r.w;
      }
      lines.push({ y: b.y, x0: rs[0]?.x ?? 0, x1: Math.max(...rs.map((r) => r.x + r.w)), text: text.replace(/\s+$/, ''), col });
    }
  }
  return lines.sort((a, b) => b.y - a.y || (a.col === 'span' ? -1 : b.col === 'span' ? 1 : (a.col as number) - (b.col as number)) || a.x0 - b.x0);
}

/**
 * Reading order: spanning lines (headers, section rules) flush the column buffers and print in place;
 * everything else collects per column and prints column by column.
 */
export function readingOrder(lines: readonly Line[], columns = 1): string {
  if (columns <= 1) return lines.map((l) => l.text).join('\n');
  const out: string[] = [];
  const cols: string[][] = Array.from({ length: columns }, () => []);
  const flush = (): void => {
    for (const c of cols) {
      if (c.length) out.push(...c, '');
      c.length = 0;
    }
  };
  for (const l of lines) {
    if (l.col === 'span') {
      flush();
      out.push(l.text);
    } else (cols[Math.min(l.col, columns - 1)] ?? cols[0])?.push(l.text);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface PageResult {
  text: string;
  columns: 1 | 2 | 3;
  fonts: Set<string>;
}

export function pageText(page: PageRuns): PageResult {
  const { columns, boundaries } = detectColumns(page.runs);
  const lines = linesOf(page.runs, boundaries);
  const fonts = new Set(page.runs.map((r) => r.font).filter(Boolean));
  return { text: readingOrder(lines, columns), columns, fonts };
}

export interface QualityInput {
  chars: number;
  pages: number;
  replacementChars: number;
  columns: number;
  source: 'pdf' | 'docx';
  warnings?: number;
}

/**
 * 0 = not measurable (scanned: under 300 chars a page, or > 2 % replacement characters);
 * pdf 0.95, minus 0.25 when columns had to be re-ordered; docx 0.95, 0.7 with mammoth warnings.
 */
export function extractionQuality(q: QualityInput): number {
  if (q.source === 'docx') return q.chars === 0 ? 0 : q.warnings && q.warnings > 0 ? 0.7 : 0.95;
  if (q.pages <= 0 || q.chars / q.pages < 300) return 0;
  if (q.chars > 0 && q.replacementChars / q.chars > 0.02) return 0;
  let v = 0.95;
  if (q.columns >= 2) v -= 0.25;
  return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
}

export function countReplacementChars(text: string): number {
  return (text.match(/�/g) ?? []).length;
}

export interface BuildMetricsInput {
  source: 'pdf' | 'docx';
  text: string;
  pages: number;
  columns: 0 | 1 | 2 | 3;
  fonts: number;
  images: number;
  warnings?: number;
  redactions?: Record<RedactionKind, number>;
}

export function buildMetrics(i: BuildMetricsInput): LayoutMetrics {
  const chars = i.text.length;
  const quality = extractionQuality({ chars, pages: i.pages, replacementChars: countReplacementChars(i.text), columns: i.columns, source: i.source, ...(i.warnings !== undefined ? { warnings: i.warnings } : {}) });
  return {
    source: i.source,
    pages: i.source === 'pdf' ? i.pages : Math.max(1, Math.ceil(chars / 3000)),
    columns_detected: i.columns,
    font_count: i.fonts,
    image_count: i.images,
    char_count: chars,
    word_count: countWords(i.text),
    extraction_quality: quality,
    redactions: i.redactions ?? emptyRedactions(),
  };
}

/** Collapse the whitespace noise extraction leaves behind without touching the words. */
export function tidyText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
