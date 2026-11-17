import { useCallback, useEffect, useState } from 'react';
import { del, errMsg, get, put } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, PageHeader, Spinner, useToast } from '../../core/ui';
import { useUnsavedChanges } from '../../core/unsaved';

interface Node {
  path: string;
  kind: 'dir' | 'file';
}
interface UserLite {
  id: number;
  username: string;
}

const TEMPLATE_PREFIX = 'users/_template/';

function RulesPage() {
  const toast = useToast();
  const [tree, setTree] = useState<Node[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [tplUser, setTplUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [treeError, setTreeError] = useState('');

  const loadTree = useCallback(async () => {
    setTreeError('');
    try {
      setTree(await get<Node[]>('/api/rules/tree'));
    } catch (e) {
      setTreeError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void loadTree();
    get<UserLite[]>('/api/users')
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [loadTree]);

  const dirty = path !== null && content !== saved;
  useUnsavedChanges(dirty);

  const open = async (p: string) => {
    if (dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Devam edilsin mi?')) return;
    try {
      const r = await get<{ path: string; content: string }>(`/api/rules/file?path=${encodeURIComponent(p)}`);
      setPath(r.path);
      setContent(r.content);
      setSaved(r.content);
      setExists(true);
      setTreeOpen(false);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const startNew = () => {
    const p = newPath.trim();
    if (!p) return;
    if (dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Devam edilsin mi?')) return;
    setPath(p);
    setContent('');
    setSaved(null);
    setExists(false);
    setNewPath('');
    setTreeOpen(false);
  };

  const fromTemplate = async () => {
    if (!path || !path.startsWith(TEMPLATE_PREFIX) || !tplUser) return;
    const target = `users/${tplUser}/${path.slice(TEMPLATE_PREFIX.length)}`;
    setPath(target);
    setSaved(null);
    setExists(false);
    toast.success('Şablon içeriği yüklendi; kaydedince kullanıcı için oluşur.');
  };

  const save = async () => {
    if (!path) return;
    setBusy(true);
    try {
      await put('/api/rules/file', { path, content });
      toast.success('Kaydedildi.');
      setSaved(content);
      setExists(true);
      await loadTree();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!path) return;
    setBusy(true);
    try {
      await del(`/api/rules/file?path=${encodeURIComponent(path)}`);
      toast.success('Silindi.');
      setDeleting(false);
      setPath(null);
      setContent('');
      setSaved(null);
      setExists(false);
      await loadTree();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const isTemplateFile = path !== null && path.startsWith(TEMPLATE_PREFIX);

  return (
    <>
      <PageHeader title="Kurallar" />
      <div className="split">
        <Card
          title="Dosyalar"
          actions={
            <Button small className="tree-toggle" aria-expanded={treeOpen} aria-controls="rules-tree-panel" onClick={() => setTreeOpen((o) => !o)}>
              {treeOpen ? 'Gizle' : 'Göster'}
            </Button>
          }
        >
          <div id="rules-tree-panel" className={treeOpen ? 'tree-panel' : 'tree-panel collapsed'}>
          {treeError ? (
            <ErrorState message={treeError} onRetry={() => void loadTree()} />
          ) : tree === null ? (
            <Spinner />
          ) : tree.length === 0 ? (
            <Empty>Dosya yok.</Empty>
          ) : (
            <ul className="tree">
              {tree.map((n) => {
                const depth = n.path.split('/').length - 1;
                const label = n.path.split('/').pop() ?? n.path;
                return (
                  <li key={n.path} style={{ paddingLeft: depth * 12 }}>
                    {n.kind === 'dir' ? (
                      <span className="dir">
                        {label}/
                      </span>
                    ) : (
                      <button type="button" aria-current={n.path === path ? 'true' : undefined} onClick={() => void open(n.path)}>
                        {label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="tree-new">
            <Field label="Yeni dosya yolu" hint="Örn: global/rules/ornek.md (.md .sh .txt .json)">
              {(id, d) => (
                <input id={id} aria-describedby={d} value={newPath} onChange={(e) => setNewPath(e.target.value)} spellCheck={false} />
              )}
            </Field>
            <Button small onClick={startNew} disabled={!newPath.trim()}>
              Yeni dosya
            </Button>
          </div>
          </div>
        </Card>

        <Card
          title={path ? <span className="mono">{path}</span> : 'Editör'}
          actions={
            path ? (
              <>
                {dirty ? <Badge tone="warn">Kaydedilmedi</Badge> : null}
                <Button small variant="primary" busy={busy} disabled={!dirty && exists} onClick={() => void save()}>
                  Kaydet
                </Button>
                <Button small variant="danger" disabled={!exists} onClick={() => setDeleting(true)}>
                  Sil
                </Button>
              </>
            ) : null
          }
        >
          {path === null ? (
            <Empty>Soldan bir dosya seçin veya yeni dosya oluşturun.</Empty>
          ) : (
            <>
              {isTemplateFile ? (
                <div className="toolbar">
                  <select aria-label="Hedef kullanıcı" value={tplUser} onChange={(e) => setTplUser(e.target.value)}>
                    <option value="">Kullanıcı seç…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.username}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                  <Button small onClick={() => void fromTemplate()} disabled={!tplUser}>
                    Kullanıcı için şablondan aç
                  </Button>
                </div>
              ) : null}
              <Field label="İçerik">
                {(id) => (
                  <textarea id={id} className="editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
                )}
              </Field>
            </>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={deleting}
        title="Dosyayı sil"
        message={`"${path ?? ''}" silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

const feature: Feature = { id: 'rules', title: 'Kurallar', icon: 'file', Page: RulesPage };
export default feature;
