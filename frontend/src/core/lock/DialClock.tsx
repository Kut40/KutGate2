import { useEffect, useState, type CSSProperties } from 'react';
import './dial-clock.css';

/*
 * Halkalı saat (kilit ekranı).
 *
 * Kaynak: CodePen "Dail", Vineeth.TR (MIT). Ayrıntı: src/portal/vendor/THIRD_PARTY.md
 *
 * Özgün tasarımdan ayrılan yerler:
 *  - Renkler sabit değil, kilit ekranının kendi token'larından gelir.
 *  - Boyut tek değişkenle (--kg-dial-size) ölçeklenir; tüm ölçüler ona oranlıdır.
 *  - Saat ve dakika iki haneli gösterilir.
 *  - prefers-reduced-motion: halkalar dönmez, yalnız rakamlar değişir.
 *
 * Mekanik: 60 çentikli iki halka; halka her saniye/dakika 6 derece geri döner ve
 * geçen değer sabit imlecin hizasına gelir. 59 -> 0 geçişinde geçiş animasyonu
 * bir an kapatılır ki halka geri sarmasın.
 */
const TICKS = Array.from({ length: 60 }, (_, i) => i);
const two = (n: number) => String(n).padStart(2, '0');

function now() {
  const d = new Date();
  return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
}

function Ring({ kind, turn, rewind }: { kind: 'sec' | 'min'; turn: number; rewind: boolean }) {
  return (
    <div className={`kg-dial-ring kg-dial-${kind}${rewind ? ' kg-dial-still' : ''}`} style={{ '--kg-dial-turn': `${6 * turn}deg` } as CSSProperties} aria-hidden="true">
      {TICKS.map((i) => (
        <i key={i} className="kg-dial-tick" style={{ '--kg-dial-angle': `${6 * i}deg` } as CSSProperties} data-i={i} />
      ))}
    </div>
  );
}

export function DialClock({ className = '' }: { className?: string }) {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = window.setInterval(() => setT(now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={`kg-dial ${className}`.trim()} role="img" aria-label={`Saat ${two(t.h)}:${two(t.m)}`}>
      <Ring kind="sec" turn={t.s} rewind={t.s === 0} />
      <Ring kind="min" turn={t.m} rewind={t.m === 0} />
      <div className="kg-dial-mm" aria-hidden="true">
        {two(t.m)}
      </div>
      <div className="kg-dial-hh" aria-hidden="true">
        {two(t.h)}
      </div>
    </div>
  );
}
