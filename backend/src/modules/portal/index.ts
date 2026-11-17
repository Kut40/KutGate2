import { listDeletedChats, readDeletedChat } from '../../portal/chatArchive.js';
import { EFFORT_LEVELS, normalizeMaxEffort } from '../../portal/agentFilter.js';
import { randomInt } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import type { Core, GateModule } from '../../core/types.js';
import { sendScriptFailure } from '../../core/scriptError.js';
import { readRows, type RowSpec } from '../../core/rows.js';
import { adminSessionActive, hashPassword, SESSION_CHECK_MS, SESSION_COOKIE } from '../../core/auth.js';
import { isLockOption, LOCK_CLOSE_CODE, LOCK_CLOSE_REASON, LOCK_OPTIONS } from '../../core/screenLock.js';
import { AGENTLOG_MAX_BYTES, APIKEY_RE, isAgentLogName, SESSION_ID_RE, USER_RE } from '../../core/exec.js';
import {
  INTERNAL_HEADER,
  internalFetch as fetchInternal,
  internalWsBase,
  loadInternalToken,
} from '../../core/internal.js';
import { castPath, readCastOutput } from '../../core/sessions.js';
import {
  readLockMaxMinutes,
  readPortalSettings,
  validatePortalSettings,
  writeLockMaxMinutes,
  writePortalSettings,
} from '../../core/settings.js';
import { parseLiveList } from './live.js';

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_LENGTH = 16;

interface UserRow {
  id: number;
  username: string;
}

interface AccountListRow {
  user_id: number;
  username: string;
  enabled: number;
  must_change: number;
  totp_enabled: number;
  last_login: string | null;
  portal_mode: number | null;
  has_api_key: number | null;
  max_effort: string | null;
}

const ACCOUNT_LIST_ROW: RowSpec<AccountListRow> = {
  user_id: 'number',
  username: 'string',
  enabled: 'number',
  must_change: 'number',
  totp_enabled: 'number',
  last_login: 'string?',
  portal_mode: 'number?',
  has_api_key: 'number?',
  max_effort: 'string?',
};

interface SessionListRow {
  id: string;
  user_id: number;
  username: string | null;
  unit: string;
  started: string;
  ended: string | null;
  end_reason: string | null;
  bytes_out: number;
  bytes_in: number;
}

const SESSION_LIST_ROW: RowSpec<SessionListRow> = {
  id: 'string',
  user_id: 'number',
  username: 'string?',
  unit: 'string',
  started: 'string',
  ended: 'string?',
  end_reason: 'string?',
  bytes_out: 'number',
  bytes_in: 'number',
};

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function parseId(v: unknown): number | null {
  const s = String(v);
  return /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : null;
}
function actor(req: FastifyRequest): string {
  return req.admin?.username ?? 'unknown';
}
function fail(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}
function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function tempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_LENGTH; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}

interface AgentLogEntry {
  file: string;
  size: number;
  mtime: string | number;
}

