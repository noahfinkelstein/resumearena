// Upload components: StepRail, FileDropzone, PasteBox, RedactionPreview, RedactionPanel, MetricsLine,
// PublicNotice, HandleField, KeyReveal, SubmitSummary, FallbackPanel. No network code path except the
// handle availability probe (a read of a raw user document).
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  extractionQualityLabel,
  formatOwnerKey,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  pastedMetrics,
  validateHandle,
  type Category,
  type LayoutMetrics,
  type Redaction,
  type RedactionKind,
  type SubmissionPayload,
  type Visibility,
} from '@resumearena/shared';
import { me as mecopy } from '../../copy/me.ts';
import { upload as copy } from '../../copy/upload.ts';
import { getUserDoc } from '../../lib/data.ts';
import { extractFile, ExtractFailed, type ExtractResult } from '../../lib/extract-client.ts';
import { fmtInt, middleTruncate } from '../../lib/format.ts';
import { issueFormUrl } from '../../lib/github.ts';
import { hashOf } from '../../lib/identity.ts';
import { Button } from '../forms/Button.tsx';
import { Checkbox, TextField } from '../forms/Fields.tsx';

// ---- StepRail ---------------------------------------------------------------------------------

export function StepRail({ step, reachable, onStep }: { step: 1 | 2 | 3 | 4; reachable: number; onStep(n: 1 | 2 | 3 | 4): void }) {
  return (
    <nav className="steprail" aria-label="Steps">
      {copy.rail.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3 | 4;
        const current = n === step;
        return (
          <button key={label} type="button" aria-current={current ? 'step' : undefined} disabled={n > reachable || current} onClick={() => onStep(n)}>
            <span className="n">{n}</span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}

// ---- FileDropzone -----------------------------------------------------------------------------

type FileError = 'type' | 'size' | 'noText' | 'unreadable';

export interface FileDropzoneProps {
  onText(result: ExtractResult & { fileName: string }): void;
  disabled?: boolean;
}

/** Owns the extraction worker. There is no has-file state: a read file advances the page. */
export function FileDropzone({ onText, disabled = false }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState<{ name: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<FileError | null>(null);
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

  const handle = useCallback(
    async (file: File) => {
      setError(null);
      setReading({ name: file.name, done: 0, total: 1 });
      try {
        const res = await extractFile(file, { maxBytes: MAX_FILE_BYTES, onProgress: (done, total) => setReading({ name: file.name, done, total }) });
        setReading(null);
        onText({ ...res, fileName: file.name });
      } catch (e) {
        setReading(null);
        const code = e instanceof ExtractFailed ? e.code : 'unreadable';
        setError(code === 'type' ? 'type' : code === 'size' ? 'size' : code === 'no_text' ? 'noText' : 'unreadable');
      }
    },
    [onText],
  );

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files[0];
    if (f) void handle(f);
  };

  const pick = (): void => inputRef.current?.click();

  if (reading) {
    const pct = reading.total > 0 ? Math.round((reading.done / reading.total) * 100) : 0;
    return (
      <div className="dropzone dropzone--reading" role="status">
        <span className="mono small">{copy.dropzone.reading(reading.name)}</span>
        <div className="dropzone-bar" aria-hidden="true">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">{copy.dropzone.readingSecondary}</span>
      </div>
    );
  }

  const err = error ? copy.fileError[error] : null;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handle(f);
        }}
      />
      {err ? (
        <div className="dropzone dropzone--error" role="alert">
          <p className="error-title">{err.title}</p>
          <p className="error-body">{err.body}</p>
          <div className="actions">
            <Button variant="secondary" onClick={pick}>
              {copy.dropzone.chooseAnother}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={['dropzone', over ? 'dropzone--over' : ''].join(' ').trim()}
          disabled={disabled}
          onClick={pick}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          style={coarse ? { minHeight: 56 } : undefined}
        >
          <span>{over ? copy.dropzone.dragover : coarse ? copy.dropzone.mobile : copy.dropzone.idle}</span>
          <span className="dropzone-constraints">{copy.dropzone.constraints}</span>
        </button>
      )}
    </>
  );
}

// ---- PasteBox ---------------------------------------------------------------------------------

