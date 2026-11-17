import { useCallback, useEffect, useState } from 'react';
import { errMsg, get, put } from '../../core/api';
import type { Feature } from '../../core/registry';
import { Badge, Button, Card, Empty, ErrorState, Field, PageHeader, Spinner, useToast } from '../../core/ui';
import { useUnsavedChanges } from '../../core/unsaved';

type Egress = 'none' | 'allowlist' | 'open';
interface Gate {
  userId: number;
  username: string;
  sftp: boolean;
  forwarding: boolean;
  egress: Egress;
  egressAllow: string[];
}
interface Draft {
  sftp: boolean;
  forwarding: boolean;
  egress: Egress;
  allow: string;
}

const toDraft = (g: Gate): Draft => ({
  sftp: g.sftp,
  forwarding: g.forwarding,
  egress: g.egress,
  allow: g.egressAllow.join('\n'),
});
const ANTHROPIC_CIDRS = ['160.79.104.0/23', '2607:6bc0::/48'];
const parseAllow = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);

function GateCard({ gate, onSaved }: { gate: Gate; onSaved: (g: Gate) => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(toDraft(gate));
  const [busy, setBusy] = useState(false);
  const dirty =
    d.sftp !== gate.sftp ||
    d.forwarding !== gate.forwarding ||
    d.egress !== gate.egress ||
    (d.egress === 'allowlist' && parseAllow(d.allow).join('\n') !== gate.egressAllow.join('\n'));
  useUnsavedChanges(dirty);

  const save = async () => {
    const egressAllow = d.egress === 'allowlist' ? parseAllow(d.allow) : [];
    setBusy(true);
    try {
      await put(`/api/gates/${gate.userId}`, { sftp: d.sftp, forwarding: d.forwarding, egress: d.egress, egressAllow });
      toast.success(`${gate.username}: kapı ayarları kaydedildi.`);
      onSaved({ ...gate, sftp: d.sftp, forwarding: d.forwarding, egress: d.egress, egressAllow });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const allowAnthropic = () => {
    const merged = Array.from(new Set([...parseAllow(d.allow), ...ANTHROPIC_CIDRS]));
    setD({ ...d, egress: 'allowlist', allow: merged.join('\n') });
    toast.success('Anthropic API aralıkları eklendi. Uygulamak için Kaydet\'e basın.');
  };

  return (
    <Card
      title={<span className="mono">{gate.username}</span>}
      actions={
        <>
          {dirty ? <Badge tone="warn">Kaydedilmedi</Badge> : null}
          <Button small variant="primary" busy={busy} onClick={() => void save()}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="set-list">
        <div className="set-row">
          <span className="label">Dosya aktarımı</span>
          <label className="check">
            <input type="checkbox" role="switch" checked={d.sftp} onChange={(e) => setD({ ...d, sftp: e.target.checked })} />
            SFTP / scp: {d.sftp ? 'açık' : 'kapalı'}
          </label>
        </div>
        <div className="set-row">
          <span className="label">Port yönlendirme</span>
          <label className="check">
            <input type="checkbox" role="switch" checked={d.forwarding} onChange={(e) => setD({ ...d, forwarding: e.target.checked })} />
            TCP forwarding: {d.forwarding ? 'açık' : 'kapalı'}
          </label>
        </div>
        <Field label="Dışa çıkış (egress)">
          {(id) => (
            <select id={id} value={d.egress} onChange={(e) => setD({ ...d, egress: e.target.value as Egress })}>
              <option value="none">Yok (hepsi engelli)</option>
              <option value="allowlist">İzin listesi</option>
              <option value="open">Açık</option>
            </select>
          )}
        </Field>
        <div className="set-row">
          <span className="label">Ajan erişimi</span>
          <div>
            <Button small className="btn-wrap" onClick={allowAnthropic}>
              Ajan için Anthropic API izni
            </Button>
          </div>
        </div>
        {d.egress === 'allowlist' ? (
            <Field label="İzinli IP / CIDR listesi" hint="Her satıra veya virgülle ayrılmış bir IPv4/IPv6/CIDR. İsim kabul edilmez.">
              {(id, h) => (
                <textarea id={id} aria-describedby={h} rows={3} value={d.allow} onChange={(e) => setD({ ...d, allow: e.target.value })} spellCheck={false} />
              )}
            </Field>
        ) : null}
      </div>
    </Card>
  );
}

function GatesPage() {
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setGates(await get<Gate[]>('/api/gates'));
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Kapılar" />
      {loadError ? (
        <Card>
          <ErrorState message={loadError} onRetry={() => void load()} />
        </Card>
      ) : gates === null ? (
        <Spinner />
      ) : gates.length === 0 ? (
        <Card>
          <Empty>Kullanıcı yok.</Empty>
        </Card>
      ) : (
        <div className="gates-grid">
          {gates.map((g) => (
            <GateCard key={g.userId} gate={g} onSaved={(n) => setGates((cur) => (cur ? cur.map((x) => (x.userId === n.userId ? n : x)) : cur))} />
          ))}
        </div>
      )}
    </>
  );
}

const feature: Feature = { id: 'gates', title: 'Kapılar', icon: 'gate', Page: GatesPage };
export default feature;
