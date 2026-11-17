import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errMsg, get } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Button, Card, Empty, ErrorState, PageHeader, Spinner, Table, Time } from '../../core/ui';

interface Entry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

function AuditPage() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (query: string, lim: number) => {
      setBusy(true);
      setLoadError('');
      try {
        setRows(await get<Entry[]>(`/api/audit?limit=${lim}&q=${encodeURIComponent(query)}`));
      } catch (e) {
        setLoadError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load('', 100);
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void load(q, limit);
  };

  return (
    <>
      <PageHeader title="Denetim" />
      <Card>
        <form className="toolbar" onSubmit={submit} role="search">
          <input type="search" aria-label="Ara" placeholder="Ara…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Kayıt sayısı" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={100}>100 kayıt</option>
            <option value={250}>250 kayıt</option>
            <option value={500}>500 kayıt</option>
          </select>
          <Button small type="submit" variant="primary" busy={busy}>
            Ara
          </Button>
          <Button small onClick={() => void load(q, limit)} disabled={busy}>
            Yenile
          </Button>
        </form>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load(q, limit)} />
        ) : rows === null ? (
          <Spinner />
        ) : (
          <Table head={['Zaman', 'Yönetici', 'İşlem', 'Ayrıntı']} empty={rows.length === 0 ? <Empty>Kayıt yok.</Empty> : null}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  <Time value={r.ts} />
                </td>
                <td>{r.actor}</td>
                <td className="mono">{r.action}</td>
                <td className="clip clip-wide" title={r.detail}>
                  {r.detail}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

const feature: Feature = { id: 'audit', title: 'Denetim', icon: 'list', Page: AuditPage };
export default feature;
