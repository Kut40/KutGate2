import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, del, errMsg, get, post, put } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Modal, PageHeader, Spinner, Table, Time, useToast } from '../../core/ui';
import { useUnsavedChanges } from '../../core/unsaved';

type Kind = 'home' | 'rules' | 'global';
interface SkillRow {
  id: number;
  name: string;
  targetKind: Kind;
  targetUser: string | null;
  version: number;
  updated: string;
}
interface SkillDetail extends SkillRow {
  source: string;
  content: string;
  versions: { version: number; created: string }[];
}
interface UserLite {
  id: number;
  username: string;
}

type FormKind = 'home' | 'rules';
interface SaveResult {
  failed?: string[];
}
interface SyncResult {
  ok: boolean;
  written: number;
  failed: string[];
}

const ALL = '*';
const KIND_LABEL: Record<FormKind, string> = { rules: 'Kullanıcı kuralları', home: 'Kişisel skill klasörü' };
const effKind = (k: Kind): FormKind => (k === 'global' ? 'rules' : k);
const effUser = (k: Kind, u: string | null): string => (k === 'global' ? ALL : (u ?? ''));
const userLabel = (u: string) => (u === ALL ? 'Tüm kullanıcılar' : u);
const targetText = (k: Kind, u: string | null) => `${KIND_LABEL[effKind(k)]} · ${userLabel(effUser(k, u))}`;

function KindSelect({ id, value, onChange, autoFocus }: { id: string; value: FormKind; onChange: (k: FormKind) => void; autoFocus?: boolean }) {
  return (
    <select id={id} data-autofocus={autoFocus ? true : undefined} value={value} onChange={(e) => onChange(e.target.value as FormKind)}>
      <option value="rules">Kullanıcı kuralları (yönetici, kullanıcı değiştiremez)</option>
      <option value="home">Kullanıcının kişisel skill klasörü (kullanıcı düzenleyebilir)</option>
    </select>
  );
}