function parseAgentLogList(stdout: string): AgentLogEntry[] | null {
  const text = stdout.trim();
  if (text === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: AgentLogEntry[] = [];
  for (const item of v) {
    const o = obj(item);
    if (typeof o.file !== 'string' || typeof o.size !== 'number') return null;
    if (typeof o.mtime !== 'string' && typeof o.mtime !== 'number') return null;
    out.push({ file: o.file, size: o.size, mtime: o.mtime });
  }
  return out;
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db, cfg } = core;
  const internalToken = loadInternalToken(cfg);

  function getUser(id: number): UserRow | undefined {
    return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }

  function userFromParam(raw: unknown, reply: FastifyReply): UserRow | null {
    const id = parseId(raw);
    if (id === null) {
      fail(reply, 400, 'geçersiz id');
      return null;
    }
    const u = getUser(id);
    if (!u) {
      fail(reply, 404, 'kullanıcı bulunamadı');
      return null;
    }
    if (!USER_RE.test(u.username)) {
      fail(reply, 400, 'geçersiz kullanıcı adı');
      return null;
    }
    return u;
  }

  function internalFetch(path: string, method: 'GET' | 'POST'): Promise<Response | null> {
    return fetchInternal(cfg, internalToken, path, method);
  }

  /** Portal sunucusundan canlı oturumlar; iç uçtan geçerli yanıt alınamazsa null. */
  async function liveIds(): Promise<Map<string, boolean> | null> {
    const res = await internalFetch('/internal/live', 'GET');
    if (!res || !res.ok) return null;
    try {
      return parseLiveList((await res.json()) as unknown);
    } catch {
      return null;
    }
  }

  /** Asıl işlem geri alınmaz; sonuç yanıtta `sessionsKilled` olarak bildirilir. */
  async function killUserSessions(req: FastifyRequest, u: UserRow): Promise<boolean> {
    const res = await internalFetch(`/internal/kill-user/${u.id}`, 'POST');
    if (res?.ok) return true;
    req.log.error({ userId: u.id, username: u.username, status: res?.status ?? null }, 'portal oturumları kapatılamadı');
    return false;
  }

  app.get('/api/portal/accounts', async () => {
    const rows = readRows<AccountListRow>(
      ACCOUNT_LIST_ROW,
      db
        .prepare(
          'SELECT p.user_id, u.username, p.enabled, p.must_change, p.totp_enabled, p.last_login, u.portal_mode, u.has_api_key, p.max_effort FROM portal_accounts p JOIN users u ON u.id = p.user_id ORDER BY u.username',
        )
        .all(),
    );
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      enabled: r.enabled === 1,
      mustChange: r.must_change === 1,
      totpEnabled: r.totp_enabled === 1,
      lastLogin: r.last_login,
      portalMode: r.portal_mode === 1,
      hasApiKey: r.has_api_key === 1,
      maxEffort: normalizeMaxEffort(r.max_effort),
    }));
  });

  app.post<{ Params: { userId: string } }>('/api/portal/accounts/:userId', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const r = await core.run('portal-mode', [u.username, 'on']);
    if (!r.ok) return sendScriptFailure(req, reply, 'portal-mode', r);
    const password = tempPassword();
    const hash = await hashPassword(password);
    const exists = !!db.prepare('SELECT 1 FROM portal_accounts WHERE user_id = ?').get(u.id);
    db.exec('BEGIN');
    try {
      if (exists) {
        db.prepare(
          'UPDATE portal_accounts SET pass_hash = ?, must_change = 1, totp_secret = NULL, totp_enabled = 0, pin_hash = NULL, pin_failures = 0, pin_locked_until = NULL, lock_minutes = NULL WHERE user_id = ?',
        ).run(hash, u.id);
      } else {
        db.prepare(
          'INSERT INTO portal_accounts(user_id, pass_hash, must_change, totp_secret, totp_enabled, enabled, created) VALUES (?, ?, 1, NULL, 0, 1, ?)',
        ).run(u.id, hash, new Date().toISOString());
      }
      db.prepare('DELETE FROM portal_sessions WHERE user_id = ?').run(u.id);
      db.prepare('UPDATE users SET portal_mode = 1 WHERE id = ?').run(u.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(
      actor(req),
      exists ? 'portal.account_reset' : 'portal.account_create',
      `${u.username}${r.dryRun ? ' (DRY)' : ''}`,
    );
    reply.header('Cache-Control', 'no-store');
    if (!exists) return { tempPassword: password };
    return { tempPassword: password, sessionsKilled: await killUserSessions(req, u) };
  });

  app.post<{ Params: { userId: string } }>('/api/portal/accounts/:userId/enabled', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const b = obj(req.body);
    if (typeof b.enabled !== 'boolean') return fail(reply, 400, 'geçersiz hesap durumu');
    if (!db.prepare('SELECT 1 FROM portal_accounts WHERE user_id = ?').get(u.id)) {
      return fail(reply, 404, 'portal hesabı yok');
    }
    db.prepare('UPDATE portal_accounts SET enabled = ? WHERE user_id = ?').run(b.enabled ? 1 : 0, u.id);
    if (!b.enabled) db.prepare('DELETE FROM portal_sessions WHERE user_id = ?').run(u.id);
    core.audit(actor(req), b.enabled ? 'portal.account_enable' : 'portal.account_disable', u.username);
    if (b.enabled) return { ok: true };
    return { ok: true, sessionsKilled: await killUserSessions(req, u) };
  });

  app.put<{ Params: { userId: string } }>('/api/portal/accounts/:userId/max-effort', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const value = obj(req.body).maxEffort;
    if (typeof value !== 'string' || !EFFORT_LEVELS.has(value)) return fail(reply, 400, 'geçersiz efor');
    const r = db.prepare('UPDATE portal_accounts SET max_effort = ? WHERE user_id = ?').run(value, u.id);
    if (r.changes === 0) return fail(reply, 404, 'portal hesabı yok');
    core.audit(actor(req), 'portal.max_effort', `${u.username} ${value}`);
    return { ok: true };
  });

  app.get('/api/portal/deleted-chats', async () => listDeletedChats(core.cfg.dataDir));

  app.get<{ Params: { username: string; id: string } }>('/api/portal/deleted-chats/:username/:id', async (req, reply) => {
    const chat = readDeletedChat(core.cfg.dataDir, req.params.username, req.params.id);
    if (!chat) return fail(reply, 404, 'sohbet bulunamadı');
    core.audit(actor(req), 'portal.chat.view_deleted', `${req.params.username} id=${req.params.id}`);
    return chat;
  });

  app.delete<{ Params: { userId: string } }>('/api/portal/accounts/:userId', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    if (!db.prepare('SELECT 1 FROM portal_accounts WHERE user_id = ?').get(u.id)) {
      return fail(reply, 404, 'portal hesabı yok');
    }
    const r = await core.run('portal-mode', [u.username, 'off']);
    if (!r.ok) return sendScriptFailure(req, reply, 'portal-mode', r);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM portal_sessions WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM portal_accounts WHERE user_id = ?').run(u.id);
      db.prepare('UPDATE users SET portal_mode = 0 WHERE id = ?').run(u.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(actor(req), 'portal.account_delete', `${u.username}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true, sessionsKilled: await killUserSessions(req, u) };
  });

  app.put<{ Params: { userId: string } }>('/api/portal/apikey/:userId', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const b = obj(req.body);
    const key = typeof b.key === 'string' ? b.key.replace(/\s+/g, '') : '';
    if (!APIKEY_RE.test(key)) return fail(reply, 400, 'geçersiz API anahtarı');
    const r = await core.run('apikey-set', [u.username], key + '\n');
    if (!r.ok) return sendScriptFailure(req, reply, 'apikey-set', r);
    db.prepare('UPDATE users SET has_api_key = 1 WHERE id = ?').run(u.id);
    core.audit(actor(req), 'portal.apikey_set', `${u.username}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>('/api/portal/apikey/:userId', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const r = await core.run('apikey-set', [u.username, '--delete']);
    if (!r.ok) return sendScriptFailure(req, reply, 'apikey-set', r);
    db.prepare('UPDATE users SET has_api_key = 0 WHERE id = ?').run(u.id);
    core.audit(actor(req), 'portal.apikey_delete', `${u.username}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });

  app.get('/api/portal/settings', async () => readPortalSettings(db));

  app.put('/api/portal/settings', async (req, reply) => {
    // detachMinutes gönderilmezse mevcut değer korunur (eski istemcilerle uyum).
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...(req.body as Record<string, unknown>) } : req.body;
    if (body && typeof body === 'object' && !('detachMinutes' in body)) {
      (body as Record<string, unknown>).detachMinutes = readPortalSettings(db).detachMinutes;
    }
    const s = validatePortalSettings(body);
    if (!s) {
      return fail(
        reply,
        400,
        'geçersiz ayar: boşta süresi 1-240 dakika, en uzun oturum 5-1440 dakika, eşzamanlı terminal 1-5, bağlantı koparsa açık tutma 1-120 dakika arasında tamsayı olmalı',
      );
    }
    writePortalSettings(db, s);
    core.audit(
      actor(req),
      'portal.settings',
      `idle=${s.idleMinutes} max=${s.maxMinutes} concurrent=${s.maxConcurrent} detach=${s.detachMinutes}`,
    );
    return s;
  });

  app.get('/api/lock/settings', async () => ({ maxMinutes: readLockMaxMinutes(db), options: [...LOCK_OPTIONS] }));

  app.put('/api/lock/settings', async (req, reply) => {
    const maxMinutes = obj(req.body).maxMinutes;
    if (!isLockOption(maxMinutes)) return fail(reply, 400, 'geçersiz üst sınır');
    writeLockMaxMinutes(db, maxMinutes);
    core.audit(actor(req), 'lock.max_minutes', String(maxMinutes));
    return { maxMinutes, options: [...LOCK_OPTIONS] };
  });

  app.get<{ Querystring: { active?: string; user?: string } }>('/api/sessions', async (req, reply) => {
    const { active, user } = req.query;
    if (active !== undefined && active !== '0' && active !== '1') return fail(reply, 400, 'oturum durumu süzgeci 0 ya da 1 olmalı');
    if (user !== undefined && user !== '' && !USER_RE.test(user)) return fail(reply, 400, 'geçersiz kullanıcı adı');
    const fetched = await liveIds();
    if (fetched === null && active === '1') return fail(reply, 502, 'portal sunucusuna ulaşılamıyor');
    const live = fetched ?? new Map<string, boolean>();
    const where: string[] = [];
    const params: string[] = [];
    if (user) {
      where.push('u.username = ?');
      params.push(user);
    }
    if (active !== undefined) {
      const ids = [...live.keys()];
      if (active === '1') {
        if (ids.length === 0) return [];
        where.push(`t.id IN (${ids.map(() => '?').join(',')})`);
      } else if (ids.length > 0) {
        where.push(`t.id NOT IN (${ids.map(() => '?').join(',')})`);
      }
      params.push(...ids);
    }
    const sql = `SELECT t.id, t.user_id, u.username, t.unit, t.started, t.ended, t.end_reason, t.bytes_out, t.bytes_in FROM term_sessions t LEFT JOIN users u ON u.id = t.user_id${
      where.length ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY t.started DESC LIMIT 500`;
    const rows = readRows<SessionListRow>(SESSION_LIST_ROW, db.prepare(sql).all(...params));
    return rows.map((r) => {
      const attached = live.get(r.id);
      return {
        id: r.id,
        userId: r.user_id,
        username: r.username ?? '',
        unit: r.unit,
        started: r.started,
        ended: r.ended,
        endReason: r.end_reason,
        bytesOut: r.bytes_out,
        bytesIn: r.bytes_in,
        live: attached !== undefined,
        ...(attached !== undefined ? { attached } : {}),
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/cast', async (req, reply) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) return fail(reply, 400, 'geçersiz id');
    if (!db.prepare('SELECT 1 FROM term_sessions WHERE id = ?').get(id)) return fail(reply, 404, 'oturum bulunamadı');
    const file = castPath(cfg, id);
    if (!file || !existsSync(file)) return fail(reply, 404, 'kayıt bulunamadı');
    return reply
      .code(200)
      .header('Cache-Control', 'no-store')
      .type('text/plain; charset=utf-8')
      .send(createReadStream(file));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/watch', { websocket: true }, (socket, req) => {
    if (!req.admin) {
      socket.close(1008, 'unauthorized');
      return;
    }
    if (req.admin.locked || req.admin.pinRequired) {
      socket.close(LOCK_CLOSE_CODE, LOCK_CLOSE_REASON);
      return;
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      socket.close(1008, 'origin');
      return;
    }
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id) || !db.prepare('SELECT 1 FROM term_sessions WHERE id = ?').get(id)) {
      socket.close(1008, 'not_found');
      return;
    }
    socket.on('message', () => {});

    let opened = false;
    let done = false;
    const upstream = new WebSocket(`${internalWsBase(cfg)}/internal/watch/${id}`, {
      headers: { [INTERNAL_HEADER]: internalToken },
    });

    const closeClient = (code: number, reason: string): void => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    };
    const replayLocal = (): void => {
      const file = castPath(cfg, id);
      const text = file ? readCastOutput(file) : '';
      if (text && socket.readyState === socket.OPEN) socket.send(text);
      closeClient(1000, 'ended');
    };

    upstream.addEventListener('open', () => {
      opened = true;
    });
    upstream.addEventListener('message', (ev) => {
      if (socket.readyState !== socket.OPEN) return;
      if (typeof ev.data === 'string') socket.send(ev.data);
    });
    upstream.addEventListener('error', () => {
      if (done) return;
      done = true;
      if (!opened) replayLocal();
      else closeClient(1011, 'upstream');
    });
    upstream.addEventListener('close', () => {
      if (done) return;
      done = true;
      if (!opened) replayLocal();
      else closeClient(1000, 'ended');
    });

    const stop = (): void => {
      done = true;
      clearInterval(sessionCheck);
      stopLockWatch();
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close();
    };
    const token = req.cookies[SESSION_COOKIE];
    const stopLockWatch = core.onSessionLocked((locked) => {
      if (locked !== token) return;
      stop();
      closeClient(LOCK_CLOSE_CODE, LOCK_CLOSE_REASON);
    });
    const sessionCheck = setInterval(() => {
      if (adminSessionActive(db, token ?? '')) return;
      stop();
      closeClient(1008, 'unauthorized');
    }, SESSION_CHECK_MS);
    socket.on('close', stop);
    socket.on('error', stop);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (req, reply) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) return fail(reply, 400, 'geçersiz id');
    if (!db.prepare('SELECT 1 FROM term_sessions WHERE id = ?').get(id)) return fail(reply, 404, 'oturum bulunamadı');
    const res = await internalFetch(`/internal/kill/${id}`, 'POST');
    if (!res) return fail(reply, 502, 'portal sunucusuna ulaşılamıyor');
    if (res.status === 404) return fail(reply, 404, 'oturum aktif değil');
    if (!res.ok) return fail(reply, 502, 'portal sunucusu hata döndü');
    core.audit(actor(req), 'sessions.kill', id);
    return { ok: true };
  });

  app.get<{ Params: { userId: string } }>('/api/agentlogs/:userId', async (req, reply) => {
    const u = userFromParam(req.params.userId, reply);
    if (!u) return reply;
    const r = await core.run('agent-logs', [u.username, 'list']);
    if (!r.ok) return sendScriptFailure(req, reply, 'agent-logs', r);
    const list = parseAgentLogList(r.stdout);
    if (!list) return fail(reply, 500, 'ajan kayıtları listesi okunamadı');
    core.audit(actor(req), 'agentlogs.list', u.username);
    return list;
  });

  app.get<{ Params: { userId: string }; Querystring: { name?: string } }>(
    '/api/agentlogs/:userId/file',
    async (req, reply) => {
      const u = userFromParam(req.params.userId, reply);
      if (!u) return reply;
      const name = req.query.name;
      if (!isAgentLogName(name)) return fail(reply, 400, 'geçersiz dosya adı');
      const r = await core.run('agent-logs', [u.username, 'read', name]);
      if (!r.ok) return sendScriptFailure(req, reply, 'agent-logs', r);
      if (Buffer.byteLength(r.stdout, 'utf8') > AGENTLOG_MAX_BYTES) return fail(reply, 413, 'dosya 5 MB sınırını aşıyor');
      core.audit(actor(req), 'agentlogs.read', `${u.username} ${name}`);
      return reply.code(200).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(r.stdout);
    },
  );
}

const mod: GateModule = { name: 'portal', register };
export default mod;
