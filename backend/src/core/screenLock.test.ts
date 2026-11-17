import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { makeAudit } from './audit.js';
import { openDb } from './db.js';
import {
  ADMIN_LOCK_PATHS,
  activityWriteDue,
  effectiveMinutes,
  frameCloseFor,
  isLockOption,
  isWeakPin,
  LOCK_OPTIONS,
  lockGate,
  lockInfo,
  makeLockStore,
  PIN_LOCK_MS,
  PIN_RE,
  pinFailureUpdate,
  pinLockSeconds,
  PORTAL_LOCK_PATHS,
  registerLockRoutes,
  shouldServerLock,
} from './screenLock.js';
import { readLockMaxMinutes, writeLockMaxMinutes } from './settings.js';
import type { ProxyTrust } from './clientip.js';
import type { Config } from './types.js';

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = 1_800_000_000_000;

test('PIN biçimi: yalnızca 4 rakam', () => {
  assert.ok(PIN_RE.test('1905'));
  for (const bad of ['123', '12345', '190537', '12a4', '', ' 1905', '1905\n']) assert.equal(PIN_RE.test(bad), false, bad);
});

test('zayıf PIN: sıralı, tek rakam tekrarı ve biçimsiz değerler', () => {
  for (const weak of ['1234', '4321', '0123', '3210', '6789', '9876', '0000', '7777']) {
    assert.equal(isWeakPin(weak), true, weak);
  }
  for (const bad of ['123', '190537', 'abcd', '', null, undefined, 1905]) assert.equal(isWeakPin(bad), true, String(bad));
  for (const ok of ['1905', '1122', '1235', '1212', '8901']) assert.equal(isWeakPin(ok), false, ok);
});

test('süre seçenekleri sözleşmeyle aynıdır, kapalı seçeneği yoktur', () => {
  assert.deepEqual([...LOCK_OPTIONS], [1, 2, 3, 5, 10, 15, 30, 60]);
  for (const bad of [0, 4, 61, -1, 1.5, '5', null]) assert.equal(isLockOption(bad), false, String(bad));
});

test('etkin süre: seçim sınıra çekilir, geçersiz değerde varsayılan', () => {
  assert.equal(effectiveMinutes(10, 15), 10);
  assert.equal(effectiveMinutes(30, 15), 15);
  assert.equal(effectiveMinutes(15, 15), 15);
  assert.equal(effectiveMinutes(null, 15), 5);
  assert.equal(effectiveMinutes(null, 3), 3);
  assert.equal(effectiveMinutes(7, 15), 5);
  assert.equal(effectiveMinutes(60, 99), 15);
});

test('yedek kilit: süre + 60 sn aşılınca, sınırda değil', () => {
  const limit = 5 * 60 * 1000 + 60 * 1000;
  assert.equal(shouldServerLock(NOW, NOW - limit, 5), false);
  assert.equal(shouldServerLock(NOW, NOW - limit - 1, 5), true);
  assert.equal(shouldServerLock(NOW, NOW, 1), false);
});

test('yedek kilit: etkinlik kaydı olmayan oturum kilitlenir', () => {
  assert.equal(shouldServerLock(NOW, null, 60), true);
  assert.equal(shouldServerLock(NOW, undefined, 60), true);
});

test('etkinlik yazımı 30 sn ile sınırlıdır', () => {
  assert.equal(activityWriteDue(NOW, NOW - 29_999), false);
  assert.equal(activityWriteDue(NOW, NOW - 30_000), true);
  assert.equal(activityWriteDue(NOW, null), true);
});

test('PIN hatası: 5. hatada 10 dk kilit ve sayaç sıfırı', () => {
  assert.deepEqual(pinFailureUpdate(0, NOW), { failures: 1, lockedUntil: null, remaining: 4, locked: false });
  assert.deepEqual(pinFailureUpdate(null, NOW), { failures: 1, lockedUntil: null, remaining: 4, locked: false });
  assert.deepEqual(pinFailureUpdate(3, NOW), { failures: 4, lockedUntil: null, remaining: 1, locked: false });
  assert.deepEqual(pinFailureUpdate(4, NOW), { failures: 0, lockedUntil: NOW + PIN_LOCK_MS, remaining: 0, locked: true });
  assert.equal(PIN_LOCK_MS, 600_000);
});

