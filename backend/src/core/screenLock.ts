import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditFn } from './audit.js';
import { clientIp, type ProxyTrust } from './clientip.js';

export const PIN_RE = /^[0-9]{4}$/;
export const LOCK_OPTIONS: readonly number[] = [1, 2, 3, 5, 10, 15, 30, 60];
export const DEFAULT_LOCK_MINUTES = 5;
export const DEFAULT_LOCK_MAX_MINUTES = 15;
export const LOCK_WARNING_SECONDS = 30;
export const SERVER_LOCK_GRACE_MS = 60 * 1000;
export const ACTIVITY_WRITE_INTERVAL_MS = 30 * 1000;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 10 * 60 * 1000;
export const LOCK_CLOSE_CODE = 4001;
export const LOCK_CLOSE_REASON = 'locked';

export type LockReason = 'bosta' | 'elle' | 'sunucu';

export function isLockOption(v: unknown): v is number {
  return typeof v === 'number' && LOCK_OPTIONS.includes(v);
}

/** Biçimi tutmayan, tek rakam tekrarlı ya da artan/azalan sıralı PIN zayıf sayılır. */
export function isWeakPin(pin: unknown): boolean {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  return [0, 1, -1].some((step) => steps.every((s) => s === step));
}

/** Kullanıcının seçimi yönetici sınırına çekilir; geçersiz değerlerde varsayılanlar geçerlidir. */
export function effectiveMinutes(chosen: unknown, max: unknown): number {
  const c = isLockOption(chosen) ? chosen : DEFAULT_LOCK_MINUTES;
  const m = isLockOption(max) ? max : DEFAULT_LOCK_MAX_MINUTES;
  return Math.min(c, m);
}

/** Son etkinlik kaydı olmayan oturum kilitlenir (fail-closed). */
export function shouldServerLock(now: number, lastActive: number | null | undefined, minutes: number): boolean {
  if (lastActive === null || lastActive === undefined) return true;
  return now - lastActive > minutes * 60 * 1000 + SERVER_LOCK_GRACE_MS;
}

export function activityWriteDue(now: number, lastActive: number | null | undefined): boolean {
  if (lastActive === null || lastActive === undefined) return true;
  return now - lastActive >= ACTIVITY_WRITE_INTERVAL_MS;
}

export interface PinFailureUpdate {
  failures: number;
  lockedUntil: number | null;
  remaining: number;
  locked: boolean;
}

export function pinFailureUpdate(failures: number | null | undefined, now: number): PinFailureUpdate {
  const next = (typeof failures === 'number' && failures > 0 ? failures : 0) + 1;
  if (next >= PIN_MAX_FAILURES) return { failures: 0, lockedUntil: now + PIN_LOCK_MS, remaining: 0, locked: true };
  return { failures: next, lockedUntil: null, remaining: PIN_MAX_FAILURES - next, locked: false };
}

export function pinLockSeconds(now: number, lockedUntil: number | null | undefined): number {
  if (lockedUntil === null || lockedUntil === undefined || lockedUntil <= now) return 0;
  return Math.ceil((lockedUntil - now) / 1000);
}

export interface LockInfo {
  minutes: number;
  maxMinutes: number;
  options: number[];
  warningSeconds: number;
}

export function lockInfo(chosen: unknown, max: number): LockInfo {
  return {
    minutes: effectiveMinutes(chosen, max),
    maxMinutes: max,
    options: [...LOCK_OPTIONS],
    warningSeconds: LOCK_WARNING_SECONDS,
  };
}

export interface LockPaths {
  base: string;
  logout: string;
}

export const PORTAL_LOCK_PATHS: LockPaths = { base: '/papi', logout: '/papi/logout' };
export const ADMIN_LOCK_PATHS: LockPaths = { base: '/api/auth', logout: '/api/auth/logout' };

/** Kimliği doğrulanmış istekte kilit kapısı; geçilebiliyorsa null. Açık uçlar bu kapıya gelmeden döner. */
export function lockGate(
  state: { locked: boolean; pinRequired: boolean },
  method: string,
  route: string,
  paths: LockPaths,
): { code: number; body: { error: string } } | null {
  const post = method === 'POST';
  const logout = post && route === paths.logout;
  if (state.pinRequired) {
    if (logout || (post && route === `${paths.base}/pin`)) return null;
    return { code: 428, body: { error: 'setup_pin' } };
  }
  if (state.locked) {
    if (logout || (post && (route === `${paths.base}/lock/unlock` || route === `${paths.base}/lock/activity`))) {
      return null;
    }
    return { code: 423, body: { error: 'locked' } };
  }
  return null;
}

