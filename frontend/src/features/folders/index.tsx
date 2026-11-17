import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { del, errMsg, get, post, put } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Button, Card, ConfirmDialog, Empty, ErrorState, Field, Modal, PageHeader, Spinner, Table, useToast } from '../../core/ui';

interface Folder {
  id: number;
  name: string;
  path: string;
}
interface UserLite {
  id: number;
  username: string;
}
interface Grant {
  userId: number;
  folderId: number;
  perm: 'r' | 'rw';
}
type Perm = 'none' | 'r' | 'rw';

function FoldersPage() {
  const toast = useToast();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [users, setUsers] = useState<UserLite[]>([]);
  const [usersError, setUsersError] = useState('');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Folder | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    const [main, u] = await Promise.allSettled([
      Promise.all([get<Folder[]>('/api/folders'), get<Grant[]>('/api/grants')]),
      get<UserLite[]>('/api/users'),
    ]);
    if (main.status === 'fulfilled') {
      const [f, g] = main.value;
      setFolders(f);
      setGrants(g);
    } else {
      setLoadError(errMsg(main.reason));
    }
    if (u.status === 'fulfilled') {
      setUsers(u.value);
      setUsersError('');
    } else {
      setUsers([]);
      setUsersError(errMsg(u.reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/folders', { name: name.trim() });
      toast.success('Klasör oluşturuldu.');
      setCreating(false);
      setName('');
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
      await del(`/api/folders/${deleting.id}`);
      toast.success('Klasör kaydı silindi (veri silinmedi).');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const permOf = (userId: number, folderId: number): Perm =>
    grants.find((g) => g.userId === userId && g.folderId === folderId)?.perm ?? 'none';

  const setPerm = async (userId: number, folderId: number, perm: Perm) => {
    const key = `${userId}:${folderId}`;
    setSaving(key);
    try {
      await put('/api/grants', { userId, folderId, perm });
      setGrants((cur) => {
        const rest = cur.filter((g) => !(g.userId === userId && g.folderId === folderId));
        return perm === 'none' ? rest : [...rest, { userId, folderId, perm }];
      });
      toast.success('Yetki güncellendi.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <PageHeader title="Klasörler">
        <Button variant="primary" onClick={() => setCreating(true)}>
          Klasör oluştur
        </Button>
      </PageHeader>

      <Card title="Klasörler">
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : folders === null ? (
          <Spinner />
        ) : (
          <Table head={['Ad', 'Yol', '']} empty={folders.length === 0 ? <Empty>Henüz klasör yok.</Empty> : null}>
            {folders.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.name}</td>
                <td className="mono clip" title={f.path}>
                  {f.path}
                </td>
                <td className="actions">
                  <Button small variant="danger" onClick={() => setDeleting(f)}>
                    Sil
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Yetki matrisi">
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : usersError ? (
          <ErrorState message={`Kullanıcı listesi alınamadı: ${usersError}`} onRetry={() => void load()} />
        ) : folders === null ? (
          <Spinner />
        ) : folders.length === 0 || users.length === 0 ? (
          <Empty>Matris için en az bir kullanıcı ve bir klasör gerekir.</Empty>
        ) : (
          <Table head={['Kullanıcı', ...folders.map((f) => f.name)]}>
            {users.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="mono row-head">
                  {u.username}
                </th>
                {folders.map((f) => (
                  <td key={f.id}>
                    <select
                      className="perm-select"
                      aria-label={`${u.username} için ${f.name} yetkisi`}
                      value={permOf(u.id, f.id)}
                      disabled={saving === `${u.id}:${f.id}`}
                      onChange={(e) => void setPerm(u.id, f.id, e.target.value as Perm)}
                    >
                      <option value="none">Yok</option>
                      <option value="r">Oku</option>
                      <option value="rw">Oku+Yaz</option>
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={creating}
        title="Klasör oluştur"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button type="submit" form="folder-create" variant="primary" busy={busy}>
              Oluştur
            </Button>
          </>
        }
      >
        <form id="folder-create" onSubmit={create}>
          <Field label="Klasör adı" hint="Küçük harfle başlar; harf, rakam ve - (2-32 karakter).">
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                data-autofocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z][a-z0-9\-]{1,31}"
                required
                autoComplete="off"
              />
            )}
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Klasörü sil"
        message={`"${deleting?.name ?? ''}" kaydı kaldırılacak; klasördeki veri silinmez.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

const feature: Feature = { id: 'folders', title: 'Klasörler', icon: 'folder', Page: FoldersPage };
export default feature;
