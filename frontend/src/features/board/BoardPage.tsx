import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { del, errMsg, get, post } from '../../core/api';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, PageHeader, Spinner, Table, Time, fmtDateTime, useToast } from '../../core/ui';

interface BoardRow {
  id: number;
  ts: string;
  author: string;
  authorKind: 'user' | 'admin';
  project: string | null;
  text: string;
}

const PROJECT_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function BoardPage() {
  const toast = useToast();
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [project, setProject] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [delTarget, setDelTarget] = useState<BoardRow | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await get<BoardRow[]>('/api/board'));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const t = text.trim();
    const p = project.trim();
    if (t.length < 1 || t.length > 2000) {
      setFormError('Not 1-2000 karakter olmalı.');
      return;
    }
    if (p && !PROJECT_RE.test(p)) {
      setFormError('Proje adı küçük harf, rakam ve tire içermeli (2-32 karakter).');
      return;
    }
    setBusy(true);
    try {
      await post('/api/board', p ? { text: t, project: p } : { text: t });
      setText('');
      setProject('');
      toast.success('Not panoya eklendi.');
      await load();
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!delTarget) return;
    setBusy(true);
    try {
      await del(`/api/board/${delTarget.id}`);
      toast.success('Not silindi.');
      setDelTarget(null);
      await load();
    } catch (err) {
      toast.error(errMsg(err));
      setDelTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Takım Panosu">
        <Button small onClick={() => void load()}>
          Yenile
        </Button>
      </PageHeader>
      <Card title="Yönetici olarak not ekle">
        <form onSubmit={add}>
          <Field label="Not" hint={`${text.length} / 2000`}>
            {(id, d) => <textarea id={id} aria-describedby={d} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required />}
          </Field>
          <Field label="Proje (isteğe bağlı)">
            {(id) => <input id={id} value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" />}
          </Field>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <Button type="submit" variant="primary" busy={busy}>
            Ekle
          </Button>
        </form>
      </Card>
      <Card title="Notlar">
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : rows === null ? (
          <Spinner />
        ) : (
          <Table head={['Zaman', 'Yazar', 'Proje', 'Not', '']} empty={rows.length === 0 ? <Empty>Pano boş.</Empty> : undefined}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  <Time value={r.ts} />
                </td>
                <td>
                  <span className="mono">{r.author}</span>{' '}
                  {r.authorKind === 'admin' ? <Badge tone="warn">Yönetici</Badge> : <Badge tone="neutral">Kullanıcı</Badge>}
                </td>
                <td>{r.project || 'genel'}</td>
                <td className="note-cell">{r.text}</td>
                <td className="actions">
                  <Button small variant="danger" onClick={() => setDelTarget(r)}>
                    Sil
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ConfirmDialog
        open={delTarget !== null}
        title="Notu sil"
        message={`${delTarget?.author ?? ''} tarafından yazılan ${delTarget ? fmtDateTime(delTarget.ts) : ''} tarihli not silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDelTarget(null)}
      />
    </>
  );
}
