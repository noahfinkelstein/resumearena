import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  disabled?: boolean;
  /** Disabled buttons always say why, next to them. */
  disabledReason?: string | undefined;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', block = false, disabled = false, disabledReason, className, type = 'button', children, ...rest }: ButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', block ? 'btn--block' : '', className ?? ''].filter(Boolean).join(' ');
  const button = (
    <button type={type} className={cls} disabled={disabled} aria-disabled={disabled || undefined} {...rest}>
      {children}
    </button>
  );
  if (disabled && disabledReason) {
    return (
      <span className="btn-wrap">
        {button}
        <span className="btn-reason">{disabledReason}</span>
      </span>
    );
  }
  return button;
}

export interface LinkButtonProps {
  to: string;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  children: ReactNode;
  className?: string;
}

export function LinkButton({ to, variant = 'secondary', size = 'md', block = false, children, className }: LinkButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', block ? 'btn--block' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <Link to={to} className={cls}>
      {children}
    </Link>
  );
}
