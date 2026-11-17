import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { del, errMsg, get, post, put } from '../../core/api';
import type { Feature } from '../../core/registry';
import { minuteLabel } from '../../core/lock/types';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Modal, PageHeader, RowMenu, Spinner, Table, Time, useToast } from '../../core/ui';

interface Account {
  userId: number;
  username: string;
  enabled: boolean;
  mustChange: boolean;
  totpEnabled: boolean;
  lastLogin: string | null;
  portalMode: boolean;
  hasApiKey: boolean;
  maxEffort: string;
}
interface UserRow {
  id: number;
  username: string;
}
interface Settings {
  idleMinutes: number;
  maxMinutes: number;
  maxConcurrent: number;
  detachMinutes: number;
}

const EFFORT_CHOICES: [string, string][] = [
  ['low', 'Düşük'],
  ['medium', 'Orta'],
  ['high', 'Yüksek'],
  ['xhigh', 'Çok yüksek'],
  ['max', 'En yüksek'],
];

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function statusText(a: Account): string {
  return [
    `Hesap: ${a.enabled ? 'Etkin' : 'Pasif'}`,
    `Parola: ${a.mustChange ? 'Değiştirilecek' : 'Belirlendi'}`,
    `TOTP: ${a.totpEnabled ? 'Etkin' : 'Kurulmadı'}`,
    `API anahtarı: ${a.hasApiKey ? 'Tanımlı' : 'Yok'}`,
    `SSH: ${a.portalMode ? 'Kapalı (portal modu)' : 'Açık'}`,
  ].join(' · ');
}

function TempPasswordModal({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success('Geçici parola kopyalandı.');
    } catch {
      toast.error('Geçici parola kopyalanamadı.');
    }
  };
  return (
    <Modal open title={`Geçici parola: ${username}`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Kapat</Button>}>
      <div className="pw-box">
        <p className="keygen-warn">Bu parola yalnızca şimdi gösterilir. Kapattıktan sonra tekrar görülemez; kullanıcıya güvenli kanaldan iletin.</p>
        <div className="secret" data-autofocus tabIndex={0}>
          {password}
        </div>
        <Button onClick={() => void copy()}>Kopyala</Button>
      </div>
    </Modal>
  );
}

