import { useCallback, useEffect, useRef, useState } from 'react';
import { useLock } from '../../core/lock/context';
import { closeNoteFor } from '../closeNote';
import type { AgentState, AttachmentPayload, ChatEvent, ChatInfo, ClientFrame, ModelInfo, ServerFrame } from './protocol';

export type ConnState = 'connecting' | 'reconnecting' | 'open' | 'closed';

const MAX_FAILS = 5;

const EMPTY_STATE: AgentState = { id: null, started: null, alive: true, busy: false, authRequired: false, model: null, effort: null, mode: 'auto', maxEffort: 'xhigh', retry: null };

function parseFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const t = (msg as { t?: unknown }).t;
  if (t === 'hello' || t === 'state' || t === 'ev' || t === 'delta' || t === 'models' || t === 'reset' || t === 'chats') return msg as ServerFrame;
  return null;
}

function pickState(f: AgentState): AgentState {
  return {
    id: typeof f.id === 'string' ? f.id : null,
    started: typeof f.started === 'string' ? f.started : null,
    alive: f.alive === true,
    busy: f.busy === true,
    authRequired: f.authRequired === true,
    model: typeof f.model === 'string' ? f.model : null,
    effort: typeof f.effort === 'string' ? f.effort : null,
    mode: typeof f.mode === 'string' ? f.mode : 'auto',
    maxEffort: typeof f.maxEffort === 'string' && f.maxEffort ? f.maxEffort : 'xhigh',
    retry:
      f.retry && typeof f.retry.attempt === 'number' && typeof f.retry.max === 'number'
        ? { attempt: f.retry.attempt, max: f.retry.max }
        : null,
  };
}

export interface UseAgent {
  events: ChatEvent[];
  agent: AgentState;
  conn: ConnState;
  closeNote: string;
  models: ModelInfo[] | null;
  chats: ChatInfo[];
  send: (text: string, attachments?: AttachmentPayload[]) => boolean;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  setMode: (mode: string) => void;
  respondPermission: (id: string, allow: boolean, always?: boolean) => boolean;
  answer: (id: string, answers: Record<string, string>) => boolean;
  stop: () => void;
  restart: () => void;
  newConversation: () => void;
  openChat: (id: string) => void;
  deleteChat: (id: string) => void;
  reconnect: () => void;
  disconnect: () => void;
}

