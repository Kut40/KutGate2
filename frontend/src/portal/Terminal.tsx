import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useLock } from '../core/lock/context';
import { Badge, Button, ConfirmDialog } from '../core/ui';
import { getStatus } from './api';
import { closeNoteFor } from './closeNote';
import { AdminNotesModal, DevlogModal } from './Notes';
import { blockCopy, DEFAULT_MAX_MINUTES, fmt, KB_THRESHOLD } from './panel';
import './portal.css';

type State = 'connecting' | 'reconnecting' | 'open' | 'closed';

const ID_STORE = 'kg_term_id';
const MAX_FAILS = 5;

function readTermId(): string | null {
  try {
    return window.sessionStorage.getItem(ID_STORE);
  } catch {
    return null;
  }
}

function writeTermId(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(ID_STORE, id);
    else window.sessionStorage.removeItem(ID_STORE);
  } catch {
    return;
  }
}
const KEYS_STORE = 'kg-portal-keys';
const KEYS_MEDIA = '(pointer: coarse), (hover: none), (max-width: 900px)';

function fontFor(width: number): number {
  return width < 480 ? 12 : width < 768 ? 13 : 14;
}

function readKeysPref(): boolean | null {
  try {
    const v = window.localStorage.getItem(KEYS_STORE);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function VKey({
  label,
  aria,
  onSend,
  repeat,
  pressed,
  wide,
  enter,
}: {
  label: string;
  aria: string;
  onSend: () => void;
  repeat?: boolean;
  pressed?: boolean;
  wide?: boolean;
  enter?: boolean;
}) {
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const timer = useRef(0);
  const iv = useRef(0);
  const fired = useRef(false);
  const live = useRef(false);

  const stop = () => {
    window.clearTimeout(timer.current);
    window.clearInterval(iv.current);
  };
  useEffect(() => stop, []);

  return (
    <button
      type="button"
      className={`portal-vkey${wide ? ' portal-vkey-wide' : ''}${enter ? ' portal-vkey-enter' : ''}`}
      aria-label={aria}
      aria-pressed={pressed}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        live.current = true;
        fired.current = false;
        stop();
        if (repeat) {
          timer.current = window.setTimeout(() => {
            fired.current = true;
            sendRef.current();
            iv.current = window.setInterval(() => sendRef.current(), 80);
          }, 400);
        }
      }}
      onPointerUp={() => {
        stop();
        if (live.current && !fired.current) sendRef.current();
        live.current = false;
      }}
      onPointerCancel={() => {
        stop();
        live.current = false;
      }}
      onPointerLeave={() => {
        stop();
        live.current = false;
      }}
      onClick={(e) => {
        if (e.detail === 0) sendRef.current();
      }}
    >
      {label}
    </button>
  );
}

