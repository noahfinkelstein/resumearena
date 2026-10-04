// The ingestion worker: pdfjs and mammoth run here so a hostile file cannot hang the page. The file's
// bytes arrive by transfer and never leave the browser; this module has no network code path.
import type { LayoutMetrics } from '@resumearena/shared';

export type ExtractRequest = { type: 'extract'; kind: 'pdf' | 'docx'; buffer: ArrayBuffer; name: string };
export type ExtractResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; text: string; metrics: LayoutMetrics }
  | { type: 'error'; code: 'no_text' | 'unreadable' | 'password'; detail?: string };

interface WorkerScope {
  postMessage(msg: ExtractResponse): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<ExtractRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (e) => {
  const req = e.data;
  if (!req || req.type !== 'extract') return;
  void run(req);
});

async function run(req: ExtractRequest): Promise<void> {
  try {
    if (req.kind === 'pdf') {
      const { extractPdf } = await import('../ingest/pdf.ts');
      const out = await extractPdf(req.buffer, (done, total) => scope.postMessage({ type: 'progress', done, total }));
      scope.postMessage({ type: 'result', text: out.text, metrics: out.metrics });
    } else {
      const { extractDocx } = await import('../ingest/docx.ts');
      scope.postMessage({ type: 'progress', done: 0, total: 1 });
      const out = await extractDocx(req.buffer);
      scope.postMessage({ type: 'progress', done: 1, total: 1 });
      scope.postMessage({ type: 'result', text: out.text, metrics: out.metrics });
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    scope.postMessage({
      type: 'error',
      code: code === 'no_text' || code === 'password' ? code : 'unreadable',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
