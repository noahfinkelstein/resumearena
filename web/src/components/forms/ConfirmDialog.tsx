import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { TextField } from './Fields.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** When set, the person must type this exactly before the action enables. */
  confirmMatch?: string;
  confirmMatchLabel?: string;
  destructive?: boolean;
  onConfirm(): void;
  onCancel(): void;
  extra?: ReactNode;
}

/** Native <dialog> with showModal(); Escape closes; focus returns to the opener by the platform. */
export function ConfirmDialog({ open, title, body, confirmLabel, confirmMatch, confirmMatchLabel, destructive = false, onConfirm, onCancel, extra }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped('');
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) d.close();
  }, [open]);

  const matches = confirmMatch === undefined || typed.trim() === confirmMatch;
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} onClose={onCancel}>
      <h2>{title}</h2>
      <div className="prose">{typeof body === 'string' ? <p>{body}</p> : body}</div>
      {confirmMatch !== undefined ? <TextField label={confirmMatchLabel ?? 'Type to confirm'} value={typed} onChange={setTyped} mono autoComplete="off" autoCapitalize="off" spellCheck={false} /> : null}
      {extra}
      <div className="dialog-actions">
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={destructive ? 'destructive' : 'primary'} disabled={!matches} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
