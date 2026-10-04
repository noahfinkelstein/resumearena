import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  buildPayload,
  checkPayload,
  generateOwnerKey,
  hashOwnerKey,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  newId,
  normalizeText,
  scrubPii,
  withTextCounts,
  type Category,
  type LayoutMetrics,
  type PublicSettings,
  type PublicStatus,
  type Redaction,
  type SubmissionPayload,
  type Visibility,
} from '@resumearena/shared';
import { Page } from '../components/chrome/Chrome.tsx';
import { Button } from '../components/forms/Button.tsx';
import { RadioRow, Toggle } from '../components/forms/Fields.tsx';
import { useToast } from '../components/forms/Toast.tsx';
import { FallbackPanel, FileDropzone, HandleField, KeyReveal, PasteBox, RedactionPreview, StepRail, SubmitSummary, type HandleStatus } from '../components/upload/Upload.tsx';
import { upload as copy } from '../copy/upload.ts';
import { getSettings, getStatus } from '../lib/data.ts';
import type { ExtractResult } from '../lib/extract-client.ts';
import { clientVersion, dispatchWithRetry, markProbeDead, probeToken, type ProbeResult } from '../lib/github.ts';
import { latestHandle, recordEntry, remember, useIdentity } from '../lib/identity.ts';
import { readDraft, writeDraft, type Draft } from '../lib/storage.ts';
import { busyWindowMinutes } from '../lib/views.ts';

type Step = 1 | 2 | 3 | 4;
type SubmitError = { kind: 'rateLimited' | 'refused' | 'network' | 'channel' | 'paused' | 'invalid'; message?: string } | null;

const LADDERS: { value: Category; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'finance', label: 'Finance' },
  { value: 'tech', label: 'Tech' },
  { value: 'academia', label: 'Academia' },
];

