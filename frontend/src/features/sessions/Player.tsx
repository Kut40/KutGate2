import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Button, ErrorState, Modal, Spinner } from '../../core/ui';
import { errMsg, getText } from '../../core/api';
import { termFontSize } from '../../core/fit';
import { fmtClock } from './util';

interface CastEvent {
  t: number;
  data: string;
}
interface Cast {
  cols: number;
  rows: number;
  events: CastEvent[];
  duration: number;
}

const SPEEDS = [1, 2, 8];
const TICK_MS = 50;

function clampDim(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(500, Math.max(1, v));
}

function parseCast(text: string): Cast {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('Kayıt boş.');
  const header = JSON.parse(lines[0] as string) as { width?: number; height?: number };
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const ev = JSON.parse(lines[i] as string) as unknown;
      if (Array.isArray(ev) && ev[1] === 'o' && typeof ev[0] === 'number' && typeof ev[2] === 'string') {
        events.push({ t: ev[0], data: ev[2] });
      }
    } catch {
      continue;
    }
  }
  const duration = events.length > 0 ? (events[events.length - 1] as CastEvent).t : 0;
  return { cols: clampDim(header.width, 80), rows: clampDim(header.height, 24), events, duration };
}

export function PlayerModal({ id, username, onClose }: { id: string; username: string; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const idxRef = useRef(0);
  const posRef = useRef(0);
  const speedRef = useRef(1);
  const pausedRef = useRef(false);
  const [cast, setCast] = useState<Cast | null>(null);
  const [error, setError] = useState('');
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [pos, setPos] = useState(0);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setError('');
    setCast(null);
    try {
      setCast(parseCast(await getText(`/api/sessions/${encodeURIComponent(id)}/cast`)));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const box = boxRef.current;
    if (!cast || !box) return;
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cols: cast.cols,
      rows: cast.rows,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: termFontSize(13),
    });
    term.open(box);
    termRef.current = term;
    idxRef.current = 0;
    posRef.current = 0;
    pausedRef.current = false;
    setPaused(false);
    setDone(false);
    setPos(0);

    const timer = window.setInterval(() => {
      if (pausedRef.current) return;
      posRef.current += (TICK_MS / 1000) * speedRef.current;
      while (idxRef.current < cast.events.length && (cast.events[idxRef.current] as CastEvent).t <= posRef.current) {
        term.write((cast.events[idxRef.current] as CastEvent).data);
        idxRef.current += 1;
      }
      if (idxRef.current >= cast.events.length) {
        posRef.current = cast.duration;
        pausedRef.current = true;
        setDone(true);
        setPaused(true);
      }
      setPos(posRef.current);
    }, TICK_MS);

    return () => {
      window.clearInterval(timer);
      term.dispose();
      termRef.current = null;
    };
  }, [cast]);

  const setSpeedTo = (s: number) => {
    speedRef.current = s;
    setSpeed(s);
  };
  const togglePause = () => {
    if (done) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };
  const restart = () => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    idxRef.current = 0;
    posRef.current = 0;
    pausedRef.current = false;
    setDone(false);
    setPaused(false);
    setPos(0);
  };

  return (
    <Modal open wide title={`Oynat: ${username}`} onClose={onClose} footer={<Button onClick={onClose}>Kapat</Button>}>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !cast ? (
        <Spinner label="Kayıt indiriliyor" />
      ) : (
        <>
          {cast.events.length === 0 ? <p className="muted">Bu kayıtta çıktı olayı yok.</p> : null}
          <div className="term-scroll">
            <div ref={boxRef} role="region" aria-label="Oynatılan terminal kaydı" />
          </div>
          <div className="player-controls">
            <Button small onClick={togglePause} disabled={done}>
              {paused ? 'Devam' : 'Duraklat'}
            </Button>
            <Button small onClick={restart}>
              Baştan
            </Button>
            {SPEEDS.map((s) => (
              <Button key={s} small variant={speed === s ? 'primary' : 'secondary'} aria-pressed={speed === s} onClick={() => setSpeedTo(s)}>
                {s}x
              </Button>
            ))}
            <progress max={cast.duration || 1} value={Math.min(pos, cast.duration || 1)} aria-label="Oynatma ilerlemesi" />
            <span className="player-time">
              {fmtClock(pos)} / {fmtClock(cast.duration)}
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}
