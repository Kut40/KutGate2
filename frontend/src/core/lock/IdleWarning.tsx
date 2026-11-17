import { useEffect, useRef, useState } from 'react';
import { Clock, Lock } from 'lucide-react';

/** Ekran okuyucuya yalnızca bu eşiklerde duyurulur (her saniye değil). */
const ANNOUNCE = new Set([30, 20, 10, 5, 3, 2, 1]);

export function IdleWarning({ seconds, onContinue, onLockNow }: { seconds: number; onContinue: () => void; onLockNow: () => void }) {
  const [spoken, setSpoken] = useState('');
  const lastRef = useRef(-1);

  useEffect(() => {
    if (seconds !== lastRef.current && ANNOUNCE.has(seconds)) setSpoken(`Ekran ${seconds} saniye içinde kilitlenecek.`);
    lastRef.current = seconds;
  }, [seconds]);

  return (
    <div className="kg-lock-warn-layer">
      <div className="kg-lock-warn" role="group" aria-label="Ekran kilitlenmek üzere" data-kg-lock-ignore="">
        <div className="kg-lock-warn-icon" aria-hidden="true">
          <Clock size={22} strokeWidth={1.75} />
        </div>
        <h2 className="kg-lock-warn-title">Ekran kilitlenmek üzere</h2>
        <div className="kg-lock-warn-count" aria-hidden="true">
          {seconds}
        </div>
        <p className="kg-lock-warn-text" aria-hidden="true">
          Hareket olmazsa <b>{seconds} saniye</b> içinde ekran kilitlenecek.
        </p>
        <p className="kg-lock-sr" aria-live="assertive" role="status">
          {spoken}
        </p>
        <div className="kg-lock-warn-actions">
          <button type="button" className="kg-lock-btn kg-lock-btn-primary" onClick={onContinue}>
            Devam et
          </button>
          <button type="button" className="kg-lock-btn" onClick={onLockNow}>
            <Lock size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Şimdi kilitle</span>
          </button>
        </div>
      </div>
    </div>
  );
}
