import { useEffect, useState } from 'react';
import { Button, useToast } from '../../core/ui';
import { errMsg, papi, PortalError } from '../api';

type Result = { branch: string; commit: string };

export function SendPanel({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [projects, setProjects] = useState<string[] | null>(null);
  const [project, setProject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    papi<{ projects: string[] }>('GET', '/git/projects')
      .then((r) => {
        setProjects(r.projects);
        if (r.projects.length === 1) setProject(r.projects[0]);
      })
      .catch((err) => setError(errMsg(err)));
  }, []);

  const fail = (err: unknown) => {
    setError(errMsg(err));
    setDetail(err instanceof PortalError && err.detail ? err.detail.trim() : '');
  };

  const sync = async () => {
    setError('');
    setDetail('');
    setSyncing(true);
    try {
      const r = await papi<{ result: 'guncel' | 'birlesti' }>('POST', '/git/sync', { project });
      toast.success(r.result === 'guncel' ? 'Kopyanız zaten ana kodla güncel.' : 'Ana koddaki yenilikler kopyanıza alındı.');
    } catch (err) {
      fail(err);
    } finally {
      setSyncing(false);
    }
  };

  const send = async () => {
    setError('');
    setDetail('');
    setBusy(true);
    try {
      const r = await papi<Result>('POST', '/git/send', { project, message: message.trim() });
      setResult(r);
      toast.success('Kodunuz gönderildi.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="send-panel">
        <p>
          Değişiklikleriniz <strong className="kg-copyable">{result.branch}</strong> dalına gönderildi (kayıt <code className="kg-copyable">{result.commit}</code>). Yönetici inceleyip onaylayınca ana koda eklenir.
        </p>
        <div className="send-acts">
          <Button variant="primary" small onClick={onDone}>
            Tamam
          </Button>
        </div>
      </div>
    );
  }

  const valid = project !== '' && message.trim().length >= 3;
  return (
    <form
      className="send-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void send();
      }}
    >
      <label className="field">
        <span>Proje</span>
        <select value={project} onChange={(e) => setProject(e.target.value)} disabled={busy || !projects}>
          <option value="">{projects ? (projects.length ? 'Proje seçin' : 'Proje yok') : 'Yükleniyor…'}</option>
          {projects?.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Ne yaptınız?</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={500}
          disabled={busy}
          placeholder="Örn. Durak listesine arama kutusu eklendi"
        />
      </label>
      <p className="hint">
        Yetkili olduğunuz <code>/srv/projects/{project || '<proje>'}</code> klasöründeki değişiklikler adınızla kaydedilip GitHub'da kendi dalınıza gönderilir. Ana koda yalnız yönetici onayıyla girer. Şifre ve anahtar dosyaları gönderilmez.
      </p>
      {error ? (
        <p className="send-error kg-copyable" role="alert">
          {error}
        </p>
      ) : null}
      {detail ? <pre className="send-detail kg-copyable">{detail}</pre> : null}
      <div className="send-acts">
        <Button small busy={syncing} disabled={!project || busy} onClick={() => void sync()}>
          Ana koddan güncelle
        </Button>
        <Button type="submit" variant="primary" small busy={busy} disabled={!valid || syncing}>
          Gönder
        </Button>
      </div>
    </form>
  );
}