/** Portal soket karesinde aşamaya göre kapanış; `ready` için null. */
export function frameCloseFor(stage: string | null | undefined): { code: number; reason: string } | null {
  if (stage === 'ready') return null;
  if (stage === 'locked') return { code: LOCK_CLOSE_CODE, reason: LOCK_CLOSE_REASON };
  return { code: 1008, reason: 'unauthorized' };
}

export type LockKind = 'portal' | 'admin';

/** Tablo ve sütun adları yalnızca bu sabit eşlemeden gelir. */
const LOCK_TABLES = {
  portal: {
    accounts: 'portal_accounts',
    accountKey: 'user_id',
    sessions: 'portal_sessions',
    sessionKey: 'user_id',
    audit: 'portal',
  },
  admin: { accounts: 'admins', accountKey: 'id', sessions: 'sessions', sessionKey: 'admin_id', audit: 'auth' },
} as const;

export interface LockActor {
  accountId: number;
  locked: boolean;
  lastActive: number | null;
  passHash: string | null;
  pinHash: string | null;
  pinLockedUntil: number | null;
  lockMinutes: number | null;
}

interface ActorRow {
  account_id: number;
  locked: number | null;
  last_active: number | null;
  pass_hash: string | null;
  pin_hash: string | null;
  pin_locked_until: number | null;
  lock_minutes: number | null;
}

export interface LockStore {
  readonly auditPrefix: string;
  maxMinutes(): number;
  actor(token: string): LockActor | null;
  overdue(lastActive: number | null | undefined, lockMinutes: unknown): boolean;
  lockSession(token: string, username: string, reason: LockReason): boolean;
  unlockSession(token: string, accountId: number): void;
  setPin(accountId: number, pinHash: string, token: string): void;
  setMinutes(accountId: number, minutes: number): void;
  recordPinFailure(accountId: number): PinFailureUpdate;
  markActive(token: string): void;
  touchActivity(token: string): void;
  frameLocked(token: string, username: string): boolean;
  onLocked(fn: (token: string) => void): () => void;
}

