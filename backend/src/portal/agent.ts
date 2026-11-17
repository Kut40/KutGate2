import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_ID_RE, listArchivedChats, MAX_LISTED_CHATS, moveChatToDeleted, titleOfUserEvent, type ChatSummary } from './chatArchive.js';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { Config } from '../core/types.js';
import type { AuditFn } from '../core/audit.js';
import { AGENT_RESUME_UUID_RE, isValidScriptCall, scriptPath, type RunFn } from '../core/exec.js';
import { readPortalSettings } from '../core/settings.js';
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
import {
  AgentFilter,
  buildAllow,
  buildAnswer,
  buildDeny,
  castLine,
  cleanMultiline,
  controlRequestLine,
  controlResponseLine,
  clampEffort,
  EFFORT_LEVELS,
  effortWithinLimit,
  isChatEvent,
  isEffortCommand,
  normalizeMaxEffort,
  LineSplitter,
  MODEL_VALUE_RE,
  setEffortLine,
  setModelLine,
  setPermissionModeLine,
  PERMISSION_MODES,
  type PermissionMode,
  userMessageLine,
  validateAttachments,
  type ChatEvent,
  type FilterResult,
  type ModelInfo,
  type PendingRequest,
  type RetryInfo,
  type ServerFrame,
} from './agentFilter.js';
import type { LiveEntry, SessionHooks, TerminalController, WatchSink } from './terminal.js';
import { originMatchesHost } from './validate.js';

const MAX_EVENTS = 2000;
export const MAX_FRAME_BYTES = { send: 32 * 1024 * 1024, other: 256 * 1024 };
const MAX_MESSAGE_CHARS = 100000;
const MAX_STDERR_LOG = 500;
const RESUME_FAIL_WINDOW_MS = 5000;
const EXIT_DRAIN_MS = 500;
const CONVERSATION_IDLE_MS = 12 * 60 * 60 * 1000;
const CONVERSATION_SWEEP_MS = 10 * 60 * 1000;

const CLAUDE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool',
  'stdio',
  '--permission-mode',
  'default',
];

interface AgentController extends TerminalController {
  owns(id: string): boolean;
}

interface AgentProcess {
  id: string;
  child: ChildProcessWithoutNullStreams;
  filter: AgentFilter;
  recorder: CastRecorder;
  startedIso: string;
  ended: boolean;
  bytesIn: number;
  lastActivity: number;
  detachTimer: ReturnType<typeof setTimeout> | undefined;
  graceMs: number;
  killing: Promise<void> | null;
  finish(reason: EndReason): void;
}

interface Conversation {
  userId: number;
  username: string;
  file: string;
  chatId: string;
  events: Map<string, ChatEvent>;
  claudeSessionId: string | null;
  proc: AgentProcess | null;
  socket: WebSocket | null;
  /** Bağlı soketin ait olduğu oturum belirteci; yalnızca bellekte tutulur, loglanmaz. */
  socketToken: string | null;
  busy: boolean;
  authRequired: boolean;
  pending: Map<string, PendingRequest>;
  models: ModelInfo[];
  model: string | null;
  effort: string | null;
  mode: PermissionMode;
  retry: RetryInfo | null;
  idleSince: number;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
}

/** Kullanıcının tüm oturumları kapatılırken açık soketin kapanış kodu; null ise soket açık kalır. */
export function killUserCloseCode(reason: EndReason): number | null {
  if (reason === 'logout') return 1000;
  if (reason === 'admin') return 1008;
  return null;
}

function newChatId(): string {
  return randomBytes(8).toString('hex');
}

function newEventId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

/** Süreci kalmayan olaylar yeniden yüklenince yarım durumda bırakılmaz. */
function settleLoaded(ev: ChatEvent): ChatEvent {
  if (ev.kind === 'text' && !ev.done) return { ...ev, done: true };
  if (ev.kind === 'tool' && ev.status === 'running') return { ...ev, status: 'failed' };
  if ((ev.kind === 'permission' || ev.kind === 'question') && ev.status === 'pending') return { ...ev, status: 'expired' };
  return ev;
}

