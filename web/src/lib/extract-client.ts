// Main-thread side of the ingestion worker. One worker per file; terminated when done or after 30 s.
import type { LayoutMetrics, Source } from '@resumearena/shared';
import type { ExtractRequest, ExtractResponse } from '../workers/extract.ts';

export type FileKind = 'pdf' | 'docx';

export interface ExtractResult {
  text: string;
  metrics: LayoutMetrics;
  source: Source;
}

export type ExtractFailure = 'type' | 'size' | 'no_text' | 'unreadable' | 'timeout';

export class ExtractFailed extends Error {
  readonly code: ExtractFailure;
  constructor(code: ExtractFailure, detail?: string) {
    super(detail ?? code);
    this.name = 'ExtractFailed';
    this.code = code;
  }
}

const PDF_TYPES = new Set(['application/pdf']);
const DOCX_TYPES = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

export function kindOf(file: { name: string; type: string }): FileKind | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (PDF_TYPES.has(file.type) || ext === 'pdf') return 'pdf';
  if (DOCX_TYPES.has(file.type) || ext === 'docx') return 'docx';
  return null;
}

export interface ExtractOptions {
  maxBytes: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** Injected in tests. */
  createWorker?: () => Worker;
}

export async function extractFile(file: File, opts: ExtractOptions): Promise<ExtractResult> {
  const kind = kindOf(file);
  if (!kind) throw new ExtractFailed('type');
  if (file.size > opts.maxBytes) throw new ExtractFailed('size');
  const buffer = await file.arrayBuffer();
  const worker = (opts.createWorker ?? (() => new Worker(new URL('../workers/extract.ts', import.meta.url), { type: 'module' })))();
  return new Promise<ExtractResult>((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new ExtractFailed('timeout'))), opts.timeoutMs ?? 30_000);
    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      worker.terminate();
      fn();
    };
    worker.onmessage = (e: MessageEvent<ExtractResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') opts.onProgress?.(msg.done, msg.total);
      else if (msg.type === 'result') finish(() => resolve({ text: msg.text, metrics: msg.metrics, source: kind }));
      else finish(() => reject(new ExtractFailed(msg.code === 'password' ? 'unreadable' : msg.code, msg.detail)));
    };
    worker.onerror = (ev) => finish(() => reject(new ExtractFailed('unreadable', ev.message)));
    const req: ExtractRequest = { type: 'extract', kind, buffer, name: file.name };
    worker.postMessage(req, [buffer]);
  });
}
