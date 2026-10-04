// Every data-branch path in one place (§3.1). Shard rules: id.slice(0, 2), handle.slice(0, 2), sha.slice(0, 2).
import { shardOf, type Category } from '@resumearena/shared';

export const SETTINGS_PATH = 'settings.json';
export const STATUS_PATH = 'status.json';
export const GITATTRIBUTES_PATH = '.gitattributes';

export const resumePath = (id: string): string => `resumes/${shardOf(id)}/${id}.json`;
export const resumeDir = (id: string): string => `resumes/${shardOf(id)}/`;
export const userPath = (handle: string): string => `users/${handle.slice(0, 2)}/${handle}.json`;
export const userDir = (handle: string): string => `users/${handle.slice(0, 2)}/`;
export const rowsPath = (id: string): string => `rows/${shardOf(id)}.json`;
export const rowsShardPath = (ab: string): string => `rows/${ab}.json`;
export const cardsPath = (id: string): string => `cards/${shardOf(id)}.json`;
export const cardsShardPath = (ab: string): string => `cards/${ab}.json`;
export const dedupeTextPath = (sha: string): string => `dedupe/text/${sha.slice(0, 2)}/${sha}.json`;
export const dedupeTextDir = (sha: string): string => `dedupe/text/${sha.slice(0, 2)}/`;
export const dedupeCardPath = (sha: string): string => `dedupe/card/${sha.slice(0, 2)}/${sha}.json`;
export const dedupeCardDir = (sha: string): string => `dedupe/card/${sha.slice(0, 2)}/`;
export const placementTicketPath = (id: string): string => `queue/placement/${id}.json`;
export const analysisQueuePath = (id: string): string => `queue/analysis/${id}.json`;
export const deleteRequestPath = (id: string): string => `queue/delete/${id}.json`;
export const rebumpPath = (id: string): string => `queue/rebump/${id}.json`;
export const PLACEMENT_QUEUE_DIR = 'queue/placement/';
export const ANALYSIS_QUEUE_DIR = 'queue/analysis/';
export const DELETE_QUEUE_DIR = 'queue/delete/';
export const REBUMP_QUEUE_DIR = 'queue/rebump/';
export const ratingsPath = (cat: Category): string => `ratings/${cat}.json`;
export const historyPath = (cat: Category, id: string): string => `history/${cat}/${shardOf(id)}/${id}.json`;
export const matchesDir = (cat: Category): string => `matches/${cat}/`;
export const arenaPath = (cat: Category): string => `arena/${cat}.json`;
export const anchorsPath = (cat: Category): string => `anchors/${cat}.json`;
export const auditPath = (day: string): string => `audits/${day}.json`;
export const anchorValidationPath = (cat: Category, day: string): string => `audits/anchor-validation-${cat}-${day}.json`;
export const usagePath = (day: string): string => `usage/${day}.jsonl`;
export const failuresPath = (day: string): string => `failures/${day}.jsonl`;
export const USAGE_DIR = 'usage/';
export const FAILURES_DIR = 'failures/';
export const ARCHIVE_DIR = 'archive/';

/** Prefixes submit and the manage actions must never write (§3.1); `ownership.test.ts` enforces it. */
export const ENGINE_OWNED_PREFIXES = ['ratings/', 'history/', 'matches/', 'arena/', 'audits/', 'status.json', 'anchors/'] as const;

export const isEngineOwned = (rel: string): boolean => ENGINE_OWNED_PREFIXES.some((p) => rel === p || rel.startsWith(p));

export const GITATTRIBUTES_TEXT = ['usage/**/*.jsonl merge=union', 'failures/**/*.jsonl merge=union', 'matches/**/*.jsonl merge=union', ''].join('\n');