function loadConversationFile(file: string): {
  events: Map<string, ChatEvent>;
  chatId: string | null;
  claudeSessionId: string | null;
  model: string | null;
  effort: string | null;
  lines: number;
} {
  const events = new Map<string, ChatEvent>();
  let claudeSessionId: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let chatId: string | null = null;
  let lines = 0;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { events, chatId, claudeSessionId, model, effort, lines };
  }
  for (const line of text.split('\n')) {
    if (line === '') continue;
    lines++;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (o.kind === 'meta') {
      if (typeof o.chatId === 'string' && CHAT_ID_RE.test(o.chatId)) chatId = o.chatId;
      const sid = o.claudeSessionId;
      claudeSessionId = typeof sid === 'string' && AGENT_RESUME_UUID_RE.test(sid) ? sid : null;
      model = typeof o.model === 'string' && MODEL_VALUE_RE.test(o.model) ? o.model : null;
      effort = typeof o.effort === 'string' && EFFORT_LEVELS.has(o.effort) ? o.effort : null;
    } else if (isChatEvent(v)) {
      events.set(v.id, settleLoaded(v));
    }
  }
  while (events.size > MAX_EVENTS) {
    const first = events.keys().next().value;
    if (first === undefined) break;
    events.delete(first);
  }
  return { events, chatId, claudeSessionId, model, effort, lines };
}

function metaOf(conv: Conversation): { kind: 'meta'; chatId: string; claudeSessionId: string | null; model: string | null; effort: string | null } {
  return { kind: 'meta', chatId: conv.chatId, claudeSessionId: conv.claudeSessionId, model: conv.model, effort: conv.effort };
}

/** Varsayılan seçili modelde `default` kaydının eforları geçerlidir. */
function effortsOf(conv: Conversation, model: string | null): string[] {
  const value = model ?? 'default';
  return conv.models.find((m) => m.value === value)?.efforts ?? [];
}

