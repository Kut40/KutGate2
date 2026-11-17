import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QrCode } from '../core/QrCode';
import { LockGate } from '../core/lock/LockGate';
import { PinSetupScreen, type PinSkin } from '../core/lock/PinSetupScreen';
import { EVT_LOCKED, EVT_RECHECK } from '../core/lock/types';
import { ErrorState, ToastProvider } from '../core/ui';
import { errMsg, getStatus, papi, type PortalStatus } from './api';
import { AuthShell, ErrorLine, PasswordInput, TermButton, TermField, useSpinChar } from './AuthShell';
import './portal.css';
import './auth.css';

const TeamPage = lazy(() => import('./TeamPage'));
const loadDashboard = () => import('./chat/DashboardScreen');
const DashboardScreen = lazy(() => loadDashboard().then((m) => ({ default: m.DashboardScreen })));

function BootPlaceholder() {
  return (
    <div className="kg-boot" role="status">
      <span className="kg-auth-sr">Yükleniyor</span>
    </div>
  );
}

function ChangePasswordScreen({ username, onDone, onLogout }: { username: string; onDone: () => Promise<void>; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 12) {
      setError('Yeni parola en az 12 karakter olmalı.');
      return;
    }
    if (username && next.toLowerCase().includes(username.toLowerCase())) {
      setError('Yeni parola kullanıcı adını içeremez.');
      return;
    }
    if (next !== again) {
      setError('Yeni parola iki alanda aynı olmalı.');
      return;
    }
    setBusy(true);
    try {
      await papi('POST', '/password', { current, new: next });
      setCurrent('');
      setNext('');
      setAgain('');
      await onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      command="$ kutgate passwd"
      windowTitle="kutgate — parola"
      heading="Parola değiştir"
      subtitle="Devam etmeden önce geçici parolanızı değiştirmeniz gerekir."
      onSubmit={submit}
    >
      <TermField label="geçerli parola">
        {(id) => <PasswordInput id={id} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />}
      </TermField>
      <TermField label="yeni parola" hint="En az 12 karakter; kullanıcı adınızı içeremez.">
        {(id, d) => <PasswordInput id={id} describedBy={d} value={next} onChange={setNext} autoComplete="new-password" minLength={12} />}
      </TermField>
      <TermField label="yeni parola (tekrar)">
        {(id) => <PasswordInput id={id} value={again} onChange={setAgain} autoComplete="new-password" minLength={12} />}
      </TermField>
      <ErrorLine message={error} />
      <div className="kg-auth-actions">
        <TermButton type="submit" primary busy={busy} busyLabel="işleniyor..." keyHint="enter">
          Parolayı değiştir
        </TermButton>
        <TermButton onClick={onLogout}>Çıkış</TermButton>
      </div>
    </AuthShell>
  );
}

