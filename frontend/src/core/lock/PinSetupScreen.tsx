import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { Button as UiButton, Field as UiField } from '../ui';
import { isStrongPin, PIN_LENGTH } from './types';
import './lock.css';

type FieldProps = { label: string; hint?: string; children: (id: string, describedBy?: string) => ReactNode };
type ButtonProps = { type?: 'submit' | 'button'; primary?: boolean; busy?: boolean; busyLabel?: string; onClick?: () => void; children: ReactNode };

/** Görünüm takımı: portal giriş ekranı kendi terminal bileşenlerini verir. */
export interface PinSkin {
  Field: ComponentType<FieldProps>;
  Button: ComponentType<ButtonProps>;
  ErrorLine: ComponentType<{ message: string }>;
  inputClass: string;
  actionsClass: string;
  lowercaseLabels?: boolean;
}

function DefaultButton({ type, primary, busy, onClick, children }: ButtonProps) {
  return (
    <UiButton type={type ?? 'button'} variant={primary ? 'primary' : 'secondary'} busy={busy} onClick={onClick}>
      {children}
    </UiButton>
  );
}
function DefaultError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

const DEFAULT_SKIN: PinSkin = {
  Field: UiField,
  Button: DefaultButton,
  ErrorLine: DefaultError,
  inputClass: 'kg-lock-pin-input',
  actionsClass: 'kg-lock-form-actions',
};

export interface PinShellArgs {
  onSubmit: (e: FormEvent) => void;
  title: string;
  description: string;
  children: ReactNode;
}

const TITLE = 'Ekran kilidi PIN’i';
const DESCRIPTION = 'Ekranı kilitlediğinizde 4 haneli PIN ile açarsınız. Devam etmek için hesap parolanızı girin.';

function defaultShell(variant: 'screen' | 'inline') {
  return function Shell({ onSubmit, title, description, children }: PinShellArgs) {
    if (variant === 'screen') {
      return (
        <div className="auth-wrap">
          <form className="auth-card" onSubmit={onSubmit}>
            <h1>{title}</h1>
            <p className="muted">{description}</p>
            {children}
          </form>
        </div>
      );
    }
    return (
      <form className="kg-lock-form" onSubmit={onSubmit}>
        <p className="muted">{description}</p>
        {children}
      </form>
    );
  };
}


export function PinSetupScreen({
  variant = 'inline',
  shell,
  skin = DEFAULT_SKIN,
  submitLabel = 'PIN’i kaydet',
  onSubmit,
  onCancel,
  onLogout,
}: {
  /** `screen`: tek başına tam ekran akışı; `inline`: modal ya da kart içi. */
  variant?: 'screen' | 'inline';
  /** Çevreleyen kabuğu değiştirir (portal AuthShell). */
  shell?: (args: PinShellArgs) => ReactNode;
  skin?: PinSkin;
  submitLabel?: string;
  /** Parola ve PIN'i sunucuya gönderir; hata fırlatırsa mesajı gösterilir. */
  onSubmit: (password: string, pin: string) => Promise<void>;
  onCancel?: () => void;
  onLogout?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPin, setShowPin] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Harf içeren değer elle yazılmamıştır (parola yöneticisi): rakamlarını PIN sanmak yerine reddedilir.
  const changePin = (raw: string, set: (v: string) => void) => {
    if (/\D/.test(raw)) {
      set('');
      setError('PIN yalnızca rakamlardan oluşur. Tarayıcı bu alanı doldurmuş olabilir; PIN’i elle yazın.');
      return;
    }
    setError('');
    set(raw.slice(0, PIN_LENGTH));
  };
  const pinInputProps = {
    className: `${skin.inputClass} kg-pin-field${showPin ? '' : ' kg-pin-mask'}`,
    // `password` tipi parola yöneticisini çağırır; maske CSS ile yapılır.
    type: 'text',
    inputMode: 'numeric',
    pattern: '[0-9]*',
    maxLength: PIN_LENGTH,
    autoComplete: 'off',
    autoCorrect: 'off',
    spellCheck: false,
    'data-lpignore': 'true',
    'data-1p-ignore': 'true',
    'data-bwignore': 'true',
    required: true,
  } as const;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (pin.length !== PIN_LENGTH) {
      setError(`PIN ${PIN_LENGTH} haneli olmalı.`);
      return;
    }
    if (!isStrongPin(pin)) {
      setError('PIN çok kolay tahmin edilir (1234, 4321 ya da 1111 gibi). Başka bir PIN seçin.');
      return;
    }
    if (pin !== again) {
      setError('PIN iki alanda aynı olmalı.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(password, pin);
      if (aliveRef.current) {
        setPassword('');
        setPin('');
        setAgain('');
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const { Field, Button, ErrorLine } = skin;
  const lc = (s: string) => (skin.lowercaseLabels ? s.toLocaleLowerCase('tr-TR').replace(/pın/g, 'PIN') : s);
  const Shell = shell ?? defaultShell(variant);

  const body = (
    <>
      <Field label={lc('Hesap parolası')}>
        {(id) => (
          <input
            id={id}
            className={skin.inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            data-autofocus=""
          />
        )}
      </Field>
      <Field label={lc('Yeni PIN')} hint="4 rakam. 1234, 4321 ya da 1111 gibi kolay PIN’ler kabul edilmez.">
        {(id, d) => (
          <input
            id={id}
            {...pinInputProps}
            name="kg-yeni-kod"
            aria-describedby={d}
            value={pin}
            onChange={(e) => changePin(e.target.value, setPin)}
          />
        )}
      </Field>
      <Field label={lc('PIN (tekrar)')}>
        {(id) => (
          <input
            id={id}
            {...pinInputProps}
            name="kg-yeni-kod-tekrar"
            value={again}
            onChange={(e) => changePin(e.target.value, setAgain)}
          />
        )}
      </Field>
      <label className="kg-pin-show">
        <input type="checkbox" checked={showPin} onChange={(e) => setShowPin(e.target.checked)} />
        <span>PIN&apos;i göster</span>
      </label>
      <ErrorLine message={error} />
      <div className={skin.actionsClass}>
        <Button type="submit" primary busy={busy} busyLabel="işleniyor...">
          {submitLabel}
        </Button>
        {onCancel ? <Button onClick={onCancel}>Vazgeç</Button> : null}
        {onLogout ? <Button onClick={onLogout}>Çıkış</Button> : null}
      </div>
    </>
  );

  return <>{Shell({ onSubmit: (e) => void submit(e), title: TITLE, description: DESCRIPTION, children: body })}</>;
}