export function registerAgent(
  app: FastifyInstance,
  deps: { db: DatabaseSync; cfg: Config; audit: AuditFn; run: RunFn; auth: PortalAuth; hooks?: SessionHooks },
): AgentController {
  const { db, cfg, audit, run, auth, hooks } = deps;
  const log = app.log;
  const hub = new LiveHub();
  const active = new Map<string, AgentProcess>();
  const conversations = new Map<number, Conversation>();
  const pendingKills = new Set<Promise<void>>();
  const dir = join(cfg.dataDir, 'agent');
  let shuttingDown = false;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [userId, conv] of conversations) {
      if (!conv.proc && !conv.socket && now - conv.idleSince >= CONVERSATION_IDLE_MS) conversations.delete(userId);
    }
  }, CONVERSATION_SWEEP_MS);
  sweep.unref();

  function appendLine(conv: Conversation, value: unknown): void {
    try {
      appendFileSync(conv.file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } catch (err) {
      log.error({ err }, 'ajan konuşması yazılamadı');
    }
  }

  function rewriteFile(conv: Conversation): void {
    const lines = [...conv.events.values()].map((ev) => JSON.stringify(ev));
    lines.push(JSON.stringify(metaOf(conv)));
    const tmp = `${conv.file}.tmp`;
    try {
      writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, conv.file);
    } catch (err) {
      log.error({ err }, 'ajan konuşması sıkıştırılamadı');
    }
  }

  function conversationOf(u: PortalUser): Conversation {
    const existing = conversations.get(u.userId);
    if (existing) return existing;
    const file = join(dir, `${u.username}.jsonl`);
    const loaded = loadConversationFile(file);
    const conv: Conversation = {
      userId: u.userId,
      username: u.username,
      file,
      chatId: loaded.chatId ?? newChatId(),
      events: loaded.events,
      claudeSessionId: loaded.claudeSessionId,
      proc: null,
      socket: null,
      socketToken: null,
      busy: false,
      authRequired: false,
      pending: new Map(),
      models: [],
      model: loaded.model,
      effort: loaded.effort,
      mode: 'auto',
      retry: null,
      idleSince: Date.now(),
    };
    conversations.set(u.userId, conv);
    if (loaded.lines > 0) rewriteFile(conv);
    return conv;
  }

  function sendFrame(conv: Conversation, frame: ServerFrame): void {
    const socket = conv.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  /** Admin ve Portal ayrı süreçtir; sınır her seferinde veritabanından okunur, böylece değişiklik hemen geçerli olur. */
  function maxEffortOf(conv: Conversation): string {
    const row = db.prepare('SELECT max_effort FROM portal_accounts WHERE user_id = ?').get(conv.userId) as
      | { max_effort?: unknown }
      | undefined;
    return normalizeMaxEffort(row?.max_effort);
  }

  /** Seçimi yönetici sınırına çeker; süreç açıksa yeni değeri ona da iletir. */
  function enforceEffortLimit(conv: Conversation): boolean {
    const next = clampEffort(conv.effort, maxEffortOf(conv));
    if (next === conv.effort) return false;
    conv.effort = next;
    appendLine(conv, metaOf(conv));
    if (next !== null && conv.proc) writeStdin(conv.proc, setEffortLine(newEventId('effort'), next));
    return true;
  }

  function stateFields(conv: Conversation) {
    return {
      id: conv.proc?.id ?? null,
      started: conv.proc?.startedIso ?? null,
      alive: conv.proc !== null,
      busy: conv.busy,
      authRequired: conv.authRequired,
      model: conv.model,
      effort: conv.effort,
      mode: conv.mode,
      maxEffort: maxEffortOf(conv),
      retry: conv.retry,
    };
  }

  function archiveDirOf(conv: Conversation): string {
    const d = join(dir, 'archive', conv.username);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  function chatsOf(conv: Conversation): ChatSummary[] {
    const archived = listArchivedChats(archiveDirOf(conv)).filter((c) => c.id !== conv.chatId);
    const events = [...conv.events.values()];
    if (events.length === 0) return archived;
    const first = events.find((e) => e.kind === 'user');
    const last = events[events.length - 1];
    const active: ChatSummary = {
      id: conv.chatId,
      title: first?.kind === 'user' ? titleOfUserEvent(first) : 'Yeni sohbet',
      updated: last.ts,
      active: true,
    };
    return [active, ...archived].slice(0, MAX_LISTED_CHATS);
  }

  function pushChats(conv: Conversation): void {
    sendFrame(conv, { t: 'chats', chats: chatsOf(conv) });
  }

  function pushState(conv: Conversation): void {
    sendFrame(conv, { t: 'state', ...stateFields(conv) });
  }

  function shouldRecord(prev: ChatEvent | undefined, ev: ChatEvent): boolean {
    switch (ev.kind) {
      case 'text':
        return ev.done && !(prev?.kind === 'text' && prev.done);
      case 'tool':
        return ev.status !== 'running' && !(prev?.kind === 'tool' && prev.status !== 'running');
      case 'permission':
        return prev?.kind !== 'permission' || prev.status !== ev.status;
      case 'question':
        return prev?.kind !== 'question' || prev.status !== ev.status;
      default:
        return prev === undefined;
    }
  }

  /** Cast ve canlı izlemeye yalnızca süzülmüş `castLine` metni gider. */
  function record(conv: Conversation, prev: ChatEvent | undefined, ev: ChatEvent): void {
    const proc = conv.proc;
    if (!proc || !shouldRecord(prev, ev)) return;
    const line = castLine(ev);
    if (line === '') return;
    try {
      proc.recorder.output(line);
    } catch (err) {
      log.error({ err }, 'ajan oturum kaydı yazılamadı');
    }
    hub.publish(proc.id, line);
  }

  function putEvent(conv: Conversation, ev: ChatEvent): void {
    const prev = conv.events.get(ev.id);
    conv.events.set(ev.id, ev);
    while (conv.events.size > MAX_EVENTS) {
      const first = conv.events.keys().next().value;
      if (first === undefined) break;
      conv.events.delete(first);
    }
    if (!(ev.kind === 'text' && !ev.done)) appendLine(conv, ev);
    record(conv, prev, ev);
    sendFrame(conv, { t: 'ev', ev });
  }

  function addNotice(conv: Conversation, level: 'info' | 'warn' | 'error', text: string): void {
    putEvent(conv, { kind: 'notice', id: newEventId('notice'), ts: Date.now(), level, text });
  }

  function setClaudeSession(conv: Conversation, sessionId: string | null): void {
    if (conv.claudeSessionId === sessionId) return;
    conv.claudeSessionId = sessionId;
    appendLine(conv, metaOf(conv));
  }

  /**
   * `initialize` yanıtı: liste saklanır ve iletilir, kayıtlı seçim yeni sürece uygulanır.
   * Listede kalmayan seçim gönderilmez, varsayılana döner. Seçim değiştiyse true döner.
   */
  function applyModels(conv: Conversation, models: ModelInfo[]): boolean {
    conv.models = models;
    sendFrame(conv, { t: 'models', models });
    let changed = false;
    if (conv.model !== null && !models.some((m) => m.value === conv.model)) {
      conv.model = null;
      changed = true;
    }
    if (conv.effort !== null && !effortsOf(conv, conv.model).includes(conv.effort)) {
      conv.effort = null;
      changed = true;
    }
    const clamped = clampEffort(conv.effort, maxEffortOf(conv));
    if (clamped !== conv.effort) {
      conv.effort = clamped;
      changed = true;
    }
    if (changed) appendLine(conv, metaOf(conv));
    const proc = conv.proc;
    if (proc) {
      if (conv.model !== null) writeStdin(proc, setModelLine(newEventId('model'), conv.model));
      if (conv.effort !== null) writeStdin(proc, setEffortLine(newEventId('effort'), conv.effort));
      if (conv.mode !== 'default') writeStdin(proc, setPermissionModeLine(newEventId('mode'), conv.mode));
    }
    return changed;
  }

  function expirePending(conv: Conversation): void {
    for (const id of conv.pending.keys()) {
      const ev = conv.events.get(id);
      if ((ev?.kind === 'permission' || ev?.kind === 'question') && ev.status === 'pending') {
        putEvent(conv, { ...ev, status: 'expired' });
      }
    }
    conv.pending.clear();
  }

  function applyResult(conv: Conversation, result: FilterResult): void {
    for (const p of result.pending) conv.pending.set(p.id, p);
    for (const frame of result.frames) {
      if (frame.t === 'ev') {
        putEvent(conv, frame.ev);
      } else {
        const ev = conv.events.get(frame.id);
        if (ev?.kind === 'text') ev.text += frame.text;
        sendFrame(conv, frame);
      }
    }
    if (result.sessionId) setClaudeSession(conv, result.sessionId);
    let changed = false;
    if (result.authRequired !== undefined && result.authRequired !== conv.authRequired) {
      conv.authRequired = result.authRequired;
      changed = true;
    }
    if (result.turnEnded && conv.busy) {
      conv.busy = false;
      changed = true;
    }
    if (result.retry !== undefined) {
      conv.retry = result.retry;
      changed = true;
    }
    if (result.models && applyModels(conv, result.models)) changed = true;
    if (changed) pushState(conv);
  }

  function writeStdin(proc: AgentProcess, line: string): void {
    if (!proc.ended && proc.child.stdin.writable) proc.child.stdin.write(line);
  }

  function startProcess(conv: Conversation): AgentProcess | null {
    if (shuttingDown) return null;
    const settings = readPortalSettings(db);
    const id = randomBytes(12).toString('hex');
    const unit = `gate-portal-${conv.username}-${id}`;
    const file = castPath(cfg, id);
    const resume = conv.claudeSessionId;
    const resumeArgs = resume ? [resume] : [];
    if (!file || !isValidScriptCall(cfg, 'portal-shell', [conv.username, id, 'agent', ...resumeArgs])) return null;

    let recorder: CastRecorder;
    try {
      recorder = new CastRecorder(file, conv.username);
    } catch {
      return null;
    }

    const command = cfg.dryRun ? 'claude' : 'sudo';
    const args = cfg.dryRun
      ? [...CLAUDE_ARGS, ...(resume ? ['--resume', resume] : [])]
      : ['-n', '--', scriptPath(cfg, 'portal-shell'), conv.username, id, 'agent', ...resumeArgs];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          TERM: 'xterm-256color',
          ...(cfg.dryRun && process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
      });
    } catch (err) {
      log.error({ err }, 'ajan süreci başlatılamadı');
      recorder.close();
      return null;
    }

    const startedMs = Date.now();
    const startedIso = new Date(startedMs).toISOString();
    const idleMs = settings.idleMinutes * 60 * 1000;
    const maxMs = settings.maxMinutes * 60 * 1000;
    let bytesOut = 0;
    let gotResult = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const filter = new AgentFilter();
    const splitter = new LineSplitter();

    db.prepare(
      'INSERT INTO term_sessions(id, user_id, unit, started, bytes_out, bytes_in) VALUES (?, ?, ?, ?, 0, 0)',
    ).run(id, conv.userId, unit, startedIso);
    hub.open(id);
    audit(conv.username, 'portal.agent.open', `id=${id} unit=${unit}${cfg.dryRun ? ' (DRY)' : ''}`);

    const proc: AgentProcess = {
      id,
      child,
      filter,
      recorder,
      startedIso,
      ended: false,
      bytesIn: 0,
      lastActivity: startedMs,
      detachTimer: undefined,
      graceMs: settings.detachMinutes * 60 * 1000,
      killing: null,
      finish,
    };

    function finish(reason: EndReason): void {
      if (proc.ended) return;
      proc.ended = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      if (proc.detachTimer) clearTimeout(proc.detachTimer);
      proc.detachTimer = undefined;
      active.delete(id);
      const killing = (async () => {
        await run('session-kill', [unit]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      })();
      proc.killing = killing;
      pendingKills.add(killing);
      void killing.finally(() => pendingKills.delete(killing));

      applyResult(conv, filter.flush());
      expirePending(conv);
      try {
        recorder.close();
      } catch {
        /* kayıt kapatılamadıysa oturum yine de sonlanır */
      }
      hub.close(id);
      db.prepare('UPDATE term_sessions SET ended = ?, end_reason = ?, bytes_out = ?, bytes_in = ? WHERE id = ?').run(
        new Date().toISOString(),
        reason,
        bytesOut,
        proc.bytesIn,
        id,
      );
      audit(conv.username, 'portal.agent.close', `id=${id} reason=${reason} out=${bytesOut} in=${proc.bytesIn}`);
      try {
        hooks?.onEnd(conv.username, id);
      } catch (err) {
        log.error({ err }, 'oturum bitiş kancası başarısız');
      }

      conv.proc = null;
      conv.idleSince = Date.now();
      conv.busy = false;
      conv.retry = null;
      pushState(conv);

      if (reason === 'exit' || reason === 'error') {
        if (resume && !gotResult && Date.now() - startedMs < RESUME_FAIL_WINDOW_MS) {
          setClaudeSession(conv, null);
          addNotice(conv, 'warn', 'Önceki konuşma sürdürülemedi. Sonraki mesajınız yeni bir oturum açar.');
        } else {
          addNotice(conv, 'warn', 'Ajan süreci beklenmedik şekilde kapandı.');
        }
      }
      if (reason === 'logout' && conv.socket) {
        const socket = conv.socket;
        conv.socket = null;
        conv.socketToken = null;
        closeSocket(socket, 1000, reason);
      }
    }

    conv.proc = proc;
    conv.authRequired = false;
    active.set(id, proc);
    try {
      hooks?.onStart(conv.username, id, startedMs);
    } catch (err) {
      log.error({ err }, 'oturum başlangıç kancası başarısız');
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      const d = sessionDeadline(startedMs, proc.lastActivity, idleMs, maxMs);
      timer = setTimeout(
        () => {
          const reason = expiredReason(Date.now(), startedMs, proc.lastActivity, idleMs, maxMs);
          if (reason) finish(reason);
          else schedule();
        },
        Math.max(0, Math.min(d.at - Date.now(), 2 ** 31 - 1)),
      );
    };

    child.stdout.on('data', (buf: Buffer) => {
      if (proc.ended) return;
      bytesOut += buf.length;
      for (const line of splitter.push(buf)) {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg === null || typeof msg !== 'object') continue;
        proc.lastActivity = Date.now();
        if ((msg as { type?: unknown }).type === 'result') gotResult = true;
        try {
          applyResult(conv, filter.push(msg));
        } catch (err) {
          log.error({ err }, 'ajan olayı işlenemedi');
        }
      }
    });
    child.stderr.on('data', (buf: Buffer) => {
      log.warn({ session: id, stderr: buf.toString('utf8').slice(0, MAX_STDERR_LOG) }, 'ajan stderr');
    });
    child.stdin.on('error', () => {});
    child.on('close', () => finish('exit'));
    child.on('exit', () => {
      if (!proc.ended && !exitTimer) exitTimer = setTimeout(() => finish('exit'), EXIT_DRAIN_MS);
    });
    child.on('error', () => finish('error'));

    writeStdin(proc, controlRequestLine(`init-${id}`, 'initialize'));
    schedule();
    return proc;
  }

  function ensureProcess(conv: Conversation): AgentProcess | null {
    return conv.proc ?? startProcess(conv);
  }

  function decide(conv: Conversation, frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== 'string') return;
    const pending = conv.pending.get(id);
    const proc = conv.proc;
    if (!pending || !proc) return;
    const ev = conv.events.get(id);

    if (frame.t === 'perm') {
      if (pending.kind !== 'permission' || typeof frame.allow !== 'boolean' || ev?.kind !== 'permission') return;
      conv.pending.delete(id);
      const always = frame.allow && frame.always === true;
      const response = frame.allow ? buildAllow(pending.input, pending.suggestions, always) : buildDeny();
      writeStdin(proc, controlResponseLine(id, response));
      const status = !frame.allow ? 'denied' : 'updatedPermissions' in response ? 'allowed_always' : 'allowed';
      putEvent(conv, { ...ev, status });
      return;
    }

    if (pending.kind !== 'question' || ev?.kind !== 'question') return;
    const answers = frame.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return;
    conv.pending.delete(id);
    writeStdin(proc, controlResponseLine(id, buildAnswer(pending.input, answers as Record<string, unknown>)));
    putEvent(conv, { ...ev, status: 'answered' });
  }

  /** Ek içeriği yalnızca sürecin girdisine gider; olaya, dosyaya ve kayda üst bilgisi yazılır. */
  function handleSend(conv: Conversation, frame: Record<string, unknown>): void {
    const text = frame.text;
    if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return;
    const checked = validateAttachments(frame.attachments);
    if (!checked.ok) {
      addNotice(conv, 'error', checked.error);
      return;
    }
    if (text.length < 1 && checked.blocks.length === 0) return;
    if (isEffortCommand(text)) {
      addNotice(conv, 'info', 'Efor seçimini mesaj kutusunun altındaki menüden yapın.');
      return;
    }
    const proc = ensureProcess(conv);
    if (!proc) {
      addNotice(conv, 'error', 'Ajan başlatılamadı.');
      return;
    }
    enforceEffortLimit(conv);
    proc.lastActivity = Date.now();
    proc.bytesIn += Buffer.byteLength(text) + checked.meta.reduce((sum, a) => sum + a.size, 0);
    const ev: ChatEvent = { kind: 'user', id: newEventId('user'), ts: Date.now(), text: cleanMultiline(text) };
    if (checked.meta.length > 0) ev.attachments = checked.meta;
    const firstMessage = conv.events.size === 0;
    putEvent(conv, ev);
    conv.busy = true;
    pushState(conv);
    if (firstMessage) pushChats(conv);
    writeStdin(proc, userMessageLine(text, checked.blocks));
  }

  function handleSetModel(conv: Conversation, model: unknown): void {
    if (typeof model !== 'string' || !conv.models.some((m) => m.value === model)) return;
    if (model === conv.model) return;
    conv.model = model;
    if (conv.effort !== null && !effortsOf(conv, model).includes(conv.effort)) conv.effort = null;
    appendLine(conv, metaOf(conv));
    if (conv.proc) writeStdin(conv.proc, setModelLine(newEventId('model'), model));
    pushState(conv);
  }

  function handleSetEffort(conv: Conversation, effort: unknown): void {
    if (typeof effort !== 'string' || !effortsOf(conv, conv.model).includes(effort)) return;
    if (!effortWithinLimit(effort, maxEffortOf(conv))) {
      pushState(conv);
      return;
    }
    if (effort === conv.effort) return;
    conv.effort = effort;
    appendLine(conv, metaOf(conv));
    if (conv.proc) writeStdin(conv.proc, setEffortLine(newEventId('effort'), effort));
    pushState(conv);
  }

  function handleSetMode(conv: Conversation, mode: unknown): void {
    if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) return;
    if (mode === conv.mode) return;
    conv.mode = mode as PermissionMode;
    if (conv.proc) writeStdin(conv.proc, setPermissionModeLine(newEventId('mode'), conv.mode));
    pushState(conv);
  }

  function handleStop(conv: Conversation): void {
    expirePending(conv);
    const proc = conv.proc;
    if (!proc || !conv.busy) return;
    proc.filter.markInterrupted();
    writeStdin(proc, controlRequestLine(newEventId('stop'), 'interrupt'));
  }

  /** Eski birimin kapanması beklenir; bu arada soket değiştiyse ya da oturum bittiyse süreç açılmaz. */
  async function reopen(conv: Conversation, socket: WebSocket, killing: Promise<void> | null): Promise<void> {
    await killing;
    if (conv.socket !== socket || conv.proc || shuttingDown) return;
    if (!startProcess(conv)) addNotice(conv, 'error', 'Ajan başlatılamadı.');
    pushState(conv);
  }

  function handleRestart(conv: Conversation, socket: WebSocket): void {
    const old = conv.proc;
    old?.finish('closed');
    void reopen(conv, socket, old?.killing ?? null).catch((err: unknown) => log.error({ err }, 'ajan yeniden başlatılamadı'));
  }

  /** Açık sohbeti silmeden arşive taşır; hiç mesajı olmayan sohbet saklanmaz. */
  function archiveCurrent(conv: Conversation): void {
    try {
      if (conv.events.size === 0) {
        rmSync(conv.file, { force: true });
        return;
      }
      rewriteFile(conv);
      renameSync(conv.file, join(archiveDirOf(conv), `${conv.chatId}.jsonl`));
    } catch (err) {
      log.error({ err }, 'sohbet arşive taşınamadı');
    }
  }

  function handleOpenChat(conv: Conversation, socket: WebSocket, id: unknown): void {
    if (typeof id !== 'string' || !CHAT_ID_RE.test(id) || id === conv.chatId) return;
    const target = join(archiveDirOf(conv), `${id}.jsonl`);
    if (!existsSync(target)) {
      pushChats(conv);
      return;
    }
    const old = conv.proc;
    old?.finish('closed');
    archiveCurrent(conv);
    try {
      renameSync(target, conv.file);
    } catch (err) {
      log.error({ err }, 'sohbet açılamadı');
      addNotice(conv, 'error', 'Sohbet açılamadı.');
      return;
    }
    const loaded = loadConversationFile(conv.file);
    conv.events = loaded.events;
    conv.chatId = id;
    conv.claudeSessionId = loaded.claudeSessionId;
    conv.model = loaded.model;
    conv.effort = loaded.effort;
    conv.pending.clear();
    conv.authRequired = false;
    conv.retry = null;
    rewriteFile(conv);
    enforceEffortLimit(conv);
    sendFrame(conv, { t: 'hello', ...stateFields(conv), events: [...conv.events.values()] });
    if (conv.models.length > 0) sendFrame(conv, { t: 'models', models: conv.models });
    pushChats(conv);
    void reopen(conv, socket, old?.killing ?? null).catch((err: unknown) => log.error({ err }, 'sohbet sürdürülemedi'));
  }

  /** Kullanıcı listesinden kaldırır; dosya yönetici kayıtlarına taşınır, yok edilmez. */
  function handleDeleteChat(conv: Conversation, socket: WebSocket, id: unknown): void {
    if (typeof id !== 'string' || !CHAT_ID_RE.test(id)) return;
    if (id !== conv.chatId) {
      const target = join(archiveDirOf(conv), `${id}.jsonl`);
      if (!existsSync(target)) {
        pushChats(conv);
        return;
      }
      try {
        moveChatToDeleted(target, cfg.dataDir, conv.username, id);
        audit(conv.username, 'portal.chat.delete', `id=${id}`);
      } catch (err) {
        log.error({ err }, 'sohbet silinemedi');
        addNotice(conv, 'error', 'Sohbet silinemedi.');
      }
      pushChats(conv);
      return;
    }
    if (conv.events.size === 0) return;
    const old = conv.proc;
    old?.finish('closed');
    try {
      rewriteFile(conv);
      moveChatToDeleted(conv.file, cfg.dataDir, conv.username, id);
      audit(conv.username, 'portal.chat.delete', `id=${id}`);
    } catch (err) {
      log.error({ err }, 'sohbet silinemedi');
      addNotice(conv, 'error', 'Sohbet silinemedi.');
      pushChats(conv);
      return;
    }
    conv.events.clear();
    conv.pending.clear();
    conv.chatId = newChatId();
    conv.claudeSessionId = null;
    conv.authRequired = false;
    if (conv.model !== null || conv.effort !== null) appendLine(conv, metaOf(conv));
    sendFrame(conv, { t: 'reset' });
    pushState(conv);
    pushChats(conv);
    void reopen(conv, socket, old?.killing ?? null).catch((err: unknown) => log.error({ err }, 'yeni ajan konuşması açılamadı'));
  }

  function handleNew(conv: Conversation, socket: WebSocket): void {
    const old = conv.proc;
    old?.finish('closed');
    archiveCurrent(conv);
    conv.events.clear();
    conv.pending.clear();
    conv.chatId = newChatId();
    conv.claudeSessionId = null;
    conv.authRequired = false;
    if (conv.model !== null || conv.effort !== null) appendLine(conv, metaOf(conv));
    sendFrame(conv, { t: 'reset' });
    pushState(conv);
    pushChats(conv);
    void reopen(conv, socket, old?.killing ?? null).catch((err: unknown) => log.error({ err }, 'yeni ajan konuşması açılamadı'));
  }

  function onFrame(conv: Conversation, socket: WebSocket, req: FastifyRequest, buf: Buffer): void {
    if (buf.length > MAX_FRAME_BYTES.send) return;
    let v: unknown;
    try {
      v = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
    const u = auth.authenticate(req);
    const refuse = frameCloseFor(u?.stage);
    if (refuse) {
      closeSocket(socket, refuse.code, refuse.reason);
      return;
    }
    if (!u || u.userId !== conv.userId) {
      closeSocket(socket, 1008, 'unauthorized');
      return;
    }
    const frame = v as Record<string, unknown>;
    if (frame.t !== 'send' && buf.length > MAX_FRAME_BYTES.other) return;
    const token = req.cookies[PORTAL_COOKIE];
    if (token) auth.touchActivity(token);
    switch (frame.t) {
      case 'send':
        handleSend(conv, frame);
        break;
      case 'set_model':
        handleSetModel(conv, frame.model);
        break;
      case 'set_effort':
        handleSetEffort(conv, frame.effort);
        break;
      case 'set_mode':
        handleSetMode(conv, frame.mode);
        break;
      case 'perm':
      case 'answer':
        decide(conv, frame);
        break;
      case 'stop':
        handleStop(conv);
        break;
      case 'restart':
        handleRestart(conv, socket);
        break;
      case 'new':
        handleNew(conv, socket);
        break;
      case 'open_chat':
        handleOpenChat(conv, socket, frame.id);
        break;
      case 'delete_chat':
        handleDeleteChat(conv, socket, frame.id);
        break;
      default:
        break;
    }
  }

  function detach(conv: Conversation, socket: WebSocket): void {
    if (conv.socket !== socket) return;
    conv.socket = null;
    conv.socketToken = null;
    conv.idleSince = Date.now();
    const proc = conv.proc;
    if (!proc) return;
    audit(conv.username, 'portal.agent.detach', `id=${proc.id}`);
    if (proc.detachTimer) clearTimeout(proc.detachTimer);
    proc.detachTimer = setTimeout(() => proc.finish('detached_timeout'), Math.min(proc.graceMs, 2 ** 31 - 1));
  }

  function attach(conv: Conversation, socket: WebSocket, req: FastifyRequest): void {
    const previous = conv.socket;
    conv.socket = null;
    if (previous && previous !== socket) closeSocket(previous, 4000, 'replaced');
    const existing = conv.proc;
    if (existing) {
      if (existing.detachTimer) clearTimeout(existing.detachTimer);
      existing.detachTimer = undefined;
      audit(conv.username, 'portal.agent.resume', `id=${existing.id}`);
    } else if (!startProcess(conv)) {
      addNotice(conv, 'error', 'Ajan başlatılamadı.');
    }
    conv.socket = socket;
    conv.socketToken = req.cookies[PORTAL_COOKIE] ?? null;
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary || conv.socket !== socket) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      onFrame(conv, socket, req, buf);
    });
    socket.on('close', () => detach(conv, socket));
    socket.on('error', () => detach(conv, socket));
    enforceEffortLimit(conv);
    sendFrame(conv, { t: 'hello', ...stateFields(conv), events: [...conv.events.values()] });
    if (conv.models.length > 0) sendFrame(conv, { t: 'models', models: conv.models });
    pushChats(conv);
  }

  app.get(
    '/papi/agent',
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
      if (!u || refuse) {
        socket.close(refuse?.code ?? 1008, refuse?.reason ?? 'unauthorized');
        return;
      }
      attach(conversationOf(u), socket, req);
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
    const proc = active.get(id);
    if (!proc) return false;
    proc.finish(reason);
    return true;
  }

  function killUser(userId: number, reason: EndReason): void {
    const conv = conversations.get(userId);
    if (!conv) return;
    conv.proc?.finish(reason);
    const code = killUserCloseCode(reason);
    if (code !== null && conv.socket) {
      const socket = conv.socket;
      conv.socket = null;
      conv.socketToken = null;
      conv.idleSince = Date.now();
      closeSocket(socket, code, reason);
    }
  }

  function detachSession(token: string): void {
    for (const conv of conversations.values()) {
      const socket = conv.socket;
      if (!socket || conv.socketToken !== token) continue;
      detach(conv, socket);
      closeSocket(socket, LOCK_CLOSE_CODE, LOCK_CLOSE_REASON);
    }
  }

  async function killAll(reason: EndReason): Promise<void> {
    shuttingDown = true;
    for (const proc of [...active.values()]) proc.finish(reason);
    await Promise.all([...pendingKills]);
  }

  function live(): LiveEntry[] {
    return [...conversations.values()].flatMap((c) => (c.proc ? [{ id: c.proc.id, attached: c.socket !== null }] : []));
  }

  function owns(id: string): boolean {
    return active.has(id);
  }

  return { live, watch, kill, killUser, killAll, owns, detachSession };
}
