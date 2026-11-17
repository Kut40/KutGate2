import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminInfo } from './types.js';
import type { AuditFn } from './audit.js';
import { generateSecret, matchTotp, otpauthUri } from './totp.js';
import { clientIp, isHttps, isProxied, trustInternalProxy } from './clientip.js';
import { loadConfig } from './config.js';
import { loadInternalToken } from './internal.js';
import { ADMIN_LOCK_PATHS, lockInfo, makeLockStore, registerLockRoutes } from './screenLock.js';
import { readLockMaxMinutes } from './settings.js';

export const SESSION_COOKIE = 'gate_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const MIN_PASSWORD = 10;
const KEYLEN = 64;
export const SESSION_CHECK_MS = 10 * 1000;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEYLEN) return false;
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'));
  return timingSafeEqual(actual, expected);
}

export interface AdminRow {
  id: number;
  username: string;
  pass_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
}

interface SessionRow {
  token: string;
  admin_id: number;
  last_seen: number;
  expires: number;
  username: string;
  locked: number | null;
  last_active: number | null;
  pin_hash: string | null;
  lock_minutes: number | null;
}

/** Yeni yönetici parolasının kuralları; geçerliyse null. */
export function adminPasswordError(username: string, current: string, next: unknown): string | null {
  if (typeof next !== 'string' || next.length < MIN_PASSWORD) return `parola en az ${MIN_PASSWORD} karakter olmalı`;
  if (next === current) return 'yeni parola eskisiyle aynı olamaz';
  if (next.toLowerCase().includes(username.toLowerCase())) return 'parola kullanıcı adını içeremez';
  return null;
}

function body(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function findAdmin(db: DatabaseSync, username: string): AdminRow | undefined {
  return db
    .prepare('SELECT id, username, pass_hash, totp_secret, totp_enabled FROM admins WHERE username = ? COLLATE NOCASE')
    .get(username) as unknown as AdminRow | undefined;
}

/** Vekil üzerinden gelen yönetici girişi TOTP kurulu olmadan oturum açamaz; doğrudan yerel erişim bundan etkilenmez. */
export function proxiedAdminNeedsTotpSetup(proxied: boolean, totpEnabled: number): boolean {
  return proxied && totpEnabled !== 1;
}

const TOTP_ACCOUNTS = {
  admin: { table: 'admins', key: 'id' },
  portal: { table: 'portal_accounts', key: 'user_id' },
} as const;

export type TotpAccountKind = keyof typeof TOTP_ACCOUNTS;

export function consumeTotp(
  db: DatabaseSync,
  kind: TotpAccountKind,
  accountId: number,
  secret: string | null,
  code: string,
  timeMs: number = Date.now(),
): boolean {
  if (!secret) return false;
  const t = TOTP_ACCOUNTS[kind];
  const row = db.prepare(`SELECT totp_last_counter AS last FROM ${t.table} WHERE ${t.key} = ?`).get(accountId) as unknown as
    | { last: number | null }
    | undefined;
  if (!row) return false;
  const counter = matchTotp(secret, code, timeMs, row.last);
  if (counter === null) return false;
  const res = db
    .prepare(
      `UPDATE ${t.table} SET totp_last_counter = ? WHERE ${t.key} = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`,
    )
    .run(counter, accountId, counter);
  return Number(res.changes) === 1;
}

export function adminSessionActive(db: DatabaseSync, token: string, now: number = Date.now()): boolean {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const row = db
    .prepare('SELECT s.expires, s.last_seen FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?')
    .get(token) as unknown as { expires: number; last_seen: number } | undefined;
  return !!row && row.expires > now && now - row.last_seen <= IDLE_MS;
}

export function createAdminSession(db: DatabaseSync, reply: FastifyReply, adminId: number, secure: boolean): void {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, ?, ?, ?, ?, ?, 0)',
  ).run(token, adminId, now, now, now + SESSION_TTL_MS, now);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export interface Auth {
  authenticate(req: FastifyRequest): AdminInfo | null;
  registerRoutes(app: FastifyInstance): void;
  onSessionLocked(fn: (token: string) => void): () => void;
  frameLocked(token: string, username: string): boolean;
  touchActivity(token: string): void;
}

