import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, errMsg, post } from './api';
import { LockGate } from './lock/LockGate';
import { PinSetupScreen } from './lock/PinSetupScreen';
import { Layout } from './Layout';
import { visibleFeatures } from './registry';
import { SessionProvider, useSession } from './session';
import { Button, ConfirmDialog, Field, Spinner, ToastProvider } from './ui';
import { hasUnsavedChanges } from './unsaved';

const routeOf = (hash: string) => hash.replace(/^#\/?/, '').split('/')[0] ?? '';

function useHashRoute() {
  const [route, setRoute] = useState(() => routeOf(window.location.hash));
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: HashChangeEvent) => {
      const next = routeOf(window.location.hash);
      if (hasUnsavedChanges() && next !== routeOf(new URL(e.oldURL).hash)) {
        const target = window.location.hash;
        window.history.replaceState(window.history.state, '', e.oldURL);
        setLeaveTo(target);
        return;
      }
      setRoute(next);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const confirmLeave = () => {
    if (leaveTo === null) return;
    window.history.pushState(null, '', leaveTo);
    setRoute(routeOf(leaveTo));
    setLeaveTo(null);
  };
  const cancelLeave = () => setLeaveTo(null);
  return { route, leaveTo, confirmLeave, cancelLeave };
}

function SetupScreen() {
  const { setup } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 10) {
      setError('Parola en az 10 karakter olmalı.');
      return;
    }
    setBusy(true);
    try {
      await setup(username, password);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Gate</h1>
        <p className="muted">İlk kurulum: yönetici hesabını oluşturun.</p>
        <Field label="Kullanıcı adı">
          {(id) => (
            <input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          )}
        </Field>
        <Field label="Parola" hint="En az 10 karakter.">
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
          )}
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" busy={busy}>
          Yönetici oluştur
        </Button>
      </form>
    </div>
  );
}

function LoginScreen() {
  const { login } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username, password, needTotp ? totp : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedTotp(true);
        setError('Doğrulama kodu gerekli.');
      } else {
        setError(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Gate</h1>
        <p className="muted">Yönetici girişi</p>
        <Field label="Kullanıcı adı">
          {(id) => (
            <input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          )}
        </Field>
        <Field label="Parola">
          {(id) => (
            <input
              id={id}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        {needTotp ? (
          <Field label="TOTP kodu" hint="Kimlik doğrulayıcı uygulamadaki 6 haneli kod.">
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            )}
          </Field>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" busy={busy}>
          Giriş yap
        </Button>
      </form>
    </div>
  );
}

function UnreachableScreen() {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Gate</h1>
        <p className="form-error" role="alert">
          Sunucuya ulaşılamıyor.
        </p>
        <p className="muted">Bağlantınızı kontrol edip yeniden deneyin.</p>
        <Button variant="primary" busy={busy} onClick={() => void retry()}>
          Yeniden dene
        </Button>
      </div>
    </div>
  );
}

function Shell() {
  const { loading, status, meta, unreachable, refresh, logout } = useSession();
  const { route, leaveTo, confirmLeave, cancelLeave } = useHashRoute();
  const features = useMemo(() => (meta ? visibleFeatures(meta.modules) : []), [meta]);
  const firstId = features[0]?.id;
  const routeMatched = features.some((f) => f.id === route);

  useEffect(() => {
    if (firstId && !routeMatched) window.location.replace(`#/${firstId}`);
  }, [firstId, routeMatched]);

  if (unreachable && !status) return <UnreachableScreen />;
  if (loading || !status) {
    return (
      <div className="auth-wrap">
        <Spinner />
      </div>
    );
  }
  if (status.needsSetup) return <SetupScreen />;
  if (!status.loggedIn) return <LoginScreen />;
  if (status.pinRequired) {
    return (
      <PinSetupScreen
        variant="screen"
        onLogout={() => void logout()}
        onSubmit={async (password, pin) => {
          await post('/api/auth/pin', { password, pin });
          await refresh();
        }}
      />
    );
  }
  if (!meta && !status.locked) {
    return (
      <div className="auth-wrap">
        <Spinner />
      </div>
    );
  }

  const current = features.find((f) => f.id === route) ?? features[0];
  let panel: ReactNode = null;
  if (meta && current) {
    const Page = current.Page;
    panel = (
      <Layout features={features} current={current.id}>
        <Page key={current.id} />
      </Layout>
    );
  }
  return (
    <LockGate
      base="/api/auth"
      username={status.username ?? ''}
      lock={status.lock}
      serverLocked={status.locked === true}
      onStateChange={() => void refresh()}
      onLogout={logout}
    >
      {panel}
      <ConfirmDialog
        open={leaveTo !== null}
        title="Kaydedilmemiş değişiklikler"
        message="Kaydedilmemiş değişiklikler var. Bu sayfadan çıkarsanız kaybolacak."
        confirmLabel="Sayfadan çık"
        danger
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
    </LockGate>
  );
}

export function App() {
  return (
    <div className="admin-app">
      <ToastProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ToastProvider>
    </div>
  );
}
