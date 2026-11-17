import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditFn } from '../core/audit.js';
import { consumeTotp, createAdminSession, findAdmin, hashPassword, verifyPassword } from '../core/auth.js';
import { unreadAdminNoteCount } from '../core/board.js';
import { clientIp, isHttps } from '../core/clientip.js';
import { lockInfo, makeLockStore, PORTAL_LOCK_PATHS, registerLockRoutes } from '../core/screenLock.js';
import { readLockMaxMinutes, readPortalSettings } from '../core/settings.js';
import { generateSecret, matchTotp, otpauthUri } from '../core/totp.js';
import { passwordError } from './validate.js';

export const PORTAL_COOKIE = 'gate_psid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const TOTP_SETUP_TTL_MS = SESSION_TTL_MS;

export type Stage = 'change_password' | 'setup_totp' | 'setup_pin' | 'locked' | 'ready';

export interface PortalUser {
  userId: number;
  username: string;
  stage: Stage;
}

interface AccountRow {
  user_id: number;
  username: string;
  locked: number;
  pass_hash: string;
  must_change: number;
  totp_secret: string | null;
  totp_enabled: number;
  enabled: number;
  pin_hash: string | null;
  lock_minutes: number | null;
}

interface SessionRow extends AccountRow {
  last_seen: number;
  expires: number;
  session_locked: number | null;
  last_active: number | null;
}

const ACCOUNT_COLS =
  'u.id AS user_id, u.username, u.locked, p.pass_hash, p.must_change, p.totp_secret, p.totp_enabled, p.enabled, p.pin_hash, p.lock_minutes';

const isNumOrNull = (v: unknown): boolean => v === null || typeof v === 'number';
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

function isAccountRow(v: unknown): v is AccountRow {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.user_id === 'number' &&
    typeof r.username === 'string' &&
    typeof r.locked === 'number' &&
    typeof r.pass_hash === 'string' &&
    typeof r.must_change === 'number' &&
    isStrOrNull(r.totp_secret) &&
    typeof r.totp_enabled === 'number' &&
    typeof r.enabled === 'number' &&
    isStrOrNull(r.pin_hash) &&
    isNumOrNull(r.lock_minutes)
  );
}

function isSessionRow(v: unknown): v is SessionRow {
  if (!isAccountRow(v)) return false;
  const r = v as unknown as Record<string, unknown>;
  return (
    typeof r.last_seen === 'number' &&
    typeof r.expires === 'number' &&
    isNumOrNull(r.session_locked) &&
    isNumOrNull(r.last_active)
  );
}