test('PIN kilidi kalan süresi', () => {
  assert.equal(pinLockSeconds(NOW, null), 0);
  assert.equal(pinLockSeconds(NOW, NOW), 0);
  assert.equal(pinLockSeconds(NOW, NOW + 1), 1);
  assert.equal(pinLockSeconds(NOW, NOW + 600_000), 600);
});

test('durum yanıtının kilit alanı', () => {
  assert.deepEqual(lockInfo(30, 15), {
    minutes: 15,
    maxMinutes: 15,
    options: [1, 2, 3, 5, 10, 15, 30, 60],
    warningSeconds: 30,
  });
});

test('soket karesi kapanışı: kilitli 4001, diğerleri 1008, hazırda yok', () => {
  assert.deepEqual(frameCloseFor('locked'), { code: 4001, reason: 'locked' });
  for (const s of ['change_password', 'setup_totp', 'setup_pin', null, undefined]) {
    assert.deepEqual(frameCloseFor(s), { code: 1008, reason: 'unauthorized' }, String(s));
  }
  assert.equal(frameCloseFor('ready'), null);
});

test('kilit kapısı: kilitliyken yalnızca açma, etkinlik ve çıkış', () => {
  const locked = { locked: true, pinRequired: false };
  for (const paths of [PORTAL_LOCK_PATHS, ADMIN_LOCK_PATHS]) {
    assert.equal(lockGate(locked, 'POST', `${paths.base}/lock/unlock`, paths), null);
    assert.equal(lockGate(locked, 'POST', `${paths.base}/lock/activity`, paths), null);
    assert.equal(lockGate(locked, 'POST', paths.logout, paths), null);
    for (const [m, r] of [
      ['POST', `${paths.base}/pin`],
      ['POST', `${paths.base}/lock/now`],
      ['PUT', `${paths.base}/lock/minutes`],
      ['DELETE', `${paths.base}/lock/unlock`],
      ['DELETE', paths.logout],
      ['POST', `${paths.base}/totp/begin`],
      ['POST', `${paths.base}/password`],
      ['GET', '/api/users'],
      ['GET', '/papi/terminal'],
      ['GET', ''],
    ]) {
      assert.deepEqual(lockGate(locked, m, r, paths), { code: 423, body: { error: 'locked' } }, `${m} ${r}`);
    }
  }
});

test('kilit kapısı: PIN yokken yalnızca PIN belirleme ve çıkış, 428 önceliklidir', () => {
  const noPin = { locked: true, pinRequired: true };
  const p = ADMIN_LOCK_PATHS;
  assert.equal(lockGate(noPin, 'POST', '/api/auth/pin', p), null);
  assert.equal(lockGate(noPin, 'POST', '/api/auth/logout', p), null);
  for (const r of ['/api/auth/totp/begin', '/api/auth/lock/unlock', '/api/users']) {
    assert.deepEqual(lockGate(noPin, 'POST', r, p), { code: 428, body: { error: 'setup_pin' } }, r);
  }
  assert.equal(lockGate({ locked: false, pinRequired: false }, 'GET', '/api/users', p), null);
});

function withDb(fn: (db: DatabaseSync) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-lock-test-'));
    const db = openDb({ dataDir: dir } as Config);
    try {
      await fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedAdmin(db: DatabaseSync, pinHash: string | null): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO admins(id, username, pass_hash, totp_enabled, created, pin_hash) VALUES (1, 'ali', 'h:parola1234', 1, '', ?)",
  ).run(pinHash);
  const ins = db.prepare(
    'INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, 1, ?, ?, ?, ?, 0)',
  );
  ins.run(TOKEN, now, now, now + 60_000, now);
  ins.run(OTHER, now, now, now + 60_000, now);
}

