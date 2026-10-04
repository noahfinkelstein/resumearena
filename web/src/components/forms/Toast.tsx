import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  error: boolean;
}

interface ToastApi {
  show(message: string, opts?: { error?: boolean }): void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** One toast at a time; 4 s auto-dismiss; click dismisses. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  const show = useCallback((message: string, opts: { error?: boolean } = {}) => {
    seq.current += 1;
    setToast({ id: seq.current, message, error: opts.error ?? false });
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4000);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [toast]);

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? (
        <div key={toast.id} className={['toast', toast.error ? 'toast--error' : ''].join(' ').trim()} role="status" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}