function TotpSetupScreen({ onDone, onLogout }: { onDone: () => Promise<void>; onLogout: () => void }) {
  const [info, setInfo] = useState<{ secret: string; otpauth: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const spin = useSpinChar(!info && !loadError);

  const begin = useCallback(async () => {
    setLoadError('');
    try {
      setInfo(await papi<{ secret: string; otpauth: string }>('POST', '/totp/begin', {}));
    } catch (err) {
      setLoadError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
  }, [begin]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await papi('POST', '/totp/confirm', { code: code.trim() });
      setInfo(null);
      await onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      command="$ kutgate totp-setup"
      windowTitle="kutgate — totp"
      heading="İki adımlı doğrulama"
      subtitle="Kimlik doğrulayıcı uygulamanıza aşağıdaki anahtarı ekleyin, ardından üretilen kodu girin."
      onSubmit={submit}
    >
      {loadError ? (
        <>
          <ErrorLine message={loadError} />
          <TermButton onClick={() => void begin()}>Yeniden dene</TermButton>
        </>
      ) : !info ? (
        <p className="kg-auth-sub" role="status">
          Yükleniyor… <span aria-hidden="true">{spin}</span>
        </p>
      ) : (
        <>
          <div className="kg-auth-qr">
            <QrCode value={info.otpauth} />
            <p className="kg-auth-hint">Karekodu kimlik doğrulayıcı uygulamanızla okutun</p>
          </div>
          <div>
            <span className="kg-auth-label-block">Gizli anahtar</span>
            <div className="kg-auth-secret">{info.secret}</div>
            <p className="kg-auth-hint kg-auth-hint-flush">Karekodu okutamıyorsanız bu anahtarı elle girin</p>
          </div>
          <details className="kg-auth-adv">
            <summary>Gelişmiş</summary>
            <span className="kg-auth-label-block">otpauth bağlantısı</span>
            <div className="kg-auth-secret">{info.otpauth}</div>
          </details>
          <TermField label="doğrulama kodu" hint="Uygulamadaki 6 haneli kod.">
            {(id, d) => (
              <input
                id={id}
                className="kg-auth-input"
                aria-describedby={d}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            )}
          </TermField>
          <ErrorLine message={error} />
          <TermButton type="submit" primary busy={busy} busyLabel="işleniyor..." keyHint="enter">
            Etkinleştir
          </TermButton>
        </>
      )}
      <div className="kg-auth-actions">
        <TermButton onClick={onLogout}>Çıkış</TermButton>
      </div>
    </AuthShell>
  );
}

function TermPinButton({ type, primary, busy, busyLabel, onClick, children }: { type?: 'submit' | 'button'; primary?: boolean; busy?: boolean; busyLabel?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <TermButton type={type} primary={primary} busy={busy} busyLabel={busyLabel} keyHint={primary ? 'enter' : undefined} onClick={onClick}>
      {children}
    </TermButton>
  );
}

const TERM_PIN_SKIN: PinSkin = {
  Field: TermField,
  Button: TermPinButton,
  ErrorLine,
  inputClass: 'kg-auth-input',
  actionsClass: 'kg-auth-actions',
  lowercaseLabels: true,
};

function PinSetupStage({ onDone, onLogout }: { onDone: () => Promise<void>; onLogout: () => void }) {
  return (
    <PinSetupScreen
      skin={TERM_PIN_SKIN}
      onLogout={onLogout}
      shell={({ onSubmit, title, description, children }) => (
        <AuthShell command="$ kutgate pin" windowTitle="kutgate — pin" heading={title} subtitle={description} onSubmit={onSubmit}>
          {children}
        </AuthShell>
      )}
      onSubmit={async (password, pin) => {
        await papi('POST', '/pin', { password, pin });
        await onDone();
      }}
    />
  );
}

function Shell() {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      setStatus(await getStatus());
    } catch (err) {
      setLoadError(errMsg(err));
    }
  }, []);

  /** Kilit durumu için sessiz okuma: ağ hatası paneli ve açık işleri bozmaz. */
  const refreshQuiet = useCallback(async () => {
    try {
      setStatus(await getStatus());
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const on = () => void refreshQuiet();
    window.addEventListener(EVT_LOCKED, on);
    window.addEventListener(EVT_RECHECK, on);
    return () => {
      window.removeEventListener(EVT_LOCKED, on);
      window.removeEventListener(EVT_RECHECK, on);
    };
  }, [refreshQuiet]);

  const loggedIn = status?.loggedIn === true;
  useEffect(() => {
    if (loggedIn) loadDashboard().catch(() => undefined);
  }, [loggedIn]);

  /** Çıkış çağrısı ağ hatasında da giriş ekranına döner. */
  const logout = useCallback(async () => {
    try {
      await papi('POST', '/logout', {});
    } catch {
      // Sunucuya ulaşılamasa da yerelde oturum kapanır.
    }
    setLoadError('');
    try {
      setStatus(await getStatus());
    } catch {
      setStatus({ loggedIn: false });
    }
  }, []);

  if (loadError) {
    return (
      <div className="auth-wrap">
        <ErrorState message={loadError} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!status) return <BootPlaceholder />;
  if (!status.loggedIn)
    return (
      <Suspense fallback={<BootPlaceholder />}>
        <TeamPage />
      </Suspense>
    );
  const setup =
    status.stage === 'change_password' ? (
      <ChangePasswordScreen username={status.username ?? ''} onDone={refresh} onLogout={() => void logout()} />
    ) : status.stage === 'setup_totp' ? (
      <TotpSetupScreen onDone={refresh} onLogout={() => void logout()} />
    ) : status.stage === 'setup_pin' ? (
      <PinSetupStage onDone={refresh} onLogout={() => void logout()} />
    ) : null;
  if (setup) return <Suspense fallback={<BootPlaceholder />}>{setup}</Suspense>;
  return (
    <LockGate
      base="/papi"
      username={status.username ?? ''}
      lock={status.lock}
      serverLocked={status.stage === 'locked'}
      onStateChange={() => void refreshQuiet()}
      onLogout={logout}
    >
      <Suspense fallback={<BootPlaceholder />}>
        <DashboardScreen
          username={status.username ?? ''}
          maxMinutes={status.maxMinutes}
          unreadAdminNotes={status.unreadAdminNotes ?? 0}
          lock={status.lock}
          onLockChanged={() => void refreshQuiet()}
          onLogout={() => void logout()}
          onUnauthorized={() => void refreshQuiet()}
        />
      </Suspense>
    </LockGate>
  );
}

export function PortalApp() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
