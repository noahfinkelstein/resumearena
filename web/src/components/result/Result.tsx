// PollingStatus, Verdict, StrengthsWeaknesses, AtsPanel, RedFlags, SubmittedText, ShareButton, ManageLink.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { LayoutMetrics, ResumeAnalysis } from '@resumearena/shared';
import { result as copy } from '../../copy/result.ts';
import { fmtClock, fmtElapsed, fmtInt } from '../../lib/format.ts';
import type { Phase, Placement } from '../../lib/polling.ts';
import { useClock } from '../../lib/useData.ts';
import type { SubScoreView } from '../../lib/views.ts';
import { Button } from '../forms/Button.tsx';
import { useToast } from '../forms/Toast.tsx';
import { Num, ScoreBars } from '../numbers/Numbers.tsx';
import { Chip } from '../tables/Tables.tsx';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

// ---- PollingStatus ----------------------------------------------------------------------------

export interface PollingStatusProps {
  phase: Phase;
  mode: 'submitter' | 'visitor';
  via: 'dispatch' | 'issue';
  submittedAt: number;
  placement: Placement | null;
  queueAhead: number | null;
  compact?: boolean;
  onResubmit?: () => void;
}

interface Row {
  key: string;
  label: string;
  secondary?: string;
}

function rowsFor(p: PollingStatusProps): { rows: Row[]; current: number } {
  const time = fmtClock(new Date(p.submittedAt));
  const s = copy.state;
  if (p.mode === 'visitor') {
    const rows: Row[] = [{ key: 'publishing', label: s.visitor.publishing }, { key: 'analysed', label: s.visitor.analysed }, { key: 'placing', label: s.visitor.placing }, { key: 'rated', label: s.visitor.rated }];
    const current = p.phase === 'rated' ? 4 : p.phase === 'placing' || p.phase === 'budget_wait' ? 2 : p.phase === 'analysed' ? 1 : 0;
    if (p.phase === 'budget_wait') rows[2] = { key: 'budget', label: s.budgetWait.label, secondary: s.budgetWait.secondary };
    return { rows, current };
  }
  const first: Row =
    p.phase === 'stale'
      ? { key: 'stale', label: s.stale.label, secondary: s.stale.secondary }
      : p.phase === 'not_seen'
        ? { key: 'not_seen', label: s.notSeen.label, secondary: s.notSeen.secondary }
        : p.via === 'issue'
          ? { key: 'fallback', label: s.fallbackPending.label, secondary: s.fallbackPending.secondary }
          : { key: 'dispatched', label: s.dispatched.label, secondary: s.dispatched.secondary(time) };
  const analysed: Row = { key: 'analysed', label: s.analysed.label, secondary: p.queueAhead !== null && p.phase === 'analysed' ? `${s.analysed.secondary} ${s.analysedAhead(p.queueAhead)}` : s.analysed.secondary };
  const placing: Row =
    p.phase === 'budget_wait'
      ? { key: 'budget', label: s.budgetWait.label, secondary: s.budgetWait.secondary }
      : { key: 'placing', label: s.placing.label(p.placement?.done ?? 0, p.placement?.total ?? 8), secondary: s.placing.secondary };
  const rows = [first, analysed, placing, { key: 'rated', label: s.rated.label }];
  const current = p.phase === 'rated' ? 4 : p.phase === 'placing' || p.phase === 'budget_wait' ? 2 : p.phase === 'analysed' ? 1 : 0;
  return { rows, current };
}

