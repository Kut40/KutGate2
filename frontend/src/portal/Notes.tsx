import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Empty, ErrorState, Modal, Spinner, useToast } from '../core/ui';
import { errMsg, papi } from './api';

interface DevlogRow {
  id: number;
  ts: string;
  username: string;
  project: string;
  summary: string;
  fileCount: number;
  files: string[];
}
interface BoardRow {
  id: number;
  ts: string;
  author: string;
  authorKind: 'user' | 'admin';
  project: string | null;
  text: string;
}
interface AdminNote {
  id: number;
  ts: string;
  title: string;
  text: string;
  toAll: boolean;
  read: boolean;
}

const TS_FORMAT = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : TS_FORMAT.format(d);
}

function useList<T>(path: string, nonce: number) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setRows(null);
    setError('');
    papi<T[]>('GET', path)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      });
    return () => {
      alive = false;
    };
  }, [path, nonce]);
  return { rows, error };
}

function DevlogTab({ nonce, retry }: { nonce: number; retry: () => void }) {
  const { rows, error } = useList<DevlogRow>('/devlog?limit=100', nonce);
  const [project, setProject] = useState('');
  const projects = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.project))).sort(), [rows]);
  const visible = (rows ?? []).filter((r) => !project || r.project === project);

  if (error) return <ErrorState message={error} onRetry={retry} />;
  if (rows === null) return <Spinner />;
  return (
    <>
      <div className="toolbar">
        <select aria-label="Proje filtresi" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Tüm projeler</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      {visible.length === 0 ? (
        <Empty>Kayıt yok.</Empty>
      ) : (
        <ul className="log-list">
          {visible.map((r) => (
            <li key={r.id} className="log-item">
              <div className="log-meta">
                <span className="portal-time">{fmtTs(r.ts)}</span>
                <strong>{r.username}</strong>
                <Badge tone="info">{r.project}</Badge>
                <span className="muted">{r.fileCount} dosya değişti</span>
              </div>
              <p className="note-text kg-copyable">{r.summary}</p>
              {r.files && r.files.length > 0 ? (
                <details className="note-files">
                  <summary>Dosya adları ({r.files.length})</summary>
                  <ul className="note-file-list kg-copyable">
                    {r.files.map((f, i) => (
                      <li key={i} className="mono">
                        {f}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BoardTab({ nonce, retry }: { nonce: number; retry: () => void }) {
  const { rows, error } = useList<BoardRow>('/board?limit=100', nonce);
  if (error) return <ErrorState message={error} onRetry={retry} />;
  if (rows === null) return <Spinner />;
  if (rows.length === 0) return <Empty>Pano boş.</Empty>;
  return (
    <ul className="log-list">
      {rows.map((r) => (
        <li key={r.id} className="log-item">
          <div className="log-meta">
            <span className="portal-time">{fmtTs(r.ts)}</span>
            <strong>{r.author}</strong>
            {r.authorKind === 'admin' ? <Badge tone="warn">Yönetici</Badge> : <Badge tone="neutral">Kullanıcı</Badge>}
            <Badge tone="info">{r.project || 'genel'}</Badge>
          </div>
          <p className="note-text kg-copyable">{r.text}</p>
        </li>
      ))}
    </ul>
  );
}

export function DevlogModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'log' | 'board'>('log');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return (
    <Modal
      open
      wide
      title="Geliştirme günlüğü"
      onClose={onClose}
      footer={
        <>
          <Button onClick={refresh}>Yenile</Button>
          <Button variant="primary" onClick={onClose}>
            Kapat
          </Button>
        </>
      }
    >
      <div className="tabs" role="tablist" aria-label="Günlük görünümü">
        <button type="button" role="tab" id="tab-devlog" aria-selected={tab === 'log'} aria-controls="panel-devlog" className="tab" onClick={() => setTab('log')}>
          Geliştirme notu
        </button>
        <button type="button" role="tab" id="tab-board" aria-selected={tab === 'board'} aria-controls="panel-devlog" className="tab" onClick={() => setTab('board')}>
          Pano
        </button>
      </div>
      <div role="tabpanel" id="panel-devlog" aria-labelledby={tab === 'log' ? 'tab-devlog' : 'tab-board'} className="note-panel">
        {tab === 'log' ? <DevlogTab nonce={nonce} retry={refresh} /> : <BoardTab nonce={nonce} retry={refresh} />}
      </div>
    </Modal>
  );
}

export function AdminNotesModal({ onClose, onUnread }: { onClose: () => void; onUnread: (n: number) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<AdminNote[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError('');
    setRows(null);
    try {
      const r = await papi<AdminNote[]>('GET', '/admin-notes');
      setRows(r);
      onUnread(r.filter((n) => !n.read).length);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [onUnread]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: number) => {
    setBusyId(id);
    try {
      await papi('POST', `/admin-notes/${id}/read`, {});
      const next = (rows ?? []).map((n) => (n.id === id ? { ...n, read: true } : n));
      setRows(next);
      onUnread(next.filter((n) => !n.read).length);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      open
      wide
      title="Yönetici notu"
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void load()}>Yenile</Button>
          <Button variant="primary" onClick={onClose}>
            Kapat
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty>Not yok.</Empty>
      ) : (
        <ul className="log-list">
          {rows.map((n) => (
            <li key={n.id} className={n.read ? 'log-item' : 'log-item note-unread'}>
              <div className="log-meta">
                <span className="portal-time">{fmtTs(n.ts)}</span>
                {n.toAll ? <Badge tone="neutral">Herkese</Badge> : <Badge tone="info">Size özel</Badge>}
                {n.read ? <Badge tone="ok">Okundu</Badge> : <Badge tone="warn">Okunmadı</Badge>}
              </div>
              <h3 className="note-title kg-copyable">{n.title}</h3>
              <p className="note-text kg-copyable">{n.text}</p>
              {!n.read ? (
                <Button small busy={busyId === n.id} onClick={() => void markRead(n.id)}>
                  Okundu
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
