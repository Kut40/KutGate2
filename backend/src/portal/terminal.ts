import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { Config } from '../core/types.js';
import type { AuditFn } from '../core/audit.js';
import { isValidScriptCall, scriptPath, type RunFn } from '../core/exec.js';
import { readPortalSettings, type PortalSettings } from '../core/settings.js';
import { RingBuffer } from '../core/ringbuffer.js';
import {
  CastRecorder,
  castPath,
  expiredReason,
  LiveHub,
  readCastOutput,
  sessionDeadline,
  type EndReason,
} from '../core/sessions.js';
import { frameCloseFor, LOCK_CLOSE_CODE, LOCK_CLOSE_REASON } from '../core/screenLock.js';
import { PORTAL_COOKIE, type PortalAuth, type PortalUser } from './auth.js';
import { decideTerminal } from './resume.js';
import { isEndControl, originMatchesHost, parseResize, resizeControl } from './validate.js';

const PTYHOST = fileURLToPath(new URL('../core/ptyhost.py', import.meta.url));
const MAX_INPUT_FRAME_BYTES = 8 * 1024 * 1024;

export interface WatchSink {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface LiveEntry {
  id: string;
  attached: boolean;
}

export interface TerminalController {
  live(): LiveEntry[];
  watch(id: string, sink: WatchSink): (() => void) | null;
  kill(id: string, reason: EndReason): boolean;
  killUser(userId: number, reason: EndReason): void;
  killAll(reason: EndReason): Promise<void>;
  /** Bu oturum belirtecine ait soketi 4001 ile kapatır; süreç yaşar, kopma süresi işler. */
  detachSession(token: string): void;
}

export interface SessionHooks {
  onStart(username: string, id: string, startMs: number): void;
  onEnd(username: string, id: string): void;
}

interface Session {
  id: string;
  userId: number;
  username: string;
  startedMs: number;
  ended: boolean;
  socket: WebSocket | null;
  /** Bağlı soketin ait olduğu oturum belirteci; yalnızca bellekte tutulur, loglanmaz. */
  socketToken: string | null;
  attach(socket: WebSocket, kind: 'new' | 'resumed', token: string, req: FastifyRequest): void;
  detachLocked(): void;
  finish(reason: EndReason): void;
}

export function registerTerminal(
  app: FastifyInstance,
  deps: { db: DatabaseSync; cfg: Config; audit: AuditFn; run: RunFn; auth: PortalAuth; hooks?: SessionHooks },
): TerminalController {
  const { db, cfg, audit, run, auth, hooks } = deps;
  const hub = new LiveHub();
  const active = new Map<string, Session>();
  const pendingKills = new Set<Promise<void>>();

  function views(): { id: string; userId: number; startedMs: number; attached: boolean; ended: boolean }[] {
    return [...active.values()].map((s) => ({
      id: s.id,
      userId: s.userId,
      startedMs: s.startedMs,
      attached: s.socket !== null,
      ended: s.ended,
    }));
  }

  function startSession(u: PortalUser, settings: PortalSettings, log: FastifyBaseLogger): Session | null {
    const id = randomBytes(12).toString('hex');
    const unit = `gate-portal-${u.username}-${id}`;
    const file = castPath(cfg, id);
    if (!file || !isValidScriptCall(cfg, 'portal-shell', [u.username, id])) return null;

    const command = cfg.dryRun
      ? ['/bin/bash', '--norc', '-i']
      : ['sudo', '-n', '--', scriptPath(cfg, 'portal-shell'), u.username, id];

    let recorder: CastRecorder;
    try {
      recorder = new CastRecorder(file, u.username);
    } catch {
      return null;
    }

    const child: ChildProcessWithoutNullStreams = spawn('python3', [PTYHOST, ...command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        TERM: 'xterm-256color',
        ...(cfg.dryRun && process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
    });

    const startedMs = Date.now();
    const startedIso = new Date(startedMs).toISOString();
    let lastActivity = startedMs;
    let bytesOut = 0;
    let bytesIn = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = settings.idleMinutes * 60 * 1000;
    const maxMs = settings.maxMinutes * 60 * 1000;
    const graceMs = settings.detachMinutes * 60 * 1000;
    const ring = new RingBuffer();

    db.prepare(
      'INSERT INTO term_sessions(id, user_id, unit, started, bytes_out, bytes_in) VALUES (?, ?, ?, ?, 0, 0)',
    ).run(id, u.userId, unit, startedIso);
    hub.open(id);
    audit(u.username, 'portal.terminal.open', `id=${id} unit=${unit}${cfg.dryRun ? ' (DRY)' : ''}`);

    const session: Session = {
      id,
      userId: u.userId,
      username: u.username,
      startedMs,
      ended: false,
      socket: null,
      socketToken: null,
      attach,
      detachLocked,
      finish,
    };

    function closeSocket(socket: WebSocket, code: number, reason: string): void {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    }

    function finish(reason: EndReason): void {
      if (session.ended) return;
      session.ended = true;
      if (timer) clearTimeout(timer);
      if (detachTimer) clearTimeout(detachTimer);
      active.delete(id);
      const killing = (async () => {
        await run('session-kill', [unit]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      })();
      pendingKills.add(killing);
      void killing.finally(() => pendingKills.delete(killing));
      const socket = session.socket;
      session.socket = null;
      session.socketToken = null;
      if (socket) closeSocket(socket, 1000, reason);
      try {
        recorder.close();
      } catch {
        /* kayıt kapatılamadıysa oturum yine de sonlanır */
      }
      hub.close(id);
      ring.clear();
      db.prepare('UPDATE term_sessions SET ended = ?, end_reason = ?, bytes_out = ?, bytes_in = ? WHERE id = ?').run(
        new Date().toISOString(),
        reason,
        bytesOut,
        bytesIn,
        id,
      );
      audit(u.username, 'portal.terminal.close', `id=${id} reason=${reason} out=${bytesOut} in=${bytesIn}`);
      try {
        hooks?.onEnd(u.username, id);
      } catch (err) {
        log.error({ err }, 'oturum bitiş kancası başarısız');
      }
    }

    function detach(socket: WebSocket): void {
      if (session.ended || session.socket !== socket) return;
      session.socket = null;
      session.socketToken = null;
      audit(u.username, 'portal.terminal.detach', `id=${id}`);
      if (detachTimer) clearTimeout(detachTimer);
      detachTimer = setTimeout(() => finish('detached_timeout'), Math.min(graceMs, 2 ** 31 - 1));
    }

    function detachLocked(): void {
      const socket = session.socket;
      if (!socket) return;
      detach(socket);
      closeSocket(socket, LOCK_CLOSE_CODE, LOCK_CLOSE_REASON);
    }

    function attach(socket: WebSocket, kind: 'new' | 'resumed', token: string, req: FastifyRequest): void {
      if (session.ended) {
        closeSocket(socket, 1000, 'ended');
        return;
      }
      if (detachTimer) {
        clearTimeout(detachTimer);
        detachTimer = undefined;
      }
      const previous = session.socket;
      session.socket = socket;
      session.socketToken = token;
      if (previous && previous !== socket) closeSocket(previous, 4000, 'replaced');
      if (kind === 'resumed') audit(u.username, 'portal.terminal.resume', `id=${id}`);

      socket.send(JSON.stringify({ t: kind, id, started: startedIso }));
      if (kind === 'resumed') {
        const buffered = ring.toString();
        if (buffered !== '') socket.send(buffered);
      }

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (session.ended || session.socket !== socket) return;
        const cur = auth.authenticate(req);
        const refuse = frameCloseFor(cur?.stage);
        if (refuse?.code === LOCK_CLOSE_CODE) {
          detachLocked();
          return;
        }
        if (refuse || !cur || cur.userId !== u.userId) {
          detach(socket);
          closeSocket(socket, 1008, 'unauthorized');
          return;
        }
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length > MAX_INPUT_FRAME_BYTES) {
          closeSocket(socket, 1009, 'too_large');
          return;
        }
        lastActivity = Date.now();
        const text = buf.toString('utf8');
        const size = parseResize(text);
        if (size) {
          recorder.resize(size.cols, size.rows);
          child.stdin.write(resizeControl(size.cols, size.rows));
          return;
        }
        if (isEndControl(text)) {
          finish('closed');
          return;
        }
        auth.touchActivity(token);
        bytesIn += buf.length;
        recorder.input(text);
        child.stdin.write(buf);
      });
      socket.on('close', () => detach(socket));
      socket.on('error', () => detach(socket));
    }

    active.set(id, session);
    try {
      hooks?.onStart(u.username, id, startedMs);
    } catch (err) {
      log.error({ err }, 'oturum başlangıç kancası başarısız');
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      const d = sessionDeadline(startedMs, lastActivity, idleMs, maxMs);
      timer = setTimeout(
        () => {
          const reason = expiredReason(Date.now(), startedMs, lastActivity, idleMs, maxMs);
          if (reason) finish(reason);
          else schedule();
        },
        Math.max(0, Math.min(d.at - Date.now(), 2 ** 31 - 1)),
      );
    };

    const outDecoder = new StringDecoder('utf8');
    const onOutput = (buf: Buffer): void => {
      if (session.ended) return;
      bytesOut += buf.length;
      const text = outDecoder.write(buf);
      if (text === '') return;
      recorder.output(text);
      ring.push(text);
      hub.publish(id, text);
      const socket = session.socket;
      if (socket && socket.readyState === socket.OPEN) socket.send(text);
    };

    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.stdin.on('error', () => {});
    child.on('exit', () => finish('exit'));
    child.on('error', () => finish('error'));

    schedule();
    return session;
  }

