import type { PublicStatus } from '@resumearena/shared';
import { about as copy } from '../../copy/about.ts';
import { fmtClockUtc, fmtCount, fmtDateTimeUtc, fmtUpdatedAgo, fmtUsd, shortSha } from '../../lib/format.ts';
import type { ProbeResult } from '../../lib/github.ts';
import { useClock } from '../../lib/useData.ts';

export interface StatusBlockProps {
  status: PublicStatus | null;
  channel: ProbeResult | 'checking';
  error?: boolean;
}

const DAY = 86_400_000;

/** A status, not a dashboard: a two-column mono table from status.json plus the one API probe. */
export function StatusBlock({ status, channel, error = false }: StatusBlockProps) {
  const now = useClock(30_000);
  const s = status;
  const over = s ? s.budget.spent_usd >= s.budget.daily_usd || s.budget.exhausted : false;
  const rerankStale = s?.last_rerank ? now - new Date(s.last_rerank.at).getTime() > 30 * 60_000 : false;
  const tokenSoon = s?.health.token_expires ? new Date(s.health.token_expires).getTime() - now < 14 * DAY : false;
  const row = (label: string, value: React.ReactNode, cls?: 'warn' | 'bad') => (
    <tr className={cls} key={label}>
      <td>{label}</td>
      <td>{value}</td>
    </tr>
  );
  return (
    <div>
      <div className="status-head">
        <span>{copy.status.heading}</span>
        <span className="updated">{s ? copy.status.asOf(fmtClockUtc(s.updated_at), fmtUpdatedAgo(s.updated_at, now).replace('updated ', '')) : '—'}</span>
      </div>
      <table className="status-block">
        <tbody>
          {row(copy.status.rows.awaitingAnalysis, s ? fmtCount(s.queue.analysis) : '—')}
          {row(copy.status.rows.awaitingPlacement, s ? fmtCount(s.queue.placement) : '—')}
          {row(copy.status.rows.spend, s ? `${fmtUsd(s.budget.spent_usd)} of ${fmtUsd(s.budget.daily_usd)}${over ? ` · ${copy.status.overBudget}` : ''}` : '—', over ? 'bad' : undefined)}
          {row(
            copy.status.rows.lastRerank,
            s?.last_rerank ? `${fmtDateTimeUtc(s.last_rerank.at)} · ${fmtCount(s.last_rerank.matches)} matches · ${s.last_rerank.placements_completed} placed${s.last_rerank.state !== 'ok' ? ` · ${s.last_rerank.state}` : ''}` : '—',
            rerankStale ? 'warn' : undefined,
          )}
          {row(copy.status.rows.lastDeploy, s ? `${fmtDateTimeUtc(s.deployed_at)} · ${shortSha(s.build_id)}` : '—')}
          {/* counts.rated sums the four ladders (one resume on three ladders counts three times); every rated entry is on the general ladder, so its board size is the distinct count. */}
          {row(copy.status.rows.rated, s ? fmtCount(s.per_category.general.rated) : '—')}
          {row(copy.status.rows.matches, s ? fmtCount(s.counts.matches) : '—')}
          {row(copy.status.rows.channel, channel === 'checking' ? copy.status.channel.checking : channel === 'ok' ? copy.status.channel.open : channel === 'limited' ? copy.status.channel.limited : copy.status.channel.down, channel === 'ok' || channel === 'checking' ? undefined : 'warn')}
          {row(copy.status.rows.paused, s ? (s.paused ? copy.status.paused : copy.status.open) : '—', s?.paused ? 'bad' : undefined)}
          {row(copy.status.rows.schedule, s ? (s.health.schedule_enabled ? copy.status.schedule.on : copy.status.schedule.off) : '—', s && !s.health.schedule_enabled ? 'bad' : undefined)}
          {row(copy.status.rows.token, s?.health.token_expires ?? '—', tokenSoon ? 'warn' : undefined)}
          {row(copy.status.rows.alerts, s ? (s.health.alerts.length ? s.health.alerts.join(', ') : copy.status.none) : '—', s && s.health.alerts.length ? 'bad' : undefined)}
          {error ? row(' ', copy.status.error, 'warn') : null}
        </tbody>
      </table>
      <p className="wry">{copy.status.wry}</p>
    </div>
  );
}
