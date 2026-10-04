// Document builders for every submit outcome (§3.3 variants). Each document is written once, complete.
import {
  subScoreTuple,
  type AnalysisQueueEntry, type Card, type CareerStage, type Category, type DedupeEntry, type DeleteRequest, type GateVerdict, type PlacementTicket,
  type QueueReason, type RejectCode, type ResumeDoc, type ReviewReason, type RowEntry, type SubmissionInput, type SubmissionPayload, type UserDoc,
} from '@resumearena/shared';
import type { PostValidated } from './analysis.ts';

export interface GateRecord {
  model: string;
  prompt: string;
  verdict: GateVerdict;
}

const base = (input: SubmissionInput, now: string): Pick<ResumeDoc, 'schema' | 'id' | 'kind' | 'handle' | 'visibility' | 'owner_hash' | 'primary' | 'created_at' | 'updated_at' | 'source' | 'text_sha256'> => ({
  schema: 1,
  id: input.id,
  kind: 'user',
  handle: input.handle,
  visibility: input.visibility,
  owner_hash: input.owner_hash,
  primary: input.ladder_hint,
  created_at: now,
  updated_at: now,
  source: input.source,
  text_sha256: input.text_sha256,
});

export function rejectedStub(input: SubmissionInput, now: string, code: RejectCode, gate?: GateRecord): ResumeDoc {
  return { ...base(input, now), status: 'rejected', rejected_reason: code, ...(gate ? { gate } : {}) };
}

export function needsReviewStub(input: SubmissionInput, now: string, reason: ReviewReason, gate: GateRecord): ResumeDoc {
  return { ...base(input, now), status: 'needs_review', review_reason: reason, gate };
}

export function duplicateStub(input: SubmissionInput, now: string, kind: 'text' | 'card', of: string | null, gate?: GateRecord): ResumeDoc {
  return { ...base(input, now), status: 'duplicate', duplicate_kind: kind, duplicate_of: of, ...(gate ? { gate } : {}) };
}

export function queuedStub(input: SubmissionInput, now: string, reason: QueueReason): ResumeDoc {
  return { ...base(input, now), status: 'queued', queue_reason: reason, metrics: input.metrics };
}

export interface AnalyzedParts {
  post: PostValidated;
  gate: GateRecord;
  versions: ResumeDoc['versions'];
  usage: ResumeDoc['usage'];
  supersedes: string | null;
}

/** The full analyzed document; `held` is this minus `text`, plus `held_reason`. */
export function analyzedDoc(input: SubmissionInput, now: string, p: AnalyzedParts): ResumeDoc {
  const doc: ResumeDoc = {
    ...base(input, now),
    status: p.post.status === 'held' ? 'held' : 'analyzed',
    metrics: input.metrics,
    gate: p.gate,
    analysis: p.post.analysis,
    card_sha256: p.post.cardSha256,
    category_relevance: p.post.categoryRelevance,
    scores: p.post.scores,
    stage: p.post.stage,
    top_signal: p.post.topSignal,
    held_reason: p.post.heldReason,
    rejected_reason: null,
    duplicate_of: null,
    supersedes: p.supersedes,
    superseded_by: null,
    deleted_at: null,
    ...(p.versions ? { versions: p.versions } : {}),
    ...(p.usage ? { usage: p.usage } : {}),
  };
  if (p.post.status !== 'held') doc.text = input.text;
  return doc;
}

export function supersededStub(old: ResumeDoc, newId: string, now: string): ResumeDoc {
  return {
    schema: 1, id: old.id, kind: 'user', status: 'superseded', handle: old.handle, visibility: old.visibility, owner_hash: old.owner_hash, primary: old.primary,
    created_at: old.created_at, updated_at: now, source: old.source, text_sha256: old.text_sha256, superseded_by: newId, superseded_at: now,
  };
}

export function deletedStub(old: ResumeDoc, now: string): ResumeDoc {
  return {
    schema: 1, id: old.id, kind: 'user', status: 'deleted', handle: old.handle, visibility: old.visibility, owner_hash: old.owner_hash, primary: old.primary,
    created_at: old.created_at, updated_at: now, source: old.source, text_sha256: old.text_sha256, deleted_at: now,
  };
}

export function rowEntry(doc: ResumeDoc, post: PostValidated): RowEntry {
  const c: Partial<Record<Category, number>> = {};
  const ss: RowEntry['ss'] = {};
  for (const cat of post.included) {
    c[cat] = post.categoryRelevance[cat];
    ss[cat] = subScoreTuple(post.analysis.scores[cat]);
  }
  return {
    h: doc.handle, v: doc.visibility, p: doc.primary, st: post.stage, sig: post.topSignal, s: 'analyzed',
    c, sc: { ...post.scores }, ss, ch: post.cardSha256, t: Math.floor(Date.parse(doc.created_at) / 1000),
  };
}

export const cardsEntry = (card: Card, st: CareerStage): { card: Card; st: CareerStage } => ({ card, st });

export const dedupeEntry = (id: string, ownerHash: string, now: string): DedupeEntry => ({ id, owner_hash: ownerHash, t: now });

export const placementTicket = (doc: ResumeDoc, supersedes: string | null, now: string): PlacementTicket => ({ schema: 1, id: doc.id, handle: doc.handle, owner_hash: doc.owner_hash, primary: doc.primary, supersedes, queued_at: now });

/**
 * The stored payload must normalize again at drain time without the key: `owner_hash` is the normalized
 * value (a payload may have carried only the key and left the hash empty) and `owner_key` is blanked (§3.3).
 */
export function analysisQueueEntry(input: SubmissionInput, payload: SubmissionPayload, reason: QueueReason, now: string): AnalysisQueueEntry {
  return { schema: 1, id: input.id, reason, enqueued_at: now, source: input.source, payload: { ...payload, owner_hash: input.owner_hash, owner_key: '' } };
}

export const deleteRequest = (id: string, handle: string, now: string): DeleteRequest => ({ schema: 1, id, requested_at: now, handle });

export function newUserDoc(handle: string, ownerHash: string, id: string, now: string): UserDoc {
  return { schema: 1, handle, owner_hash: ownerHash, created_at: now, state: 'active', key_exposed: false, resumes: [{ id, created_at: now, current: true }] };
}

/** Append a new current entry, flipping the previous one; a tombstone revives. */
export function userDocWithNew(user: UserDoc, id: string, now: string): UserDoc {
  return { ...user, state: 'active', resumes: [...user.resumes.map((r) => ({ ...r, current: false })), { id, created_at: now, current: true }] };
}

/**
 * Remove an entry; the last removal tombstones the profile (D-41). `promote` names the remaining entry
 * that becomes current, or null: only an `analyzed` document may be promoted (the caller checks), since a
 * superseded stub has no text, no rows and no rating of its own to come back to.
 */
export function userDocWithout(user: UserDoc, id: string, promote: string | null = null): UserDoc {
  const resumes = user.resumes.filter((r) => r.id !== id).map((r) => ({ ...r, current: r.current || r.id === promote }));
  return { ...user, resumes, state: resumes.length ? 'active' : 'tombstone' };
}

/** The entry that may become current after `id` is removed: the newest remaining one, if its document is analyzed. */
export function promotionCandidate(user: UserDoc, id: string): string | null {
  const removed = user.resumes.find((r) => r.id === id);
  if (!removed?.current) return null;
  const remaining = user.resumes.filter((r) => r.id !== id);
  return remaining[remaining.length - 1]?.id ?? null;
}