export function PasteBox({ onText, onSwitch }: { onText(result: ExtractResult): void; onSwitch(): void }) {
  const [text, setText] = useState('');
  const id = useId();
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {copy.paste.label}
      </label>
      <textarea id={id} className="textarea" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={copy.paste.placeholder} />
      <p className="field-help mt-2">{copy.paste.helper}</p>
      <div className="actions">
        <Button variant="primary" disabled={text.trim().length === 0} disabledReason={text.trim().length === 0 ? copy.preview.useDisabledUnder : undefined} onClick={() => onText({ text, metrics: pastedMetrics(text), source: 'paste' })}>
          {copy.paste.use}
        </Button>
        <Button variant="quiet" onClick={onSwitch}>
          {copy.paste.switchBack}
        </Button>
      </div>
    </div>
  );
}

// ---- MetricsLine / PublicNotice ---------------------------------------------------------------

export function metricsLineText(m: LayoutMetrics): string {
  const chars = fmtInt(m.char_count);
  if (m.source === 'paste') return `pasted · ${chars} characters`;
  if (m.source === 'docx') return `Word file · ${chars} characters`;
  const n = (v: number, one: string, many: string): string => `${v} ${v === 1 ? one : many}`;
  return `${n(m.pages, 'page', 'pages')} · ${n(m.columns_detected, 'column', 'columns')} · ${n(m.font_count, 'font', 'fonts')} · ${n(m.image_count, 'image', 'images')} · ${chars} characters · extraction ${extractionQualityLabel(m.extraction_quality)}`;
}

export function MetricsLine({ metrics }: { metrics: LayoutMetrics }) {
  return (
    <div>
      <p className="metrics-line">{metricsLineText(metrics)}</p>
      <p className="field-help">{copy.preview.metricsHelper}</p>
    </div>
  );
}

/** No props, so nobody rewrites the sentence per page. */
export function PublicNotice({ id }: { id?: string }) {
  return (
    <div className="notice">
      <p id={id}>{copy.preview.publicNotice}</p>
      <p className="notice-wry">{copy.preview.wry}</p>
    </div>
  );
}

// ---- RedactionPanel ---------------------------------------------------------------------------

const KIND_ORDER: RedactionKind[] = ['name', 'email', 'phone', 'url', 'address', 'manual'];

