import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onChange(value: string): void;
  helper?: ReactNode;
  error?: ReactNode;
  /** Neutral status line (e.g. "Available."). */
  status?: ReactNode;
  mono?: boolean;
  live?: boolean;
}

export function TextField({ label, value, onChange, helper, error, status, mono = false, live = false, id, className, ...rest }: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const helpId = `${inputId}-help`;
  const errId = `${inputId}-err`;
  return (
    <div className={['field', className ?? ''].join(' ').trim()}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={['field-input', mono ? 'field-input--mono' : ''].join(' ').trim()}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[helper ? helpId : null, error ? errId : null].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {error ? (
        <div id={errId} className="field-error" aria-live={live ? 'polite' : undefined}>
          {error}
        </div>
      ) : status ? (
        <div className="field-ok" aria-live={live ? 'polite' : undefined}>
          {status}
        </div>
      ) : null}
      {helper ? (
        <div id={helpId} className="field-help">
          {helper}
        </div>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  helper?: ReactNode;
}

export function SelectField({ label, value, options, onChange, helper }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {helper ? <div className="field-help">{helper}</div> : null}
    </div>
  );
}

export interface RadioRowProps<V extends string> {
  legend: string;
  value: V;
  options: { value: V; label: string }[];
  onChange(value: V): void;
  helper?: ReactNode;
}

export function RadioRow<V extends string>({ legend, value, options, onChange, helper }: RadioRowProps<V>) {
  const name = useId();
  return (
    <fieldset className="radio-row">
      <legend className="radio-legend">{legend}</legend>
      <div className="radio-options">
        {options.map((o) => (
          <label key={o.value} className="radio-chip" data-checked={o.value === value}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {helper ? <div className="field-help mt-2">{helper}</div> : null}
    </fieldset>
  );
}

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  helper?: ReactNode;
  disabled?: boolean | undefined;
  disabledReason?: ReactNode | undefined;
}

export function Toggle({ label, checked, onChange, helper, disabled = false, disabledReason }: ToggleProps) {
  return (
    <label className="toggle" data-checked={checked} data-disabled={disabled}>
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {disabled && disabledReason ? <span className="toggle-help">{disabledReason}</span> : helper ? <span className="toggle-help">{helper}</span> : null}
    </label>
  );
}

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
}

export function Checkbox({ label, checked, onChange }: CheckboxProps) {
  return (
    <label className="checkbox" data-checked={checked}>
      <span className="checkbox-box" aria-hidden="true" />
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