/** File polls only. Each row: a 10 px square (hollow ahead, accent done, fg current) and a label. */
export function PollingStatus(props: PollingStatusProps) {
  const now = useClock(1000);
  const { rows, current } = rowsFor(props);
  const visible = props.compact ? rows.filter((_, i) => i === Math.min(current, rows.length - 1)) : rows;
  const offset = props.compact ? Math.min(current, rows.length - 1) : 0;
  return (
    <ol className={['poll', props.compact ? 'poll--compact' : ''].join(' ').trim()}>
      {visible.map((row, j) => {
        const i = j + offset;
        const state = i < current ? 'done' : i === current ? 'current' : 'ahead';
        return (
          <li key={row.key} className={`poll-row poll-row--${state}`}>
            <span className={`poll-square poll-square--${state}`} aria-hidden="true" />
            <div>
              <div className="poll-label" aria-live={state === 'current' ? 'polite' : undefined}>
                <span>{row.label}</span>
                {state === 'current' && props.phase !== 'rated' ? (
                  <span className="poll-elapsed" aria-hidden="true">
                    {fmtElapsed(now - props.submittedAt)}
                  </span>
                ) : null}
                {state === 'current' && props.phase === 'stale' && props.onResubmit ? (
                  <Button variant="quiet" size="sm" onClick={props.onResubmit}>
                    {copy.state.staleResubmit}
                  </Button>
                ) : null}
              </div>
              {state === 'current' && row.secondary ? <div className="poll-secondary">{row.secondary}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---- Analysis sections ------------------------------------------------------------------------

export function Verdict({ text }: { text: string }) {
  return <p className="verdict">{text}</p>;
}

export function StrengthsWeaknesses({ strengths, weaknesses }: { strengths: string[]; weaknesses: string[] }) {
  return (
    <div className="two-col">
      <div>
        <h3>{copy.section.strengths}</h3>
        <ul>
          {strengths.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3>{copy.section.weaknesses}</h3>
        <ul>
          {weaknesses.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AtsPanel({ score, fixes, factors, target }: { score: number; fixes: ResumeAnalysis['ats']['fixes']; factors: SubScoreView[]; target: string }) {
  return (
    <div>
      <p className="verdict">
        <Num value={score} /> / 100
        <span className="muted small"> · {copy.ats.target(target)}</span>
      </p>
      <h3 className="mt-4 small">{copy.ats.fixes}</h3>
      <ul className="ats-fixes">
        {[...fixes]
          .sort((x, y) => PRIORITY_ORDER[x.priority] - PRIORITY_ORDER[y.priority])
          .map((f, i) => (
            <li key={i}>
              <span className="muted">{f.issue}</span>
              <span className="ats-arrow" aria-hidden="true">
                {' '}
                →{' '}
              </span>
              <span className="sr-only">. {copy.ats.fixLabel} </span>
              {f.fix} <Chip variant={f.priority === 'high' ? 'warn' : 'default'}>{copy.ats.priority(f.priority)}</Chip>
            </li>
          ))}
      </ul>
      <details className="mt-4">
        <summary>{copy.ats.factors}</summary>
        <div className="mt-3">
          <ScoreBars rows={factors} expandable />
        </div>
      </details>
    </div>
  );
}

export function RedFlags({ flags }: { flags: ResumeAnalysis['red_flags'] }) {
  const shown = flags.filter((f) => f.severity !== 'low');
  if (shown.length === 0) return null;
  return (
    <div className="flags">
      <ul>
        {shown.map((f, i) => (
          <li key={i}>
            {f.detail} <span className="muted xs">· {f.type.replace(/_/g, ' ')} · {f.severity} · {f.location}</span>
          </li>
        ))}
      </ul>
      <p className="muted small mt-3">{copy.redFlags.note}</p>
    </div>
  );
}

export function SubmittedText({ text, metrics, isOwner }: { text: string; metrics: LayoutMetrics | null; isOwner: boolean }) {
  const chars = fmtInt(text.length);
  const summary = !metrics || metrics.source === 'paste' ? copy.textSummaryPaste(chars) : metrics.source === 'docx' ? copy.textSummaryDocx(chars) : copy.textSummary(chars, metrics.pages, metrics.columns_detected);
  return (
    <div>
      <details className="submitted-text">
        <summary>{summary}</summary>
        <pre>{text}</pre>
      </details>
      <p className="public-footer">
        {copy.publicFooter}
        {isOwner ? (
          <>
            {' '}
            <Link to="/me">{copy.publicFooterOwner}</Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

export function ShareButton({ url, pendingHint = false }: { url: string; pendingHint?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await navigator.clipboard.writeText(url);
          toast.show(pendingHint ? copy.shareToastPending : copy.shareToast);
        } catch {
          toast.show(url);
        } finally {
          setBusy(false);
        }
      }}
    >
      {copy.share}
    </Button>
  );
}

export function ManageLink({ handle }: { handle: string }) {
  return (
    <Link to={`/me?handle=${encodeURIComponent(handle)}`} className="small">
      {copy.manage}
    </Link>
  );
}

export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="muted small mt-3">{children}</p>;
}