export function RedactionPanel({ items, onRestoreName, mobileSummary = false }: { items: Redaction[]; onRestoreName?: () => void; mobileSummary?: boolean }) {
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: items.filter((r) => r.kind === k) })).filter((g) => g.items.length > 0);
  const body = (
    <>
      {groups.length === 0 ? <p className="muted small">{copy.removed.empty}</p> : null}
      {groups.map((g) => {
        const label = g.kind === 'name' ? copy.removed.kind.name : copy.removed.kind[g.kind][g.items.length === 1 ? 0 : 1] + (g.items.length > 1 ? ` (${g.items.length})` : '');
        return (
          <div key={g.kind} className="removed-group">
            <h4>{label}</h4>
            {g.items.map((it, i) => (
              <div key={`${g.kind}-${i}`} className="removed-item">
                <span title={it.original}>{middleTruncate(it.original)}</span>
                <span>→</span>
                <span className="tok">{it.token}</span>
                {g.kind === 'name' && onRestoreName && i === 0 ? (
                  <Button variant="quiet" size="sm" onClick={onRestoreName}>
                    {copy.removed.notAName}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        );
      })}
      <p className="removed-foot">{copy.removed.footnote}</p>
    </>
  );
  if (mobileSummary) {
    const hasName = items.some((r) => r.kind === 'name');
    return (
      <details open={hasName} className="mt-3">
        <summary>{copy.removed.headingCount(items.length)}</summary>
        {body}
      </details>
    );
  }
  return (
    <aside aria-label={copy.removed.heading}>
      <h3 className="removed-heading">{copy.removed.heading}</h3>
      {body}
    </aside>
  );
}

// ---- RedactionPreview -------------------------------------------------------------------------

export interface RedactionPreviewProps {
  value: string;
  onChange(text: string): void;
  removed: Redaction[];
  onRedactSelection(from: number, to: number): void;
  onRestoreName?: () => void;
  metrics: LayoutMetrics;
}

export function RedactionPreview({ value, onChange, removed, onRedactSelection, onRestoreName, metrics }: RedactionPreviewProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const noticeId = useId();
  const taId = useId();
  const chars = value.length;
  const over = chars > MAX_TEXT_CHARS;
  const under = chars < MIN_TEXT_CHARS;
  const poor = metrics.source === 'pdf' && extractionQualityLabel(metrics.extraction_quality) === 'poor';
  const checkSelection = (): void => {
    const el = ref.current;
    setHasSelection(!!el && el.selectionEnd > el.selectionStart);
  };
  return (
    <div className="preview-grid">
      <div>
        {poor ? (
          <div className="warning-block">
            <p className="error-title">{copy.preview.poor.title}</p>
            <p className="muted">{copy.preview.poor.body}</p>
          </div>
        ) : null}
        <div className="small-only">
          <RedactionPanel items={removed} {...(onRestoreName ? { onRestoreName } : {})} mobileSummary />
        </div>
        <div className="preview-label-row">
          <label htmlFor={taId}>{copy.preview.textareaLabel}</label>
          <span className={['counter', over || under ? 'counter--bad' : ''].join(' ').trim()} aria-live="polite">
            {copy.preview.counter(fmtInt(chars))}
          </span>
        </div>
        <textarea
          id={taId}
          ref={ref}
          className="textarea preview-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onSelect={checkSelection}
          onKeyUp={checkSelection}
          onMouseUp={checkSelection}
          onBlur={() => setHasSelection(false)}
          spellCheck={false}
          aria-describedby={noticeId}
        />
        {over ? <p className="field-error">{copy.preview.over(fmtInt(chars - MAX_TEXT_CHARS))}</p> : under ? <p className="field-error">{copy.preview.under}</p> : null}
        <div className="actions" style={{ marginTop: 'var(--space-3)' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasSelection}
            title={copy.preview.redactSelectionTitle}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = ref.current;
              if (!el || el.selectionEnd <= el.selectionStart) return;
              onRedactSelection(el.selectionStart, el.selectionEnd);
              setHasSelection(false);
            }}
          >
            {copy.preview.redactSelection}
          </Button>
        </div>
        <MetricsLine metrics={metrics} />
        <PublicNotice id={noticeId} />
      </div>
      <div className="large-only">
        <RedactionPanel items={removed} {...(onRestoreName ? { onRestoreName } : {})} />
      </div>
    </div>
  );
}

// ---- HandleField ------------------------------------------------------------------------------

export type HandleStatus = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'blocked' | 'invalid' | 'yours' | 'unreachable';

export interface HandleFieldProps {
  value: string;
  onChange(v: string): void;
  status: HandleStatus;
  onStatus(status: HandleStatus, ownerHash: string | null): void;
  /** Keys this browser holds, by handle. */
  keys: Record<string, string>;
}

/** Reserved list and regex locally, then the raw users/<h2>/<handle>.json probe after 400 ms idle. */
export function HandleField({ value, onChange, status, onStatus, keys }: HandleFieldProps) {
  const seq = useRef(0);
  useEffect(() => {
    const h = value.trim();
    seq.current += 1;
    const mine = seq.current;
    if (h.length === 0) {
      onStatus('idle', null);
      return;
    }
    const verdict = validateHandle(h);
    if (verdict !== 'ok') {
      onStatus(verdict === 'format' ? 'invalid' : verdict, null);
      return;
    }
    onStatus('checking', null);
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const doc = await getUserDoc(h, { polling: true });
          if (mine !== seq.current) return;
          if (!doc) return onStatus('available', null);
          const key = keys[h];
          if (key && (await hashOf(key)) === doc.owner_hash) return onStatus('yours', doc.owner_hash);
          // A tombstoned handle stays reserved for its key (D-28).
          onStatus('taken', doc.owner_hash);
        } catch {
          if (mine === seq.current) onStatus('unreachable', null);
        }
      })();
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, keys]);

  const line = copy.details.handle;
  const errorKinds: HandleStatus[] = ['taken', 'reserved', 'blocked', 'invalid'];
  const message = status === 'idle' ? null : line[status];
  return (
    <TextField
      label={copy.details.handleLabel}
      value={value}
      onChange={(v) => onChange(v.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20))}
      placeholder={copy.details.handlePlaceholder}
      helper={copy.details.handleHelper}
      maxLength={20}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      autoComplete="off"
      live
      {...(errorKinds.includes(status) ? { error: message } : message ? { status: message } : {})}
    />
  );
}