export function makeAuth(
  db: DatabaseSync,
  audit: AuditFn,
  proxyToken: string = loadInternalToken(loadConfig()),
): Auth {
  const trust = trustInternalProxy(proxyToken);
  const failures = new Map<string, number[]>();
  const pendingTotp = new Map<number, string>();
  const lockStore = makeLockStore(db, 'admin', audit, readLockMaxMinutes);

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of failures) {
      const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length) failures.set(k, fresh);
      else failures.delete(k);
    }
    db.prepare('DELETE FROM sessions WHERE expires <= ? OR last_seen <= ?').run(now, now - IDLE_MS);
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

  function lookup(token: string): AdminInfo | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = db
      .prepare(
        'SELECT s.token, s.admin_id, s.last_seen, s.expires, s.locked, s.last_active, a.username, a.pin_hash, a.lock_minutes FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?',
      )
      .get(token) as unknown as SessionRow | undefined;
    if (!row) return null;
    const now = Date.now();
    if (row.expires <= now || now - row.last_seen > IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now, token);
    const pinRequired = row.pin_hash === null;
    let locked = !pinRequired && row.locked === 1;
    if (!pinRequired && !locked && lockStore.overdue(row.last_active, row.lock_minutes)) {
      lockStore.lockSession(token, row.username, 'sunucu');
      locked = true;
    }
    return { id: row.admin_id, username: row.username, locked, pinRequired };
  }

  function authenticate(req: FastifyRequest): AdminInfo | null {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    return lookup(token);
  }

  function startSession(req: FastifyRequest, reply: FastifyReply, adminId: number): void {
    createAdminSession(db, reply, adminId, isHttps(req, trust));
  }

  function adminCount(): number {
    const r = db.prepare('SELECT COUNT(*) AS n FROM admins').get() as unknown as { n: number };
    return r.n;
  }

  function registerRoutes(app: FastifyInstance): void {
    app.get('/api/auth/status', async (req) => {
      const needsSetup = adminCount() === 0;
      const viaProxy = isProxied(req);
      const admin = authenticate(req);
      if (!admin) return { needsSetup, loggedIn: false, viaProxy };
      const row = db.prepare('SELECT totp_enabled, lock_minutes FROM admins WHERE id = ?').get(admin.id) as unknown as
        | { totp_enabled: number; lock_minutes: number | null }
        | undefined;
      return {
        needsSetup,
        loggedIn: true,
        username: admin.username,
        totpEnabled: row?.totp_enabled === 1,
        viaProxy,
        locked: admin.locked,
        pinRequired: admin.pinRequired,
        lock: lockInfo(row?.lock_minutes, lockStore.maxMinutes()),
      };
    });

    app.post('/api/auth/setup', async (req, reply) => {
      if (isProxied(req)) return reply.code(403).send({ error: 'setup_not_allowed_via_proxy' });
      const b = body(req.body);
      const username = b.username;
      const password = b.password;
      if (adminCount() > 0) return reply.code(409).send({ error: 'already_setup' });
      if (typeof username !== 'string' || username.trim() === '') {
        return reply.code(400).send({ error: 'kullanıcı adı gerekli' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return reply.code(400).send({ error: `parola en az ${MIN_PASSWORD} karakter olmalı` });
      }
      const passHash = await hashPassword(password);
      if (adminCount() > 0) return reply.code(409).send({ error: 'already_setup' });
      const name = username.trim();
      const res = db
        .prepare('INSERT INTO admins(username, pass_hash, totp_enabled, created) VALUES (?, ?, 0, ?)')
        .run(name, passHash, new Date().toISOString());
      startSession(req, reply, Number(res.lastInsertRowid));
      audit(name, 'auth.setup');
      return { ok: true };
    });

    app.post('/api/auth/login', async (req, reply) => {
      const b = body(req.body);
      const username = typeof b.username === 'string' ? b.username.trim() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const code = typeof b.totp === 'string' ? b.totp.trim() : '';
      const ip = clientIp(req, trust);
      // findAdmin büyük/küçük harf ayırmaz; sayaç da ayırmamalı, yoksa ad varyantları deneme sınırını aşar.
      const key = `${ip}|${username.toLowerCase()}`;
      const attempt = reserveAttempt(key);
      if (attempt === null) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const row = findAdmin(db, username);
      let ok = false;
      if (row) {
        ok = await verifyPassword(password, row.pass_hash);
      } else {
        await scryptAsync(password, randomBytes(16));
      }
      if (!row || !ok) {
        audit(username || '-', 'auth.login_failed', `ip=${ip}`);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      if (proxiedAdminNeedsTotpSetup(isProxied(req), row.totp_enabled)) {
        releaseAttempt(key, attempt);
        return reply.code(403).send({ error: 'admin_totp_setup_required' });
      }
      if (row.totp_enabled === 1) {
        if (!code) {
          releaseAttempt(key, attempt);
          return reply.code(401).send({ error: 'totp_required' });
        }
        if (!consumeTotp(db, 'admin', row.id, row.totp_secret, code)) {
          audit(row.username, 'auth.login_failed', `ip=${ip} totp`);
          return reply.code(401).send({ error: 'invalid_totp' });
        }
      }
      failures.delete(key);
      startSession(req, reply, row.id);
      audit(row.username, 'auth.login', `ip=${ip}`);
      return { ok: true };
    });

    app.post('/api/auth/logout', async (req, reply) => {
      const admin = authenticate(req);
      const token = req.cookies[SESSION_COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      if (admin) audit(admin.username, 'auth.logout');
      return { ok: true };
    });

    /** Hesap ayarı değişikliklerinde parola denetimi: açık kalmış oturum tek başına yetmesin. */
    async function passwordConfirmed(req: FastifyRequest, reply: FastifyReply, admin: AdminInfo, given: unknown): Promise<AdminRow | null> {
      const ip = clientIp(req, trust);
      const key = `${ip}|${admin.username.toLowerCase()}`;
      if (reserveAttempt(key) === null) {
        reply.code(429).send({ error: 'too_many_attempts' });
        return null;
      }
      const row = findAdmin(db, admin.username);
      if (!row || !(await verifyPassword(typeof given === 'string' ? given : '', row.pass_hash))) {
        audit(admin.username, 'auth.password_check_failed', `ip=${ip}`);
        reply.code(403).send({ error: 'invalid_current_password' });
        return null;
      }
      failures.delete(key);
      return row;
    }

    app.post('/api/auth/password', async (req, reply) => {
      const admin = req.admin;
      if (!admin) return reply.code(401).send({ error: 'unauthorized' });
      const b = body(req.body);
      const row = await passwordConfirmed(req, reply, admin, b.current);
      if (!row) return reply;
      const err = adminPasswordError(admin.username, b.current as string, b.new);
      if (err) return reply.code(400).send({ error: err });
      const hash = await hashPassword(b.new as string);
      db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hash, admin.id);
      // Parola değişince bu tarayıcı dışındaki oturumlar kapanır.
      const closed = db
        .prepare('DELETE FROM sessions WHERE admin_id = ? AND token <> ?')
        .run(admin.id, req.cookies[SESSION_COOKIE] ?? '');
      audit(admin.username, 'auth.password_changed', `kapanan_oturum=${Number(closed.changes)}`);
      return { ok: true };
    });

    app.post('/api/auth/totp/begin', async (req, reply) => {
      const admin = req.admin;
      if (!admin) return reply.code(401).send({ error: 'unauthorized' });
      if (!(await passwordConfirmed(req, reply, admin, body(req.body).password))) return reply;
      const secret = generateSecret();
      pendingTotp.set(admin.id, secret);
      return { secret, otpauth: otpauthUri('Gate', admin.username, secret) };
    });

    app.post('/api/auth/totp/confirm', async (req, reply) => {
      const admin = req.admin;
      if (!admin) return reply.code(401).send({ error: 'unauthorized' });
      const b = body(req.body);
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      const secret = pendingTotp.get(admin.id);
      if (!secret) return reply.code(400).send({ error: 'totp_not_started' });
      const counter = matchTotp(secret, code);
      if (counter === null) return reply.code(400).send({ error: 'invalid_totp' });
      db.prepare('UPDATE admins SET totp_secret = ?, totp_enabled = 1, totp_last_counter = ? WHERE id = ?').run(
        secret,
        counter,
        admin.id,
      );
      pendingTotp.delete(admin.id);
      audit(admin.username, 'auth.totp_enabled');
      return { ok: true };
    });

    registerLockRoutes(app, {
      base: ADMIN_LOCK_PATHS.base,
      store: lockStore,
      audit,
      limiter: {
        blocked: (key) => recentFailures(key) >= RATE_MAX_FAILURES,
        fail: addFailure,
        clear: (key) => failures.delete(key),
      },
      identify: (req) => {
        const token = req.cookies[SESSION_COOKIE];
        const admin = token ? lookup(token) : null;
        return token && admin ? { token, username: admin.username, setupStage: null } : null;
      },
      hash: hashPassword,
      verify: verifyPassword,
      trust,
    });
  }

  return {
    authenticate,
    registerRoutes,
    onSessionLocked: lockStore.onLocked,
    frameLocked: lockStore.frameLocked,
    touchActivity: lockStore.touchActivity,
  };
}
