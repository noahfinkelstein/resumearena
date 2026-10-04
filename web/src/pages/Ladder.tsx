import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { anonIdOf, CATEGORIES, PAGE_SIZE, RANK_KEY, STAGES, tierFor, validateHandle, type CareerStage, type Category, type LadderMeta, type LadderPage, type RankEntry } from '@resumearena/shared';
import { Page } from '../components/chrome/Chrome.tsx';
import { Button } from '../components/forms/Button.tsx';
import { EmptyState, ErrorState } from '../components/forms/States.tsx';
import { Cursor, LadderFilters, LeaderboardTable, YouAreHereRow } from '../components/tables/Tables.tsx';
import { UpdatedAgo } from '../components/chrome/Chrome.tsx';
import { errors } from '../copy/errors.ts';
import { ladder as copy } from '../copy/ladder.ts';
import { getLadderMeta, getLadderPage, getManifest, getRankEntry, getRankShard, getUserDoc } from '../lib/data.ts';
import { CATEGORY_LABEL, fmtInt } from '../lib/format.ts';
import { entriesNewestFirst, useIdentity } from '../lib/identity.ts';
import { useData } from '../lib/useData.ts';
import { clampPage, ladderRows, pageForRank, stagePartition, type LadderRow } from '../lib/views.ts';

const isCategory = (s: string | undefined): s is Category => s !== undefined && (CATEGORIES as readonly string[]).includes(s);
const isStage = (s: string | null): s is CareerStage => s !== null && (STAGES as readonly string[]).includes(s);

export function Ladder() {
  const { category } = useParams();
  if (!isCategory(category)) return <Navigate to="/leaderboard/general" replace />;
  return <LadderInner category={category} />;
}

