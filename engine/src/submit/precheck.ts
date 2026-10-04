// The cheap checks submit runs twice: before any model call and again inside the decide mutation on the
// fresh tree (§9.3 steps 4–6, 10, 11). Pure reads; the caller acts on the verdict.
import { ResumeDocZ, UserDocZ, timingSafeEqualString, type ResumeDoc, type SubmissionInput, type UserDoc } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { dedupeCardPath, dedupeTextPath, placementTicketPath, resumePath, userPath } from '../store/paths.ts';
import { sha256Hex } from '../rng.ts';

export type Precheck =
  | { kind: 'noop' }
  | { kind: 'collision' }
  | { kind: 'reject'; code: 'handle_taken' | 'resubmit_too_soon' }
  | { kind: 'duplicate'; dupKind: 'text' | 'card'; of: string | null }
  | { kind: 'proceed'; user: UserDoc | null; supersedes: string | null; oldDoc: ResumeDoc | null };

export async function readResumeDoc(store: Store, id: string): Promise<ResumeDoc | null> {
  const raw = await store.readJson<unknown>(resumePath(id));
  if (raw === null) return null;
  const r = ResumeDocZ.safeParse(raw);
  if (!r.success) throw new Error(`resumes/${id}: malformed document (${r.error.issues[0]?.path.join('.')})`);
  return r.data as ResumeDoc;
}

export async function readUserDoc(store: Store, handle: string): Promise<UserDoc | null> {
  const raw = await store.readJson<unknown>(userPath(handle));
  if (raw === null) return null;
  const r = UserDocZ.safeParse(raw);
  if (!r.success) throw new Error(`users/${handle}: malformed document (${r.error.issues[0]?.path.join('.')})`);
  return r.data;
}

/** D-11: the key must hash to the stored owner_hash, compared in constant time. */
export function keyVerifies(user: UserDoc, input: SubmissionInput): boolean {
  if (input.owner_key === null) return false;
  if (!timingSafeEqualString(user.owner_hash, input.owner_hash)) return false;
  return timingSafeEqualString(sha256Hex(input.owner_key), user.owner_hash);
}

export interface PrecheckOptions {
  cardSha256?: string | null;
  /** Draining queue/analysis: the id's own `queued` stub is the thing being completed, not a re-run. */
  resumeQueued?: boolean;
}

/** The existing document is this submission's own budget/paused stub, which the drain may complete. */
export const isOwnQueuedStub = (existing: Pick<ResumeDoc, 'status' | 'owner_hash' | 'text_sha256'>, input: SubmissionInput): boolean =>
  existing.status === 'queued' && existing.owner_hash === input.owner_hash && existing.text_sha256 === input.text_sha256;

/** Steps 4–6 (+ card dedupe when the card hash is known). */
export async function precheckSubmit(store: Store, input: SubmissionInput, opts: PrecheckOptions = {}): Promise<Precheck> {
  const existing = await readResumeDoc(store, input.id);
  if (existing) {
    if (existing.owner_hash !== input.owner_hash || existing.text_sha256 !== input.text_sha256) return { kind: 'collision' };
    if (!(opts.resumeQueued && existing.status === 'queued')) return { kind: 'noop' };
  }

  const user = await readUserDoc(store, input.handle);
  let supersedes: string | null = null;
  let oldDoc: ResumeDoc | null = null;
  if (user) {
    const sameOwner = timingSafeEqualString(user.owner_hash, input.owner_hash);
    if (!sameOwner || !keyVerifies(user, input) || user.key_exposed) return { kind: 'reject', code: 'handle_taken' };
    const current = user.resumes.find((r) => r.current);
    if (user.state === 'active' && current) {
      const doc = await readResumeDoc(store, current.id);
      if ((await store.exists(placementTicketPath(current.id))) || doc?.status === 'queued') return { kind: 'reject', code: 'resubmit_too_soon' };
      // Only a live, analyzed entry is a revision's parent (D-42); a stale `current` pointing at a superseded or
      // deleted stub would otherwise resurrect a rating the person already gave up.
      if (doc?.status === 'analyzed') {
        supersedes = current.id;
        oldDoc = doc;
      }
    }
  }

  const textDup = await store.readJson<{ id: string; owner_hash: string }>(dedupeTextPath(input.text_sha256));
  if (textDup && textDup.id !== input.id) return { kind: 'duplicate', dupKind: 'text', of: textDup.owner_hash === input.owner_hash ? textDup.id : null };
  if (opts.cardSha256) {
    const cardDup = await store.readJson<{ id: string; owner_hash: string }>(dedupeCardPath(opts.cardSha256));
    if (cardDup && cardDup.id !== input.id && cardDup.id !== supersedes) return { kind: 'duplicate', dupKind: 'card', of: cardDup.owner_hash === input.owner_hash ? cardDup.id : null };
  }
  return { kind: 'proceed', user, supersedes, oldDoc };
}

export type ManageCheck = { kind: 'ok'; user: UserDoc; doc: ResumeDoc } | { kind: 'key_mismatch'; reason: string };

/** Delete / set_visibility: key must verify; an exposed key may only delete; the doc must be the key holder's. */
export async function precheckManage(store: Store, input: SubmissionInput): Promise<ManageCheck> {
  const user = await readUserDoc(store, input.handle);
  if (!user) return { kind: 'key_mismatch', reason: 'unknown handle' };
  if (!keyVerifies(user, input)) return { kind: 'key_mismatch', reason: 'key does not verify' };
  if (user.key_exposed && input.action !== 'delete') return { kind: 'key_mismatch', reason: 'exposed key may only delete' };
  const doc = await readResumeDoc(store, input.id);
  if (!doc) return { kind: 'key_mismatch', reason: 'no such entry' };
  if (!timingSafeEqualString(doc.owner_hash, input.owner_hash) || doc.handle !== input.handle) return { kind: 'key_mismatch', reason: 'entry belongs to another key' };
  if (doc.status === 'deleted') return { kind: 'key_mismatch', reason: 'already deleted' };
  if (input.action === 'set_visibility' && doc.status !== 'analyzed') return { kind: 'key_mismatch', reason: 'only analyzed entries have a visibility' };
  return { kind: 'ok', user, doc };
}
