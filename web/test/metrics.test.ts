import { describe, expect, it } from 'vitest';
import { pastedMetrics } from '@resumearena/shared';
import { buildMetrics, detectColumns, extractionQuality, linesOf, pageText, readingOrder, tidyText, type TextRun } from '../src/ingest/metrics.ts';
import { metricsLineText } from '../src/components/upload/Upload.tsx';

/** Lay words out as pdf text runs: one run per word, 6 pt per character, 11 pt line height. */
function column(lines: string[], x: number, topY: number, font = 'F1'): TextRun[] {
  const runs: TextRun[] = [];
  lines.forEach((line, i) => {
    let cx = x;
    for (const word of line.split(' ')) {
      const w = word.length * 6;
      runs.push({ str: word, x: cx, y: topY - i * 11, w, h: 10, font });
      cx += w + 4;
    }
  });
  return runs;
}

const LEFT = ['Experience and roles', 'Senior engineer at Acme', 'Led a migration of a service', 'Cut latency by a third', 'Engineer at Northwind', 'Built a pipeline for data', 'Education and schools', 'BS Computer Science 2020', 'Dean list three years', 'Skills Go Rust Kubernetes', 'Terraform Postgres Kafka', 'Observability and planning'];
const RIGHT = ['Summary of work', 'Infrastructure engineer six', 'years building services', 'Projects and side work', 'Open source HTTP framework', 'Four thousand stars', 'Awards and honours', 'Hackathon winner 2019', 'Scholarship recipient', 'Languages English Hindi', 'Interests cycling chess', 'References on request'];

describe('lines and columns', () => {
  it('groups runs into lines left to right with spaces', () => {
    const lines = linesOf(column(['Hello wide world', 'Second line'], 50, 700));
    expect(lines.map((l) => l.text)).toEqual(['Hello wide world', 'Second line']);
    expect(lines[0]!.y).toBeGreaterThan(lines[1]!.y);
  });

  it('detects a single column', () => {
    expect(detectColumns(column(LEFT, 50, 700))).toEqual({ columns: 1, boundaries: [] });
  });

  it('detects two columns with shared baselines and reads them column by column, with a spanning header first', () => {
    const header: TextRun[] = [{ str: '[name] senior infrastructure engineer resume header line', x: 50, y: 720, w: 420, h: 12, font: 'F2' }];
    const runs = [...header, ...column(LEFT, 50, 700), ...column(RIGHT, 320, 700)];
    const cols = detectColumns(runs);
    expect(cols.columns).toBe(2);
    expect(cols.boundaries).toHaveLength(1);
    const lines = linesOf(runs, cols.boundaries);
    expect(lines.filter((l) => l.col === 'span')).toHaveLength(1);
    expect(lines.some((l) => l.text === 'Experience and roles')).toBe(true);
    const text = readingOrder(lines, cols.columns);
    const idx = (s: string): number => text.indexOf(s);
    expect(idx('[name]')).toBe(0);
    expect(idx('Experience and roles')).toBeLessThan(idx('Summary of work'));
    expect(idx('Observability and planning')).toBeLessThan(idx('Summary of work'));
    const page = pageText({ width: 612, height: 792, runs });
    expect(page.columns).toBe(2);
    expect(page.fonts.size).toBe(2);
  });

  it('three columns cap at 3', () => {
    const runs = [...column(LEFT, 30, 700), ...column(RIGHT, 230, 700), ...column(LEFT, 430, 700)];
    expect(detectColumns(runs).columns).toBe(3);
    expect(pageText({ width: 612, height: 792, runs }).columns).toBe(3);
  });
});

describe('extraction quality (D-13)', () => {
  it('is 0 for scanned pages, lower for re-ordered columns, 0.95 for clean pdf and docx', () => {
    expect(extractionQuality({ chars: 200, pages: 1, replacementChars: 0, columns: 1, source: 'pdf' })).toBe(0);
    expect(extractionQuality({ chars: 4000, pages: 2, replacementChars: 200, columns: 1, source: 'pdf' })).toBe(0);
    expect(extractionQuality({ chars: 4000, pages: 2, replacementChars: 0, columns: 1, source: 'pdf' })).toBe(0.95);
    expect(extractionQuality({ chars: 4000, pages: 2, replacementChars: 0, columns: 2, source: 'pdf' })).toBe(0.7);
    expect(extractionQuality({ chars: 4000, pages: 0, replacementChars: 0, columns: 0, source: 'docx' })).toBe(0.95);
    expect(extractionQuality({ chars: 4000, pages: 0, replacementChars: 0, columns: 0, source: 'docx', warnings: 2 })).toBe(0.7);
  });

  it('buildMetrics fills every field and never null', () => {
    const text = 'word '.repeat(700).trim();
    const m = buildMetrics({ source: 'pdf', text, pages: 2, columns: 1, fonts: 3, images: 1 });
    expect(m).toMatchObject({ source: 'pdf', pages: 2, columns_detected: 1, font_count: 3, image_count: 1, char_count: text.length, word_count: 700, extraction_quality: 0.95 });
    expect(m.redactions).toEqual({ name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 });
    const d = buildMetrics({ source: 'docx', text, pages: 0, columns: 0, fonts: 0, images: 0 });
    expect(d.pages).toBe(Math.ceil(text.length / 3000));
  });

  it('tidyText collapses extraction noise', () => {
    expect(tidyText('a  b \n\n\n\nc\r\nd ')).toBe('a b\n\nc\nd');
  });
});

describe('metrics line labels', () => {
  it('pdf, docx and paste read as specified', () => {
    const pdf = buildMetrics({ source: 'pdf', text: 'x'.repeat(3412), pages: 2, columns: 1, fonts: 2, images: 0 });
    expect(metricsLineText(pdf)).toBe('2 pages · 1 column · 2 fonts · 0 images · 3,412 characters · extraction good');
    const twoCol = buildMetrics({ source: 'pdf', text: 'x'.repeat(3412), pages: 1, columns: 2, fonts: 1, images: 1 });
    expect(metricsLineText(twoCol)).toBe('1 page · 2 columns · 1 font · 1 image · 3,412 characters · extraction fair');
    expect(metricsLineText(pastedMetrics('x'.repeat(500)))).toBe('pasted · 500 characters');
    expect(metricsLineText(buildMetrics({ source: 'docx', text: 'x'.repeat(500), pages: 0, columns: 0, fonts: 0, images: 0 }))).toBe('Word file · 500 characters');
  });
});