export function makeLockStore(
  db: DatabaseSync,
  kind: LockKind,
  audit: AuditFn,
  readMaxMinutes: (db: DatabaseSync) => number,
): LockStore {
  const t = LOCK_TABLES[kind];
  const listeners = new Set<(token: string) => void>();

  const selectActor = db.prepare(
    `SELECT a.${t.accountKey} AS account_id, s.locked, s.last_active, a.pass_hash, a.pin_hash, a.pin_locked_until, a.lock_minutes FROM ${t.sessions} s JOIN ${t.accounts} a ON a.${t.accountKey} = s.${t.sessionKey} WHERE s.token = ?`,
  );
  const lockStmt = db.prepare(`UPDATE ${t.sessions} SET locked = 1 WHERE token = ? AND COALESCE(locked, 0) = 0`);
  const unlockStmt = db.prepare(`UPDATE ${t.sessions} SET locked = 0, last_active = ? WHERE token = ?`);
  const activeStmt = db.prepare(
    `UPDATE ${t.sessions} SET last_active = ? WHERE token = ? AND COALESCE(locked, 0) = 0`,
  );
  const selectActivity = db.prepare(`SELECT locked, last_active FROM ${t.sessions} WHERE token = ?`);
  const clearFailures = db.prepare(
    `UPDATE ${t.accounts} SET pin_failures = 0, pin_locked_until = NULL WHERE ${t.accountKey} = ?`,
  );
  const setPinStmt = db.prepare(
    `UPDATE ${t.accounts} SET pin_hash = ?, pin_failures = 0, pin_locked_until = NULL WHERE ${t.accountKey} = ?`,
  );
  const setMinutesStmt = db.prepare(`UPDATE ${t.accounts} SET lock_minutes = ? WHERE ${t.accountKey} = ?`);
  const selectFailures = db.prepare(`SELECT pin_failures FROM ${t.accounts} WHERE ${t.accountKey} = ?`);
  const updateFailures = db.prepare(
    `UPDATE ${t.accounts} SET pin_failures = ?, pin_locked_until = COALESCE(?, pin_locked_until) WHERE ${t.accountKey} = ?`,
  );

  function maxMinutes(): number {
    return readMaxMinutes(db);
  }

  function overdue(lastActive: number | null | undefined, lockMinutes: unknown): boolean {
    return shouldServerLock(Date.now(), lastActive, effectiveMinutes(lockMinutes, maxMinutes()));
  }

  function actor(token: string): LockActor | null {
    const r = selectActor.get(token) as unknown as ActorRow | undefined;
    if (!r) return null;
    return {
      accountId: r.account_id,
      locked: r.locked === 1,
      lastActive: r.last_active,
      passHash: r.pass_hash,
      pinHash: r.pin_hash,
      pinLockedUntil: r.pin_locked_until,
      lockMinutes: r.lock_minutes,
    };
  }

  function lockSession(token: string, username: string, reason: LockReason): boolean {
    if (Number(lockStmt.run(token).changes) === 0) return false;
    audit(username, `${t.audit}.lock`, `neden=${reason}`);
    for (const fn of listeners) {
      try {
        fn(token);
      } catch (err) {
        console.error('kilit kancası başarısız', err);
      }
    }
    return true;
  }

  function unlockSession(token: string, accountId: number): void {
    clearFailures.run(accountId);
    unlockStmt.run(Date.now(), token);
  }

  function setPin(accountId: number, pinHash: string, token: string): void {
    setPinStmt.run(pinHash, accountId);
    activeStmt.run(Date.now(), token);
  }

  function setMinutes(accountId: number, minutes: number): void {
    setMinutesStmt.run(minutes, accountId);
  }

  /** Okuma ve yazma aynı yazma işleminde: iki süreçten gelen deneme de sayacı atlatamaz. */
  function recordPinFailure(accountId: number): PinFailureUpdate {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = selectFailures.get(accountId) as unknown as { pin_failures: number | null } | undefined;
      const update = pinFailureUpdate(row?.pin_failures, Date.now());
      updateFailures.run(update.failures, update.lockedUntil, accountId);
      db.exec('COMMIT');
      return update;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function markActive(token: string): void {
    activeStmt.run(Date.now(), token);
  }

  function touchActivity(token: string): void {
    const r = selectActivity.get(token) as unknown as { locked: number | null; last_active: number | null } | undefined;
    if (!r || r.locked === 1) return;
    const now = Date.now();
    if (activityWriteDue(now, r.last_active)) activeStmt.run(now, token);
  }

  /** Her soket karesinde çağrılır: süresi geçmiş oturum burada kilitlenir, girdi etkinlik sayılıp kilidi ertelemez. */
  function frameLocked(token: string, username: string): boolean {
    const a = actor(token);
    if (!a) return true;
    if (a.locked) return true;
    if (a.pinHash === null || !overdue(a.lastActive, a.lockMinutes)) return false;
    lockSession(token, username, 'sunucu');
    return true;
  }

  function onLocked(fn: (token: string) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    auditPrefix: t.audit,
    maxMinutes,
    actor,
    overdue,
    lockSession,
    unlockSession,
    setPin,
    setMinutes,
    recordPinFailure,
    markActive,
    touchActivity,
    frameLocked,
    onLocked,
  };
}

export interface LockIdentity {
  token: string;
  username: string;
  /** Kilit uçlarının çalışmayacağı kurulum aşaması (`change_password`, `setup_totp`); yoksa null. */
  setupStage: string | null;
}

export interface FailureLimiter {
  blocked(key: string): boolean;
  fail(key: string): void;
  clear(key: string): void;
}

export interface LockRouteDeps {
  base: string;
  store: LockStore;
  limiter: FailureLimiter;
  audit: AuditFn;
  identify(req: FastifyRequest): LockIdentity | null;
  hash(secret: string): Promise<string>;
  verify(secret: string, stored: string): Promise<boolean>;
  trust?: ProxyTrust;
}

function bodyOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Portal ve admin aynı uçları buradan kaydeder. */
export function registerLockRoutes(app: FastifyInstance, deps: LockRouteDeps): void {
  const { base, store, limiter, identify, hash, verify } = deps;
  const ipOf = (req: FastifyRequest): string => clientIp(req, deps.trust);

  function audit(username: string, action: string, detail?: string): void {
    deps.audit(username, `${store.auditPrefix}.${action}`, detail);
  }

  function resolve(req: FastifyRequest, reply: FastifyReply): { who: LockIdentity; actor: LockActor } | null {
    const who = identify(req);
    const actor = who ? store.actor(who.token) : null;
    if (!who || !actor) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    return { who, actor };
  }

  /** Kurulumu bitmemiş, PIN'siz ya da kilitli oturumda yanıtı yazıp true döner. */
  function refused(reply: FastifyReply, who: LockIdentity, actor: LockActor): boolean {
    if (who.setupStage) {
      reply.code(409).send({ error: `stage_${who.setupStage}` });
      return true;
    }
    if (actor.pinHash === null) {
      reply.code(428).send({ error: 'setup_pin' });
      return true;
    }
    if (actor.locked) {
      reply.code(423).send({ error: 'locked' });
      return true;
    }
    return false;
  }

  app.post(`${base}/pin`, async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return reply;
    const { who, actor } = r;
    if (who.setupStage) return reply.code(409).send({ error: `stage_${who.setupStage}` });
    if (actor.locked) return reply.code(423).send({ error: 'locked' });
    const b = bodyOf(req.body);
    const key = `${ipOf(req)}|${who.username.toLowerCase()}`;
    if (limiter.blocked(key)) return reply.code(429).send({ error: 'too_many_attempts' });
    const password = typeof b.password === 'string' ? b.password : '';
    if (!(await verify(password, actor.passHash ?? ''))) {
      limiter.fail(key);
      return reply.code(403).send({ error: 'invalid_current_password' });
    }
    if (isWeakPin(b.pin)) return reply.code(400).send({ error: 'pin_weak' });
    store.setPin(actor.accountId, await hash(b.pin as string), who.token);
    // Eski PIN'in hatalı denemeleri yeni PIN'i engellemesin.
    limiter.clear(`pin|${ipOf(req)}|${who.username.toLowerCase()}`);
    audit(who.username, 'pin_set');
    return { ok: true };
  });

  app.post(`${base}/lock/now`, async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return reply;
    if (refused(reply, r.who, r.actor)) return reply;
    const reason: LockReason = bodyOf(req.body).reason === 'elle' ? 'elle' : 'bosta';
    store.lockSession(r.who.token, r.who.username, reason);
    return { locked: true };
  });

  app.post(`${base}/lock/unlock`, async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return reply;
    const { who, actor } = r;
    if (who.setupStage) return reply.code(409).send({ error: `stage_${who.setupStage}` });
    if (actor.pinHash === null) return reply.code(428).send({ error: 'setup_pin' });
    if (!actor.locked) return { ok: true };
    const pin = bodyOf(req.body).pin;
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) return reply.code(400).send({ error: 'pin_format' });
    const seconds = pinLockSeconds(Date.now(), actor.pinLockedUntil);
    if (seconds > 0) return reply.code(423).send({ error: 'pin_locked', seconds });
    const ip = ipOf(req);
    // Giriş sınırıyla aynı pencere ve eşik; ayrı anahtar, PIN'i unutan kullanıcının parolayla girişini kapatmaz.
    const key = `pin|${ip}|${who.username.toLowerCase()}`;
    if (limiter.blocked(key)) return reply.code(429).send({ error: 'too_many_attempts' });
    const match = await verify(pin, actor.pinHash);
    // Aynı anda gönderilen denemeler bekleme sırasında hesabı kilitlemiş olabilir; doğru PIN de bu kilidi aşamaz.
    const fresh = store.actor(who.token);
    if (!fresh) return reply.code(401).send({ error: 'unauthorized' });
    const lateSeconds = pinLockSeconds(Date.now(), fresh.pinLockedUntil);
    if (lateSeconds > 0) return reply.code(423).send({ error: 'pin_locked', seconds: lateSeconds });
    if (!match) {
      limiter.fail(key);
      const update = store.recordPinFailure(actor.accountId);
      audit(who.username, 'unlock_failed', `ip=${ip}`);
      if (update.locked) {
        return reply.code(423).send({ error: 'pin_locked', seconds: pinLockSeconds(Date.now(), update.lockedUntil) });
      }
      return reply.code(403).send({ error: 'pin_invalid', remaining: update.remaining });
    }
    limiter.clear(key);
    store.unlockSession(who.token, actor.accountId);
    audit(who.username, 'unlock', `ip=${ip}`);
    return { ok: true };
  });

  app.post(`${base}/lock/activity`, async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return reply;
    if (r.actor.locked) return reply.code(423).send({ ok: false, locked: true });
    store.markActive(r.who.token);
    return { ok: true, idleSeconds: effectiveMinutes(r.actor.lockMinutes, store.maxMinutes()) * 60 };
  });

  app.put(`${base}/lock/minutes`, async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return reply;
    if (refused(reply, r.who, r.actor)) return reply;
    const minutes = bodyOf(req.body).minutes;
    if (!isLockOption(minutes) || minutes > store.maxMinutes()) {
      return reply.code(400).send({ error: 'minutes_invalid' });
    }
    store.setMinutes(r.actor.accountId, minutes);
    audit(r.who.username, 'lock_minutes', `minutes=${minutes}`);
    return { minutes };
  });
}
