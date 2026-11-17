import { useEffect, useId, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react';

const SPIN = ['|', '/', '-', '\\'];

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useSpinChar(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % SPIN.length), 240);
    return () => window.clearInterval(t);
  }, [active]);
  return prefersReducedMotion() ? '…' : SPIN[i];
}

/** Harf başına gecikme ve yazım bittikten sonra baştan yazmadan önce bekleme süresi. */
const TYPE_MS = 160;
const REPEAT_PAUSE_MS = 3000;

function TypedCommand({ text }: { text: string }) {
  const still = prefersReducedMotion();
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (still) return;
    const done = typed >= text.length;
    const t = window.setTimeout(() => setTyped(done ? 0 : (v) => v + 1), done ? REPEAT_PAUSE_MS : TYPE_MS);
    return () => window.clearTimeout(t);
  }, [typed, text, still]);
  const n = still ? text.length : typed;
  return (
    <>
      <span className="kg-auth-sr">{text}</span>
      <span aria-hidden="true">
        <span className="kg-auth-prompt">$</span> {text.slice(2, n)}
        {n < text.length ? <span className="kg-auth-block" /> : null}
      </span>
    </>
  );
}

export function AuthShell({
  command,
  windowTitle,
  heading,
  subtitle,
  onSubmit,
  children,
}: {
  command: string;
  windowTitle: string;
  heading?: string;
  subtitle?: string;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className="kg-auth-page">
      <div className="kg-auth-bg" aria-hidden="true" />
      <div className="kg-auth-stack">
        <form className="kg-auth-window" onSubmit={onSubmit}>
          <div className="kg-auth-bar">
            <span className="kg-auth-dots" aria-hidden="true">
              <i className="kg-auth-dot kg-auth-dot-r" />
              <i className="kg-auth-dot kg-auth-dot-y" />
              <i className="kg-auth-dot kg-auth-dot-g" />
            </span>
            <span className="kg-auth-title">{windowTitle}</span>
            <span aria-hidden="true" />
          </div>
          <div className="kg-auth-body">
            <p className="kg-auth-cmd">
              <TypedCommand text={command} />
            </p>
            {heading ? <h1 className="kg-auth-heading">{heading}</h1> : null}
            {subtitle ? <p className="kg-auth-sub">{subtitle}</p> : null}
            {children}
          </div>
        </form>
        <p className="kg-auth-foot">Bu oturum kaydedilmektedir · Yetkisiz erişim yasaktır</p>
      </div>
    </div>
  );
}

export function TermField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="kg-auth-field">
      <div className="kg-auth-row">
        <label htmlFor={id} className="kg-auth-label">
          <span>{label}</span>
          <span aria-hidden="true" className="kg-auth-gt">
            &gt;
          </span>
        </label>
        {children(id, hintId)}
      </div>
      {hint ? (
        <div className="kg-auth-hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function PasswordInput({
  id,
  describedBy,
  value,
  onChange,
  autoComplete,
  minLength,
  autoFocus,
}: {
  id: string;
  describedBy?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="kg-auth-pw">
      <input
        id={id}
        className="kg-auth-input"
        aria-describedby={describedBy}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        required
        autoFocus={autoFocus}
        autoCapitalize="none"
        spellCheck={false}
      />
      <button type="button" className="kg-auth-eye" aria-pressed={shown} aria-label={shown ? 'Parolayı gizle' : 'Parolayı göster'} onClick={() => setShown((s) => !s)}>
        {shown ? 'gizle' : 'göster'}
      </button>
    </div>
  );
}

export function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="kg-auth-error" role="alert">
      <span aria-hidden="true">✗ </span>
      {message}
    </p>
  );
}

export function TermButton({
  primary,
  busy,
  busyLabel,
  keyHint,
  children,
  disabled,
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; busy?: boolean; busyLabel?: string; keyHint?: string }) {
  const spin = useSpinChar(!!busy);
  return (
    <button {...rest} type={type ?? 'button'} className={`kg-auth-btn${primary ? ' kg-auth-btn-primary' : ''}`} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? (
        <>
          {busyLabel ?? 'bağlanıyor...'} <span aria-hidden="true">{spin}</span>
        </>
      ) : (
        <>
          {keyHint ? (
            <span aria-hidden="true" className="kg-auth-key">
              [ {keyHint} ]{' '}
            </span>
          ) : null}
          {children}
        </>
      )}
    </button>
  );
}
