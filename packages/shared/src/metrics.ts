// LayoutMetrics helpers (D-13). The numbers travel to the analysis; the file never does.
import type { LayoutMetrics, RedactionKind } from './types.ts';
import { CHARS_PER_PAGE } from './constants.ts';

export type ExtractionQualityLabel = 'good' | 'fair' | 'poor';

/** SPA display thresholds: ≥ 0.80 good, ≥ 0.60 fair, else poor. 0 means "not measurable" and reads as poor. */
export function extractionQualityLabel(q: number): ExtractionQualityLabel {
  if (q >= 0.8) return 'good';
  if (q >= 0.6) return 'fair';
  return 'poor';
}

export function emptyRedactions(): Record<RedactionKind, number> {
  return { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 };
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** docx/paste have no page count; `ceil(char_count / 3000)` with a floor of 1 page for non-empty text. */
export function pagesForChars(charCount: number): number {
  return charCount <= 0 ? 0 : Math.ceil(charCount / CHARS_PER_PAGE);
}

/** Metrics for pasted text: nothing about layout is measurable, extraction is perfect by definition. */
export function pastedMetrics(text: string, redactions: Record<RedactionKind, number> = emptyRedactions()): LayoutMetrics {
  const charCount = text.length;
  return {
    source: 'paste',
    pages: pagesForChars(charCount),
    columns_detected: 0,
    font_count: 0,
    image_count: 0,
    char_count: charCount,
    word_count: countWords(text),
    extraction_quality: 1,
    redactions: { ...redactions },
  };
}

/** The user edits the text after extraction; counts must follow the text that is actually sent. */
export function withTextCounts(metrics: LayoutMetrics, text: string): LayoutMetrics {
  const charCount = text.length;
  const pages = metrics.source === 'pdf' ? metrics.pages : pagesForChars(charCount);
  return { ...metrics, pages, char_count: charCount, word_count: countWords(text), redactions: { ...metrics.redactions } };
}
