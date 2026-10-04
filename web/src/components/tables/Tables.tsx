// LeaderboardTable, LadderFilters, Cursor, YouAreHereRow, MatchList, RatingHistoryTable, Chip.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { STAGES, type CareerStage } from '@resumearena/shared';
import { ladder as copy } from '../../copy/ladder.ts';
import { result as rcopy } from '../../copy/result.ts';
import { fmtDate, fmtInt, fmtRelative, STAGE_LABEL, truncateEllipsis } from '../../lib/format.ts';
import { pageForRank, type HistoryEvent, type LadderRow, type MatchView } from '../../lib/views.ts';
import { Button } from '../forms/Button.tsx';
import { SelectField, TextField } from '../forms/Fields.tsx';
import { Skeleton } from '../forms/States.tsx';
import { Num, Outcome, Record, TierLabel } from '../numbers/Numbers.tsx';

export function Chip({ children, variant = 'default', title }: { children: ReactNode; variant?: 'default' | 'warn' | 'provisional'; title?: string }) {
  return (
    <span className={['chip', variant === 'default' ? '' : `chip--${variant}`].join(' ').trim()} title={title}>
      {children}
    </span>
  );
}

export interface LeaderboardTableProps {
  rows: LadderRow[];
  mode: 'compact' | 'full';
  focusId?: string | null;
  loading?: boolean;
  skeletonRows?: number;
  /** Row ids whose rating changed in the last refresh (150 ms crossfade). */
  changed?: ReadonlySet<string>;
  emptyCell?: ReactNode;
}

const identityCell = (row: LadderRow): ReactNode =>
  row.identity.kind === 'handle' ? <Link to={`/u/${row.identity.value}`}>{row.identity.value}</Link> : <Link to={`/r/${row.id}`} className="mono">{row.identity.value}</Link>;

