// Browser half of VITE_MOCK=1 (§13.2). dispatch() writes a fake doc after 3 s and a rank entry after
// 10 s into an in-memory overlay that getJson consults first; probeToken() reads
// localStorage['resumearena.mockProbe']. Everything here is dead code outside mock builds.
import { anonIdOf, shardOf, handleShard, type ResumeDoc, type RankEntry, type RankShard, type SubmissionPayload, type UserDoc, type Manifest, type LadderPage } from '@resumearena/shared';
import { KEYS, readRaw } from './storage.ts';

const IS_MOCK = import.meta.env.VITE_MOCK === '1';

const overlay = new Map<string, unknown>();

const keyOf = (url: string): string => {
  const noQuery = url.split('?')[0] ?? url;
  // Match on the tail so the key is independent of base path and origin.
  const m = /(?:\/data\/|\/__raw\/)(.*)$/.exec(noQuery);
  return m?.[1] ?? noQuery;
};

export const mockOverlay = {
  get(url: string): unknown {
    if (!IS_MOCK) return undefined;
    const k = keyOf(url);
    return overlay.has(k) ? overlay.get(k) : undefined;
  },
  set(path: string, value: unknown): void {
    overlay.set(path, value);
  },
  clear(): void {
    overlay.clear();
  },
};

export function mockProbe(): 'ok' | 'dead' | 'limited' | 'unknown' {
  const v = readRaw(KEYS.mockProbe);
  return v === 'dead' || v === 'limited' || v === 'unknown' ? v : 'ok';
}

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const base = (): string => import.meta.env.BASE_URL ?? '/';

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** A real analyzed doc from the mock dataset, used as the template for synthesized ones. */
async function templateDoc(): Promise<ResumeDoc | null> {
  const manifest = await fetchJson<Manifest>(`${base()}data/manifest.json`);
  const page = await fetchJson<LadderPage>(`${base()}data/ladder/general/all/1.json`);
  const ids = page?.rows.map((r) => r[1]) ?? [];
  for (const id of ids.slice(0, 20)) {
    const doc = await fetchJson<ResumeDoc>(`${base()}__raw/resumes/${shardOf(id)}/${id}.json`);
    if (doc?.status === 'analyzed' && doc.analysis) return doc;
  }
  void manifest;
  return null;
}

export async function mockDispatch(p: SubmissionPayload): Promise<{ ok: true }> {
  const mode = readRaw(KEYS.mockProbe);
  if (mode === 'dead') return Promise.resolve({ ok: true });
  const id = p.submission_id;
  const docPath = `resumes/${shardOf(id)}/${id}.json`;
  const userPath = `users/${handleShard(p.handle)}/${p.handle}.json`;
  if (p.action === 'delete') {
    setTimeout(() => {
      overlay.set(docPath, { schema: 1, id, kind: 'user', status: 'deleted', deleted_at: nowIso() });
      overlay.set(userPath, null);
    }, 3000);
    return { ok: true };
  }
  if (p.action === 'set_visibility') {
    setTimeout(() => {
      void (async () => {
        const existing = (overlay.get(docPath) as ResumeDoc | undefined) ?? (await fetchJson<ResumeDoc>(`${base()}__raw/${docPath}`));
        if (existing) overlay.set(docPath, { ...existing, visibility: p.visibility, updated_at: nowIso() });
      })();
    }, 3000);
    return { ok: true };
  }
  setTimeout(() => {
    void (async () => {
      const tpl = await templateDoc();
      const created = nowIso();
      const doc: ResumeDoc = {
        ...(tpl ?? ({} as ResumeDoc)),
        schema: 1,
        id,
        kind: 'user',
        status: 'analyzed',
        handle: p.handle,
        visibility: p.visibility === 'handle' ? 'handle' : 'anonymous',
        owner_hash: p.owner_hash,
        primary: (p.ladder_hint || 'general') as ResumeDoc['primary'],
        created_at: created,
        updated_at: created,
        source: { kind: 'dispatch', run_id: 1, issue_number: null, client_version: p.client_version },
        text: p.text,
        text_sha256: tpl?.text_sha256 ?? '0'.repeat(64),
        supersedes: null,
        superseded_by: null,
        held_reason: null,
        rejected_reason: null,
        duplicate_of: null,
        deleted_at: null,
      };
      try {
        const m = JSON.parse(p.metrics_json) as ResumeDoc['metrics'];
        if (m) doc.metrics = m;
      } catch {
        // keep the template metrics
      }
      overlay.set(docPath, doc);
      const user: UserDoc = { schema: 1, handle: p.handle, owner_hash: p.owner_hash, created_at: created, state: 'active', key_exposed: false, resumes: [{ id, created_at: created, current: true }] };
      overlay.set(userPath, user);
    })();
  }, 3000);
  setTimeout(() => {
    void (async () => {
      const shardPath = `rank/${shardOf(id)}.json`;
      const existing = (overlay.get(shardPath) as RankShard | undefined) ?? (await fetchJson<RankShard>(`${base()}data/${shardPath}`)) ?? {};
      const entry: RankEntry = {
        h: p.visibility === 'handle' ? p.handle : null,
        v: p.visibility === 'handle' ? 'handle' : 'anonymous',
        st: 'mid',
        sig: 'mock entry',
        p: (p.ladder_hint || 'general') as RankEntry['p'],
        g: [57, 130, 1512, 118.4, 8, 5, 3, 0, null, 1, 0.4385, null],
      };
      overlay.set(shardPath, { ...existing, [id]: entry });
      const manifest = await fetchJson<Manifest>(`${base()}data/manifest.json`);
      if (manifest) overlay.set('manifest.json', { ...manifest, build_id: `${manifest.build_id}-mock${Date.now()}` });
      void anonIdOf;
    })();
  }, 10000);
  return { ok: true };
}
