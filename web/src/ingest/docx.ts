// DOCX text through mammoth. No layout is measurable; quality is 0.95, or 0.7 when mammoth warned.
import mammoth from 'mammoth';
import { buildMetrics, tidyText } from './metrics.ts';
import { ExtractError, type ExtractOutput } from './pdf.ts';

export async function extractDocx(data: ArrayBuffer): Promise<ExtractOutput> {
  let value: string;
  let warnings = 0;
  try {
    const res = await mammoth.extractRawText({ arrayBuffer: data });
    value = res.value;
    warnings = res.messages.filter((m) => m.type === 'warning' || m.type === 'error').length;
  } catch (e) {
    throw new ExtractError('unreadable', e instanceof Error ? e.message : String(e));
  }
  const text = tidyText(value);
  if (text.length === 0) throw new ExtractError('no_text');
  const metrics = buildMetrics({ source: 'docx', text, pages: 0, columns: 0, fonts: 0, images: 0, warnings });
  return { text, metrics };
}
