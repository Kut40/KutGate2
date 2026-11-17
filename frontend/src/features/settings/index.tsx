import { useEffect, useState, type FormEvent } from 'react';
import { del, errMsg, get, post, put } from '../../core/api';
import { PinSetupScreen } from '../../core/lock/PinSetupScreen';
import { minuteLabel } from '../../core/lock/types';
import type { Feature } from '../../core/registry';
import { QrCode } from '../../core/QrCode';
import { useSession } from '../../core/session';
import { Badge, Button, Card, Field, Modal, PageHeader, useToast } from '../../core/ui';

function LockCard() {
  const { status, refresh } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const lock = status?.lock;

  const changeMinutes = async (minutes: number) => {
    setBusy(true);
    try {
      await put('/api/auth/lock/minutes', { minutes });
      toast.success(`Kilit süresi ${minuteLabel(minutes)} olarak ayarlandı.`);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ekran kilidi">
      {lock ? (
        <Field label="Kilit süresi" hint="Hareketsiz kalınca ekran bu süre sonunda kilitlenir. Üstü yönetici sınırıyla belirlenir.">
          {(id, d) => (
            <select id={id} aria-describedby={d} className="input-narrow" value={lock.minutes} disabled={busy} onChange={(e) => void changeMinutes(Number(e.target.value))}>
              {lock.options.map((m) => (
                <option key={m} value={m} disabled={m > lock.maxMinutes}>
                  {minuteLabel(m)}
                  {m > lock.maxMinutes ? ' (yönetici sınırı)' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <p className="hint">4 haneli PIN ile açılır. PIN&apos;i değiştirmek için hesap parolası gerekir.</p>
      <Button onClick={() => setPinOpen(true)}>PIN değiştir</Button>
      <Modal open={pinOpen} title="PIN değiştir" onClose={() => setPinOpen(false)}>
        <PinSetupScreen
          submitLabel="PIN&#8217;i değiştir"
          onCancel={() => setPinOpen(false)}
          onSubmit={async (password, pin) => {
            await post('/api/auth/pin', { password, pin });
            toast.success('PIN değiştirildi.');
            setPinOpen(false);
          }}
        />
      </Modal>
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== again) {
      setError('Yeni parola iki alanda aynı olmalı.');
      return;
    }
    setBusy(true);
    try {
      await post('/api/auth/password', { current, new: next });
      toast.success('Parola değiştirildi. Diğer açık oturumlar kapatıldı.');
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Parola">
      <form onSubmit={submit}>
        <Field label="Geçerli parola">
          {(id) => <input id={id} className="input-narrow" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />}
        </Field>
        <Field label="Yeni parola" hint="En az 10 karakter. Kullanıcı adınızı içeremez.">
          {(id, d) => <input id={id} aria-describedby={d} className="input-narrow" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />}
        </Field>
        <Field label="Yeni parola (tekrar)">
          {(id) => <input id={id} className="input-narrow" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />}
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" busy={busy}>
          Parolayı değiştir
        </Button>
      </form>
    </Card>
  );
}

const CLAUDE_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function ClaudeKeyCard() {
  const toast = useToast();
  const [state, setState] = useState<{ set: boolean; hint: string | null } | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ set: boolean; hint: string | null }>('/api/settings/claude-key')
      .then(setState)
      .catch((e) => setError(errMsg(e)));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const clean = key.replace(/\s+/g, '');
    if (!CLAUDE_KEY_RE.test(clean)) {
      setError('Anahtar biçimi geçersiz (sk-ant-… ile başlamalı).');
      return;
    }
    setBusy(true);
    try {
      setState(await put<{ set: boolean; hint: string | null }>('/api/settings/claude-key', { key: clean }));
      setKey('');
      toast.success('Claude API anahtarı kaydedildi.');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      setState(await del<{ set: boolean; hint: string | null }>('/api/settings/claude-key'));
      toast.success('Claude API anahtarı silindi.');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Claude API anahtarı (skill üretici)"
      actions={state?.set ? <Badge tone="ok">Tanımlı · {state.hint}</Badge> : <Badge tone="neutral">Tanımlı değil</Badge>}
    >
      <p className="hint">
        Skill üretici ve geliştirme günlüğü özeti bu anahtarla çalışır. Tanımlı değilse sunucudaki claude.ai girişi kullanılır.
        Kaydedilen anahtar bir daha gösterilmez.
      </p>
      <form onSubmit={save}>
        <Field label="Anthropic API anahtarı">
          {(id) => (
            <input
              id={id}
              className="input-narrow"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-api03-…"
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="toolbar">
          <Button type="submit" variant="primary" busy={busy}>
            {state?.set ? 'Anahtarı değiştir' : 'Kaydet'}
          </Button>
          {state?.set ? (
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              Anahtarı sil
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function SettingsPage() {
  const { status, meta, refresh } = useSession();
  const toast = useToast();
  const [setupData, setSetupData] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const begin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setSetupData(await post<{ secret: string; otpauth: string }>('/api/auth/totp/begin', { password }));
      setPassword('');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/auth/totp/confirm', { code: code.trim() });
      toast.success('TOTP etkinleştirildi.');
      setSetupData(null);
      setCode('');
      await refresh();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Ayarlar" />
      <Card
        title="İki adımlı doğrulama (TOTP)"
        actions={status?.totpEnabled ? <Badge tone="ok">Etkin</Badge> : <Badge tone="neutral">Etkin değil</Badge>}
      >
        {!setupData ? (
          <>
            <p>
              {status?.totpEnabled
                ? 'TOTP etkin. Yeni bir gizli anahtar oluşturmak mevcut kurulumu değiştirir.'
                : 'Girişte kimlik doğrulayıcı uygulamadan alınan 6 haneli kod istemek için TOTP kurun.'}
            </p>
            <form onSubmit={begin}>
              <Field label="Hesap parolası" hint="Kurulumu başlatmak için gerekir.">
                {(id, d) => <input id={id} aria-describedby={d} className="input-narrow" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
              </Field>
              <Button type="submit" variant="primary" busy={busy}>
                {status?.totpEnabled ? 'Yeniden kur' : 'Kurulumu başlat'}
              </Button>
            </form>
          </>
        ) : (
          <form onSubmit={confirm}>
            <p>Gizli anahtarı kimlik doğrulayıcı uygulamanıza girin (SHA1, 6 hane, 30 sn) veya otpauth adresini kullanın.</p>
            <div className="field">
              <QrCode value={setupData.otpauth} />
              <p className="muted">Karekodu kimlik doğrulayıcı uygulamanızla okutun.</p>
            </div>
            <div className="field">
              <span className="label">Gizli anahtar</span>
              <div className="secret">{setupData.secret}</div>
            </div>
            <div className="field">
              <span className="label">otpauth adresi</span>
              <div className="secret secret-sm">
                {setupData.otpauth}
              </div>
            </div>
            <Field label="Doğrulama kodu" hint="Uygulamada görünen 6 haneli kod.">
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  className="input-narrow"
                />
              )}
            </Field>
            <div className="toolbar">
              <Button type="submit" variant="primary" busy={busy}>
                Doğrula ve etkinleştir
              </Button>
              <Button
                onClick={() => {
                  setSetupData(null);
                  setCode('');
                }}
              >
                Vazgeç
              </Button>
            </div>
          </form>
        )}
      </Card>
      <PasswordCard />
      <LockCard />
      <ClaudeKeyCard />
      {meta ? (
        <Card title="Sunucu">
          <dl className="kv">
            <dt>Dry-run</dt>
            <dd>{meta.dryRun ? 'Evet' : 'Hayır'}</dd>
            <dt>Kurallar kökü</dt>
            <dd className="mono">{meta.rulesRoot}</dd>
            <dt>Home kökü</dt>
            <dd className="mono">{meta.homeRoot}</dd>
            <dt>Projeler kökü</dt>
            <dd className="mono">{meta.projectsRoot}</dd>
            <dt>Modüller</dt>
            <dd>{meta.modules.join(', ')}</dd>
          </dl>
        </Card>
      ) : null}
    </>
  );
}

const feature: Feature = { id: 'settings', title: 'Ayarlar', icon: 'settings', Page: SettingsPage };
export default feature;
