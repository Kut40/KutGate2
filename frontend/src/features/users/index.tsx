import { useCallback, useEffect, useState, type FormEvent } from 'react';
import defaultAvatar from '../../portal/team-photos/default-avatar.svg';
import { apiResponse, del, errMsg, get, post, put } from '../../core/api';
import { fileToAvatar } from '../../core/avatarImage';
import type { Feature } from '../../core/registry';
import { fmtClock } from '../sessions/util';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Modal, PageHeader, RowMenu, Spinner, Table, Time, useToast } from '../../core/ui';

interface User {
  id: number;
  username: string;
  display: string;
  ranks: string[];
  avatar: string | null;
  locked: boolean;
  created: string;
  keyCount: number;
  grants: { folderId: number; perm: 'r' | 'rw' }[];
}
interface SshKey {
  id: number;
  comment: string;
  fingerprint: string;
  key: string;
}

interface GenerateResult {
  keyId: number;
  fingerprint: string;
  expiresIn: number;
  downloads: { windows: string; unix: string };
}
type Os = 'windows' | 'unix';

const HOST_STORE = 'gate.keygen.host';

function readHost(): string {
  try {
    return window.localStorage.getItem(HOST_STORE) ?? '';
  } catch {
    return '';
  }
}
function saveHost(v: string) {
  try {
    window.localStorage.setItem(HOST_STORE, v);
  } catch {
    return;
  }
}

