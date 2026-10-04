// The user message shared by the gate and the analyst (§9.6, scoring-rubric.md §1.4): byte-stable key
// order, `target_role: none` in v1, and the résumé inside the only <resume_text> block.
import type { LayoutMetrics } from '@resumearena/shared';

const METRIC_KEYS = ['source', 'pages', 'columns_detected', 'font_count', 'image_count', 'char_count', 'extraction_quality'] as const;

export const TAG_REMOVED = '[tag removed]';

export function buildUserMessage(input: { text: string; metrics: LayoutMetrics; targetRole?: string | null; validationNote?: string | null }): string {
  const safe = input.text.replaceAll(/<\/?resume_text/gi, TAG_REMOVED);
  const metrics = Object.fromEntries(METRIC_KEYS.map((k) => [k, input.metrics[k]]));
  const lines = [
    `layout_metrics: ${JSON.stringify(metrics)}`,
    `target_role: ${input.targetRole ? JSON.stringify(input.targetRole.slice(0, 80)) : 'none'}`,
    '',
    '<resume_text>',
    safe,
    '</resume_text>',
  ];
  if (input.validationNote) lines.push(`validation_note: ${input.validationNote.replace(/\s+/g, ' ').slice(0, 1200)}`);
  return lines.join('\n');
}

/** Inverse of buildUserMessage, used by the mock transport to see what it was asked about. */
export function parseUserMessage(message: string): { text: string; metrics: Record<string, unknown>; validationNote: string | null } {
  const open = message.indexOf('<resume_text>\n');
  const close = message.lastIndexOf('\n</resume_text>');
  const text = open >= 0 && close > open ? message.slice(open + '<resume_text>\n'.length, close) : '';
  const metricsLine = message.split('\n').find((l) => l.startsWith('layout_metrics: '));
  let metrics: Record<string, unknown> = {};
  if (metricsLine) {
    try {
      metrics = JSON.parse(metricsLine.slice('layout_metrics: '.length)) as Record<string, unknown>;
    } catch {
      metrics = {};
    }
  }
  const noteIdx = message.indexOf('\nvalidation_note: ');
  return { text, metrics, validationNote: noteIdx >= 0 ? message.slice(noteIdx + '\nvalidation_note: '.length) : null };
}
