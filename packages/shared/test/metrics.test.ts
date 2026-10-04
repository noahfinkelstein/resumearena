import { describe, expect, it } from 'vitest';
import { countWords, emptyRedactions, extractionQualityLabel, pagesForChars, pastedMetrics, withTextCounts } from '../src/metrics.ts';
import { LayoutMetricsZ } from '../src/schemas/data.ts';

describe('metrics', () => {
  it('extraction quality labels at 0.80 / 0.60', () => {
    expect(extractionQualityLabel(1)).toBe('good');
    expect(extractionQualityLabel(0.8)).toBe('good');
    expect(extractionQualityLabel(0.79)).toBe('fair');
    expect(extractionQualityLabel(0.6)).toBe('fair');
    expect(extractionQualityLabel(0.59)).toBe('poor');
    expect(extractionQualityLabel(0)).toBe('poor');
  });
  it('pastedMetrics', () => {
    const text = 'word '.repeat(700).trim();
    const m = pastedMetrics(text);
    expect(m).toEqual({ source: 'paste', pages: 2, columns_detected: 0, font_count: 0, image_count: 0, char_count: 3499, word_count: 700, extraction_quality: 1, redactions: emptyRedactions() });
    expect(LayoutMetricsZ.parse(m)).toEqual(m);
    expect(pastedMetrics('').pages).toBe(0);
    expect(pastedMetrics('x', { ...emptyRedactions(), email: 2 }).redactions.email).toBe(2);
    expect(pagesForChars(3000)).toBe(1);
    expect(pagesForChars(3001)).toBe(2);
    expect(countWords('  a\tb\n\nc ')).toBe(3);
  });
  it('withTextCounts keeps pdf pages and recounts the rest', () => {
    const pdf = { ...pastedMetrics('x'), source: 'pdf' as const, pages: 3 };
    expect(withTextCounts(pdf, 'one two three').pages).toBe(3);
    expect(withTextCounts(pdf, 'one two three').word_count).toBe(3);
    expect(withTextCounts({ ...pdf, source: 'docx' }, 'x'.repeat(6001)).pages).toBe(3);
  });
});