/** Content-Disposition başlığından dosya adını okur; yoksa null. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // geçersiz kodlama; düz ada düşülür
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/.exec(header);
  const v = (plain?.[1] ?? plain?.[2] ?? '').trim();
  return v ? v.replace(/[\\/]/g, '_') : null;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="keygen-icon" aria-hidden="true" focusable="false">
      <path d="M12 3v12 M7 11l5 5 5-5 M4 20h16" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="keygen-icon" aria-hidden="true" focusable="false">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function KeysModal({ user, onClose, onChanged }: { user: User; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const [keysError, setKeysError] = useState('');
  const [key, setKey] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SshKey | null>(null);

  const [host, setHost] = useState(readHost);
  const [port, setPort] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [endAt, setEndAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [downloaded, setDownloaded] = useState<Record<Os, boolean>>({ windows: false, unix: false });
  const [dlBusy, setDlBusy] = useState<Record<Os, boolean>>({ windows: false, unix: false });

  const load = useCallback(async () => {
    setKeysError('');
    try {
      setKeys(await get<SshKey[]>(`/api/users/${user.id}/keys`));
    } catch (e) {
      setKeysError(errMsg(e));
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!result) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [result, endAt]);

  const expired = result !== null && remaining <= 0;

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    const h = host.trim();
    if (!h) {
      setGenError('Sunucu adresi gerekli.');
      return;
    }
    const body: { host: string; port?: number } = { host: h };
    if (port.trim()) body.port = Number(port.trim());
    setGenerating(true);
    setGenError('');
    try {
      const r = await post<GenerateResult>(`/api/users/${user.id}/keys/generate`, body);
      saveHost(h);
      setResult(r);
      setEndAt(Date.now() + r.expiresIn * 1000);
      setDownloaded({ windows: false, unix: false });
      await load();
      onChanged();
    } catch (err) {
      setGenError(errMsg(err));
    } finally {
      setGenerating(false);
    }
  };

  const download = async (os: Os) => {
    if (!result || expired || downloaded[os] || dlBusy[os]) return;
    setDlBusy((d) => ({ ...d, [os]: true }));
    try {
      const res = await apiResponse('GET', result.downloads[os]);
      const blob = await res.blob();
      const fallback = os === 'windows' ? `baglan-${user.username}.cmd` : `baglan-${user.username}.sh`;
      const name = filenameFrom(res.headers.get('content-disposition')) ?? fallback;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      setDownloaded((d) => ({ ...d, [os]: true }));
    } catch (err) {
      toast.error(`İndirilemedi: ${errMsg(err)}`);
    } finally {
      setDlBusy((d) => ({ ...d, [os]: false }));
    }
  };

  const steps: { text: string; code?: string; after?: string }[] = [
    { text: 'Dosyayı indirin.' },
    { text: "Çift tıklayın (Mac/Linux'ta terminalde ", code: `bash baglan-${user.username}.sh`, after: ').' },
    { text: "İlk bağlanışta 'yes' ya da Enter." },
  ];

  const copyInstructions = async () => {
    try {
      await navigator.clipboard.writeText(
        steps.map((s, i) => `${i + 1}. ${s.text}${s.code ? `"${s.code}"` : ''}${s.after ?? ''}`).join('\n'),
      );
      toast.success('Talimat kopyalandı.');
    } catch {
      toast.error('Talimat kopyalanamadı.');
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: { key: string; comment?: string } = { key: key.trim() };
      if (comment.trim()) body.comment = comment.trim();
      await post(`/api/users/${user.id}/keys`, body);
      toast.success('Anahtar eklendi.');
      setKey('');
      setComment('');
      await load();
      onChanged();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await del(`/api/keys/${removing.id}`);
      toast.success('Anahtar kaldırıldı.');
      setRemoving(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const dlButton = (os: Os, label: string) => (
    <Button variant="primary" onClick={() => void download(os)} disabled={expired || downloaded[os]} busy={dlBusy[os]}>
      {downloaded[os] ? <CheckIcon /> : <DownloadIcon />}
      {downloaded[os] ? `${label.replace(' için indir', '')}: indirildi` : label}
    </Button>
  );

  return (
    <Modal open title={`SSH anahtarları: ${user.username}`} onClose={onClose} wide footer={<Button onClick={onClose}>Kapat</Button>}>
      <section className="keygen" aria-labelledby="keygen-title">
        <h3 id="keygen-title" className="keygen-title">
          Bağlantı dosyası
        </h3>
        <form onSubmit={generate} noValidate>
          <Button type="submit" variant="primary" className="btn-lg keygen-main" busy={generating}>
            Anahtar üret
          </Button>
          <div className="form-row keygen-fields">
            <Field label="Sunucu adresi" hint="Alan adı veya IP. Bu tarayıcıda hatırlanır.">
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  maxLength={253}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sunucu.ornek.com"
                />
              )}
            </Field>
            <Field label="Port (isteğe bağlı)" hint="Boşsa 22.">
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                />
              )}
            </Field>
          </div>
          {genError ? (
            <p className="form-error" role="alert">
              {genError}
            </p>
          ) : null}
        </form>

        {generating ? <Spinner label="Anahtar üretiliyor" /> : null}

        {result ? (
          <div className="keygen-result">
            <p className="keygen-fp">
              Parmak izi: <span className="mono">{result.fingerprint}</span>
            </p>
            <div className="keygen-downloads">
              {dlButton('windows', 'Windows için indir')}
              {dlButton('unix', 'Mac / Linux için indir')}
            </div>
            {expired ? (
              <p className="form-error" role="status">
                Süre doldu, yeniden üretin.
              </p>
            ) : (
              <p className="keygen-timer" role="timer">
                Kalan süre: <strong className="mono">{fmtClock(remaining)}</strong>
              </p>
            )}
            <div className="keygen-steps">
              <ol>
                {steps.map((s, i) => (
                  <li key={i}>
                    {s.text}
                    {s.code ? <code>{s.code}</code> : null}
                    {s.after}
                  </li>
                ))}
              </ol>
              <Button small onClick={() => void copyInstructions()}>
                Talimatı kopyala
              </Button>
            </div>
          </div>
        ) : null}

        <p className="keygen-warn" role="note">
          Bu dosya bir şifre gibidir. Yalnızca kullanıcının kendisine güvenli kanaldan verin; paylaşılan bir sohbete atmayın.
        </p>
      </section>

      <h3 className="keygen-title keygen-list-title">Kayıtlı anahtarlar</h3>
      {keysError ? (
        <ErrorState message={keysError} onRetry={() => void load()} />
      ) : keys === null ? (
        <Spinner />
      ) : (
        <Table head={['Açıklama', 'Parmak izi', '']} empty={keys.length === 0 ? <Empty>Anahtar yok.</Empty> : null}>
          {keys.map((k) => (
            <tr key={k.id}>
              <td className="clip" title={k.comment || undefined}>{k.comment || '-'}</td>
              <td className="mono clip" title={k.key}>
                {k.fingerprint}
              </td>
              <td className="actions">
                <Button small variant="danger" onClick={() => setRemoving(k)}>
                  Kaldır
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <details className="keygen-adv">
        <summary>Gelişmiş: kendi anahtarını ekle</summary>
        <form onSubmit={add}>
          <Field label="Genel anahtar" hint="Tek satır: ssh-ed25519, ssh-rsa veya ecdsa-sha2-* ile başlamalı.">
            {(id, d) => (
              <textarea id={id} aria-describedby={d} value={key} onChange={(e) => setKey(e.target.value)} rows={3} required spellCheck={false} />
            )}
          </Field>
          <Field label="Açıklama (isteğe bağlı)">
            {(id) => <input id={id} value={comment} onChange={(e) => setComment(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            Anahtar ekle
          </Button>
        </form>
      </details>
      <ConfirmDialog
        open={removing !== null}
        title="Anahtarı kaldır"
        message={`"${removing ? removing.comment || removing.fingerprint : ''}" anahtarı kaldırılsın mı?`}
        confirmLabel="Kaldır"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </Modal>
  );
}

function ProfileModal({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [all, setAll] = useState<string[] | null>(null);
  const [display, setDisplay] = useState(user.display);
  const [ranks, setRanks] = useState<string[]>(user.ranks);
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(user.avatar);
  const [photoBusy, setPhotoBusy] = useState(false);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const image = await fileToAvatar(file);
      const u = await put<User>(`/api/users/${user.id}/avatar`, { image });
      setAvatar(u.avatar);
      toast.success('Fotoğraf güncellendi.');
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await del(`/api/users/${user.id}/avatar`);
      setAvatar(null);
      toast.success('Fotoğraf kaldırıldı.');
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  useEffect(() => {
    get<{ ranks: string[] }>('/api/ranks')
      .then((r) => setAll(r.ranks))
      .catch((e: unknown) => {
        toast.error(errMsg(e));
        setAll([]);
      });
  }, [toast]);

  const toggle = (r: string, on: boolean) => setRanks((prev) => (on ? [...prev, r] : prev.filter((x) => x !== r)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await put(`/api/users/${user.id}/profile`, { display: display.trim(), ranks });
      toast.success('Kullanıcı bilgileri kaydedildi.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Kullanıcı bilgileri: ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button type="submit" form="user-profile" variant="primary" busy={busy}>
            Kaydet
          </Button>
        </>
      }
    >
      <form id="user-profile" onSubmit={save}>
        <div className="avatar-edit">
          {avatar ? <img className="avatar-edit-img" src={avatar} alt={`${user.display || user.username} fotoğrafı`} /> : <img className="avatar-edit-img" src={defaultAvatar} alt="Ortak profil resmi" />}
          <div className="avatar-edit-acts">
            <label className="btn btn-secondary btn-sm">
              {avatar ? 'Fotoğrafı değiştir' : 'Fotoğraf yükle'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-file"
                disabled={photoBusy}
                onChange={(e) => {
                  void pickPhoto(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {avatar ? (
              <Button small onClick={() => void removePhoto()} disabled={photoBusy}>
                Kaldır
              </Button>
            ) : null}
            <span className="hint">Kartta 3:4 oranında görünür; otomatik kırpılır.</span>
          </div>
        </div>
        <Field label="Görünen ad" hint="Takım sayfasındaki kartta bu ad yazar.">
          {(id, d) => (
            <input id={id} aria-describedby={d} data-autofocus value={display} maxLength={64} onChange={(e) => setDisplay(e.target.value)} />
          )}
        </Field>
        <fieldset className="rank-set">
          <legend>Rütbeler</legend>
          {all === null ? (
            <Spinner />
          ) : (
            <div className="set-list">
              {all.map((r) => (
                <div className="set-row" key={r}>
                  <span className="label">{r}</span>
                  <label className="check">
                    <input type="checkbox" role="switch" aria-label={r} checked={ranks.includes(r)} onChange={(e) => toggle(r, e.target.checked)} />
                    <span aria-hidden="true">{ranks.includes(r) ? 'Var' : 'Yok'}</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

function UsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [busy, setBusy] = useState(false);
  const [keysFor, setKeysFor] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [locking, setLocking] = useState<User | null>(null);
  const [editing, setEditing] = useState<User | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setUsers(await get<User[]>('/api/users'));
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: { username: string; display?: string } = { username: username.trim() };
      if (display.trim()) body.display = display.trim();
      await post('/api/users', body);
      toast.success('Kullanıcı oluşturuldu.');
      setCreating(false);
      setUsername('');
      setDisplay('');
      await load();
    } catch (err) {
      toast.error(errMsg(err));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setLock = async (u: User, locked: boolean) => {
    setBusy(true);
    try {
      await post(`/api/users/${u.id}/lock`, { locked });
      toast.success(locked ? 'Kullanıcı kilitlendi.' : 'Kilit açıldı.');
      setLocking(null);
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/api/users/${deleting.id}`);
      toast.success('Kullanıcı silindi.');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const keyUser = users?.find((u) => u.id === keysFor) ?? null;

  return (
    <>
      <PageHeader title="Kullanıcılar">
        <Button variant="primary" onClick={() => setCreating(true)}>
          Kullanıcı oluştur
        </Button>
      </PageHeader>
      <Card>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : users === null ? (
          <Spinner />
        ) : (
          <Table
            head={['Kullanıcı', 'Ad', 'Rütbe', 'Durum', 'Anahtar', 'Yetki', 'Oluşturma', '']}
            empty={users.length === 0 ? <Empty>Henüz kullanıcı yok.</Empty> : null}
          >
            {users.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.username}</td>
                <td className="clip" title={u.display || undefined}>{u.display || '-'}</td>
                <td className="clip" title={u.ranks.join(', ') || undefined}>{u.ranks.length ? u.ranks.join(', ') : '-'}</td>
                <td>{u.locked ? <Badge tone="bad">Kilitli</Badge> : <Badge tone="ok">Aktif</Badge>}</td>
                <td>{u.keyCount}</td>
                <td>{u.grants.length}</td>
                <td>
                  <Time value={u.created} />
                </td>
                <td className="actions actions-nowrap">
                  <Button small onClick={() => setKeysFor(u.id)}>
                    Anahtarlar
                  </Button>
                  <RowMenu
                    label={`${u.username} işlemleri`}
                    items={[
                      { label: 'Bilgileri düzenle', onSelect: () => setEditing(u) },
                      { label: u.locked ? 'Kilidi aç' : 'Kilitle', onSelect: () => (u.locked ? void setLock(u, false) : setLocking(u)) },
                      { label: 'Sil', danger: true, onSelect: () => setDeleting(u) },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={creating}
        title="Kullanıcı oluştur"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button type="submit" form="user-create" variant="primary" busy={busy}>
              Oluştur
            </Button>
          </>
        }
      >
        <form id="user-create" onSubmit={create}>
          <Field label="Kullanıcı adı" hint="Küçük harfle başlar; harf, rakam, _ ve - (2-32 karakter).">
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                data-autofocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                pattern="[a-z][a-z0-9_\-]{1,31}"
                required
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Görünen ad (isteğe bağlı)">
            {(id) => <input id={id} value={display} onChange={(e) => setDisplay(e.target.value)} />}
          </Field>
        </form>
      </Modal>

      {editing ? <ProfileModal user={editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
      {keyUser ? <KeysModal user={keyUser} onClose={() => setKeysFor(null)} onChanged={() => void load()} /> : null}

      <ConfirmDialog
        open={locking !== null}
        title="Kullanıcıyı kilitle"
        message={`"${locking?.username ?? ''}" kilitlenecek ve açık oturumları sonlandırılacak.`}
        confirmLabel="Kilitle"
        danger
        busy={busy}
        onConfirm={() => locking && void setLock(locking, true)}
        onCancel={() => setLocking(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Kullanıcıyı sil"
        message={`"${deleting?.username ?? ''}" silinecek: Linux hesabı ve çalışan süreçleri kapatılır, ev dizini arşive taşınır; portal hesabı ve oturumları, kapı ayarları, klasör yetkileri, SSH anahtarları, kullanıcıya özel skill'ler ve ona gönderilen yönetici notları silinir. Bu işlem geri alınamaz.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

const feature: Feature = { id: 'users', title: 'Kullanıcılar', icon: 'users', Page: UsersPage };
export default feature;