function adminStore(db: DatabaseSync) {
  return makeLockStore(db, 'admin', makeAudit(db), readLockMaxMinutes);
}

function sessionRow(db: DatabaseSync, token: string): { locked: number; last_active: number } {
  return db.prepare('SELECT locked, last_active FROM sessions WHERE token = ?').get(token) as unknown as {
    locked: number;
    last_active: number;
  };
}

function auditRows(db: DatabaseSync): { action: string; detail: string | null }[] {
  const rows = db.prepare('SELECT action, detail FROM audit ORDER BY id').all() as unknown as {
    action: string;
    detail: string | null;
  }[];
  return rows.map((r) => ({ action: r.action, detail: r.detail }));
}

test(
  'şema: alanlar eklenir, üst sınır varsayılanı 15, yeniden açılış zarar vermez',
  withDb((db) => {
    for (const table of ['portal_accounts', 'admins']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
      for (const c of ['pin_hash', 'pin_failures', 'pin_locked_until', 'lock_minutes']) assert.ok(cols.includes(c), `${table}.${c}`);
    }
    for (const table of ['portal_sessions', 'sessions']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
      for (const c of ['locked', 'last_active']) assert.ok(cols.includes(c), `${table}.${c}`);
    }
    assert.equal(readLockMaxMinutes(db), 15);
    writeLockMaxMinutes(db, 30);
    assert.equal(readLockMaxMinutes(db), 30);
    db.prepare("UPDATE settings SET value = '7' WHERE key = 'lock.maxMinutes'").run();
    assert.equal(readLockMaxMinutes(db), 15);
  }),
);

test(
  'kilit yalnızca o oturumu etkiler, yayın ve denetim bir kez olur',
  withDb((db) => {
    seedAdmin(db, 'h:1905');
    const store = adminStore(db);
    const seen: string[] = [];
    const off = store.onLocked((t) => seen.push(t));
    assert.equal(store.lockSession(TOKEN, 'ali', 'elle'), true);
    assert.equal(store.lockSession(TOKEN, 'ali', 'elle'), false);
    assert.deepEqual(seen, [TOKEN]);
    assert.equal(sessionRow(db, TOKEN).locked, 1);
    assert.equal(sessionRow(db, OTHER).locked, 0);
    const locks = auditRows(db).filter((r) => r.action === 'auth.lock');
    assert.deepEqual(locks, [{ action: 'auth.lock', detail: 'neden=elle' }]);
    off();
    store.lockSession(OTHER, 'ali', 'bosta');
    assert.deepEqual(seen, [TOKEN]);
  }),
);

test(
  'kare denetimi: süresi geçen oturum kilitlenir, girdi kilidi ertelemez',
  withDb((db) => {
    seedAdmin(db, 'h:1905');
    const store = adminStore(db);
    const seen: string[] = [];
    store.onLocked((t) => seen.push(t));
    assert.equal(store.frameLocked(TOKEN, 'ali'), false);
    const old = Date.now() - 6 * 60 * 1000 - 1000;
    db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?').run(old, TOKEN);
    assert.equal(store.frameLocked(TOKEN, 'ali'), true);
    assert.deepEqual(seen, [TOKEN]);
    store.touchActivity(TOKEN);
    assert.equal(sessionRow(db, TOKEN).last_active, old);
    assert.deepEqual(auditRows(db).at(-1), { action: 'auth.lock', detail: 'neden=sunucu' });
  }),
);

test(
  'kare denetimi: oturum satırı yoksa ya da silindiyse kilitli sayılır',
  withDb((db) => {
    seedAdmin(db, 'h:1905');
    const store = adminStore(db);
    assert.equal(store.frameLocked('c'.repeat(64), 'ali'), true);
    assert.equal(store.frameLocked(OTHER, 'ali'), false);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(OTHER);
    assert.equal(store.frameLocked(OTHER, 'ali'), true);
  }),
);

