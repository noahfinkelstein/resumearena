// pdfjs text extraction in reading order with column detection and layout metrics (D-13, D-46).
// Runs inside workers/extract.ts; never on the main thread.
import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { LayoutMetrics } from '@resumearena/shared';
import { buildMetrics, pageText, tidyText, type TextRun } from './metrics.ts';

// Never a root-absolute path: the site lives under /resumearena/.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

export class ExtractError extends Error {
  readonly code: 'no_text' | 'unreadable' | 'password';
  constructor(code: 'no_text' | 'unreadable' | 'password', message?: string) {
    super(message ?? code);
    this.name = 'ExtractError';
    this.code = code;
  }
}

export interface ExtractOutput {
  text: string;
  metrics: LayoutMetrics;
}

const IMAGE_OPS = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintImageMaskXObjectRepeat].filter((n): n is number => typeof n === 'number'));

const isTextItem = (i: unknown): i is TextItem => typeof (i as TextItem).str === 'string' && Array.isArray((i as TextItem).transform);

export async function extractPdf(data: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<ExtractOutput> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, stopAtErrors: false });
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    throw new ExtractError(name === 'PasswordException' ? 'password' : 'unreadable', e instanceof Error ? e.message : String(e));
  }
  try {
    const pages = doc.numPages;
    const texts: string[] = [];
    const fonts = new Set<string>();
    let columns: 0 | 1 | 2 | 3 = 0;
    let images = 0;
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const vp = page.getViewport({ scale: 1 });
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!isTextItem(item) || item.str.length === 0) continue;
        const t = item.transform as number[];
        const h = Math.hypot(t[2] ?? 0, t[3] ?? 1) || item.height || 10;
        runs.push({ str: item.str, x: t[4] ?? 0, y: t[5] ?? 0, w: item.width, h, font: item.fontName });
      }
      const result = pageText({ width: vp.width, height: vp.height, runs });
      texts.push(result.text);
      for (const f of result.fonts) fonts.add(f);
      if (result.columns > columns) columns = result.columns;
      images += await countImages(page);
      page.cleanup();
      onProgress?.(n, pages);
    }
    const text = tidyText(texts.join('\n\n'));
    const metrics = buildMetrics({ source: 'pdf', text, pages, columns: text.length ? columns : 0, fonts: fonts.size, images });
    if (metrics.extraction_quality === 0) throw new ExtractError('no_text');
    return { text, metrics };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function countImages(page: pdfjs.PDFPageProxy): Promise<number> {
  try {
    const ops = await page.getOperatorList();
    let n = 0;
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) n++;
    return n;
  } catch {
    return 0;
  }
}
