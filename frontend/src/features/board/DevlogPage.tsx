import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { del, errMsg, get, put } from '../../core/api';
import { Button, Card, ConfirmDialog, Empty, ErrorState, Field, PageHeader, Spinner, Table, Time, fmtDateTime, useToast } from '../../core/ui';
import { localDay } from './util';

const DEVLOG_LIMIT = 500;

interface DevlogRow {
  id: number;
  ts: string;
  username: string;
  project: string;
  summary: string;
  fileCount: number;
  files: string[];
}
interface DevlogSettings {
  intervalMinutes: number;
  summarize: boolean;
}

function SettingsCard() {
  const toast = useToast();
  const [s, setS] = useState<DevlogSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setS(await get<DevlogSettings>('/api/devlog/settings'));
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
    if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 1 || s.intervalMinutes > 120) {
      setError('Aralık 1-120 dakika olmalı.');
      return;
    }
    setBusy(true);
    try {
      await put('/api/devlog/settings', { intervalMinutes: s.intervalMinutes, summarize: s.summarize });
      toast.success('Geliştirme günlüğü ayarları kaydedildi.');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ayarlar">
      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !s ? (
        <Spinner />
      ) : (
        <form onSubmit={save}>
          <div className="form-row">
            <Field label="Aralık (dakika)" hint="1-120">
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  type="number"
                  min={1}
                  max={120}
                  value={s.intervalMinutes || ''}
                  onChange={(e) => setS({ ...s, intervalMinutes: e.target.value === '' ? 0 : Number(e.target.value) })}
                  required
                />
              )}
            </Field>
            <label className="check">
              <input type="checkbox" role="switch" checked={Boolean(s.summarize)} onChange={(e) => setS({ ...s, summarize: e.target.checked })} />
              Özetleme açık
            </label>
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
    </Card>
  );
}

export function DevlogPage() {
  const toast = useToast();
  const [rows, setRows] = useState<DevlogRow[] | null>(null);
  const [error, setError] = useState('');
  const [user, setUser] = useState('');
  const [project, setProject] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [delTarget, setDelTarget] = useState<DevlogRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await get<DevlogRow[]>(`/api/devlog?limit=${DEVLOG_LIMIT}`));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const users = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.username))).sort(), [rows]);
  const projects = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.project))).sort(), [rows]);
  const visible = (rows ?? []).filter(
    (r) => (!user || r.username === user) && (!project || r.project === project) && (!from || localDay(r.ts) >= from) && (!to || localDay(r.ts) <= to),
  );

  const remove = async () => {
    if (!delTarget) return;
    setBusy(true);
    try {
      await del(`/api/devlog/${delTarget.id}`);
      toast.success('Kayıt silindi.');
      setDelTarget(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
      setDelTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Geliştirme Notları">
        <Button small onClick={() => void load()}>
          Yenile
        </Button>
      </PageHeader>
      <Card title="Kayıtlar">
        <div className="form-row filters">
          <Field label="Kullanıcı">
            {(id) => (
              <select id={id} value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="">Tümü</option>
                {users.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Proje">
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Tümü</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Başlangıç tarihi">{(id) => <input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Bitiş tarihi">{(id) => <input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : rows === null ? (
          <Spinner />
        ) : (
          <>
            {rows.length >= DEVLOG_LIMIT ? <p className="hint">Son {DEVLOG_LIMIT} kayıt gösteriliyor; daha eskileri süzgeçlere girmez.</p> : null}
            <Table head={['Zaman', 'Kullanıcı', 'Proje', 'Özet', 'Dosya', '']} empty={visible.length === 0 ? <Empty>Kayıt yok.</Empty> : undefined}>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="mono">
                    <Time value={r.ts} />
                  </td>
                  <td className="mono">{r.username}</td>
                  <td>{r.project}</td>
                  <td className="note-cell">
                    {r.summary}
                    {r.files && r.files.length > 0 ? (
                      <details className="note-files">
                        <summary>Dosya adları ({r.files.length})</summary>
                        <ul className="note-file-list">
                          {r.files.map((f, i) => (
                            <li key={i} className="mono">
                              {f}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td>{r.fileCount}</td>
                  <td className="actions">
                    <Button small variant="danger" onClick={() => setDelTarget(r)}>
                      Sil
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>
      <SettingsCard />
      <ConfirmDialog
        open={delTarget !== null}
        title="Kaydı sil"
        message={`${delTarget?.username ?? ''} kullanıcısının ${delTarget ? fmtDateTime(delTarget.ts) : ''} tarihli geliştirme kaydı silinecek.`}
        confirmLabel="Sil"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDelTarget(null)}
      />
    </>
  );
}