export function Upload() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const { keys } = useIdentity();

  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [source, setSource] = useState<'pdf' | 'docx' | 'paste' | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<LayoutMetrics | null>(null);
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<Redaction[]>([]);
  const [nameRestored, setNameRestored] = useState(false);
  const [nameWarning, setNameWarning] = useState(false);

  const [handle, setHandle] = useState(() => params.get('handle') ?? latestHandle() ?? '');
  const [handleStatus, setHandleStatus] = useState<HandleStatus>('idle');
  const [ladderHint, setLadderHint] = useState<Category>('general');
  const [visibility, setVisibility] = useState<Visibility>('anonymous');

  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<SubmitError>(null);
  const [fallback, setFallback] = useState<{ payload: SubmissionPayload; reason: 'missing' | 'revoked' | 'refused' | 'network' } | null>(null);
  const submitted = useRef(false);

  // Restore a draft (reload mid-upload, or "Back to the text" from a rejection).
  useEffect(() => {
    const d = readDraft();
    if (!d?.text) return;
    const restore = params.get('restore') === '1' || !d.sent;
    if (!restore) return;
    setText(d.text);
    setRemoved(d.redactions as Redaction[]);
    setMetrics(d.metrics as LayoutMetrics);
    setSource(d.source);
    setFileName(d.fileName ?? null);
    if (d.handle && !params.get('handle')) setHandle(d.handle);
    if (d.ladder_hint) setLadderHint(d.ladder_hint);
    if (d.visibility) setVisibility(d.visibility);
    setStep(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
    getSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  // Persist the draft as it changes; `sent` is kept so the result page can resend after a collision.
  useEffect(() => {
    if (!source || !metrics) return;
    const d: Draft = { text, redactions: removed, metrics, source, handle, ladder_hint: ladderHint, visibility, ...(fileName ? { fileName } : {}) };
    writeDraft(d);
  }, [text, removed, metrics, source, handle, ladderHint, visibility, fileName]);

  useEffect(() => {
    if (!source || submitted.current) return;
    const guard = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [source]);

  const onExtracted = useCallback((r: ExtractResult & { fileName?: string }) => {
    const normalized = normalizeText(r.text);
    const scrub = scrubPii(normalized);
    setText(scrub.text);
    setRemoved(scrub.redactions);
    setMetrics(r.metrics);
    setSource(r.source);
    setFileName(r.fileName ?? null);
    setNameRestored(false);
    setNameWarning(false);
    setStep(2);
  }, []);

  const restoreName = (): void => {
    const names = removed.filter((r) => r.kind === 'name');
    if (names.length === 0) return;
    let i = 0;
    const restored = text.replace(/\[name\]/g, (m) => {
      const n = names[i++];
      return n ? n.original : m;
    });
    setText(restored);
    setRemoved(removed.filter((r) => r.kind !== 'name'));
    setNameRestored(true);
  };

  const redactSelection = (from: number, to: number): void => {
    const original = text.slice(from, to);
    setText(`${text.slice(0, from)}[redacted]${text.slice(to)}`);
    setRemoved([...removed, { kind: 'manual', original, token: '[redacted]', index: from }]);
  };

  const chars = text.length;
  const inRange = chars >= MIN_TEXT_CHARS && chars <= MAX_TEXT_CHARS;

  /** "Use this text": the workflow re-runs the default scrub, so anything it would still remove is removed here first. */
  const useThisText = (): void => {
    const again = scrubPii(text);
    if (again.text !== text) {
      const onlyName = again.redactions.every((r) => r.kind === 'name');
      if (onlyName && nameRestored) {
        setNameWarning(true);
        return;
      }
      setText(again.text);
      setRemoved([...removed, ...again.redactions]);
      toast.show(`Removed ${again.redactions.length} more ${again.redactions.length === 1 ? 'item' : 'items'} the workflow would have caught.`);
      return;
    }
    setNameWarning(false);
    setStep(3);
  };

  const resubmit = handleStatus === 'yours' && Boolean(keys[handle]);
  const handleOk = handleStatus === 'available' || handleStatus === 'yours' || handleStatus === 'unreachable';

  // Step 4: a key is made once per handle; the probe runs on mount so nobody types a handle for nothing.
  useEffect(() => {
    if (step !== 4) return;
    if (resubmit) setKey(keys[handle] ?? null);
    else setKey((k) => k ?? generateOwnerKey());
    probeToken().then(setProbe);
  }, [step, resubmit, handle, keys]);

  const finalMetrics = useMemo((): LayoutMetrics | null => {
    if (!metrics) return null;
    const m = withTextCounts(metrics, text);
    return { ...m, redactions: scrubPii(text).counts };
  }, [metrics, text]);

  // §7.2: compare to the published cap, and say how long the measured window can still take to clear.
  const busyMinutes = status && settings ? busyWindowMinutes(status, settings.limits.max_submissions_per_hour, Date.now()) : status ? busyWindowMinutes(status, 20, Date.now()) : null;
  const paused = status?.paused ?? settings?.paused ?? false;
  const pauseMessage = settings?.pause_message ?? '';
  const exhausted = status?.budget.exhausted ?? false;

  /** The dispatch payload for the current step-4 state, validated; null when it cannot be built or fails checkPayload. */
  const makePayload = useCallback(async (): Promise<{ payload: SubmissionPayload; id: string; owner_hash: string } | { error: string } | null> => {
    if (!key || !finalMetrics) return null;
    const id = newId();
    const owner_hash = await hashOwnerKey(key);
    const payload = buildPayload({ action: 'submit', id, handle, owner_hash, visibility, text: normalizeText(text), metrics: finalMetrics, ladder_hint: ladderHint, client_version: clientVersion(), ...(resubmit ? { owner_key: key } : {}) });
    const check = checkPayload(payload);
    return check.ok ? { payload, id, owner_hash } : { error: check.message };
  }, [key, finalMetrics, handle, visibility, text, ladderHint, resubmit]);

  /** The draft remembers what was sent without the raw key (§11.4); the result page re-attaches it from resumearena.keys. */
  const rememberSent = (id: string, payload: SubmissionPayload): void => {
    const prev = readDraft();
    if (prev) writeDraft({ ...prev, sent: { id, payload: { ...payload, owner_key: '' }, withKey: payload.owner_key !== '' } });
  };

  // product-ux §3.2 step 4: a dead channel shows the fallback panel at once, not after a doomed submit.
  useEffect(() => {
    if (step !== 4 || probe !== 'dead' || fallback || paused) return;
    let cancelled = false;
    void makePayload().then((made) => {
      if (cancelled || !made || 'error' in made) return;
      if (key) remember(handle, key);
      setFallback({ payload: made.payload, reason: 'revoked' });
    });
    return () => {
      cancelled = true;
    };
  }, [step, probe, fallback, paused, makePayload, handle, key]);

  const submit = async (): Promise<void> => {
    if (!key || !finalMetrics) return;
    setError(null);
    setFallback(null);
    if (paused) return setError({ kind: 'paused', message: pauseMessage });
    if (exhausted && resubmit) return setError({ kind: 'paused', message: copy.submit.exhausted });
    const made = await makePayload();
    if (!made) return;
    if ('error' in made) return setError({ kind: 'invalid', message: made.error });
    const { payload, id, owner_hash } = made;
    remember(handle, key);
    setSending(copy.submit.sending);
    const live = await probeToken();
    if (live === 'dead') {
      setSending(null);
      setFallback({ payload, reason: 'revoked' });
      return;
    }
    const r = await dispatchWithRetry(payload, { onAttempt: (n) => setSending(n === 0 ? copy.submit.sending : copy.submit.retrying(n)) });
    setSending(null);
    if (r.ok) {
      submitted.current = true;
      recordEntry(id, { handle, owner_hash, submitted_at: new Date().toISOString(), via: 'dispatch', ladder_hint: ladderHint });
      rememberSent(id, payload);
      navigate(`/r/${id}`);
      return;
    }
    if (r.kind === 'token_dead') {
      markProbeDead();
      setProbe('dead');
      setFallback({ payload, reason: 'revoked' });
    } else if (r.kind === 'rate_limited') setError({ kind: 'rateLimited' });
    else if (r.kind === 'invalid') {
      setError({ kind: 'refused' });
      setFallback({ payload, reason: 'refused' });
    } else {
      setError({ kind: 'network' });
      setFallback({ payload, reason: 'network' });
    }
  };

  const onFallbackOpened = (payload: SubmissionPayload): void => {
    submitted.current = true;
    recordEntry(payload.submission_id, { handle, owner_hash: payload.owner_hash, submitted_at: new Date().toISOString(), via: 'issue', ladder_hint: ladderHint });
    rememberSent(payload.submission_id, payload);
    navigate(`/r/${payload.submission_id}`);
  };

  const reachable = source ? (handleOk ? 4 : 3) : 1;
  const widthFor: Record<Step, 'narrow' | 'content'> = { 1: 'narrow', 2: 'content', 3: 'narrow', 4: 'narrow' };

  return (
    <Page title={copy.title} width={widthFor[step]}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{copy.title}</h1>
          {step === 1 ? <p className="page-lead">{copy.lead}</p> : null}
        </div>
      </div>
      <StepRail step={step} reachable={reachable} onStep={(n) => setStep(n)} />

      {step === 1 ? (
        <div>
          {paused ? <p className="warn">{copy.submit.paused(pauseMessage)}</p> : null}
          {mode === 'file' ? (
            <>
              <FileDropzone onText={onExtracted} />
              <div className="actions">
                <Button variant="quiet" onClick={() => setMode('paste')}>
                  {copy.paste.switch}
                </Button>
              </div>
            </>
          ) : (
            <PasteBox onText={onExtracted} onSwitch={() => setMode('file')} />
          )}
        </div>
      ) : null}

      {step === 2 && metrics ? (
        <div>
          <div className="section-head">
            <h2 className="section-title">{copy.preview.heading}</h2>
          </div>
          <p className="page-lead" style={{ marginTop: 0, marginBottom: 'var(--space-5)' }}>
            {copy.preview.lead}
          </p>
          {nameWarning ? (
            <div className="warning-block">
              <p>The first line still reads as a person’s name to the workflow, which removes names on arrival. Edit the line, or redact it again.</p>
              <div className="actions" style={{ marginTop: 'var(--space-2)' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const again = scrubPii(text);
                    setText(again.text);
                    setRemoved([...removed, ...again.redactions]);
                    setNameRestored(false);
                    setNameWarning(false);
                  }}
                >
                  Redact it again
                </Button>
              </div>
            </div>
          ) : null}
          <RedactionPreview value={text} onChange={(t) => { setText(t); setNameWarning(false); }} removed={removed} onRedactSelection={redactSelection} metrics={withTextCounts(metrics, text)} {...(removed.some((r) => r.kind === 'name') ? { onRestoreName: restoreName } : {})} />
          <div className="actions sticky-bar">
            <Button variant="primary" disabled={!inRange} disabledReason={chars > MAX_TEXT_CHARS ? copy.preview.useDisabledOver : chars < MIN_TEXT_CHARS ? copy.preview.useDisabledUnder : undefined} onClick={useThisText}>
              {copy.preview.use}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setSource(null);
                setMetrics(null);
                setText('');
                setRemoved([]);
                writeDraft(null);
                setStep(1);
              }}
            >
              {copy.preview.chooseAnother}
            </Button>
            <Button variant="quiet" onClick={() => setStep(1)}>
              {copy.preview.back}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div>
          <h2 className="section-title">{copy.details.heading}</h2>
          <HandleField value={handle} onChange={setHandle} status={handleStatus} onStatus={(s) => setHandleStatus(s)} keys={keys} />
          <RadioRow<Category> legend={copy.details.ladderLegend} value={ladderHint} options={LADDERS} onChange={setLadderHint} helper={copy.details.ladderHelper} />
          <Toggle label={copy.details.visibilityLabel} checked={visibility === 'handle'} onChange={(v) => setVisibility(v ? 'handle' : 'anonymous')} helper={copy.details.visibilityHelper} />
          <p className="muted small mt-5">{copy.details.consent}</p>
          <div className="actions">
            <Button variant="primary" disabled={!handleOk} disabledReason={!handleOk ? copy.details.continueDisabled : undefined} onClick={() => setStep(4)}>
              {copy.details.continue}
            </Button>
            <Button variant="quiet" onClick={() => setStep(2)}>
              {copy.details.back}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 && key ? (
        <div>
          {resubmit ? (
            <>
              <h2 className="section-title">{copy.resubmit.heading(handle)}</h2>
              <p className="mt-3">{copy.resubmit.lead(handle)}</p>
            </>
          ) : (
            <>
              <h2 className="section-title">{copy.key.heading}</h2>
              <KeyReveal handle={handle} keyString={key} saved={saved} onSaved={setSaved} />
            </>
          )}
          <SubmitSummary handle={handle} ladderHint={ladderHint} visibility={visibility} chars={chars} />
          {busyMinutes !== null ? <p className="busy-note">{copy.submit.busy(busyMinutes)}</p> : null}
          {exhausted && !resubmit ? <p className="busy-note">{copy.submit.exhausted}</p> : null}
          {probe === 'dead' && !fallback && finalMetrics && !paused ? <p className="warn mt-3">{copy.submitError.channel.title}</p> : null}
          {error ? (
            <div className="state" role="alert">
              <p className="state-title">{error.kind === 'paused' || error.kind === 'invalid' ? error.message || copy.submit.paused('') : copy.submitError[error.kind].title}</p>
              {error.kind !== 'paused' && error.kind !== 'invalid' ? <p className="state-body">{copy.submitError[error.kind].body}</p> : null}
            </div>
          ) : null}
          {fallback ? (
            <FallbackPanel payload={fallback.payload} reason={fallback.reason} onOpened={() => onFallbackOpened(fallback.payload)} onRetry={() => void submit()} />
          ) : (
            <div className="actions sticky-bar">
              <Button variant="primary" block disabled={(!resubmit && !saved) || sending !== null || paused} disabledReason={paused ? copy.submit.paused(pauseMessage) : !resubmit && !saved ? copy.submit.disabled : undefined} onClick={() => void submit()}>
                {sending ?? copy.submit.button}
              </Button>
              <Button variant="quiet" onClick={() => setStep(3)}>
                {copy.details.back}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Page>
  );
}