  app.get<{ Querystring: { resume?: unknown } }>(
    '/papi/terminal',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const u = auth.authenticate(req);
        if (!u) return reply.code(401).send({ error: 'unauthorized' });
        if (!originMatchesHost(req.headers.origin, req.headers.host)) {
          return reply.code(403).send({ error: 'origin' });
        }
        if (u.stage !== 'ready') return reply.code(403).send({ error: 'setup_incomplete' });
        return undefined;
      },
    },
    (socket, req) => {
      const u = auth.authenticate(req);
      const refuse = frameCloseFor(u?.stage);
      const token = req.cookies[PORTAL_COOKIE];
      if (!u || refuse || !token) {
        socket.close(refuse?.code ?? 1008, refuse?.reason ?? 'unauthorized');
        return;
      }
      const settings = readPortalSettings(db);
      const decision = decideTerminal({
        resume: req.query.resume,
        userId: u.userId,
        sessions: views(),
        maxConcurrent: settings.maxConcurrent,
      });
      if (decision.kind === 'reject') {
        socket.close(1008, 'max_concurrent');
        return;
      }
      if (decision.kind === 'resume') {
        const existing = active.get(decision.id);
        if (existing && !existing.ended && existing.userId === u.userId) {
          existing.attach(socket, 'resumed', token, req);
          return;
        }
      }
      const session = startSession(u, settings, req.log);
      if (!session) {
        socket.close(1011, 'invalid');
        return;
      }
      session.attach(socket, 'new', token, req);
    },
  );

  function watch(id: string, sink: WatchSink): (() => void) | null {
    const file = castPath(cfg, id);
    if (!file) return null;
    const replay = readCastOutput(file);
    if (!hub.isLive(id)) {
      if (replay) sink.send(replay);
      sink.close(1000, 'ended');
      return () => {};
    }
    if (replay) sink.send(replay);
    return hub.subscribe(id, {
      data: (chunk) => sink.send(chunk),
      end: () => sink.close(1000, 'ended'),
    });
  }

  function kill(id: string, reason: EndReason): boolean {
    const s = active.get(id);
    if (!s) return false;
    s.finish(reason);
    return true;
  }

  function killUser(userId: number, reason: EndReason): void {
    for (const s of [...active.values()]) if (s.userId === userId) s.finish(reason);
  }

  async function killAll(reason: EndReason): Promise<void> {
    for (const s of [...active.values()]) s.finish(reason);
    await Promise.all([...pendingKills]);
  }

  function detachSession(token: string): void {
    for (const s of active.values()) if (s.socketToken === token) s.detachLocked();
  }

  function live(): LiveEntry[] {
    return [...active.values()].map((s) => ({ id: s.id, attached: s.socket !== null }));
  }

  return { live, watch, kill, killUser, killAll, detachSession };
}
