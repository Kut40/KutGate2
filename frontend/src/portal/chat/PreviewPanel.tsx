import { useEffect, useState } from 'react';
import { errMsg, papi } from '../api';

type Info = { url: string; port: number; aux: number; host: string };

export function PreviewPanel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    papi<Info>('POST', '/preview/open')
      .then(setInfo)
      .catch((err) => setError(errMsg(err)));
  }, []);

  if (error) {
    return (
      <p className="send-error kg-copyable" role="alert">
        {error}
      </p>
    );
  }
  if (!info) return <p className="hint">Hazırlanıyor…</p>;
  return (
    <div className="send-panel preview-panel">
      <section className="preview-opt">
        <h3>Kendi önizlemem</h3>
        <p>
          Sizin çalıştırdığınız uygulama: <strong className="kg-copyable">127.0.0.1:{info.port}</strong> → <strong className="kg-copyable">{info.host}</strong>. Yalnız siz görürsünüz.
        </p>
        <p className="hint">
          Ajanınıza “uygulamayı {info.port} portunda önizleme için başlat” deyin. İkinci bir servis gerekirse {info.aux} portunu kullanın.
        </p>
        <div className="send-acts">
          <a className="btn btn-primary btn-sm" href={info.url} target="_blank" rel="noopener noreferrer">
            Kendi önizlememi aç
          </a>
        </div>
      </section>
    </div>
  );
}
