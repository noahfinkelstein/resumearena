import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export function Skeleton({ width = '100%', height = '1em', className }: { width?: string | number; height?: string | number; className?: string }) {
  return <span className={['skeleton', className ?? ''].join(' ').trim()} style={{ width, height }} aria-hidden="true" />;
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {body ? <p className="state-body">{body}</p> : null}
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, body, retry, extra }: { title: string; body?: ReactNode; retry?: () => void; extra?: ReactNode }) {
  return (
    <div className="state" role="alert">
      <p className="state-title">{title}</p>
      {body ? <p className="state-body">{body}</p> : null}
      {retry || extra ? (
        <div className="actions">
          {retry ? (
            <Button variant="quiet" onClick={retry}>
              Retry
            </Button>
          ) : null}
          {extra}
        </div>
      ) : null}
    </div>
  );
}