// ---- KeyReveal --------------------------------------------------------------------------------

export function KeyReveal({ handle, keyString, saved, onSaved }: { handle: string; keyString: string; saved: boolean; onSaved(v: boolean): void }) {
  const [copied, setCopied] = useState(false);
  const shown = formatOwnerKey(keyString);
  const copyKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Selection is the fallback: the element is user-select: all.
    }
  };
  const save = (): void => {
    const blob = new Blob([copy.key.fileContents(handle, shown)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resumearena-key-${handle}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="key-reveal">
      <p>{copy.key.lead}</p>
      <div className="key-string" aria-label="Owner key">
        {shown}
      </div>
      <div className="actions" style={{ marginTop: 0 }}>
        <Button variant="secondary" onClick={() => void copyKey()}>
          {copied ? copy.key.copied : copy.key.copy}
        </Button>
        <Button variant="quiet" onClick={save}>
          {copy.key.save}
        </Button>
      </div>
      <div className="mt-4">
        <Checkbox label={copy.key.savedCheckbox} checked={saved} onChange={onSaved} />
      </div>
      <p className="muted small mt-3">{copy.key.storageNote}</p>
    </div>
  );
}

// ---- SubmitSummary ----------------------------------------------------------------------------

export function SubmitSummary({ handle, ladderHint, visibility, chars }: { handle: string; ladderHint: Category; visibility: Visibility; chars: number }) {
  return <p className="summary-line">{copy.summary(handle, ladderHint, visibility, fmtInt(chars))}</p>;
}

// ---- FallbackPanel ----------------------------------------------------------------------------

export interface FallbackPanelProps {
  payload: SubmissionPayload;
  reason: 'missing' | 'revoked' | 'refused' | 'network';
  onOpened(): void;
  onRetry?: () => void;
  children?: ReactNode;
}

/**
 * Opens the prefilled Issue Form and reports back. Only submit and delete have a fallback: a submission
 * copies the text (the one field the URL cannot carry); a deletion copies the formatted key (the one
 * field the URL deliberately never carries, github.ts).
 */
export function FallbackPanel({ payload, reason, onOpened, onRetry, children }: FallbackPanelProps) {
  const [opened, setOpened] = useState(false);
  const isDelete = payload.action === 'delete';
  const resubmit = payload.action === 'submit' && payload.owner_key !== '';
  const open = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(isDelete ? formatOwnerKey(payload.owner_key) : payload.text);
    } catch {
      // The person can still copy from the preview (or the key from the device section).
    }
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const url = issueFormUrl(payload);
    onOpened();
    setOpened(true);
    if (coarse) window.location.assign(url);
    else window.open(url, '_blank', 'noopener');
  };
  const title = reason === 'refused' ? copy.submitError.refused.title : reason === 'network' ? copy.submitError.network.title : copy.submitError.channel.title;
  const body = isDelete ? mecopy.del.fallbackBody : reason === 'refused' ? copy.submitError.refused.body : reason === 'network' ? copy.submitError.network.body : copy.submitError.channel.body;
  return (
    <div className="fallback" role="alert">
      <p className="error-title">{title}</p>
      <p className="muted">{body}</p>
      {children}
      {resubmit ? (
        <p className="warn mt-3">{copy.fallback.resubmitUnsupported}</p>
      ) : (
        <div className="actions">
          <Button variant="primary" onClick={() => void open()}>
            {isDelete ? mecopy.del.fallbackButton : copy.fallback.open}
          </Button>
          {onRetry ? (
            <Button variant="quiet" onClick={onRetry}>
              {copy.fallback.retry}
            </Button>
          ) : null}
        </div>
      )}
      <p className="muted small mt-3">{opened ? (isDelete ? mecopy.del.fallbackOpened : copy.fallback.opened) : copy.fallback.note}</p>
    </div>
  );
}
