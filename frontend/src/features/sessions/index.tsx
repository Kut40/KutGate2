import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError, errMsg, get, post } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, PageHeader, Spinner, Table, Time, useToast } from '../../core/ui';
import { AgentLogs } from './AgentLogs';
import { PlayerModal } from './Player';
import { fmtBytes } from './util';
import { WatchModal } from './Watch';

interface SessionRow {
  id: string;
  userId: number;
  username: string;
  unit: string;
  started: string;
  ended: string | null;
  endReason: string | null;
  bytesOut: number;
  bytesIn: number;
  live: boolean;
  attached?: boolean;
}

type Tab = 'active' | 'history' | 'logs';

const HISTORY_LIMIT = 500;

const REASONS: Record<string, string> = {
  idle: 'Boşta kaldı',
  max: 'Süre doldu',
  closed: 'Bağlantı kapandı',
  exit: 'Kapandı',
  error: 'Hata',
  detached_timeout: 'Bağlantı koptu',
  logout: 'Çıkış yapıldı',
  admin: 'Yönetici sonlandırdı',
};

function SessionsList({ tab }: { tab: 'active' | 'history' }) {
  const toast = useToast();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [watch, setWatch] = useState<SessionRow | null>(null);
  const [play, setPlay] = useState<SessionRow | null>(null);
  const [kill, setKill] = useState<SessionRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await get<SessionRow[]>(`/api/sessions?active=${tab === 'active' ? 1 : 0}`));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 502
          ? `Portal sunucusuna ulaşılamıyor, ${tab === 'active' ? 'aktif oturumlar alınamadı' : 'oturumlar alınamadı'}.`
          : errMsg(e),
      );
    }
  }, [tab]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'active') return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [tab, load]);

  const doKill = async () => {
    if (!kill) return;
    setBusy(true);
    try {
      await post(`/api/sessions/${encodeURIComponent(kill.id)}/kill`);
      toast.success(`${kill.username}: oturum sonlandırıldı.`);
      setKill(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
      setKill(null);
    } finally {
      setBusy(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = rows ? rows.filter((r) => !needle || r.username.toLowerCase().includes(needle)) : [];

  return (
    <Card
      title={tab === 'active' ? 'Aktif oturumlar' : 'Geçmiş oturumlar'}
      actions={<Button small onClick={() => void load()}>Yenile</Button>}
    >
      <div className="toolbar">
        <input type="search" placeholder="Kullanıcıya göre filtrele" aria-label="Kullanıcıya göre filtrele" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner />
      ) : (
        <>
          {tab === 'history' && rows.length >= HISTORY_LIMIT ? (
            <p className="hint">Son {HISTORY_LIMIT} kayıt gösteriliyor; daha eskileri süzgeçlere girmez.</p>
          ) : null}
          <Table
            head={['Kullanıcı', 'Başlangıç', 'Bitiş', 'Neden', 'Çıktı', 'Girdi', 'Durum', '']}
            empty={visible.length === 0 ? <Empty>{tab === 'active' ? 'Aktif oturum yok.' : 'Geçmiş oturum yok.'}</Empty> : undefined}
          >
            {visible.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.username}</td>
                <td>
                  <Time value={r.started} />
                </td>
                <td>{r.ended ? <Time value={r.ended} /> : '-'}</td>
                <td>{r.endReason ? (REASONS[r.endReason] ?? r.endReason) : '-'}</td>
                <td>{fmtBytes(r.bytesOut)}</td>
                <td>{fmtBytes(r.bytesIn)}</td>
                <td>
                  {r.live ? (
                    <>
                      <Badge tone="ok">Canlı</Badge>
                      {r.attached === false ? (
                        <>
                          {' '}
                          <Badge tone="warn" title="Oturum çalışıyor ancak şu anda bağlı istemci yok">
                            Bağlantı yok
                          </Badge>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <Badge tone="neutral">Bitti</Badge>
                  )}
                </td>
                <td className="actions">
                  {r.live ? (
                    <>
                      <Button small onClick={() => setWatch(r)}>
                        Canlı izle
                      </Button>
                      <Button small variant="danger" onClick={() => setKill(r)}>
                        Sonlandır
                      </Button>
                    </>
                  ) : (
                    <Button small onClick={() => setPlay(r)}>
                      Oynat
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {watch ? <WatchModal id={watch.id} username={watch.username} onClose={() => setWatch(null)} /> : null}
      {play ? <PlayerModal id={play.id} username={play.username} onClose={() => setPlay(null)} /> : null}
      <ConfirmDialog
        open={kill !== null}
        title="Oturumu sonlandır"
        message={`${kill?.username ?? ''} kullanıcısının terminal oturumu hemen sonlandırılacak.`}
        confirmLabel="Sonlandır"
        danger
        busy={busy}
        onConfirm={() => void doKill()}
        onCancel={() => setKill(null)}
      />
    </Card>
  );
}

function SessionsPage() {
  const [tab, setTab] = useState<Tab>('active');
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'active', label: 'Aktif' },
    { id: 'history', label: 'Geçmiş' },
    { id: 'logs', label: 'Ajan kayıtları' },
  ];
  const panelId = `${baseId}-panel`;
  const tabId = (id: Tab) => `${baseId}-tab-${id}`;

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    const t = tabs[next];
    if (!t) return;
    e.preventDefault();
    setTab(t.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <PageHeader title="Oturumlar" />
      <div className="tabs" role="tablist" aria-label="Oturum görünümü">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            id={tabId(t.id)}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={panelId}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {tab === 'logs' ? <AgentLogs /> : <SessionsList key={tab} tab={tab} />}
      </div>
    </>
  );
}

const feature: Feature = { id: 'sessions', title: 'Oturumlar', icon: 'sessions', Page: SessionsPage };
export default feature;
