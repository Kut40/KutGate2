import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { del, errMsg, get, post } from '../../core/api';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, PageHeader, Spinner, Table, Time, useToast } from '../../core/ui';

interface AdminNote {
  id: number;
  ts: string;
  target: string | null;
  title: string;
  text: string;
  reads: { username: string; readTs: string }[];
}
interface Account {
  userId: number;
  username: string;
}

export function AdminNotesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<AdminNote[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState('');
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [delTarget, setDelTarget] = useState<AdminNote | null>(null);

  const load = useCallback(async () => {
    setError('');
    const [n, a] = await Promise.allSettled([get<AdminNote[]>('/api/admin-notes'), get<Account[]>('/api/portal/accounts')]);
    if (n.status === 'fulfilled') setRows(n.value);
    else setError(errMsg(n.reason));
    if (a.status === 'fulfilled') {
      setAccounts(a.value);
      setAccountsError('');
    } else {
      setAccounts([]);
      setTarget('');
      setAccountsError(errMsg(a.reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const ti = title.trim();
    const te = text.trim();
    if (ti.length < 1 || ti.length > 120) {
      setFormError('Başlık 1-120 karakter olmalı.');
      return;
    }
    if (te.length < 1 || te.length > 4000) {
      setFormError('Metin 1-4000 karakter olmalı.');
      return;
    }
    setBusy(true);
    try {
      await post('/api/admin-notes', { target: target || null, title: ti, text: te });
      setTitle('');
      setText('');
      setTarget('');
      toast.success('Yönetici notu gönderildi.');
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
      await del(`/api/admin-notes/${delTarget.id}`);
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
      <PageHeader title="Yönetici Notları">
        <Button small onClick={() => void load()}>
          Yenile
        </Button>
      </PageHeader>
      <Card title="Yeni not">
        <form onSubmit={create}>
          <Field label="Hedef" hint={accountsError ? `Kullanıcı listesi alınamadı: ${accountsError}` : undefined}>
            {(id, d) => (
              <select id={id} aria-describedby={d} value={target} onChange={(e) => setTarget(e.target.value)} disabled={accountsError !== ''}>
                <option value="">Tüm kullanıcılar</option>
                {accounts.map((a) => (
                  <option key={a.userId} value={a.username}>
                    {a.username}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Başlık" hint="1-120 karakter">
            {(id, d) => <input id={id} aria-describedby={d} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />}
          </Field>
          <Field label="Metin" hint={`${text.length} / 4000`}>
            {(id, d) => <textarea id={id} aria-describedby={d} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required />}
          </Field>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <Button type="submit" variant="primary" busy={busy}>
            Gönder
          </Button>
        </form>
      </Card>
      <Card title="Gönderilenler">
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : rows === null ? (
          <Spinner />
        ) : (
          <Table head={['Zaman', 'Hedef', 'Başlık ve metin', 'Okuyanlar', '']} empty={rows.length === 0 ? <Empty>Gönderilmiş not yok.</Empty> : undefined}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  <Time value={r.ts} />
                </td>
                <td>{r.target === null ? <Badge tone="neutral">Tüm kullanıcılar</Badge> : <span className="mono">{r.target}</span>}</td>
                <td className="note-cell">
                  <strong>{r.title}</strong>
                  {'\n'}
                  {r.text}
                </td>
                <td>
                  {r.reads.length === 0 ? (
                    <span className="muted">Henüz okunmadı</span>
                  ) : (
                    <ul className="readers">
                      {r.reads.map((x) => (
                        <li key={x.username}>
                          <Badge tone="ok">
                            {x.username} · <Time value={x.readTs} />
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
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
        message={`"${delTarget?.title ?? ''}" başlıklı not silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDelTarget(null)}
      />
    </>
  );
}