test(
  'kare denetimi: PIN yoksa kilit kurulmaz',
  withDb((db) => {
    seedAdmin(db, null);
    const store = adminStore(db);
    db.prepare('UPDATE sessions SET last_active = 1').run();
    assert.equal(store.frameLocked(TOKEN, 'ali'), false);
    assert.equal(sessionRow(db, TOKEN).locked, 0);
  }),
);

test(
  'etkinlik yazımı 30 sn ile sınırlı, güncel kayda dokunmaz',
  withDb((db) => {
    seedAdmin(db, 'h:1905');
    const store = adminStore(db);
    const recent = Date.now() - 10_000;
    db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?').run(recent, TOKEN);
    store.touchActivity(TOKEN);
    assert.equal(sessionRow(db, TOKEN).last_active, recent);
    const stale = Date.now() - 31_000;
    db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?').run(stale, TOKEN);
    store.touchActivity(TOKEN);
    assert.ok(sessionRow(db, TOKEN).last_active > stale);
    store.touchActivity('c'.repeat(64));
  }),
);

test(
  'portal tabloları aynı işlemlerle çalışır, üst sınır etkin süreyi kısar',
  withDb((db) => {
    const now = Date.now();
    db.prepare("INSERT INTO users(id, username, display, locked, created) VALUES (7, 'veli', '', 0, '')").run();
    db.prepare("INSERT INTO portal_accounts(user_id, pass_hash, must_change, totp_enabled, enabled, pin_hash, lock_minutes) VALUES (7, 'x', 0, 1, 1, 'h:1905', 60)").run();
    db.prepare(
      'INSERT INTO portal_sessions(token, user_id, created, last_seen, expires, last_active, locked) VALUES (?, 7, ?, ?, ?, ?, 0)',
    ).run(TOKEN, now, now, now + 60_000, now - 20 * 60 * 1000);
    const store = makeLockStore(db, 'portal', makeAudit(db), readLockMaxMinutes);
    assert.equal(store.actor(TOKEN)?.accountId, 7);
    assert.equal(store.frameLocked(TOKEN, 'veli'), true);
    assert.deepEqual(auditRows(db).at(-1), { action: 'portal.lock', detail: 'neden=sunucu' });
    for (let i = 0; i < 4; i++) assert.equal(store.recordPinFailure(7).locked, false);
    assert.equal(store.recordPinFailure(7).locked, true);
    const row = db.prepare('SELECT pin_failures, pin_locked_until FROM portal_accounts WHERE user_id = 7').get() as unknown as {
      pin_failures: number;
      pin_locked_until: number;
    };
    assert.equal(row.pin_failures, 0);
    assert.ok(row.pin_locked_until > now);
  }),
);

async function routes(db: DatabaseSync, onVerify?: () => void, trust?: ProxyTrust) {
  const store = adminStore(db);
  const counts = new Map<string, number>();
  const app = Fastify();
  registerLockRoutes(app, {
    base: '/t',
    store,
    audit: makeAudit(db),
    limiter: {
      blocked: (k) => (counts.get(k) ?? 0) >= 5,
      fail: (k) => counts.set(k, (counts.get(k) ?? 0) + 1),
      clear: (k) => counts.delete(k),
    },
    identify: () => ({ token: TOKEN, username: 'ali', setupStage: null }),
    hash: async (s) => `h:${s}`,
    verify: async (s, h) => {
      onVerify?.();
      return h === `h:${s}`;
    },
    trust,
  });
  await app.ready();
  const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, payload });
  return { app, store, counts, post };
}

