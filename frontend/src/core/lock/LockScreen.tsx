import { useCallback, useEffect, useRef, useState } from 'react';
import { Delete, Lock, LogOut } from 'lucide-react';
import { DialClock } from './DialClock';
import { PIN_LENGTH as PIN_LEN, type UnlockResult } from './types';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function LockScreen({
  username,
  onUnlock,
  onLogout,
}: {
  username: string;
  onUnlock: (pin: string) => Promise<UnlockResult>;
  onLogout: () => Promise<void> | void;
}) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [shake, setShake] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const onUnlockRef = useRef(onUnlock);
  onUnlockRef.current = onUnlock;

  const secsLeft = until > 0 ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  const lockedOut = secsLeft > 0;
  const disabled = busy || lockedOut || leaving;

  useEffect(() => {
    aliveRef.current = true;
    rootRef.current?.focus();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Kilitli süre boyunca sayaç canlı akar.
  useEffect(() => {
    if (until <= 0) return;
    setNow(Date.now());
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) {
        setUntil(0);
        setError('');
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [until]);

  useEffect(() => {
    if (!shake) return;
    const t = window.setTimeout(() => setShake(false), 500);
    return () => window.clearTimeout(t);
  }, [shake]);

  const submit = useCallback(async (pin: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    let r: UnlockResult;
    try {
      r = await onUnlockRef.current(pin);
    } catch {
      r = { ok: false, kind: 'error', message: 'İşlem tamamlanamadı. Yeniden deneyin.' };
    }
    busyRef.current = false;
    if (!aliveRef.current) return;
    setBusy(false);
    if (r.ok) return;
    setDigits('');
    if (r.kind === 'invalid') {
      setError(r.remaining > 0 ? `PIN hatalı, ${r.remaining} hakkınız kaldı.` : 'PIN hatalı.');
      setShake(true);
    } else if (r.kind === 'locked') {
      setNow(Date.now());
      setUntil(Date.now() + r.seconds * 1000);
      setShake(true);
    } else {
      setError(r.message);
    }
  }, []);

  useEffect(() => {
    if (digits.length === PIN_LEN && !busyRef.current && !lockedOut) void submit(digits);
  }, [digits, lockedOut, submit]);

  const add = useCallback((ch: string) => {
    if (busyRef.current) return;
    setError((e) => (e.startsWith('PIN hatalı') ? '' : e));
    setDigits((d) => (d.length < PIN_LEN ? d + ch : d));
  }, []);
  const back = useCallback(() => {
    if (busyRef.current) return;
    setDigits((d) => d.slice(0, -1));
  }, []);

  // Fiziksel klavye: rakamlar ve Backspace.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || disabledRef.current) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        add(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add, back]);

  const logout = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await onLogout();
    } catch {
      // Ağ hatasında da giriş ekranına dönülür; karar üst bileşendedir.
    } finally {
      if (aliveRef.current) setLeaving(false);
    }
  };

  const mm = Math.floor(secsLeft / 60);
  const ss = secsLeft % 60;
  const message = lockedOut ? `Çok fazla hatalı deneme. ${mm} dk ${ss} sn sonra yeniden deneyin.` : error;

  return (
    <div className="kg-lock-screen" role="dialog" aria-modal="true" aria-labelledby="kg-lock-title" tabIndex={-1} ref={rootRef}>
      <div className="kg-lock-inner">
        <DialClock className="kg-lock-dial" />
        <div className="kg-lock-user">
          <Lock size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="kg-lock-name" title={username}>
            {username}
          </span>
        </div>
        <h1 className="kg-lock-title" id="kg-lock-title">
          Ekran kilitli
        </h1>
        <p className="kg-lock-sub">PIN&apos;inizi girin</p>
        <div className={`kg-lock-dots${shake ? ' kg-lock-shake' : ''}`} role="img" aria-label={`${digits.length} / ${PIN_LEN} hane girildi`}>
          {Array.from({ length: PIN_LEN }, (_, i) => (
            <span key={i} className="kg-lock-dot" data-on={i < digits.length} />
          ))}
        </div>
        <p className="kg-lock-error" role="alert" aria-live={lockedOut ? 'off' : 'assertive'}>
          {message}
        </p>
        {lockedOut ? (
          <p className="kg-lock-sr" role="status">
            Çok fazla hatalı deneme. Tuş takımı geçici olarak kilitlendi.
          </p>
        ) : null}
        <div className="kg-lock-pad" role="group" aria-label="PIN tuş takımı">
          {KEYS.map((k) => (
            <button key={k} type="button" className="kg-lock-key" aria-label={`Rakam ${k}`} disabled={disabled} onClick={() => add(k)}>
              {k}
            </button>
          ))}
          <span aria-hidden="true" />
          <button type="button" className="kg-lock-key" aria-label="Rakam 0" disabled={disabled} onClick={() => add('0')}>
            0
          </button>
          <button type="button" className="kg-lock-key kg-lock-key-aux" aria-label="Son rakamı sil" disabled={disabled || digits.length === 0} onClick={back}>
            <Delete size={22} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div className="kg-lock-foot">
          <button type="button" className="kg-lock-out" onClick={() => void logout()} disabled={leaving}>
            <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{leaving ? 'Çıkış yapılıyor…' : 'Çıkış yap'}</span>
          </button>
          <p className="kg-lock-hint">PIN&apos;inizi unuttuysanız çıkış yapıp parola ve doğrulama kodunuzla yeniden girin.</p>
        </div>
      </div>
    </div>
  );
}
