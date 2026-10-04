// workflow_dispatch → SubmissionPayload (§7.1, D-12): the ten flat string inputs, nothing else.
import type { SubmissionPayload, SubmissionSource } from '@resumearena/shared';

export interface DispatchEvent {
  inputs: Record<string, unknown>;
}

export const PAYLOAD_FIELDS = ['action', 'submission_id', 'handle', 'owner_hash', 'visibility', 'text', 'metrics_json', 'ladder_hint', 'client_version', 'owner_key'] as const;

export function isDispatchEvent(raw: unknown): raw is DispatchEvent {
  return !!raw && typeof raw === 'object' && typeof (raw as DispatchEvent).inputs === 'object' && (raw as DispatchEvent).inputs !== null;
}

/** Unknown inputs are dropped; missing ones become '' so normalizePayload reports the field, not a crash. */
export function payloadFromInputs(inputs: Record<string, unknown>): SubmissionPayload {
  const out: Record<string, string> = {};
  for (const f of PAYLOAD_FIELDS) {
    const v = inputs[f];
    out[f] = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  }
  return out as unknown as SubmissionPayload;
}

export function fromDispatch(event: DispatchEvent, runId: number): { payload: SubmissionPayload; source: SubmissionSource } {
  const payload = payloadFromInputs(event.inputs);
  return { payload, source: { kind: 'dispatch', run_id: runId, issue_number: null, client_version: payload.client_version } };
}