test(
  'PIN belirleme: parola zorunlu, zayıf PIN reddedilir, sayaç sıfırlanır, PIN denetime yazılmaz',
  withDb(async (db) => {
    seedAdmin(db, null);
    db.prepare('UPDATE admins SET pin_failures = 3, pin_locked_until = 99 WHERE id = 1').run();
    db.prepare('UPDATE sessions SET last_active = 1 WHERE token = ?').run(TOKEN);
    const { app, post } = await routes(db);
    const wrong = await post('/t/pin', { password: 'yanlis', pin: '1905' });
    assert.equal(wrong.statusCode, 403);
    assert.deepEqual(wrong.json(), { error: 'invalid_current_password' });
    for (const pin of ['1234', '1111', '190537', 1905]) {
      const r = await post('/t/pin', { password: 'parola1234', pin });
      assert.equal(r.statusCode, 400, String(pin));
      assert.deepEqual(r.json(), { error: 'pin_weak' });
    }
    const ok = await post('/t/pin', { password: 'parola1234', pin: '1905' });
    assert.deepEqual(ok.json(), { ok: true });
    const row = db.prepare('SELECT pin_hash, pin_failures, pin_locked_until FROM admins WHERE id = 1').get() as unknown as {
      pin_hash: string;
      pin_failures: number;
      pin_locked_until: number | null;
    };
    assert.deepEqual({ ...row }, { pin_hash: 'h:1905', pin_failures: 0, pin_locked_until: null });
    assert.ok(sessionRow(db, TOKEN).last_active > 1);
    const rows = auditRows(db);
    assert.deepEqual(rows.at(-1), { action: 'auth.pin_set', detail: null });
    assert.ok(rows.every((r) => !String(r.detail).includes('1905')));
    await app.close();
  }),
);

test(
  'yeni PIN eski PIN denemelerinin sınırını temizler',
  withDb(async (db) => {
    seedAdmin(db, 'h:1905');
    const { app, post, counts } = await routes(db);
    counts.set('pin|127.0.0.1|ali', 5);
    assert.deepEqual((await post('/t/pin', { password: 'parola1234', pin: '2509' })).json(), { ok: true });
    assert.equal(counts.has('pin|127.0.0.1|ali'), false);
    await post('/t/lock/now', { reason: 'elle' });
    assert.deepEqual((await post('/t/lock/unlock', { pin: '2509' })).json(), { ok: true });
    await app.close();
  }),
);

test(
  'kilit ve açma: 5 hatada 423, doğru PIN de kilidi aşamaz, süre bitince açılır',
  withDb(async (db) => {
    seedAdmin(db, 'h:1905');
    const { app, post, counts } = await routes(db);
    assert.deepEqual((await post('/t/lock/now', { reason: 'elle' })).json(), { locked: true });
    assert.equal(sessionRow(db, TOKEN).locked, 1);

    const format = await post('/t/lock/unlock', { pin: '12' });
    assert.equal(format.statusCode, 400);

    for (let remaining = 4; remaining >= 1; remaining--) {
      const r = await post('/t/lock/unlock', { pin: '0001' });
      assert.equal(r.statusCode, 403);
      assert.deepEqual(r.json(), { error: 'pin_invalid', remaining });
    }
    const fifth = await post('/t/lock/unlock', { pin: '0001' });
    assert.equal(fifth.statusCode, 423);
    assert.equal(fifth.json().error, 'pin_locked');
    assert.ok(fifth.json().seconds > 590 && fifth.json().seconds <= 600);

    const blocked = await post('/t/lock/unlock', { pin: '1905' });
    assert.equal(blocked.statusCode, 423);
    assert.equal(sessionRow(db, TOKEN).locked, 1);
    assert.equal(auditRows(db).filter((r) => r.action === 'auth.unlock_failed').length, 5);

    db.prepare('UPDATE admins SET pin_locked_until = 1 WHERE id = 1').run();
    assert.equal((await post('/t/lock/unlock', { pin: '1905' })).statusCode, 429);
    counts.clear();
    const ok = await post('/t/lock/unlock', { pin: '1905' });
    assert.deepEqual(ok.json(), { ok: true });
    assert.equal(sessionRow(db, TOKEN).locked, 0);
    assert.ok(auditRows(db).every((r) => !String(r.detail).includes('1905') && !String(r.detail).includes(TOKEN)));
    await app.close();
  }),
);