export function LeaderboardTable({ rows, mode, focusId = null, loading = false, skeletonRows = 10, changed, emptyCell }: LeaderboardTableProps) {
  const full = mode === 'full';
  const focusRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (focusId && focusRef.current) focusRef.current.scrollIntoView({ block: 'center' });
  }, [focusId, rows]);
  const cols = full ? 9 : 4;
  return (
    <table className={['data', full ? 'data--sticky ladder-table' : ''].join(' ').trim()}>
      <thead>
        <tr>
          <th scope="col" className="num">
            {copy.columns.rank}
          </th>
          <th scope="col">{copy.columns.identity}</th>
          <th scope="col" className="col-tier">
            {copy.columns.tier}
          </th>
          <th scope="col" className="num">
            {copy.columns.rating}
          </th>
          {full ? (
            <>
              <th scope="col" className="num">
                {copy.columns.pm}
              </th>
              <th scope="col" className="num">
                {copy.columns.record}
              </th>
              <th scope="col">{copy.columns.stage}</th>
              <th scope="col">{copy.columns.signal}</th>
              <th scope="col" className="num col-d7">
                {copy.columns.d7}
              </th>
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {loading && rows.length === 0
          ? Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`s${i}`}>
                {Array.from({ length: cols }, (_, j) => (
                  <td key={j} className={j === 0 || j === 3 ? 'num' : undefined}>
                    <span className="muted num">—</span>
                  </td>
                ))}
              </tr>
            ))
          : null}
        {!loading && rows.length === 0 && emptyCell ? (
          <tr>
            <td colSpan={cols} className="empty-cell">
              {emptyCell}
            </td>
          </tr>
        ) : null}
        {rows.map((row) => {
          const isYou = focusId === row.id;
          return (
            <tr key={row.id} ref={isYou ? focusRef : undefined} aria-current={isYou ? 'true' : undefined}>
              <td className="num">
                <Num value={row.rank} />
              </td>
              <td className="col-identity">
                {identityCell(row)}
                {isYou ? <span className="you-mark">◂ {copy.you}</span> : null}
              </td>
              <td className="col-tier">
                <TierLabel tier={row.tier} />
              </td>
              <td className="num">
                <span className="cell-fade" data-changed={changed?.has(row.id) ? 'true' : undefined}>
                  <Num value={row.r} kind="rating" />
                </span>
              </td>
              {full ? (
                <>
                  <td className="num muted">
                    <Num value={row.pm} />
                  </td>
                  <td className="num">
                    <Record w={row.w} l={row.l} d={row.d} />
                  </td>
                  <td>{STAGE_LABEL[row.stage]}</td>
                  <td>{row.sig ? <Chip title={row.sig}>{truncateEllipsis(row.sig, 18)}</Chip> : null}</td>
                  <td className="num col-d7">
                    <Num value={row.d7} kind="delta" />
                  </td>
                </>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface LadderFiltersProps {
  stage: CareerStage | null;
  q: string;
  onStage(stage: CareerStage | null): void;
  onQuery(q: string): void;
  canFindMe: boolean;
  onFindMe(): void;
  page: number;
  pages: number;
  onPage(n: number): void;
  onJumpToRank(rank: number): void;
}

export function LadderFilters({ stage, q, onStage, onQuery, canFindMe, onFindMe, page, pages, onPage, onJumpToRank }: LadderFiltersProps) {
  return (
    <div className="filters">
      <SelectField
        label={copy.filters.stage}
        value={stage ?? ''}
        options={[{ value: '', label: copy.filters.any }, ...STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))]}
        onChange={(v) => onStage((v || null) as CareerStage | null)}
      />
      <TextField label={copy.filters.search} value={q} onChange={onQuery} placeholder={copy.filters.searchPlaceholder} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      {canFindMe ? (
        <Button variant="secondary" onClick={onFindMe}>
          {copy.filters.findMe}
        </Button>
      ) : null}
      <PageInput page={page} pages={pages} onPage={onPage} onJumpToRank={onJumpToRank} />
    </div>
  );
}

function PageInput({ page, pages, onPage, onJumpToRank }: { page: number; pages: number; onPage(n: number): void; onJumpToRank(rank: number): void }) {
  const [text, setText] = useState(String(page));
  useEffect(() => setText(String(page)), [page]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const t = text.trim();
    if (t.startsWith('#')) {
      const rank = Number(t.slice(1).replace(/,/g, ''));
      if (Number.isFinite(rank) && rank > 0) onJumpToRank(rank);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n)) onPage(n);
  };
  return (
    <form className="field" onSubmit={submit}>
      <label className="field-label" htmlFor="ladder-page">
        {copy.filters.page}
      </label>
      <input id="ladder-page" className="cursor-input" value={text} onChange={(e) => setText(e.target.value)} inputMode="numeric" aria-describedby="ladder-page-help" />
      <span id="ladder-page-help" className="field-help">
        {copy.filters.jumpHint} · {pages} pages
      </span>
    </form>
  );
}

export interface CursorProps {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage(n: number): void;
}

/** Numbered pages, because pages are files. */
export function Cursor({ page, pages, total, pageSize, onPage }: CursorProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="cursor" aria-label="Pages">
      <span className="num muted">{copy.cursor.range(fmtInt(from), fmtInt(to), fmtInt(total))}</span>
      <div className="cursor-controls">
        <Button variant="quiet" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ◂ {copy.cursor.newer}
        </Button>
        <span className="num">{copy.cursor.of(page, Math.max(1, pages))}</span>
        <Button variant="quiet" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {copy.cursor.older} ▸
        </Button>
      </div>
    </nav>
  );
}

export function YouAreHereRow({ row, onJump, pageSize = 100 }: { row: LadderRow; onJump(page: number): void; pageSize?: number }) {
  return (
    <div className="you-row" role="note">
      <span className="num">
        <Num value={row.rank} kind="rank" />
      </span>
      <span>{row.identity.value}</span>
      <span className="num">
        <Num value={row.r} kind="rating" />
      </span>
      <Button variant="quiet" size="sm" onClick={() => onJump(pageForRank(row.rank, pageSize))}>
        {copy.jump}
      </Button>
    </div>
  );
}

export function MatchList({ matches, limit = 10, now = Date.now() }: { matches: MatchView[]; limit?: number; now?: number }) {
  const rows = matches.slice(0, limit);
  return (
    <table className="data match-rows">
      <thead>
        <tr>
          <th scope="col">{rcopy.matches.columns.result}</th>
          <th scope="col">{rcopy.matches.columns.opponent}</th>
          <th scope="col" className="num">
            {rcopy.matches.columns.delta}
          </th>
          <th scope="col">{rcopy.matches.columns.note}</th>
          <th scope="col">when</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td>
              <Outcome value={m.outcome} />
            </td>
            <td>
              {m.opponentHref ? <Link to={m.opponentHref}>{m.opponentIdentity}</Link> : <span className="muted">{m.opponentIdentity}</span>}
              <span className="muted xs"> · {m.category}</span>
            </td>
            <td className="num">
              <Num value={m.delta} kind="delta" />
            </td>
            <td className="note-cell">
              <span className="match-note" title={m.note}>
                {m.note}
              </span>
            </td>
            <td className="muted nowrap xs" title={fmtDate(m.at)}>
              {fmtRelative(m.at, now)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RatingHistoryTable({ events, pageSize = 50 }: { events: HistoryEvent[]; pageSize?: number }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(events.length / pageSize));
  const slice = events.slice((page - 1) * pageSize, page * pageSize);
  return (
    <div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">date</th>
            <th scope="col">event</th>
            <th scope="col" className="num">
              rating
            </th>
            <th scope="col" className="num">
              ±
            </th>
          </tr>
        </thead>
        <tbody>
          {slice.map((e, i) => (
            <tr key={`${e.date}-${i}`}>
              <td className="num">{e.date}</td>
              <td>{e.label}</td>
              <td className="num">
                <Num value={e.r} kind="rating" />
              </td>
              <td className="num muted">
                <Num value={Math.round(1.96 * e.rd)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 ? <Cursor page={page} pages={pages} total={events.length} pageSize={pageSize} onPage={setPage} /> : null}
    </div>
  );
}

export { Skeleton };
