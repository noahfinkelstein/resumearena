import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CATEGORIES, type ArenaPair, type ArenaPool, type Category } from '@resumearena/shared';
import { ArenaCard, CategoryPicker, JudgeReveal, StreakCounter } from '../components/arena/Arena.tsx';
import { Page } from '../components/chrome/Chrome.tsx';
import { Button } from '../components/forms/Button.tsx';
import { EmptyState, ErrorState } from '../components/forms/States.tsx';
import { arena as copy } from '../copy/arena.ts';
import { errors } from '../copy/errors.ts';
import { agreementPct, applyGuess, markSeen, MIN_PAIRS, nextCategory, prepareQueue, type Guess } from '../lib/arena.ts';
import { getArenaPool, getManifest, getRankEntries, type RankLookup } from '../lib/data.ts';
import { useIdentity } from '../lib/identity.ts';
import { readArena, writeArena } from '../lib/storage.ts';
import { useData } from '../lib/useData.ts';
import { EMPTY_LOOKUP, opponentLabel } from '../lib/views.ts';

const isCategory = (s: string | null): s is Category => s !== null && (CATEGORIES as readonly string[]).includes(s);

export function Arena() {
  const [params, setParams] = useSearchParams();
  const [stored, setStored] = useState(() => readArena());
  // The default ladder is resolved once per visit (the rotation advances per visit, not per render): deriving
  // it from stored.lastCategory on every render would move it again each time the effect below records it,
  // and every move re-ran the pool loader.
  const [defaultCategory] = useState<Category>(() => nextCategory(stored.lastCategory));
  const category: Category = isCategory(params.get('category')) ? (params.get('category') as Category) : defaultCategory;
  const { entries } = useIdentity();
  const ownIds = useMemo(() => new Set(Object.keys(entries)), [entries]);

  // Record the ladder being played: once on arrival, then only when the person switches.
  useEffect(() => {
    if (stored.lastCategory === category) return;
    const next = { ...stored, lastCategory: category };
    setStored(next);
    writeArena(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const pool = useData<{ pool: ArenaPool | null; buildId: string | null }>(
    async (signal) => {
      const manifest = await getManifest({ signal });
      if (!manifest) return { pool: null, buildId: null };
      return { pool: await getArenaPool(category, manifest.build_id, { signal }), buildId: manifest.build_id };
    },
    [category],
  );

  const [queue, setQueue] = useState<ArenaPair[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [identities, setIdentities] = useState<RankLookup>(EMPTY_LOOKUP);
  const [wry, setWry] = useState<string | null>(null);

  useEffect(() => {
    const pairs = pool.data?.pool?.pairs ?? [];
    const q = prepareQueue(pairs, { seen: stored.seen, ownIds });
    setQueue(q.fresh);
    setExhausted(q.exhausted);
    setGuess(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.data, ownIds]);

  const pair = queue[0] ?? null;
  const total = pool.data?.pool?.pairs.length ?? 0;
  const enough = total >= MIN_PAIRS;

  const reveal = useCallback(
    async (g: Guess) => {
      if (!pair || guess) return;
      const r = applyGuess(stored, pair, g);
      setStored(r.state);
      writeArena(r.state);
      setGuess(g);
      setAgreed(r.agreed);
      setWry(r.state.streak === 10 ? copy.wryTen : r.state.disagreeRun === 5 ? copy.wryFive : null);
      const buildId = pool.data?.buildId;
      if (buildId) setIdentities(await getRankEntries([pair.a.id, pair.b.id], buildId, { max: 2 }));
    },
    [pair, guess, stored, pool.data],
  );

  const next = useCallback(() => {
    if (!pair) return;
    setQueue((q) => q.slice(1));
    setGuess(null);
    setIdentities(EMPTY_LOOKUP);
    if (queue.length <= 1) setExhausted(true);
  }, [pair, queue.length]);

  const skip = useCallback(() => {
    if (!pair) return;
    const s = markSeen(stored, pair.m);
    setStored(s);
    writeArena(s);
    next();
  }, [pair, stored, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!pair) return;
      if (guess) {
        if (e.key === 'Enter') {
          e.preventDefault();
          next();
        }
        return;
      }
      if (e.key === '1' || e.key === 'ArrowLeft') void reveal('A');
      else if (e.key === '2' || e.key === 'ArrowRight') void reveal('B');
      else if (e.key === '=') void reveal('draw');
      else if (e.key === 's' || e.key === 'S') skip();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pair, guess, reveal, next, skip]);

  const setCategory = (c: Category): void => {
    setParams({ category: c }, { replace: true });
  };

  return (
    <Page title={copy.title} width="prose">
      <div className="arena-head">
        <h1 className="page-title">{copy.title}</h1>
        <StreakCounter streak={stored.streak} guesses={stored.guesses} agreedPct={agreementPct(stored)} />
      </div>
      <div className="inline-list" style={{ alignItems: 'end' }}>
        <CategoryPicker value={category} onChange={setCategory} />
        <details className="small" style={{ paddingBottom: '0.5rem' }}>
          <summary className="muted">?</summary>
          <p className="muted prose mt-2">{copy.explainer}</p>
        </details>
      </div>

      {pool.error && !pool.data ? (
        <ErrorState title={errors.dataError.title} body={errors.dataError.body} retry={pool.reload} />
      ) : pool.loading && !pool.data ? (
        <div className="arena-pair mt-5">
          <div className="arena-card" style={{ minHeight: '20rem' }} />
          <div className="arena-card" style={{ minHeight: '20rem' }} />
        </div>
      ) : !enough ? (
        <EmptyState title={copy.empty.title} body={copy.empty.body} />
      ) : !pair ? (
        <EmptyState
          title={exhausted ? copy.exhausted.title : copy.empty.title}
          body={exhausted ? copy.exhausted.body : copy.empty.body}
          action={
            <Link to={`/arena?category=${nextCategory(category)}`} className="btn btn--secondary">
              {copy.anotherLadder}
            </Link>
          }
        />
      ) : (
        <>
          <h2 className="arena-question">{copy.question}</h2>
          <div className="arena-pair">
            <ArenaCard side="A" card={pair.a.card} hotkey="1" chosen={guess === 'A'} winner={guess !== null && pair.w === 'A'} onPick={guess ? undefined : () => void reveal('A')} />
            <ArenaCard side="B" card={pair.b.card} hotkey="2" chosen={guess === 'B'} winner={guess !== null && pair.w === 'B'} onPick={guess ? undefined : () => void reveal('B')} />
          </div>
          <div className="arena-bar">
            {guess ? (
              <Button variant="secondary" onClick={next} autoFocus>
                {copy.next} <kbd className="kbd">Enter</kbd>
              </Button>
            ) : (
              <>
                <Button variant="primary" onClick={() => void reveal('A')} className="small-only">
                  {copy.a}
                </Button>
                <Button variant="quiet" onClick={() => void reveal('draw')}>
                  {copy.tooClose} <kbd className="kbd">=</kbd>
                </Button>
                <Button variant="quiet" onClick={skip}>
                  {copy.skip} <kbd className="kbd">s</kbd>
                </Button>
                <Button variant="primary" onClick={() => void reveal('B')} className="small-only">
                  {copy.b}
                </Button>
              </>
            )}
          </div>
          {guess ? (
            <>
              <JudgeReveal pair={pair} guess={guess} agreed={agreed} identities={{ a: opponentLabel(pair.a.id, identities), b: opponentLabel(pair.b.id, identities) }} />
              {wry ? <p className="wry">{wry}</p> : null}
            </>
          ) : null}
        </>
      )}
    </Page>
  );
}