function body(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const SETUP_PAPI: ReadonlySet<string> = new Set([
  '/papi/status',
  '/papi/password',
  '/papi/totp/begin',
  '/papi/totp/confirm',
  '/papi/pin',
  '/papi/logout',
  '/papi/lock/activity',
]);

export function setupIncomplete(stage: Stage, route: string, rawPath: string): boolean {
  if (stage === 'ready' || stage === 'locked') return false;
  return !(SETUP_PAPI.has(route) && SETUP_PAPI.has(rawPath));
}

export function stageOf(row: {
  must_change: number;
  totp_enabled: number;
  pin_hash: string | null;
  session_locked?: number | null;
}): Stage {
  if (row.must_change === 1) return 'change_password';
  if (row.totp_enabled !== 1) return 'setup_totp';
  if (row.pin_hash === null) return 'setup_pin';
  return row.session_locked === 1 ? 'locked' : 'ready';
}

export interface PortalAuth {
  authenticate(req: FastifyRequest): PortalUser | null;
  registerRoutes(app: FastifyInstance): void;
  onLogout(fn: (u: PortalUser) => void): void;
  onLocked(fn: (token: string) => void): () => void;
  frameLocked(token: string, username: string): boolean;
  touchActivity(token: string): void;
}

export function makePortalAuth(db: DatabaseSync, audit: AuditFn): PortalAuth {
  const failures = new Map<string, number[]>();
  const pendingTotp = new Map<number, { secret: string; exp: number }>();
  const logoutListeners: ((u: PortalUser) => void)[] = [];
  const lockStore = makeLockStore(db, 'portal', audit, readLockMaxMinutes);

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of failures) {
      const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length) failures.set(k, fresh);
      else failures.delete(k);
    }
    for (const [k, p] of pendingTotp) if (p.exp <= now) pendingTotp.delete(k);
    db.prepare('DELETE FROM portal_sessions WHERE expires <= ? OR last_seen <= ?').run(now, now - IDLE_MS);
  }, 60 * 1000);
  cleanup.unref();

  function recentFailures(key: string): number {
    const now = Date.now();
    const arr = (failures.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length) failures.set(key, arr);
    else failures.delete(key);
    return arr.length;
  }

  function addFailure(key: string): void {
    const arr = failures.get(key) ?? [];
    arr.push(Date.now());
    failures.set(key, arr);
  }

  function reserveAttempt(key: string): number | null {
    if (recentFailures(key) >= RATE_MAX_FAILURES) return null;
    const at = Date.now();
    failures.set(key, [...(failures.get(key) ?? []), at]);
    return at;
  }

  function releaseAttempt(key: string, at: number): void {
    const arr = failures.get(key);
    if (!arr) return;
    const i = arr.indexOf(at);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) failures.delete(key);
  }

  function notifyLogout(req: FastifyRequest, u: PortalUser): void {
    for (const fn of logoutListeners) {
      try {
        fn({ userId: u.userId, username: u.username, stage: u.stage });
      } catch (err) {
        req.log.error({ err }, 'çıkış kancası başarısız');
      }
    }
  }

  function lookup(token: string): (PortalUser & { row: AccountRow }) | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = db
      .prepare(
        `SELECT ${ACCOUNT_COLS}, s.last_seen, s.expires, s.locked AS session_locked, s.last_active FROM portal_sessions s JOIN portal_accounts p ON p.user_id = s.user_id JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token);
    if (!isSessionRow(row)) return null;
    const now = Date.now();
    if (row.expires <= now || now - row.last_seen > IDLE_MS || row.enabled !== 1 || row.locked === 1) {
      db.prepare('DELETE FROM portal_sessions WHERE token = ?').run(token);
      return null;
    }
    db.prepare('UPDATE portal_sessions SET last_seen = ? WHERE token = ?').run(now, token);
    let stage = stageOf(row);
    if (stage === 'ready' && lockStore.overdue(row.last_active, row.lock_minutes)) {
      lockStore.lockSession(token, row.username, 'sunucu');
      stage = 'locked';
    }
    return { userId: row.user_id, username: row.username, stage, row };
  }

  function current(req: FastifyRequest): (PortalUser & { row: AccountRow }) | null {
    const token = req.cookies[PORTAL_COOKIE];
    if (!token) return null;
    return lookup(token);
  }

  function authenticate(req: FastifyRequest): PortalUser | null {
    const u = current(req);
    return u ? { userId: u.userId, username: u.username, stage: u.stage } : null;
  }

  function startSession(reply: FastifyReply, userId: number, secure: boolean): void {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare(
      'INSERT INTO portal_sessions(token, user_id, created, last_seen, expires, last_active, locked) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(token, userId, now, now, now + SESSION_TTL_MS, now);
    reply.setCookie(PORTAL_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure,
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  async function checkPassword(password: string, hash: string): Promise<boolean> {
    if (await verifyPassword(password, hash)) return true;
    const trimmed = password.trim();
    return trimmed !== password && trimmed.length > 0 && (await verifyPassword(trimmed, hash));
  }

  function getAccount(userId: number): AccountRow | undefined {
    const row = db
      .prepare(`SELECT ${ACCOUNT_COLS} FROM portal_accounts p JOIN users u ON u.id = p.user_id WHERE u.id = ?`)
      .get(userId);
    return isAccountRow(row) ? row : undefined;
  }

  function registerRoutes(app: FastifyInstance): void {
    app.get('/papi/status', async (req) => {
      const u = current(req);
      if (!u) return { loggedIn: false };
      const s = readPortalSettings(db);
      return {
        loggedIn: true,
        username: u.username,
        stage: u.stage,
        maxMinutes: s.maxMinutes,
        idleMinutes: s.idleMinutes,
        detachMinutes: s.detachMinutes,
        unreadAdminNotes: unreadAdminNoteCount(db, u.username),
        lock: lockInfo(u.row.lock_minutes, lockStore.maxMinutes()),
      };
    });

    app.post('/papi/login', async (req, reply) => {
      const b = body(req.body);
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const code = typeof b.totp === 'string' ? b.totp.trim() : '';
      const ip = clientIp(req);
      const key = `${ip}|${username}`;
      const attempt = reserveAttempt(key);
      if (attempt === null) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const admin = findAdmin(db, username);
      if (admin) {
        if (!(await checkPassword(password, admin.pass_hash))) {
          audit(admin.username, 'auth.login_failed', `ip=${ip} via=portal`);
          return reply.code(401).send({ error: 'invalid_credentials' });
        }
        if (admin.totp_enabled !== 1) {
          releaseAttempt(key, attempt);
          return reply.code(403).send({ error: 'admin_totp_setup_required' });
        }
        if (!code) {
          releaseAttempt(key, attempt);
          return reply.code(401).send({ error: 'totp_required' });
        }
        if (!consumeTotp(db, 'admin', admin.id, admin.totp_secret, code)) {
          audit(admin.username, 'auth.login_failed', `ip=${ip} via=portal totp`);
          return reply.code(401).send({ error: 'invalid_totp' });
        }
        failures.delete(key);
        createAdminSession(db, reply, admin.id, isHttps(req));
        audit(admin.username, 'auth.login', `ip=${ip} via=portal`);
        return { ok: true, stage: 'admin', redirect: '/admin/' };
      }
      const found = db
        .prepare(`SELECT ${ACCOUNT_COLS} FROM portal_accounts p JOIN users u ON u.id = p.user_id WHERE u.username = ?`)
        .get(username);
      const row = isAccountRow(found) ? found : undefined;
      let ok = false;
      if (row && row.pass_hash) {
        ok = await checkPassword(password, row.pass_hash);
      } else {
        await hashPassword(password);
      }
      if (!row || !ok || row.enabled !== 1 || row.locked === 1) {
        audit(username || '-', 'portal.login_failed', `ip=${ip}`);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      if (row.totp_enabled === 1) {
        if (!code) {
          releaseAttempt(key, attempt);
          return reply.code(401).send({ error: 'totp_required' });
        }
        if (!consumeTotp(db, 'portal', row.user_id, row.totp_secret, code)) {
          audit(row.username, 'portal.login_failed', `ip=${ip} totp`);
          return reply.code(401).send({ error: 'invalid_totp' });
        }
      }
      failures.delete(key);
      db.prepare('UPDATE portal_accounts SET last_login = ? WHERE user_id = ?').run(
        new Date().toISOString(),
        row.user_id,
      );
      startSession(reply, row.user_id, isHttps(req));
      audit(row.username, 'portal.login', `ip=${ip}`);
      return { ok: true, stage: stageOf(row) };
    });

    app.post('/papi/forgot', async (req, reply) => {
      const b = body(req.body);
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
      const code = typeof b.totp === 'string' ? b.totp.trim() : '';
      const ip = clientIp(req);
      const key = `${ip}|${username}`;
      if (recentFailures(key) >= RATE_MAX_FAILURES) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const policy = passwordError(username, b.new);
      if (policy) return reply.code(400).send({ error: policy });
      const found = findAdmin(db, username)
        ? undefined
        : db
            .prepare(`SELECT ${ACCOUNT_COLS} FROM portal_accounts p JOIN users u ON u.id = p.user_id WHERE u.username = ?`)
            .get(username);
      const row = isAccountRow(found) ? found : undefined;
      const valid =
        !!row &&
        row.enabled === 1 &&
        row.locked !== 1 &&
        row.totp_enabled === 1 &&
        !!row.totp_secret &&
        /^\d{6}$/.test(code) &&
        consumeTotp(db, 'portal', row.user_id, row.totp_secret, code);
      if (!row || !valid) {
        addFailure(key);
        audit(username || '-', 'portal.password_reset_failed', `ip=${ip}`);
        return reply.code(401).send({ error: 'invalid_reset' });
      }
      const hash = await hashPassword(b.new as string);
      db.prepare('UPDATE portal_accounts SET pass_hash = ?, must_change = 0 WHERE user_id = ?').run(hash, row.user_id);
      db.prepare('DELETE FROM portal_sessions WHERE user_id = ?').run(row.user_id);
      failures.delete(key);
      audit(row.username, 'portal.password_reset_self', `ip=${ip}`);
      notifyLogout(req, { userId: row.user_id, username: row.username, stage: stageOf(row) });
      return { ok: true };
    });

    app.post('/papi/password', async (req, reply) => {
      const u = current(req);
      if (!u) return reply.code(401).send({ error: 'unauthorized' });
      if (u.stage === 'locked') return reply.code(423).send({ error: 'locked' });
      const b = body(req.body);
      const cur = typeof b.current === 'string' ? b.current : '';
      const key = `${clientIp(req)}|${u.username}`;
      const attempt = reserveAttempt(key);
      if (attempt === null) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      if (!(await verifyPassword(cur, u.row.pass_hash))) {
        return reply.code(400).send({ error: 'invalid_current_password' });
      }
      releaseAttempt(key, attempt);
      const err = passwordError(u.username, b.new);
      if (err) return reply.code(400).send({ error: err });
      const hash = await hashPassword(b.new as string);
      db.prepare('UPDATE portal_accounts SET pass_hash = ?, must_change = 0 WHERE user_id = ?').run(hash, u.userId);
      audit(u.username, 'portal.password_changed');
      const row = getAccount(u.userId);
      return { ok: true, stage: row ? stageOf(row) : 'change_password' };
    });

    app.post('/papi/totp/begin', async (req, reply) => {
      const u = current(req);
      if (!u) return reply.code(401).send({ error: 'unauthorized' });
      if (u.stage !== 'setup_totp') return reply.code(409).send({ error: `stage_${u.stage}` });
      const secret = generateSecret();
      pendingTotp.set(u.userId, { secret, exp: Date.now() + TOTP_SETUP_TTL_MS });
      return { secret, otpauth: otpauthUri('Gate Portal', u.username, secret) };
    });

    app.post('/papi/totp/confirm', async (req, reply) => {
      const u = current(req);
      if (!u) return reply.code(401).send({ error: 'unauthorized' });
      if (u.stage !== 'setup_totp') return reply.code(409).send({ error: `stage_${u.stage}` });
      const b = body(req.body);
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      const pending = pendingTotp.get(u.userId);
      const secret = pending && pending.exp > Date.now() ? pending.secret : null;
      if (!secret) return reply.code(400).send({ error: 'totp_not_started' });
      const counter = matchTotp(secret, code);
      if (counter === null) return reply.code(400).send({ error: 'invalid_totp' });
      db.prepare(
        'UPDATE portal_accounts SET totp_secret = ?, totp_enabled = 1, totp_last_counter = ? WHERE user_id = ?',
      ).run(secret, counter, u.userId);
      pendingTotp.delete(u.userId);
      audit(u.username, 'portal.totp_enabled');
      const row = getAccount(u.userId);
      return { ok: true, stage: row ? stageOf(row) : 'setup_totp' };
    });

    app.post('/papi/logout', async (req, reply) => {
      const u = current(req);
      const token = req.cookies[PORTAL_COOKIE];
      if (token) db.prepare('DELETE FROM portal_sessions WHERE token = ?').run(token);
      reply.clearCookie(PORTAL_COOKIE, { path: '/' });
      if (u) {
        audit(u.username, 'portal.logout');
        notifyLogout(req, u);
      }
      return { ok: true };
    });

    registerLockRoutes(app, {
      base: PORTAL_LOCK_PATHS.base,
      store: lockStore,
      audit,
      limiter: {
        blocked: (key) => recentFailures(key) >= RATE_MAX_FAILURES,
        fail: addFailure,
        clear: (key) => failures.delete(key),
      },
      identify: (req) => {
        const u = current(req);
        const token = req.cookies[PORTAL_COOKIE];
        if (!u || !token) return null;
        const setupStage = u.stage === 'change_password' || u.stage === 'setup_totp' ? u.stage : null;
        return { token, username: u.username, setupStage };
      },
      hash: hashPassword,
      verify: verifyPassword,
    });
  }

  function onLogout(fn: (u: PortalUser) => void): void {
    logoutListeners.push(fn);
  }

  return {
    authenticate,
    registerRoutes,
    onLogout,
    onLocked: lockStore.onLocked,
    frameLocked: lockStore.frameLocked,
    touchActivity: lockStore.touchActivity,
  };
}