export function useAgent(onUnauthorized: () => void): UseAgent {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [agent, setAgent] = useState<AgentState>(EMPTY_STATE);
  const [conn, setConn] = useState<ConnState>('closed');
  const [closeNote, setCloseNote] = useState('');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const autoRef = useRef(false);
  const failsRef = useRef(0);
  const retryRef = useRef(0);
  const connectRef = useRef<(opts?: { auto?: boolean }) => void>(() => undefined);
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;
  const lock = useLock();
  const lockRef = useRef(lock);
  lockRef.current = lock;
  /** Soket 4001 (ekran kilidi) ile kapandı; kilit açılınca yeniden bağlanılır. */
  const waitUnlockRef = useRef(false);

  const connect = useCallback((opts?: { auto?: boolean }) => {
    window.clearTimeout(retryRef.current);
    const old = wsRef.current;
    if (old) {
      old.onclose = null;
      old.close();
    }
    const auto = opts?.auto === true;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/papi/agent`);
    wsRef.current = ws;
    autoRef.current = true;
    if (!auto) failsRef.current = 0;
    setConn(auto ? 'reconnecting' : 'connecting');
    setCloseNote('');
    let first = true;
    ws.onmessage = (ev: MessageEvent) => {
      if (wsRef.current !== ws) return;
      if (first) {
        first = false;
        failsRef.current = 0;
        setConn('open');
      }
      const f = parseFrame(ev.data);
      if (!f) return;
      switch (f.t) {
        case 'hello':
          setAgent(pickState(f));
          setEvents(Array.isArray(f.events) ? f.events.filter((e) => e && typeof e === 'object' && typeof e.id === 'string') : []);
          break;
        case 'state':
          setAgent(pickState(f));
          break;
        case 'ev': {
          const e = f.ev;
          if (!e || typeof e !== 'object' || typeof e.id !== 'string') break;
          setEvents((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].id === e.id) {
                const next = prev.slice();
                next[i] = e;
                return next;
              }
            }
            return [...prev, e];
          });
          break;
        }
        case 'delta':
          setEvents((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const p = prev[i];
              if (p.id === f.id) {
                if (p.kind !== 'text' || typeof f.text !== 'string') return prev;
                const next = prev.slice();
                next[i] = { ...p, text: p.text + f.text };
                return next;
              }
            }
            return prev;
          });
          break;
        case 'models':
          setModels(
            Array.isArray(f.models)
              ? f.models
                  .filter((m) => m && typeof m.value === 'string' && typeof m.label === 'string')
                  .map((m) => ({ ...m, efforts: Array.isArray(m.efforts) ? m.efforts.filter((x) => typeof x === 'string') : [] }))
              : null,
          );
          break;
        case 'reset':
          setEvents([]);
          break;
        case 'chats':
          setChats(
            Array.isArray(f.chats)
              ? f.chats
                  .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string' && typeof c.updated === 'number')
                  .map((c) => ({ id: c.id, title: c.title, updated: c.updated, active: c.active === true }))
              : [],
          );
          break;
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (wsRef.current !== ws) return;
      if (ev.code === 4001) {
        // Ekran kilitlendi: otomatik yeniden bağlanma yok, kilit açılınca bağlanılır.
        autoRef.current = false;
        window.clearTimeout(retryRef.current);
        waitUnlockRef.current = true;
        setConn('closed');
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
        setConn('reconnecting');
        window.clearTimeout(retryRef.current);
        retryRef.current = window.setTimeout(() => connectRef.current({ auto: true }), delay);
        return;
      }
      autoRef.current = false;
      setConn('closed');
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
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, []);

  const sendFrame = useCallback((f: ClientFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(f));
    return true;
  }, []);

  const send = useCallback(
    (text: string, attachments?: AttachmentPayload[]) =>
      sendFrame(attachments && attachments.length ? { t: 'send', text, attachments } : { t: 'send', text }),
    [sendFrame],
  );
  const setModel = useCallback((model: string) => void sendFrame({ t: 'set_model', model }), [sendFrame]);
  const setEffort = useCallback((effort: string) => void sendFrame({ t: 'set_effort', effort }), [sendFrame]);
  const setMode = useCallback((mode: string) => void sendFrame({ t: 'set_mode', mode }), [sendFrame]);
  const respondPermission = useCallback(
    (id: string, allow: boolean, always?: boolean) =>
      sendFrame(always ? { t: 'perm', id, allow, always: true } : { t: 'perm', id, allow }),
    [sendFrame],
  );
  const answer = useCallback((id: string, answers: Record<string, string>) => sendFrame({ t: 'answer', id, answers }), [sendFrame]);
  const stop = useCallback(() => void sendFrame({ t: 'stop' }), [sendFrame]);
  const restart = useCallback(() => void sendFrame({ t: 'restart' }), [sendFrame]);
  const newConversation = useCallback(() => void sendFrame({ t: 'new' }), [sendFrame]);
  const openChat = useCallback((id: string) => void sendFrame({ t: 'open_chat', id }), [sendFrame]);
  const deleteChat = useCallback((id: string) => void sendFrame({ t: 'delete_chat', id }), [sendFrame]);
  const reconnect = useCallback(() => connect(), [connect]);
  const disconnect = useCallback(() => {
    autoRef.current = false;
    window.clearTimeout(retryRef.current);
  }, []);

  return { events, agent, conn, closeNote, models, chats, send, setModel, setEffort, setMode, respondPermission, answer, stop, restart, newConversation, openChat, deleteChat, reconnect, disconnect };
}
