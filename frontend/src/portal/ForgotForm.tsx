import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errMsg, papi } from './api';

const OTP_LENGTH = 6;
const MIN_PASSWORD = 12;

type Field = 'user' | 'otp' | 'pw' | 'pw2';

export function ForgotForm({
  initialUser,
  onDone,
  onBack,
  onBusy,
}: {
  initialUser: string;
  onDone: (username: string) => void;
  onBack: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const ids = useId();
  const userRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(initialUser);
  const [otp, setOtp] = useState('');
  const [otpFocused, setOtpFocused] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errField, setErrField] = useState<Field | null>(null);
  const alertId = `${ids}-alert`;
  const errFor = (f: Field) => (error && (errField === null || errField === f) ? alertId : undefined);
  const fail = (text: string, field: Field | null) => {
    setError(text);
    setErrField(field);
  };

  useEffect(() => {
    (initialUser.trim() ? otpRef.current : userRef.current)?.focus();
  }, [initialUser]);

  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const u = username.trim().toLowerCase();
    if (!u) {
      fail('Kullanıcı adınızı girin.', 'user');
      userRef.current?.focus();
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      fail('Doğrulayıcı uygulamanızdaki 6 haneli kodu girin.', 'otp');
      otpRef.current?.focus();
      return;
    }
    if (pw.length < MIN_PASSWORD) {
      fail(`Yeni parola en az ${MIN_PASSWORD} karakter olmalı.`, 'pw');
      pwRef.current?.focus();
      return;
    }
    if (pw.toLowerCase().includes(u)) {
      fail('Yeni parola kullanıcı adını içeremez.', 'pw');
      pwRef.current?.focus();
      return;
    }
    if (pw !== pw2) {
      fail('Yeni parola iki alanda aynı olmalı.', 'pw2');
      return;
    }
    fail('', null);
    setBusy(true);
    try {
      await papi('POST', '/forgot', { username: u, totp: otp, new: pw });
      onDone(u);
    } catch (err) {
      fail(errMsg(err), null);
      setOtp('');
      otpRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="kg-f-form" onSubmit={submit} noValidate aria-labelledby={`${ids}-title`}>
      <div className="kg-f-head">
        <h2 className="kg-f-title" id={`${ids}-title`}>
          Parolayı sıfırla
        </h2>
        <p className="kg-f-sub">Doğrulayıcı uygulamanızdaki kodla yeni parola belirleyin.</p>
      </div>

      <div className="kg-f-field">
        <label className="kg-f-label" htmlFor={`${ids}-user`}>
          Kullanıcı adı
        </label>
        <input
          ref={userRef}
          id={`${ids}-user`}
          className="kg-f-input"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={busy}
          aria-describedby={errFor('user')}
        />
      </div>

      <div className="kg-f-field kg-f-field--center">
        <label className="kg-f-label" id={`${ids}-otp-label`} htmlFor={`${ids}-otp`}>
          Doğrulama kodu
        </label>
        <div className="kg-f-otp">
          <input
            ref={otpRef}
            id={`${ids}-otp`}
            className="kg-f-otp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={OTP_LENGTH}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
            onFocus={(e) => {
              setOtpFocused(true);
              const len = e.target.value.length;
              e.target.setSelectionRange(len, len);
            }}
            onBlur={() => setOtpFocused(false)}
            readOnly={busy}
            aria-labelledby={`${ids}-otp-label`}
            aria-describedby={errFor('otp')}
          />
          {Array.from({ length: OTP_LENGTH }, (_, i) => (
            <span
              key={i}
              className={otpFocused && i === Math.min(otp.length, OTP_LENGTH - 1) ? 'kg-f-otp-slot is-active' : 'kg-f-otp-slot'}
              aria-hidden="true"
            >
              {otp[i] ?? ''}
            </span>
          ))}
        </div>
      </div>

      <div className="kg-f-field">
        <label className="kg-f-label" htmlFor={`${ids}-pw`}>
          Yeni parola
        </label>
        <div className="kg-f-pw">
          <input
            ref={pwRef}
            id={`${ids}-pw`}
            className="kg-f-input"
            type={showPw ? 'text' : 'password'}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={busy}
            aria-describedby={[errFor('pw'), `${ids}-pw-hint`].filter(Boolean).join(' ')}
          />
          <button
            type="button"
            className="kg-f-toggle"
            onClick={() => setShowPw((v) => !v)}
            aria-pressed={showPw}
            aria-label={showPw ? 'Parolayı gizle' : 'Parolayı göster'}
          >
            {showPw ? 'Gizle' : 'Göster'}
          </button>
        </div>
        <p className="kg-f-desc kg-f-desc--start" id={`${ids}-pw-hint`}>
          En az {MIN_PASSWORD} karakter; kullanıcı adınızı içeremez.
        </p>
      </div>

      <div className="kg-f-field">
        <label className="kg-f-label" htmlFor={`${ids}-pw2`}>
          Yeni parola (tekrar)
        </label>
        <input
          id={`${ids}-pw2`}
          className="kg-f-input"
          type={showPw ? 'text' : 'password'}
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={busy}
          aria-describedby={errFor('pw2')}
        />
      </div>

      {error ? (
        <div className="kg-f-alert" role="alert" id={alertId}>
          <svg className="kg-f-alert-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.25M12 16.25v.01" />
          </svg>
          <div className="kg-f-alert-body">
            <p className="kg-f-alert-title">Parola sıfırlanamadı</p>
            <p className="kg-f-alert-text">{error}</p>
          </div>
        </div>
      ) : null}

      <button type="submit" className="kg-f-submit" disabled={busy} aria-busy={busy}>
        {busy ? <span className="kg-f-spin" aria-hidden="true" /> : null}
        {busy ? 'Kontrol ediliyor' : 'Parolayı değiştir'}
      </button>

      <button type="button" className="kg-f-link" onClick={onBack} disabled={busy}>
        Girişe dön
      </button>
    </form>
  );
}
