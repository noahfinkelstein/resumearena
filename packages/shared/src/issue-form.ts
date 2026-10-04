// Issue Form bodies (§7.3–§7.4). GitHub renders each field as "### <label>\n\n<value>\n\n"; textareas
// with `render:` are fenced; empty optional fields render as "_No response_".
import type { SubmissionPayload } from './types.ts';

const HEADING_RE = /^### (.*)$/;
// CommonMark fence: up to three spaces of indent, then a run of three or more backticks or tildes.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A value that is exactly one fenced block yields its inside; `_No response_` is an empty field. */
function unwrapValue(raw: string): string {
  let value = raw.trim();
  const fence = value.match(/^```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?```$/);
  if (fence) value = fence[1] ?? '';
  else if (/^```[A-Za-z0-9_-]*[ \t]*\n?```$/.test(value)) value = '';
  if (value === '_No response_') value = '';
  return value;
}

/**
 * Splits the body on `### <label>` headings, but only outside an open code fence: a pasted Markdown
 * CV inside the fenced `text` field carries its own `### ` lines and must stay in one piece. A fence
 * closes on a run of the same character at least as long as the one that opened it (CommonMark), so
 * a stray shorter run inside the value does not end the block.
 */
export function parseIssueForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let label: string | null = null;
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (label !== null) out[label] = unwrapValue(buf.join('\n'));
  };
  for (const line of lines) {
    if (fence === null) {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        flush();
        const next = (heading[1] ?? '').trim();
        // A heading without a label starts no field; its lines are dropped until the next heading.
        label = next === '' ? null : next;
        buf = [];
        continue;
      }
      const open = FENCE_OPEN_RE.exec(line);
      if (open) fence = open[1] ?? null;
    } else {
      const close = FENCE_CLOSE_RE.exec(line);
      const run = close?.[1] ?? '';
      if (run !== '' && run[0] === fence[0] && run.length >= fence.length) fence = null;
    }
    if (label !== null) buf.push(line);
  }
  flush();
  return out;
}

/** True when the body carried an owner_key field with a value, whatever the template (a hand-added one too). */
export const issueFieldsCarryKey = (fields: Record<string, string>): boolean => (fields.owner_key ?? '').trim() !== '';

/**
 * The ten dispatch inputs from a parsed Issue Form; the delete template carries only three of them.
 * Only a delete issue may carry a key (D-11, §7.3): a submission body with a hand-added `### owner_key`
 * section would otherwise become a resubmission that publishes the key without redaction.
 */
export function payloadFromIssueFields(fields: Record<string, string>, isDelete: boolean): SubmissionPayload {
  return {
    action: isDelete ? 'delete' : 'submit',
    submission_id: fields.submission_id ?? '',
    handle: fields.handle ?? '',
    owner_hash: fields.owner_hash ?? '',
    visibility: isDelete ? '' : ((fields.visibility as SubmissionPayload['visibility'] | undefined) ?? 'anonymous'),
    text: isDelete ? '' : (fields.text ?? ''),
    metrics_json: fields.metrics_json && fields.metrics_json !== '' ? fields.metrics_json : '{}',
    ladder_hint: (fields.ladder_hint as SubmissionPayload['ladder_hint'] | undefined) ?? '',
    client_version: fields.client_version ?? 'issue',
    owner_key: isDelete ? (fields.owner_key ?? '') : '',
  };
}
