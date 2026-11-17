import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { attachFit, termFontSize } from '../../core/fit';
import { Badge, Button, Modal } from '../../core/ui';
import { useLock } from '../../core/lock/context';

type State = 'connecting' | 'open' | 'closed';

export function WatchModal({ id, username, onClose }: { id: string; username: string; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lock = useLock();
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const [state, setState] = useState<State>('connecting');
  const [note, setNote] = useState('');

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: termFontSize(13),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    const detachFit = attachFit(term, fit, box, 13);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/sessions/${encodeURIComponent(id)}/watch`);
    ws.onopen = () => setState('open');
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') term.write(ev.data);
      else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
    };
    ws.onclose = (ev: CloseEvent) => {
      setState('closed');
      if (ev.code === 4001) {
        setNote('Ekran kilitli, yayın durduruldu.');
        lockRef.current.reportLocked();
      } else {
        setNote('Yayın sona erdi veya bağlantı kapandı.');
      }
    };
    ws.onerror = () => {
      return;
    };
    return () => {
      detachFit();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [id]);

  return (
    <Modal open wide title={`Canlı izle: ${username}`} onClose={onClose} footer={<Button onClick={onClose}>Kapat</Button>}>
      <p role="status">
        {state === 'open' ? <Badge tone="ok">Canlı</Badge> : state === 'connecting' ? <Badge tone="warn">Bağlanıyor</Badge> : <Badge tone="bad">Kapandı</Badge>}{' '}
        <span className="muted">Salt okunur: girdi gönderilmez.</span>
      </p>
      {note ? <p className="muted">{note}</p> : null}
      <div className="term-watch" ref={boxRef} role="region" aria-label="Canlı terminal çıktısı" />
    </Modal>
  );
}