function LadderInner({ category }: { category: Category }) {
  const [params, setParams] = useSearchParams();
  const stage = isStage(params.get('stage')) ? (params.get('stage') as CareerStage) : null;
  const q = params.get('q') ?? '';
  const focus = params.get('focus');
  const pageParam = Number(params.get('page') ?? '1') || 1;
  const partition = stagePartition(stage);
  useIdentity();

  const meta = useData<{ meta: LadderMeta | null; buildId: string }>(
    async (signal) => {
      const manifest = await getManifest({ signal });
      if (!manifest) return null;
      return { meta: await getLadderMeta(category, manifest.build_id, { signal }), buildId: manifest.build_id };
    },
    [category],
    { every: 5 * 60_000 },
  );
  const pages = stage ? (meta.data?.meta?.stages[stage]?.pages ?? 1) : (meta.data?.meta?.pages ?? 1);
  const total = stage ? (meta.data?.meta?.stages[stage]?.total ?? 0) : (meta.data?.meta?.total ?? 0);
  const page = clampPage(pageParam, pages);
  const updatedAt = meta.data?.meta?.updated_at ?? null;

  const pageData = useData<LadderPage>(
    async (signal) => {
      if (!meta.data) return null;
      return getLadderPage(category, partition, page, meta.data.buildId, { signal });
    },
    [category, partition, page, meta.data?.buildId, updatedAt],
    { enabled: meta.data !== null },
  );

  // Crossfade changed rating cells when a refresh brings new numbers for the same rows.
  const prevRatings = useRef<Map<string, number>>(new Map());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const rows = useMemo(() => ladderRows(pageData.data), [pageData.data]);
  useEffect(() => {
    const next = new Map(rows.map((r) => [r.id, r.r]));
    const diff = new Set<string>();
    for (const [id, r] of next) {
      const prev = prevRatings.current.get(id);
      if (prev !== undefined && prev !== r) diff.add(id);
    }
    prevRatings.current = next;
    if (diff.size) {
      setChanged(diff);
      const t = window.setTimeout(() => setChanged(new Set()), 150);
      return () => window.clearTimeout(t);
    }
  }, [rows]);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      setParams(next);
    },
    [params, setParams],
  );

  // find me: the newest own entry that has a tuple on this ladder.
  const [findBusy, setFindBusy] = useState(false);
  const ownIds = entriesNewestFirst().map(([id]) => id);
  const canFindMe = ownIds.length > 0 && meta.data !== null;
  const findMe = async (): Promise<void> => {
    if (!meta.data) return;
    setFindBusy(true);
    try {
      for (const id of ownIds.slice(0, 5)) {
        const entry = await getRankEntry(id, meta.data.buildId).catch(() => null);
        const t = entry?.[RANK_KEY[category]];
        if (t && t[0] !== null) {
          update({ page: String(pageForRank(t[0], PAGE_SIZE)), focus: id, stage: null, q: null });
          return;
        }
      }
    } finally {
      setFindBusy(false);
    }
  };

  // Search: a handle → users doc → rank; an anon- prefix → the shard it lives in.
  const [search, setSearch] = useState<{ q: string; rows: LadderRow[] | null; loading: boolean }>({ q: '', rows: null, loading: false });
  useEffect(() => {
    const query = q.trim().toLowerCase();
    if (!query || !meta.data) {
      setSearch({ q: '', rows: null, loading: false });
      return;
    }
    const buildId = meta.data.buildId;
    let cancelled = false;
    setSearch({ q: query, rows: null, loading: true });
    const t = window.setTimeout(() => {
      void (async () => {
        const found: LadderRow[] = [];
        try {
          if (query.startsWith('anon-')) {
            const prefix = query.slice(5);
            if (prefix.length >= 2) {
              const shard = await getRankShard(prefix, buildId);
              for (const [id, e] of Object.entries(shard ?? {})) {
                if (id.startsWith(prefix)) {
                  const row = rowFromEntry(id, e, category);
                  if (row) found.push(row);
                }
              }
            }
          } else if (validateHandle(query) === 'ok') {
            const user = await getUserDoc(query);
            const current = user?.resumes.find((r) => r.current)?.id;
            if (current) {
              const e = await getRankEntry(current, buildId);
              const row = e ? rowFromEntry(current, e, category) : null;
              if (row) found.push(row);
            }
          }
        } catch {
          // a failed lookup reads as no hit; the filters stay usable
        }
        if (!cancelled) setSearch({ q: query, rows: found.sort((a, b) => a.rank - b.rank).slice(0, 50), loading: false });
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, meta.data, category]);

  const focusRow = focus ? rows.find((r) => r.id === focus) : undefined;
  const [focusVisible, setFocusVisible] = useState(true);
  useEffect(() => {
    if (!focusRow) return;
    const el = document.querySelector('tr[aria-current="true"]');
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(([e]) => setFocusVisible(e?.isIntersecting ?? true));
    obs.observe(el);
    return () => obs.disconnect();
  }, [focusRow, rows]);

  const label = CATEGORY_LABEL[category];
  const showingSearch = search.q.length > 0;
  return (
    <Page title={copy.title(label)} width="table">
      <div className="page-head">
        <div className="ladder-head">
          <h1 className="page-title">{copy.title(label)}</h1>
        </div>
        <span className="updated">
          {meta.data?.meta ? copy.rated(fmtInt(meta.data.meta.total)) : '—'}
          {updatedAt ? (
            <>
              {' · '}
              <UpdatedAgo at={updatedAt} />
            </>
          ) : null}
        </span>
      </div>
      <nav className="cat-row" aria-label="Ladders">
        {CATEGORIES.map((c) => (
          <Link key={c} to={`/leaderboard/${c}`} aria-current={c === category ? 'page' : undefined}>
            {c}
          </Link>
        ))}
      </nav>
      <LadderFilters
        stage={stage}
        q={q}
        onStage={(s) => update({ stage: s, page: null, focus: null })}
        onQuery={(v) => update({ q: v })}
        canFindMe={canFindMe && !findBusy}
        onFindMe={() => void findMe()}
        page={page}
        pages={pages}
        onPage={(n) => update({ page: String(clampPage(n, pages)), focus: null })}
        onJumpToRank={(rank) => update({ page: String(clampPage(pageForRank(rank, PAGE_SIZE), pages)), focus: null })}
      />
      {meta.error && !meta.data ? (
        <ErrorState title={errors.dataError.title} body={errors.dataError.body} retry={meta.reload} />
      ) : showingSearch ? (
        <div className="mt-4">
          {search.loading ? (
            <p className="muted small">Searching.</p>
          ) : search.rows && search.rows.length > 0 ? (
            <>
              <p className="muted small">{copy.searchResults(search.rows.length)}</p>
              <LeaderboardTable rows={search.rows} mode="full" />
            </>
          ) : (
            <EmptyState title={copy.empty.search.title} action={<Button variant="quiet" onClick={() => update({ q: null })}>Clear search</Button>} />
          )}
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <LeaderboardTable
              rows={rows}
              mode="full"
              focusId={focus}
              loading={pageData.loading || meta.loading}
              skeletonRows={Math.min(PAGE_SIZE, total || PAGE_SIZE)}
              changed={changed}
              emptyCell={
                pageData.error ? (
                  <>
                    {errors.dataError.title} {errors.dataError.body}{' '}
                    <Button variant="quiet" size="sm" onClick={pageData.reload}>
                      {errors.dataError.retry}
                    </Button>
                  </>
                ) : stage ? (
                  <>
                    {copy.empty.stage.title} {copy.empty.stage.body}
                  </>
                ) : (
                  <>
                    {copy.empty.none.title} {copy.empty.none.body}
                  </>
                )
              }
            />
          </div>
          <Cursor page={page} pages={pages} total={total} pageSize={PAGE_SIZE} onPage={(n) => update({ page: String(n), focus: null })} />
          {focusRow && !focusVisible ? <YouAreHereRow row={focusRow} onJump={() => document.querySelector('tr[aria-current="true"]')?.scrollIntoView({ block: 'center' })} /> : null}
        </>
      )}
    </Page>
  );
}

function rowFromEntry(id: string, e: RankEntry, category: Category): LadderRow | null {
  const t = e[RANK_KEY[category]];
  if (!t || t[0] === null) return null;
  const [rank, , r, rd, , w, l, d, d7, , top] = t;
  return {
    rank,
    id,
    identity: e.v === 'handle' && e.h ? { kind: 'handle', value: e.h } : { kind: 'anon', value: anonIdOf(id) },
    tier: tierFor(r),
    r,
    pm: Math.round(1.96 * rd),
    w,
    l,
    d,
    stage: e.st,
    sig: e.sig,
    d7,
    top: top ?? 1,
  };
}