function ApiKeyModal({ account, onClose, onChanged }: { account: Account; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    // Terminalden kopyalanan uzun anahtarlar satır sonu/boşluk içerebilir; anahtarlarda boşluk olmaz.
    const clean = key.replace(/\s+/g, '');
    if (!KEY_RE.test(clean)) {
      setError('Anahtar biçimi geçersiz (sk-ant-… ile başlamalı).');
      return;
    }
    setBusy(true);
    try {
      await put(`/api/portal/apikey/${account.userId}`, { key: clean });
      setKey('');
      toast.success(`${account.username}: API anahtarı ayarlandı.`);
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await del(`/api/portal/apikey/${account.userId}`);
      toast.success(`${account.username}: API anahtarı silindi.`);
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setConfirmDel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={!confirmDel}
        title={`API anahtarı: ${account.username}`}
        onClose={onClose}
        footer={
          <>
            {account.hasApiKey ? (
              <Button variant="danger" onClick={() => setConfirmDel(true)}>
                Anahtarı sil
              </Button>
            ) : null}
            <Button onClick={onClose}>Vazgeç</Button>
            <Button variant="primary" type="submit" form="apikey-form" busy={busy}>
              Kaydet
            </Button>
          </>
        }
      >
        <form id="apikey-form" onSubmit={save}>
          <p className="muted">Durum: {account.hasApiKey ? 'Anahtar tanımlı.' : 'Anahtar tanımlı değil.'} Kaydedilen anahtar bir daha gösterilmez.</p>
          <Field label="Anthropic API anahtarı">
            {(id) => (
              <input
                id={id}
                data-autofocus
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
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
        </form>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        title="API anahtarını sil"
        message={`${account.username} için API anahtarı silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDel(false)}
      />
    </>
  );
}

interface LockSettings {
  maxMinutes: number;
  options: number[];
}

function LockLimitForm() {
  const toast = useToast();
  const [ls, setLs] = useState<LockSettings | null>(null);
  const [value, setValue] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const r = await get<LockSettings>('/api/lock/settings');
      setLs(r);
      setValue(r.maxMinutes);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await put('/api/lock/settings', { maxMinutes: value });
      toast.success('Ekran kilidi üst sınırı kaydedildi.');
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!ls) return <Spinner />;
  return (
    <form onSubmit={save}>
      <Field label="Ekran kilidi üst sınırı" hint="Portal kullanıcıları ve yöneticiler bu süreden uzununu seçemez.">
        {(id, d) => (
          <select id={id} aria-describedby={d} className="input-narrow" value={value} onChange={(e) => setValue(Number(e.target.value))}>
            {ls.options.map((m) => (
              <option key={m} value={m}>
                {minuteLabel(m)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={value === ls.maxMinutes}>
          Kaydet
        </Button>
      </div>
    </form>
  );
}

function SettingsCard() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setS(await get<Settings>('/api/portal/settings'));
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    setError('');
    if (s.idleMinutes < 1 || s.idleMinutes > 240 || s.maxMinutes < 5 || s.maxMinutes > 1440 || s.maxConcurrent < 1 || s.maxConcurrent > 5 || s.detachMinutes < 1 || s.detachMinutes > 120) {
      setError('Değerler aralık dışında.');
      return;
    }
    setBusy(true);
    try {
      await put('/api/portal/settings', s);
      toast.success('Portal ayarları kaydedildi.');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <Card title="Ayarlar" className="settings-card">
      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !s ? (
        <Spinner />
      ) : (
        <form onSubmit={save}>
          <div className="form-row">
            <Field label="Boşta süresi (dakika)" hint="1-240">
              {(id, d) => (
                <input id={id} aria-describedby={d} type="number" min={1} max={240} value={s.idleMinutes || ''} onChange={(e) => setS({ ...s, idleMinutes: num(e.target.value) })} required />
              )}
            </Field>
            <Field label="En uzun oturum (dakika)" hint="5-1440">
              {(id, d) => (
                <input id={id} aria-describedby={d} type="number" min={5} max={1440} value={s.maxMinutes || ''} onChange={(e) => setS({ ...s, maxMinutes: num(e.target.value) })} required />
              )}
            </Field>
            <Field label="Kullanıcı başına eşzamanlı terminal" hint="1-5">
              {(id, d) => (
                <input id={id} aria-describedby={d} type="number" min={1} max={5} value={s.maxConcurrent || ''} onChange={(e) => setS({ ...s, maxConcurrent: num(e.target.value) })} required />
              )}
            </Field>
            <Field label="Bağlantı koparsa oturumu açık tut (dakika)" hint="1-120 · ekran kilidi, ağ değişimi">
              {(id, d) => (
                <input id={id} aria-describedby={d} type="number" min={1} max={120} value={s.detachMinutes || ''} onChange={(e) => setS({ ...s, detachMinutes: num(e.target.value) })} required />
              )}
            </Field>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={busy}>
              Kaydet
            </Button>
          </div>
        </form>
      )}
      <LockLimitForm />
    </Card>
  );
}

interface DeletedChat {
  username: string;
  id: string;
  title: string;
  deletedAt: number;
}

const PERM_LABELS: Record<string, string> = {
  pending: 'Bekliyor',
  allowed: 'Onaylandı',
  allowed_always: 'Oturumda onaylandı',
  denied: 'Reddedildi',
  expired: 'Süresi doldu',
};
const QUESTION_LABELS: Record<string, string> = { pending: 'Bekliyor', answered: 'Yanıtlandı', expired: 'Süresi doldu' };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface ViewLine {
  key: string;
  label: string;
  text: string;
  ts: number | null;
}

function toLines(events: unknown): ViewLine[] {
  if (!Array.isArray(events)) return [];
  const out: ViewLine[] = [];
  events.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    const ts = typeof e.ts === 'number' ? e.ts : null;
    const key = `${i}-${str(e.id)}`;
    const push = (label: string, text: string) => out.push({ key, label, text, ts });
    switch (e.kind) {
      case 'user': {
        const names = Array.isArray(e.attachments)
          ? e.attachments.map((a) => (a && typeof a === 'object' ? str((a as Record<string, unknown>).name) : '')).filter(Boolean)
          : [];
        push('Kullanıcı', [str(e.text), names.length ? `Ekler: ${names.join(', ')}` : ''].filter(Boolean).join('\n'));
        break;
      }
      case 'text':
        push('Ajan', str(e.text));
        break;
      case 'tool': {
        const detail = str(e.path) || str(e.command) || str(e.pattern);
        const result = str(e.error) || str(e.summary);
        push('Araç', [str(e.name), detail, result].filter(Boolean).join(' · '));
        break;
      }
      case 'permission': {
        const detail = str(e.command) || str(e.path);
        const st = PERM_LABELS[str(e.status)] ?? str(e.status);
        push('İzin', [str(e.name), detail, st].filter(Boolean).join(' · '));
        break;
      }
      case 'question':
        push('Soru', QUESTION_LABELS[str(e.status)] ?? str(e.status));
        break;
      case 'turn_end':
        if (e.outcome === 'error' || e.outcome === 'stopped') {
          push('Tur', [e.outcome === 'error' ? 'Hata ile bitti' : 'Durduruldu', str(e.message)].filter(Boolean).join(': '));
        }
        break;
      case 'notice':
        push('Bildirim', str(e.text));
        break;
      default:
        break;
    }
  });
  return out;
}

function DeletedChatModal({ chat, onClose }: { chat: DeletedChat; onClose: () => void }) {
  const [lines, setLines] = useState<ViewLine[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    setLines(null);
    try {
      const r = await get<{ events: unknown }>(`/api/portal/deleted-chats/${encodeURIComponent(chat.username)}/${encodeURIComponent(chat.id)}`);
      setLines(toLines(r?.events));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [chat.username, chat.id]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Modal open wide title={`${chat.username}: ${chat.title}`} onClose={onClose} footer={<Button variant="primary" onClick={onClose} data-autofocus>Kapat</Button>}>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : lines === null ? (
        <Spinner />
      ) : lines.length === 0 ? (
        <Empty>Gösterilecek kayıt yok.</Empty>
      ) : (
        <div className="chat-view">
          {lines.map((l) => (
            <div key={l.key} className="chat-line">
              <div className="chat-meta muted">
                <strong>{l.label}</strong>
                {l.ts !== null ? <span>{new Date(l.ts).toLocaleTimeString('tr-TR')}</span> : null}
              </div>
              <div className="chat-text">{l.text}</div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function DeletedChatsCard() {
  const [rows, setRows] = useState<DeletedChat[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<DeletedChat | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await get<DeletedChat[]>('/api/portal/deleted-chats');
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const names = Array.from(new Set((rows ?? []).map((r) => r.username))).sort();
  const shown = (rows ?? []).filter((r) => !filter || r.username === filter);

  return (
    <Card title="Silinen sohbetler" actions={<Button small onClick={() => void load()}>Yenile</Button>}>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner />
      ) : (
        <>
          <div className="toolbar">
            <select aria-label="Kullanıcı" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Tüm kullanıcılar</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="hint toolbar-note toolbar-inline">
              Kullanıcıların listesinden sildiği sohbetler burada saklanır. Görüntülemeler denetim kaydına yazılır.
            </span>
          </div>
          <Table
            head={['Kullanıcı', 'Sohbet başlığı', 'Silinme zamanı', '']}
            empty={shown.length === 0 ? <Empty>Silinen sohbet yok.</Empty> : undefined}
          >
            {shown.map((r) => (
              <tr key={`${r.username}/${r.id}`}>
                <td className="mono">{r.username}</td>
                <td className="clip" title={r.title}>
                  {r.title}
                </td>
                <td>
                  <Time value={r.deletedAt} />
                </td>
                <td className="actions">
                  <Button small onClick={() => setView(r)}>
                    Görüntüle
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {view ? <DeletedChatModal chat={view} onClose={() => setView(null)} /> : null}
    </Card>
  );
}

function PortalPage() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersError, setUsersError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pickUser, setPickUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ userId: number; username: string } | null>(null);
  const [delTarget, setDelTarget] = useState<Account | null>(null);
  const [keyTarget, setKeyTarget] = useState<Account | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    const [a, u] = await Promise.allSettled([get<Account[]>('/api/portal/accounts'), get<UserRow[]>('/api/users')]);
    if (a.status === 'fulfilled') setAccounts(a.value);
    else setLoadError(errMsg(a.reason));
    if (u.status === 'fulfilled') {
      setUsers(u.value);
      setUsersError('');
    } else {
      setUsers([]);
      setPickUser('');
      setUsersError(errMsg(u.reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [effortBusy, setEffortBusy] = useState<number | null>(null);
  const setMaxEffort = async (a: Account, maxEffort: string) => {
    setEffortBusy(a.userId);
    try {
      await put(`/api/portal/accounts/${a.userId}/max-effort`, { maxEffort });
      toast.success('Efor sınırı güncellendi');
    } catch (e) {
      toast.error(errMsg(e));
    }
    setEffortBusy(null);
    await load();
  };

  const warnSessions = (r: { sessionsKilled?: boolean } | null | undefined) => {
    if (r && r.sessionsKilled === false) {
      toast.warn('İşlem yapıldı ama açık oturumlar kapatılamadı. Oturumlar sayfasından kontrol edin.');
    }
  };

  const createOrReset = async (userId: number, username: string) => {
    setBusy(true);
    try {
      const r = await post<{ tempPassword: string; sessionsKilled?: boolean }>(`/api/portal/accounts/${userId}`);
      setTemp({ username, password: r.tempPassword });
      warnSessions(r);
      setResetTarget(null);
      setPickUser('');
      await load();
    } catch (e) {
      toast.error(errMsg(e));
      setResetTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a: Account) => {
    try {
      const r = await post<{ sessionsKilled?: boolean } | null>(`/api/portal/accounts/${a.userId}/enabled`, { enabled: !a.enabled });
      toast.success(`${a.username}: hesap ${a.enabled ? 'pasifleştirildi' : 'etkinleştirildi'}.`);
      warnSessions(r);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const remove = async () => {
    if (!delTarget) return;
    setBusy(true);
    try {
      const r = await del<{ sessionsKilled?: boolean } | null>(`/api/portal/accounts/${delTarget.userId}`);
      toast.success(`${delTarget.username}: portal hesabı silindi.`);
      warnSessions(r);
      setDelTarget(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
      setDelTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const withAccount = new Set((accounts ?? []).map((a) => a.userId));
  const candidates = users.filter((u) => !withAccount.has(u.id));

  return (
    <>
      <PageHeader title="Portal hesapları">
        <Button small onClick={() => void load()}>
          Yenile
        </Button>
      </PageHeader>
      <Card title="Hesaplar">
        <div className="toolbar">
          <select
            aria-label="Hesap açılacak kullanıcı"
            value={pickUser}
            onChange={(e) => setPickUser(e.target.value)}
            disabled={usersError !== ''}
          >
            <option value="">Kullanıcı seçin…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
          <Button
            small
            variant="primary"
            busy={busy}
            disabled={!pickUser || usersError !== ''}
            onClick={() => {
              const u = users.find((x) => String(x.id) === pickUser);
              if (u) void createOrReset(u.id, u.username);
            }}
          >
            Hesap oluştur
          </Button>
          <span className="hint toolbar-note">Hesap açılınca kullanıcının SSH erişimi kapanır; geçici parola yalnızca bir kez gösterilir.</span>
        </div>
        {usersError ? <ErrorState message={`Kullanıcı listesi alınamadı: ${usersError}`} onRetry={() => void load()} /> : null}
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : accounts === null ? (
          <Spinner />
        ) : (
          <Table
            head={['Kullanıcı', 'Durum', 'En yüksek efor', 'Son giriş', '']}
            empty={accounts.length === 0 ? <Empty>Portal hesabı yok.</Empty> : undefined}
          >
            {accounts.map((a) => (
              <tr key={a.userId}>
                <td className="mono">{a.username}</td>
                <td className="status-cell" title={statusText(a)}>
                  <div className="badges badges-row">
                    {!a.enabled ? (
                      <Badge tone="bad" title="Hesap durumu: Pasif">
                        Pasif
                      </Badge>
                    ) : null}
                    {!a.totpEnabled ? (
                      <Badge tone="warn" title="TOTP: Kurulmadı">
                        TOTP kurulmadı
                      </Badge>
                    ) : null}
                    {a.mustChange ? (
                      <Badge tone="warn" title="Parola: ilk girişte değiştirilecek">
                        Parola değiştirilecek
                      </Badge>
                    ) : null}
                    {a.hasApiKey ? (
                      <Badge tone="ok" title="API anahtarı: Tanımlı">
                        API anahtarı: Tanımlı
                      </Badge>
                    ) : null}
                    <Badge tone={a.portalMode ? 'info' : 'neutral'} title={a.portalMode ? 'SSH: Kapalı (portal modu)' : 'SSH: Açık'}>
                      {a.portalMode ? 'SSH Kapalı' : 'SSH Açık'}
                    </Badge>
                  </div>
                </td>
                <td>
                  <select
                    aria-label={`${a.username} en yüksek efor`}
                    value={a.maxEffort}
                    disabled={effortBusy === a.userId}
                    onChange={(e) => void setMaxEffort(a, e.target.value)}
                  >
                    {EFFORT_CHOICES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{a.lastLogin ? <Time value={a.lastLogin} /> : 'Hiç'}</td>
                <td className="actions actions-nowrap">
                  <Button small onClick={() => setKeyTarget(a)}>
                    API anahtarı
                  </Button>
                  <RowMenu
                    label={`${a.username} işlemleri`}
                    items={[
                      { label: 'Sıfırla', onSelect: () => setResetTarget({ userId: a.userId, username: a.username }) },
                      { label: a.enabled ? 'Pasifleştir' : 'Etkinleştir', onSelect: () => void toggle(a) },
                      { label: 'Sil', danger: true, onSelect: () => setDelTarget(a) },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="hint card-note">Efor sınırı: kullanıcı bu seviyenin üstünü sohbette seçemez. Yeni sınır bir sonraki mesajında geçerli olur.</p>
      </Card>
      <DeletedChatsCard />
      <SettingsCard />
      {temp ? <TempPasswordModal username={temp.username} password={temp.password} onClose={() => setTemp(null)} /> : null}
      {keyTarget ? <ApiKeyModal account={keyTarget} onClose={() => setKeyTarget(null)} onChanged={() => void load()} /> : null}
      <ConfirmDialog
        open={resetTarget !== null}
        title="Hesabı sıfırla"
        message={`${resetTarget?.username ?? ''} için yeni geçici parola üretilecek; TOTP kurulumu, ekran kilidi PIN'i ve kilit süresi sıfırlanacak, açık portal oturumları kapatılacak.`}
        confirmLabel="Sıfırla"
        danger
        busy={busy}
        onConfirm={() => resetTarget && void createOrReset(resetTarget.userId, resetTarget.username)}
        onCancel={() => setResetTarget(null)}
      />
      <ConfirmDialog
        open={delTarget !== null}
        title="Portal hesabını sil"
        message={`${delTarget?.username ?? ''} portal hesabı silinecek ve SSH erişimi yeniden açılacak.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDelTarget(null)}
      />
    </>
  );
}

const feature: Feature = { id: 'portal', title: 'Portal hesapları', icon: 'portal', Page: PortalPage };
export default feature;