test(
  'doğrulama sürerken hesap kilitlenirse doğru PIN açamaz',
  withDb(async (db) => {
    seedAdmin(db, 'h:1905');
    let store: ReturnType<typeof adminStore> | undefined;
    const r = await routes(db, () => {
      for (let i = 0; i < 5; i++) store?.recordPinFailure(1);
    });
    store = r.store;
    store.lockSession(TOKEN, 'ali', 'bosta');
    const res = await r.post('/t/lock/unlock', { pin: '1905' });
    assert.equal(res.statusCode, 423);
    assert.equal(res.json().error, 'pin_locked');
    assert.equal(sessionRow(db, TOKEN).locked, 1);
    await r.app.close();
  }),
);

test(
  'etkinlik ucu: kilitliyken güncellemez, açıkken kalan süreyi döner',
  withDb(async (db) => {
    seedAdmin(db, 'h:1905');
    const { app, post, store } = await routes(db);
    db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?').run(Date.now() - 1000, TOKEN);
    const before = sessionRow(db, TOKEN).last_active;
    assert.deepEqual((await post('/t/lock/activity')).json(), { ok: true, idleSeconds: 300 });
    assert.ok(sessionRow(db, TOKEN).last_active > before);
    store.lockSession(TOKEN, 'ali', 'bosta');
    const at = sessionRow(db, TOKEN).last_active;
    const locked = await post('/t/lock/activity');
    assert.equal(locked.statusCode, 423);
    assert.deepEqual(locked.json(), { ok: false, locked: true });
    assert.equal(sessionRow(db, TOKEN).last_active, at);
    await app.close();
  }),
);

test(
  'süre seçimi: listede olmayan ve sınırı aşan reddedilir',
  withDb(async (db) => {
    seedAdmin(db, 'h:1905');
    const { app } = await routes(db);
    const put = (minutes: unknown) => app.inject({ method: 'PUT', url: '/t/lock/minutes', payload: { minutes } });
    for (const bad of [4, 30, 60, '5', null]) assert.equal((await put(bad)).statusCode, 400, String(bad));
    assert.deepEqual((await put(15)).json(), { minutes: 15 });
    const row = db.prepare('SELECT lock_minutes FROM admins WHERE id = 1').get() as unknown as { lock_minutes: number };
    assert.equal(row.lock_minutes, 15);
    assert.deepEqual(auditRows(db).at(-1), { action: 'auth.lock_minutes', detail: 'minutes=15' });
    await app.close();
  }),
);

test(
  'PIN yokken kilit ucu 428, kilitliyken PIN değişmez',
  withDb(async (db) => {
    seedAdmin(db, null);
    const { app, post } = await routes(db);
    assert.equal((await post('/t/lock/now')).statusCode, 428);
    db.prepare("UPDATE admins SET pin_hash = 'h:1905' WHERE id = 1").run();
    db.prepare('UPDATE sessions SET locked = 1 WHERE token = ?').run(TOKEN);
    assert.equal((await post('/t/pin', { password: 'parola1234', pin: '2509' })).statusCode, 423);
    assert.equal((await post('/t/lock/now')).statusCode, 423);
    await app.close();
  }),
);

test(
  'deneme anahtarı IP başlığını yalnızca verilen güven kuralına göre kullanır',
  withDb(async (db) => {
    seedAdmin(db, null);
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    const payload = { password: 'yanlis', pin: '2509' };
    const loose = await routes(db);
    await loose.app.inject({ method: 'POST', url: '/t/pin', payload, headers });
    assert.equal(loose.counts.get('203.0.113.9|ali'), 1);
    await loose.app.close();
    const strict = await routes(db, undefined, () => false);
    await strict.app.inject({ method: 'POST', url: '/t/pin', payload, headers });
    assert.equal(strict.counts.get('127.0.0.1|ali'), 1);
    assert.equal(strict.counts.has('203.0.113.9|ali'), false);
    await strict.app.close();
  }),
);