function UserSelect({ id, value, users, onChange }: { id: string; value: string; users: UserLite[]; onChange: (u: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Seç…</option>
      <option value={ALL}>Tüm kullanıcılar</option>
      {users.map((u) => (
        <option key={u.id} value={u.username}>
          {u.username}
        </option>
      ))}
    </select>
  );
}
const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

function SkillsPage() {
  const toast = useToast();
  const [list, setList] = useState<SkillRow[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | FormKind>('');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [kind, setKind] = useState<FormKind>('home');
  const [user, setUser] = useState('');
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'claude' | 'template' | null>(null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [origTarget, setOrigTarget] = useState<{ kind: FormKind; user: string } | null>(null);
  const [origText, setOrigText] = useState<{ source: string; content: string } | null>(null);
  const [versions, setVersions] = useState<{ version: number; created: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [copying, setCopying] = useState<SkillRow | null>(null);
  const [copyKind, setCopyKind] = useState<FormKind>('home');
  const [copyUser, setCopyUser] = useState('');
  const [deleting, setDeleting] = useState<SkillRow | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setList(await get<SkillRow[]>('/api/skills'));
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    get<UserLite[]>('/api/users')
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [load]);

  const reset = () => {
    setEditingId(null);
    setOrigTarget(null);
    setOrigText(null);
    setName('');
    setSource('');
    setContent('');
    setMode(null);
    setErrors(null);
    setVersions([]);
  };

  const edit = async (id: number) => {
    try {
      const s = await get<SkillDetail>(`/api/skills/${id}`);
      setEditingId(s.id);
      setKind(effKind(s.targetKind));
      setUser(effUser(s.targetKind, s.targetUser));
      setOrigTarget({ kind: effKind(s.targetKind), user: effUser(s.targetKind, s.targetUser) });
      setOrigText({ source: s.source, content: s.content });
      setName(s.name);
      setSource(s.source);
      setContent(s.content);
      setVersions(s.versions);
      setMode(null);
      setErrors(null);
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const nameOk = NAME_RE.test(name);
  const targetOk = user !== '';

  const generate = async () => {
    setBusy('generate');
    try {
      const r = await post<{ content: string; mode: 'claude' | 'template' }>('/api/skills/generate', { name, source });
      setContent(r.content);
      setMode(r.mode);
      setErrors(null);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const validate = async (): Promise<boolean> => {
    setBusy('validate');
    try {
      const r = await post<{ ok: boolean; errors: string[] }>('/api/skills/validate', { name, content });
      setErrors(r.ok ? [] : r.errors);
      if (r.ok) toast.success('Doğrulama başarılı.');
      return r.ok;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const warnFailed = (failed?: string[]) => {
    if (failed && failed.length > 0) toast.error(`Bazı kullanıcılara yazılamadı: ${failed.join(', ')}`);
  };

  /** Silme hatası: 500 ve `failed` varsa kullanıcı adlarıyla bildirir. */
  const deleteErrText = (e: unknown): string => {
    if (e instanceof ApiError && e.data && typeof e.data === 'object') {
      const f = (e.data as { failed?: unknown }).failed;
      if (Array.isArray(f) && f.length > 0) {
        return `Skill bazı kullanıcılardan silinemedi: ${f.filter((x): x is string => typeof x === 'string').join(', ')}`;
      }
    }
    return errMsg(e);
  };

  const save = async () => {
    setBusy('save');
    try {
      if (editingId === null) {
        const r = await post<SaveResult>('/api/skills', { name, targetKind: kind, targetUser: user, source, content });
        toast.success('Skill kaydedildi.');
        warnFailed(r?.failed);
        reset();
      } else if (!origTarget || (origTarget.kind === kind && origTarget.user === user)) {
        const r = await put<SaveResult>(`/api/skills/${editingId}`, { content, source });
        toast.success('Yeni sürüm kaydedildi.');
        warnFailed(r?.failed);
        await edit(editingId);
      } else {
        let r: SaveResult;
        try {
          r = await post<SaveResult>('/api/skills', { name, targetKind: kind, targetUser: user, source, content });
        } catch (e) {
          toast.error(`Yeni hedefe kaydedilemedi, eski kayıt korundu: ${errMsg(e)}`);
          return;
        }
        warnFailed(r?.failed);
        try {
          const dr = await del<SaveResult | null>(`/api/skills/${editingId}`);
          warnFailed(dr?.failed);
        } catch (e) {
          toast.error(`Yeni hedefe kaydedildi ancak eski kayıt silinemedi: ${deleteErrText(e)}`);
          await load();
          return;
        }
        toast.success('Skill yeni hedefe taşındı.');
        reset();
      }
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const resync = async (s: SkillRow) => {
    setBusy(`sync-${s.id}`);
    try {
      const r = await post<SyncResult>(`/api/skills/${s.id}/sync`);
      if (r.failed.length > 0) toast.error(`${r.written} kullanıcıya yazıldı, ${r.failed.length} başarısız: ${r.failed.join(', ')}`);
      else toast.success(`${r.written} kullanıcıya yazıldı, 0 başarısız.`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!copying) return;
    setBusy('copy');
    try {
      const r = await post<SaveResult>(`/api/skills/${copying.id}/copy`, { targetKind: copyKind, targetUser: copyUser });
      toast.success('Kopyalandı.');
      warnFailed(r?.failed);
      setCopying(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy('delete');
    try {
      const r = await del<SaveResult | null>(`/api/skills/${deleting.id}`);
      toast.success('Skill silindi.');
      warnFailed(r?.failed);
      if (editingId === deleting.id) reset();
      setDeleting(null);
      await load();
    } catch (e) {
      toast.error(deleteErrText(e));
      setDeleting(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list ?? []).filter(
      (s) =>
        (!kindFilter || effKind(s.targetKind) === kindFilter) &&
        (!f || s.name.toLowerCase().includes(f) || effUser(s.targetKind, s.targetUser).toLowerCase().includes(f) || userLabel(effUser(s.targetKind, s.targetUser)).toLowerCase().includes(f)),
    );
  }, [list, filter, kindFilter]);

  const editing = editingId !== null;
  const dirty = editing
    ? source !== origText?.source || content !== origText?.content || (origTarget !== null && (kind !== origTarget.kind || user !== origTarget.user))
    : name.trim() !== '' || source.trim() !== '' || content.trim() !== '';
  useUnsavedChanges(dirty);

  return (
    <>
      <PageHeader title="Skill Stüdyosu">
        {editing ? <Button onClick={reset}>Yeni skill</Button> : null}
      </PageHeader>

      <Card title={editing ? `Düzenle: ${name} (sürüm ${versions[0]?.version ?? ''})`.replace(' (sürüm )', '') : 'Yeni skill'}>
        <div className="form-row">
          <Field label="Tür">
            {(id) => <KindSelect id={id} value={kind} onChange={setKind} />}
          </Field>
          <Field label="Kullanıcı">
            {(id) => <UserSelect id={id} value={user} users={users} onChange={setUser} />}
          </Field>
          <Field label="Skill adı" hint="küçük harf, rakam, - (2-64)">
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                value={name}
                disabled={editing}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={name !== '' && !nameOk}
                autoComplete="off"
              />
            )}
          </Field>
        </div>

        <div className="block">
          <Field label="Düz metin açıklama">
            {(id) => <textarea id={id} className="plain" rows={4} value={source} onChange={(e) => setSource(e.target.value)} />}
          </Field>
          <div className="toolbar">
            <Button small variant="primary" busy={busy === 'generate'} disabled={!nameOk || !source.trim()} onClick={() => void generate()}>
              Skill'e çevir
            </Button>
            {mode ? <Badge tone="info">{mode === 'claude' ? 'Claude ile üretildi' : 'Şablonla üretildi'}</Badge> : null}
          </div>
        </div>

        <div className="block">
          <Field label="SKILL.md taslağı">
            {(id) => <textarea id={id} className="editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />}
          </Field>
          {errors !== null ? (
            errors.length === 0 ? (
              <p className="toolbar">
                <Badge tone="ok">Geçerli</Badge>
              </p>
            ) : (
              <ul className="form-error" role="alert">
                {errors.map((er, i) => (
                  <li key={i}>{er}</li>
                ))}
              </ul>
            )
          ) : null}
          <div className="toolbar">
            <Button small busy={busy === 'validate'} disabled={!content.trim() || !nameOk} onClick={() => void validate()}>
              Doğrula
            </Button>
            <Button
              small
              variant="primary"
              busy={busy === 'save'}
              disabled={!content.trim() || !nameOk || !targetOk}
              onClick={() => void save()}
            >
              Kaydet
            </Button>
          </div>
        </div>

        {editing && versions.length > 0 ? (
          <div className="block">
            <h3 className="mini-title">Sürümler</h3>
            <ul className="plain-list">
              {versions.map((v) => (
                <li key={v.version}>
                  v{v.version}{' '}
                  <span className="muted">
                    <Time value={v.created} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card title="Kayıtlı skill'ler">
        <div className="toolbar">
          <input type="search" aria-label="Skill ara" placeholder="Ad veya kullanıcı ara…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select aria-label="Tür filtresi" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | FormKind)}>
            <option value="">Tüm türler</option>
            <option value="rules">Kullanıcı kuralları</option>
            <option value="home">Kişisel skill klasörü</option>
          </select>
        </div>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : list === null ? (
          <Spinner />
        ) : (
          <Table
            head={['Ad', 'Hedef', 'Sürüm', 'Güncelleme', '']}
            empty={shown.length === 0 ? <Empty>Skill yok.</Empty> : null}
          >
            {shown.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.name}</td>
                <td>
                  <Badge tone="info" title={targetText(s.targetKind, s.targetUser)}>
                    {targetText(s.targetKind, s.targetUser)}
                  </Badge>
                </td>
                <td>v{s.version}</td>
                <td>
                  <Time value={s.updated} />
                </td>
                <td className="actions">
                  <Button small onClick={() => void edit(s.id)}>
                    Düzenle
                  </Button>
                  {s.targetKind === 'home' && s.targetUser === ALL ? (
                    <Button small busy={busy === `sync-${s.id}`} onClick={() => void resync(s)}>
                      Yeniden uygula
                    </Button>
                  ) : null}
                  <Button
                    small
                    onClick={() => {
                      setCopying(s);
                      setCopyKind(effKind(s.targetKind));
                      setCopyUser(effUser(s.targetKind, s.targetUser));
                    }}
                  >
                    Kopyala
                  </Button>
                  <Button small variant="danger" onClick={() => setDeleting(s)}>
                    Sil
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={copying !== null}
        title={`Kopyala: ${copying?.name ?? ''}`}
        onClose={() => setCopying(null)}
        footer={
          <>
            <Button onClick={() => setCopying(null)}>Vazgeç</Button>
            <Button variant="primary" busy={busy === 'copy'} disabled={!copyUser} onClick={() => void copy()}>
              Kopyala
            </Button>
          </>
        }
      >
        <Field label="Tür">
          {(id) => <KindSelect id={id} value={copyKind} onChange={setCopyKind} autoFocus />}
        </Field>
        <Field label="Kullanıcı">
          {(id) => <UserSelect id={id} value={copyUser} users={users} onChange={setCopyUser} />}
        </Field>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Skill'i sil"
        message={`"${deleting?.name ?? ''}" ve dosyası silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy === 'delete'}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

const feature: Feature = { id: 'skills', title: 'Skill Stüdyosu', icon: 'spark', Page: SkillsPage };
export default feature;