export function TerminalScreen({
  username,
  maxMinutes,
  unreadAdminNotes,
  onLogout,
  onUnauthorized,
  onBack,
}: {
  username: string;
  maxMinutes?: number;
  unreadAdminNotes: number;
  onLogout: () => void;
  onUnauthorized: () => void;
  onBack?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const autoRef = useRef(false);
  const failsRef = useRef(0);
  const retryRef = useRef(0);
  const connectRef = useRef<(opts?: { fresh?: boolean; auto?: boolean }) => void>(() => undefined);
  const [state, setState] = useState<State>('closed');
  const [closeNote, setCloseNote] = useState('');
  const [endAt, setEndAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [confirmNew, setConfirmNew] = useState(false);
  const totalSecRef = useRef(DEFAULT_MAX_MINUTES * 60);
  totalSecRef.current = (maxMinutes ?? DEFAULT_MAX_MINUTES) * 60;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;
  const lock = useLock();
  const lockRef = useRef(lock);
  lockRef.current = lock;
  /** Soket 4001 (ekran kilidi) ile kapandı; kilit açılınca aynı `resume` kimliğiyle bağlanılır. */
  const waitUnlockRef = useRef(false);
  const [unread, setUnread] = useState(unreadAdminNotes);
  const [devlogOpen, setDevlogOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [keysPref, setKeysPref] = useState<boolean | null>(readKeysPref);
  const [keysAuto, setKeysAuto] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(KEYS_MEDIA).matches);
  const keysVisible = keysPref ?? keysAuto;
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(KEYS_MEDIA);
    const on = () => setKeysAuto(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (stripRef.current && !stripRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        moreRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const toggleKeys = () => {
    const next = !keysVisible;
    setKeysPref(next);
    try {
      window.localStorage.setItem(KEYS_STORE, next ? '1' : '0');
    } catch {
      return;
    }
  };

  const sendRaw = useCallback((s: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
  }, []);

  const sendKey = useCallback(
    (s: string) => {
      let out = s;
      if (ctrlRef.current) {
        if (s.length === 1 && /[a-z]/i.test(s)) out = String.fromCharCode(s.toLowerCase().charCodeAt(0) & 0x1f);
        ctrlRef.current = false;
        setCtrl(false);
      }
      sendRaw(out);
    },
    [sendRaw],
  );

  const sendArrow = useCallback(
    (c: 'A' | 'B' | 'C' | 'D') => {
      const app = termRef.current?.modes.applicationCursorKeysMode;
      sendKey(`${app ? '\x1bO' : '\x1b['}${c}`);
    },
    [sendKey],
  );

  useEffect(() => {
    setUnread(unreadAdminNotes);
  }, [unreadAdminNotes]);

  useEffect(() => {
    const t = window.setInterval(() => {
      getStatus()
        .then((s) => {
          if (!s.loggedIn) unauthRef.current();
          else setUnread(s.unreadAdminNotes ?? 0);
        })
        .catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: fontFor(window.innerWidth),
      rightClickSelectsWord: false,
      theme: {
        selectionBackground: 'rgba(0, 0, 0, 0)',
        selectionInactiveBackground: 'rgba(0, 0, 0, 0)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const block = (e: Event) => e.preventDefault();
    const events = ['copy', 'cut', 'dragstart'];
    events.forEach((n) => box.addEventListener(n, block));
    // Sağ tık: menü yerine panodaki metni yapıştır (Windows terminallerindeki gibi).
    // Pano okuma API'si yalnızca güvenli bağlamda (HTTPS/localhost) vardır; yoksa sessizce geçilir.
    const onContextMenu = (e: Event) => {
      e.preventDefault();
      const clip = navigator.clipboard;
      if (clip && typeof clip.readText === 'function') {
        clip.readText().then((txt) => { if (txt) term.paste(txt); }).catch(() => undefined);
      }
    };
    box.addEventListener('contextmenu', onContextMenu);

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true;
      const k = ev.key.toLowerCase();
      const mod = ev.ctrlKey || ev.metaKey;
      // Yapıştırma: tarayıcının yerel paste olayına bırak (xterm onu işler). preventDefault YOK.
      const isPaste =
        (mod && !ev.altKey && k === 'v') ||
        (ev.shiftKey && !ev.ctrlKey && k === 'insert');
      if (isPaste) return false;
      const swallow =
        (mod && !ev.shiftKey && k === 'c' && term.hasSelection()) ||
        (ev.ctrlKey && ev.shiftKey && k === 'c') ||
        (ev.ctrlKey && k === 'insert');
      if (swallow) {
        ev.preventDefault();
        term.clearSelection();
        return false;
      }
      return true;
    });

    const sendResize = () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const dataSub = term.onData((d) => {
      let out = d;
      if (ctrlRef.current) {
        if (d.length === 1 && /[a-z]/i.test(d)) out = String.fromCharCode(d.toLowerCase().charCodeAt(0) & 0x1f);
        ctrlRef.current = false;
        setCtrl(false);
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(out);
    });
    const resizeSub = term.onResize(sendResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(box);

    const onBoxClick = () => term.focus();
    box.addEventListener('click', onBoxClick);

    let fitTimer = 0;
    const applyFit = () => {
      const fs = fontFor(window.innerWidth);
      if (term.options.fontSize !== fs) term.options.fontSize = fs;
      try {
        fit.fit();
      } catch {
        return;
      }
    };
    const syncViewport = () => {
      const vv = window.visualViewport;
      const app = appRef.current;
      if (vv && app) {
        app.style.setProperty('--portal-vh', `${vv.height}px`);
        app.style.setProperty('--portal-top', `${vv.offsetTop}px`);
        app.dataset.kbOpen = String(window.innerHeight - vv.height > KB_THRESHOLD);
      }
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(applyFit, 80);
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    const vvp = window.visualViewport;
    if (vvp) {
      vvp.addEventListener('resize', syncViewport);
      vvp.addEventListener('scroll', syncViewport);
    }

    return () => {
      window.clearTimeout(fitTimer);
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      if (vvp) {
        vvp.removeEventListener('resize', syncViewport);
        vvp.removeEventListener('scroll', syncViewport);
      }
      box.removeEventListener('click', onBoxClick);
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      events.forEach((n) => box.removeEventListener(n, block));
      box.removeEventListener('contextmenu', onContextMenu);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const connect = useCallback((opts?: { fresh?: boolean; auto?: boolean }) => {
    const term = termRef.current;
    if (!term) return;
    window.clearTimeout(retryRef.current);
    const old = wsRef.current;
    if (old) {
      old.onclose = null;
      old.close();
    }
    const fresh = opts?.fresh === true;
    const auto = opts?.auto === true;
    if (fresh) writeTermId(null);
    const id = fresh ? null : readTermId();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = id ? `?resume=${encodeURIComponent(id)}` : '';
    const ws = new WebSocket(`${proto}//${window.location.host}/papi/terminal${q}`);
    wsRef.current = ws;
    autoRef.current = true;
    if (!auto) failsRef.current = 0;
    setState(auto ? 'reconnecting' : 'connecting');
    setCloseNote('');
    if (!auto) term.reset();
    let first = true;
    const write = (data: unknown) => {
      if (typeof data === 'string') term.write(data);
      else if (data instanceof Blob) void data.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      else if (data instanceof ArrayBuffer) term.write(new Uint8Array(data));
    };
    ws.onopen = () => {
      fitRef.current?.fit();
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (first) {
        first = false;
        failsRef.current = 0;
        setState('open');
        if (typeof ev.data === 'string') {
          let msg: unknown = null;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            msg = null;
          }
          if (msg && typeof msg === 'object') {
            const m = msg as { t?: unknown; id?: unknown; started?: unknown };
            if ((m.t === 'new' || m.t === 'resumed') && typeof m.id === 'string') {
              writeTermId(m.id);
              term.reset();
              // Kalan süre sunucunun bildirdiği oturum başlangıcından hesaplanır (yeniden bağlanmada sıfırlanmaz).
              const startedMs = typeof m.started === 'string' ? Date.parse(m.started) : NaN;
              const base = Number.isFinite(startedMs) ? startedMs : Date.now();
              setEndAt(base + totalSecRef.current * 1000);
              fitRef.current?.fit();
              ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
              return;
            }
          }
        }
        setEndAt((prev) => prev || Date.now() + totalSecRef.current * 1000);
      }
      write(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (wsRef.current !== ws) return;
      if (ev.code === 4001) {
        // Ekran kilitlendi: otomatik yeniden bağlanma yok; terminal kimliği (resume) korunur.
        autoRef.current = false;
        window.clearTimeout(retryRef.current);
        waitUnlockRef.current = true;
        setState('closed');
        setCloseNote(closeNoteFor('locked'));
        lockRef.current.reportLocked();
        unauthRef.current();
        return;
      }
      if (ev.reason === 'unauthorized') unauthRef.current();
      const stop = ev.code === 1000 || ev.code === 4000 || ev.code === 1008;
      if (autoRef.current && !stop && failsRef.current < MAX_FAILS) {
        const delay = Math.min(15000, 1000 * 2 ** failsRef.current);
        failsRef.current += 1;
        setState('reconnecting');
        window.clearTimeout(retryRef.current);
        retryRef.current = window.setTimeout(() => connectRef.current({ auto: true }), delay);
        return;
      }
      autoRef.current = false;
      setState('closed');
      setCloseNote(closeNoteFor(ev.reason));
    };
    ws.onerror = () => {
      return;
    };
  }, []);
  connectRef.current = connect;

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!lock.locked && waitUnlockRef.current) {
      waitUnlockRef.current = false;
      connectRef.current();
    }
  }, [lock.locked]);

  useEffect(() => {
    const retryNow = () => {
      if (!autoRef.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      connectRef.current({ auto: true });
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') retryNow();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', retryNow);
    window.addEventListener('pageshow', retryNow);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', retryNow);
      window.removeEventListener('pageshow', retryNow);
      autoRef.current = false;
      window.clearTimeout(retryRef.current);
    };
  }, []);

  useEffect(() => {
    if (state !== 'open') return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [state, endAt]);

  const newSession = () => {
    setConfirmNew(false);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'end' }));
    connect({ fresh: true });
  };

  const logout = () => {
    autoRef.current = false;
    window.clearTimeout(retryRef.current);
    writeTermId(null);
    onLogout();
  };

  return (
    <div className="portal-app" ref={appRef}>
      <header className="portal-strip" ref={stripRef}>
        <div className="portal-id">
          <span className="brand">KutGate Takım Çalışma Paneli</span>
          <span className="who">{username}</span>
          <span role="status">
            {state === 'open' ? (
              <Badge tone="ok">Bağlı</Badge>
            ) : state === 'connecting' ? (
              <Badge tone="warn">Bağlanıyor</Badge>
            ) : state === 'reconnecting' ? (
              <Badge tone="warn">Yeniden bağlanıyor…</Badge>
            ) : (
              <Badge tone="bad">Bağlı değil</Badge>
            )}
          </span>
          <span className="muted portal-left">
            <span className="portal-left-label">Kalan süre: </span>
            <span className="portal-time">{state === 'open' ? fmt(remaining) : '--:--:--'}</span>
          </span>
        </div>
        <button
          type="button"
          ref={moreRef}
          className="portal-more"
          aria-label={unread > 0 ? `Menü, ${unread} okunmamış yönetici notu` : 'Menü'}
          aria-expanded={menuOpen}
          aria-controls="portal-actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span aria-hidden="true">⋯</span>
          {unread > 0 ? <span className="portal-more-dot" aria-hidden="true" /> : null}
        </button>
        <div className="portal-actions" id="portal-actions" data-open={menuOpen}>
          {onBack ? (
            <Button onClick={() => { setMenuOpen(false); onBack(); }}>← Sohbete dön</Button>
          ) : null}
          <Button aria-pressed={keysVisible} onClick={() => { setMenuOpen(false); toggleKeys(); }}>
            Tuşlar
          </Button>
          <Button onClick={() => { setMenuOpen(false); setDevlogOpen(true); }}>Geliştirme günlüğü</Button>
          <Button className={unread > 0 ? 'btn-attn' : ''} onClick={() => { setMenuOpen(false); setNotesOpen(true); }}>
            Yönetici notu
            {unread > 0 ? <Badge tone="warn">{unread} okunmamış</Badge> : null}
          </Button>
          <Button variant="primary" onClick={() => { setMenuOpen(false); if (state === 'open') setConfirmNew(true); else connect({ fresh: true }); }}>
            Yeni oturum
          </Button>
          <Button onClick={() => { setMenuOpen(false); logout(); }}>Çıkış</Button>
        </div>
      </header>
      <p className="portal-hint">
        İpucu: ajanı başlatmak için <code>claude</code> yazın.
      </p>
      <div className="portal-term-wrap">
        <div className="portal-term" ref={boxRef} role="region" aria-label="Terminal" />
        {state === 'closed' ? (
          <div className="portal-closed" role="alert">
            <p>{closeNote || 'Bağlı değil.'}</p>
            <Button variant="primary" onClick={() => connect()}>
              Yeniden bağlan
            </Button>
          </div>
        ) : null}
      </div>
      {keysVisible ? (
        <div className="portal-keys" role="toolbar" aria-label="Sanal tuşlar">
          <div className="portal-keys-scroll">
            <VKey label="Esc" aria="Escape" onSend={() => sendKey('\x1b')} />
            <VKey label="Tab" aria="Tab" onSend={() => sendKey('\t')} />
            <VKey label="⇧Tab" aria="Shift Tab" onSend={() => sendKey('\x1b[Z')} />
            <VKey label="←" aria="Sol ok" repeat onSend={() => sendArrow('D')} />
            <VKey label="→" aria="Sağ ok" repeat onSend={() => sendArrow('C')} />
            <VKey label="1" aria="1" onSend={() => sendKey('1')} />
            <VKey label="2" aria="2" onSend={() => sendKey('2')} />
            <VKey label="3" aria="3" onSend={() => sendKey('3')} />
            <VKey label="y" aria="y" onSend={() => sendKey('y')} />
            <VKey label="n" aria="n" onSend={() => sendKey('n')} />
            <VKey label="Ctrl+C" aria="Control C" wide onSend={() => sendKey('\x03')} />
            <VKey
              label="Ctrl"
              aria="Control değiştirici"
              pressed={ctrl}
              onSend={() => {
                ctrlRef.current = !ctrlRef.current;
                setCtrl(ctrlRef.current);
              }}
            />
          </div>
          <div className="portal-keys-fixed">
            <VKey label="↑" aria="Yukarı ok" repeat onSend={() => sendArrow('A')} />
            <VKey label="↓" aria="Aşağı ok" repeat onSend={() => sendArrow('B')} />
            <VKey label="↵" aria="Enter" enter onSend={() => sendKey('\r')} />
          </div>
        </div>
      ) : null}
      <p className="portal-rec">Bu oturum kaydedilmektedir.</p>
      <div className="portal-modals" onCopy={blockCopy} onCut={blockCopy} onDragStart={blockCopy} onContextMenu={blockCopy}>
        {devlogOpen ? <DevlogModal onClose={() => setDevlogOpen(false)} /> : null}
        {notesOpen ? <AdminNotesModal onClose={() => setNotesOpen(false)} onUnread={setUnread} /> : null}
        <ConfirmDialog
          open={confirmNew}
          title="Yeni oturum"
          message="Açık oturum kapatılacak ve içindeki çalışan işlemler sonlandırılacak. Devam edilsin mi?"
          confirmLabel="Yeni oturum aç"
          danger
          onConfirm={newSession}
          onCancel={() => setConfirmNew(false)}
        />
      </div>
    </div>
  );
}
