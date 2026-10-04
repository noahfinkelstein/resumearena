// KeyInput, EntrySummary, VisibilityControl, DeleteEntry, DeviceKeys.
import { useState } from 'react';
import { Link } from 'react-router';
import { formatOwnerKey, parseOwnerKey, validateHandle, type SubmissionPayload } from '@resumearena/shared';
import { me as copy } from '../../copy/me.ts';
import { fmtDate } from '../../lib/format.ts';
import type { ProfileView, ResultView } from '../../lib/views.ts';
import { Button } from '../forms/Button.tsx';
import { ConfirmDialog } from '../forms/ConfirmDialog.tsx';
import { TextField, Toggle } from '../forms/Fields.tsx';
import { RatingDisplay, TierLabel } from '../numbers/Numbers.tsx';
import { Chip } from '../tables/Tables.tsx';
import { FallbackPanel } from '../upload/Upload.tsx';

// ---- KeyInput ---------------------------------------------------------------------------------

export interface KeyInputProps {
  initialHandle?: string;
  busy?: boolean;
  error?: { title: string; body: string } | null;
  onKey(canonicalKey: string, handle: string): void;
}

export function KeyInput({ initialHandle = '', busy = false, error = null, onKey }: KeyInputProps) {
  const [key, setKey] = useState('');
  const [handle, setHandle] = useState(initialHandle);
  const parsed = parseOwnerKey(key);
  const handleOk = validateHandle(handle.trim()) === 'ok';
  const keyError = key.trim().length > 0 && parsed === null ? copy.errors.notAKey.body : undefined;
  return (
    <div>
      <TextField label={copy.keyInput.label} value={key} onChange={setKey} placeholder={copy.keyInput.placeholder} helper={copy.keyInput.helper} mono autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" {...(keyError ? { error: keyError } : {})} />
      <TextField label={copy.keyInput.handleLabel} value={handle} onChange={(v) => setHandle(v.toLowerCase())} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" maxLength={20} />
      {error ? (
        <div className="state" role="alert">
          <p className="state-title">{error.title}</p>
          <p className="state-body">{error.body}</p>
        </div>
      ) : null}
      <div className="actions">
        <Button variant="secondary" disabled={!parsed || !handleOk || busy} onClick={() => parsed && onKey(parsed, handle.trim())}>
          {busy ? copy.keyInput.checking : copy.keyInput.use}
        </Button>
      </div>
    </div>
  );
}

// ---- EntrySummary -----------------------------------------------------------------------------

export function EntrySummary({ profile, result }: { profile: ProfileView; result: ResultView | null }) {
  const primary = result?.primaryRating ?? result?.generalRating ?? null;
  const identity = result ? result.identity.value : profile.visibility === 'handle' ? profile.handle : profile.handle;
  return (
    <div>
      <p className="ident-line">
        <span className="ident">{identity}</span>
        {profile.visibility ? <span>{profile.visibility === 'handle' ? 'handle shown' : 'anonymous'}</span> : null}
        {result ? <span>{copy.summary.submitted(fmtDate(result.createdAt))}</span> : null}
        <Chip>{copy.summary.versions(profile.versions)}</Chip>
      </p>
      <div className="mt-4">
        {primary ? (
          <RatingDisplay size="md" rating={primary.r} pm={primary.pm} tier={primary.tier} provisional={primary.provisional ? primary.placement : null} delta7={primary.delta7} />
        ) : (
          <p className="muted">{result ? copy.summary.analysed : copy.summary.pending}</p>
        )}
        {primary && !primary.provisional ? (
          <p className="muted small mt-2">
            {primary.category} · <TierLabel tier={primary.tier} />
          </p>
        ) : null}
      </div>
      {profile.currentId ? (
        <p className="mt-3">
          <Link to={`/r/${profile.currentId}`}>{copy.summary.result} →</Link>
        </p>
      ) : null}
    </div>
  );
}

// ---- VisibilityControl ------------------------------------------------------------------------

export interface VisibilityControlProps {
  value: 'anonymous' | 'handle';
  pending: { since: number; next: 'anonymous' | 'handle'; timedOut: boolean } | null;
  sending: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onDispatch(next: 'anonymous' | 'handle'): void;
}

export function VisibilityControl({ value, pending, sending, disabled = false, disabledReason, onDispatch }: VisibilityControlProps) {
  const shown = pending ? pending.next === 'handle' : value === 'handle';
  const reason = sending ? copy.visibility.sending : pending ? (pending.timedOut ? copy.visibility.notApplied : copy.visibility.received) : disabledReason;
  return (
    <Toggle label={copy.visibility.label} checked={shown} disabled={disabled || sending || (pending !== null && !pending.timedOut)} {...(reason ? { disabledReason: reason } : {})} onChange={(next) => onDispatch(next ? 'handle' : 'anonymous')} />
  );
}

// ---- DeleteEntry ------------------------------------------------------------------------------

export interface DeleteEntryProps {
  handle: string;
  id: string;
  onDispatch(): Promise<'ok' | 'down' | 'failed'>;
  fallbackPayload: SubmissionPayload | null;
  disabled?: boolean;
}

export function DeleteEntry({ handle, id, onDispatch, fallbackPayload, disabled = false }: DeleteEntryProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'down' | 'failed'>('idle');
  const confirm = async (): Promise<void> => {
    setState('sending');
    const r = await onDispatch();
    setState(r === 'ok' ? 'done' : r);
    if (r === 'ok') setOpen(false);
  };
  if (state === 'done') return <p role="status">{copy.del.received}</p>;
  return (
    <div>
      <p>{copy.del.line}</p>
      <p className="wry">{copy.del.wry}</p>
      <div className="actions">
        <Button variant="destructive" disabled={disabled} onClick={() => setOpen(true)}>
          {copy.del.button}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={copy.del.dialogTitle}
        body={copy.del.dialogBody}
        confirmLabel={state === 'sending' ? '…' : copy.del.button}
        confirmMatch={handle}
        confirmMatchLabel={copy.del.confirmLabel}
        destructive
        onConfirm={() => void confirm()}
        onCancel={() => {
          setOpen(false);
          setState('idle');
        }}
        extra={
          state === 'down' || state === 'failed' ? (
            fallbackPayload ? (
              <FallbackPanel payload={fallbackPayload} reason={state === 'down' ? 'revoked' : 'refused'} onOpened={() => setState('done')} />
            ) : (
              <p className="field-error mt-3">{copy.errors.channelDown.body}</p>
            )
          ) : null
        }
      />
      <span className="sr-only">{id}</span>
    </div>
  );
}

// ---- DeviceKeys -------------------------------------------------------------------------------

export function DeviceKeys({ handle, keyString, onForget }: { handle: string; keyString: string; onForget(): void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  if (forgotten) return <p role="status">{copy.device.forgotten}</p>;
  return (
    <div>
      <div className="actions" style={{ marginTop: 0 }}>
        <Button variant="quiet" onClick={() => setShown((s) => !s)}>
          {shown ? copy.device.hide : copy.device.show}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            onForget();
            setForgotten(true);
          }}
        >
          {copy.device.forget}
        </Button>
      </div>
      {shown ? (
        <div className="mt-3">
          <div className="key-string" aria-label={`Owner key for ${handle}`}>
            {formatOwnerKey(keyString)}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(formatOwnerKey(keyString));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                // user-select: all covers the manual path
              }
            }}
          >
            {copied ? copy.device.copied : copy.device.copy}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
