// The write sets of §9.3 step 11, each applied on the fresh tree inside one `decide` mutation.
import type { CardsShard, ResumeDoc, RowsShard, SubmissionInput, UsageLine, UserDoc } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import {
  analysisQueuePath, cardsPath, dedupeCardPath, dedupeTextPath, deleteRequestPath, placementTicketPath, resumePath, rowsPath, usagePath, userPath,
} from '../store/paths.ts';
import type { PostValidated } from './analysis.ts';
import { cardsEntry, dedupeEntry, deletedStub, newUserDoc, placementTicket, promotionCandidate, rowEntry, supersededStub, userDocWithNew, userDocWithout } from './docs.ts';
import { readResumeDoc } from './precheck.ts';

export async function appendUsage(store: Store, day: string, lines: readonly UsageLine[]): Promise<void> {
  if (lines.length) await store.appendLines(usagePath(day), lines.map((l) => JSON.stringify(l)));
}

async function removeRowAndCard(store: Store, id: string): Promise<void> {
  const rows = (await store.readJson<RowsShard>(rowsPath(id))) ?? {};
  if (id in rows) {
    delete rows[id];
    await store.writeJson(rowsPath(id), rows);
  }
  const cards = (await store.readJson<CardsShard>(cardsPath(id))) ?? {};
  if (id in cards) {
    delete cards[id];
    await store.writeJson(cardsPath(id), cards);
  }
}

async function removeDedupe(store: Store, doc: ResumeDoc): Promise<void> {
  const text = await store.readJson<{ id: string }>(dedupeTextPath(doc.text_sha256));
  if (text && text.id === doc.id) await store.remove(dedupeTextPath(doc.text_sha256));
  if (doc.card_sha256) {
    const card = await store.readJson<{ id: string }>(dedupeCardPath(doc.card_sha256));
    if (card && card.id === doc.id) await store.remove(dedupeCardPath(doc.card_sha256));
  }
}

/** Only a stub (plus the analysis queue entry when queued). */
export async function writeStub(store: Store, doc: ResumeDoc): Promise<void> {
  await store.writeJson(resumePath(doc.id), doc);
}

export async function writeAnalyzed(store: Store, input: SubmissionInput, doc: ResumeDoc, post: PostValidated, user: UserDoc | null, supersedes: string | null, now: string): Promise<void> {
  await store.writeJson(resumePath(doc.id), doc);
  const nextUser = user ? userDocWithNew(user, doc.id, now) : newUserDoc(doc.handle, doc.owner_hash, doc.id, now);
  await store.writeJson(userPath(doc.handle), nextUser);
  const rows = (await store.readJson<RowsShard>(rowsPath(doc.id))) ?? {};
  rows[doc.id] = rowEntry(doc, post);
  await store.writeJson(rowsPath(doc.id), rows);
  const cards = (await store.readJson<CardsShard>(cardsPath(doc.id))) ?? {};
  cards[doc.id] = cardsEntry(post.analysis.card, post.stage);
  await store.writeJson(cardsPath(doc.id), cards);
  await store.writeJson(dedupeTextPath(input.text_sha256), dedupeEntry(doc.id, doc.owner_hash, now));
  await store.writeJson(dedupeCardPath(post.cardSha256), dedupeEntry(doc.id, doc.owner_hash, now));
  await store.writeJson(placementTicketPath(doc.id), placementTicket(doc, supersedes, now));
  if (supersedes) {
    const old = await readResumeDoc(store, supersedes);
    if (old && old.status !== 'deleted') {
      await removeDedupe(store, old);
      await removeRowAndCard(store, old.id);
      await store.writeJson(resumePath(old.id), supersededStub(old, doc.id, now));
    }
  }
}

export async function writeVisibility(store: Store, doc: ResumeDoc, visibility: ResumeDoc['visibility'], now: string): Promise<void> {
  await store.writeJson(resumePath(doc.id), { ...doc, visibility, updated_at: now });
  const rows = (await store.readJson<RowsShard>(rowsPath(doc.id))) ?? {};
  const row = rows[doc.id];
  if (row) {
    row.v = visibility;
    await store.writeJson(rowsPath(doc.id), rows);
  }
}

/** D-27: submit-side delete touches only submit-owned files plus the delete request; rerank removes the rest. */
export async function writeDelete(store: Store, doc: ResumeDoc, user: UserDoc, now: string, exposeKey: boolean): Promise<void> {
  await store.writeJson(resumePath(doc.id), deletedStub(doc, now));
  await removeRowAndCard(store, doc.id);
  await removeDedupe(store, doc);
  const candidate = promotionCandidate(user, doc.id);
  const candidateDoc = candidate ? await readResumeDoc(store, candidate) : null;
  const next = userDocWithout(user, doc.id, candidateDoc?.status === 'analyzed' ? candidate : null);
  await store.writeJson(userPath(doc.handle), exposeKey ? { ...next, key_exposed: true } : next);
  await store.remove(placementTicketPath(doc.id));
  await store.remove(analysisQueuePath(doc.id));
  await store.writeJson(deleteRequestPath(doc.id), { schema: 1, id: doc.id, requested_at: now, handle: doc.handle });
}

export interface SubmitPathsExtra {
  cardSha256?: string | null;
  supersedes?: string | null;
  /** The superseded document's hashes, so only its two dedupe shards are materialized rather than the whole tree. */
  oldDoc?: Pick<ResumeDoc, 'text_sha256' | 'card_sha256'> | null;
  day: string;
}

/** Sparse patterns a submission can touch, so one materialize covers every attempt (§9.3 step 3). */
export function submitPaths(input: SubmissionInput, extra: SubmitPathsExtra): string[] {
  const paths = [
    `/${resumePath(input.id)}`,
    `/users/${input.handle.slice(0, 2)}/`,
    `/${rowsPath(input.id)}`,
    `/${cardsPath(input.id)}`,
    `/dedupe/text/${input.text_sha256.slice(0, 2)}/`,
    `/${placementTicketPath(input.id)}`,
    `/${analysisQueuePath(input.id)}`,
    `/${deleteRequestPath(input.id)}`,
    `/${usagePath(extra.day)}`,
  ];
  if (extra.cardSha256) paths.push(`/dedupe/card/${extra.cardSha256.slice(0, 2)}/`);
  if (extra.supersedes) {
    paths.push(`/${resumePath(extra.supersedes)}`, `/${rowsPath(extra.supersedes)}`, `/${cardsPath(extra.supersedes)}`, `/${placementTicketPath(extra.supersedes)}`);
    const old = extra.oldDoc;
    if (old) {
      paths.push(`/dedupe/text/${old.text_sha256.slice(0, 2)}/`);
      if (old.card_sha256) paths.push(`/dedupe/card/${old.card_sha256.slice(0, 2)}/`);
    }
  }
  return [...new Set(paths)];
}
