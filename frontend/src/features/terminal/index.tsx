import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Feature } from '../../core/registry';
import { attachFit, termFontSize } from '../../core/fit';
import { useLock } from '../../core/lock/context';
import { Badge, Button, Card, PageHeader } from '../../core/ui';

type State = 'connecting' | 'open' | 'closed';

function TerminalPage() {
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>('closed');
  const lock = useLock();
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: termFontSize(14),
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    let detachFit = () => {};
    if (boxRef.current) {
      term.open(boxRef.current);
      detachFit = attachFit(term, fit, boxRef.current, 14);
    }
    termRef.current = term;
    fitRef.current = fit;
    const sub = term.onData((d) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    return () => {
      detachFit();
      sub.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const old = wsRef.current;
    if (old) {
      old.onclose = null;
      old.close();
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal`);
    wsRef.current = ws;
    setState('connecting');
    term.reset();
    ws.onopen = () => {
      setState('open');
      fitRef.current?.fit();
      term.focus();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') term.write(ev.data);
      else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
    };
    ws.onclose = (ev: CloseEvent) => {
      if (wsRef.current === ws) {
        setState('closed');
        // 4001: ekran kilitlendi. Otomatik yeniden bağlanma yok; kilit açılınca "Yeniden bağlan" çalışır.
        if (ev.code === 4001) {
          term.write('\r\n[ekran kilitli, bağlantı kapandı]\r\n');
          lockRef.current.reportLocked();
        } else {
          term.write(`\r\n[${closeText(ev)}]\r\n`);
        }
      }
    };
    ws.onerror = () => {
      /* onclose durumu günceller */
    };
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  const endShell = () => {
    const ws = wsRef.current;
    if (ws) ws.close();
  };

  return (
    <>
      <PageHeader title="Terminal">
        <span role="status">
          {state === 'open' ? (
            <Badge tone="ok">Bağlı</Badge>
          ) : state === 'connecting' ? (
            <Badge tone="warn">Bağlanıyor</Badge>
          ) : (
            <Badge tone="bad">Bağlı değil</Badge>
          )}
        </span>
        <Button
          small
          onClick={endShell}
          disabled={state === 'closed'}
          title="Bağlantı kesilir; kabuk ve içinde çalışan komutlar sonlandırılır."
        >
          Kabuğu sonlandır
        </Button>
        <Button small variant="primary" onClick={connect} disabled={state !== 'closed'}>
          Yeniden bağlan
        </Button>
      </PageHeader>
      <Card className="term-card">
        <div className="term-box" ref={boxRef} role="region" aria-label="Terminal" />
      </Card>
    </>
  );
}

function closeText(ev: CloseEvent): string {
  if (ev.code === 1013) return 'açık terminal sınırı doldu, başka bir terminali kapatıp yeniden deneyin';
  if (ev.code === 1008) return 'bu terminal için yetki yok, sayfayı yenileyin';
  if (ev.reason === 'idle') return 'boşta kaldığı için kapandı';
  if (ev.reason === 'exit') return 'kabuk sonlandı';
  if (ev.reason === 'error') return 'kabuk bir hata nedeniyle kapandı';
  return 'bağlantı kapandı';
}

const feature: Feature = { id: 'terminal', title: 'Terminal', icon: 'terminal', Page: TerminalPage };
export default feature;
