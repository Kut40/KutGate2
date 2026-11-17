import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyRequest } from 'fastify';
import { makeAudit } from '../core/audit.js';
import { hashPassword } from '../core/auth.js';
import { openDb } from '../core/db.js';
import { generateSecret, totp } from '../core/totp.js';
import type { Config } from '../core/types.js';
import { makePortalAuth, PORTAL_COOKIE, type PortalUser, setupIncomplete, stageOf } from './auth.js';

const TOKEN = 'a'.repeat(64);

test('aşama sırası: parola > TOTP > PIN > kilit/hazır', () => {
  const full = { must_change: 0, totp_enabled: 1, pin_hash: 'x', session_locked: 0 };
  assert.equal(stageOf(full), 'ready');
  assert.equal(stageOf({ ...full, session_locked: null }), 'ready');
  assert.equal(stageOf({ must_change: 0, totp_enabled: 1, pin_hash: 'x' }), 'ready');
  assert.equal(stageOf({ ...full, session_locked: 1 }), 'locked');
  assert.equal(stageOf({ ...full, pin_hash: null }), 'setup_pin');
  assert.equal(stageOf({ ...full, pin_hash: null, session_locked: 1 }), 'setup_pin');
  assert.equal(stageOf({ ...full, totp_enabled: 0, pin_hash: null }), 'setup_totp');
  assert.equal(stageOf({ ...full, totp_enabled: 0, session_locked: 1 }), 'setup_totp');
  assert.equal(stageOf({ ...full, must_change: 1, totp_enabled: 0, pin_hash: null, session_locked: 1 }), 'change_password');
});

function setup(pinHash: string | null, lastActive: number, totp = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-portal-auth-'));
  const db = openDb({ dataDir: dir } as Config);
  const now = Date.now();
  db.prepare("INSERT INTO users(id, username, display, locked, created) VALUES (7, 'veli', '', 0, '')").run();
  db.prepare(
    'INSERT INTO portal_accounts(user_id, pass_hash, must_change, totp_enabled, enabled, pin_hash) VALUES (7, ?, 0, ?, 1, ?)',
  ).run('x', totp, pinHash);
  db.prepare(
    'INSERT INTO portal_sessions(token, user_id, created, last_seen, expires, last_active, locked) VALUES (?, 7, ?, ?, ?, ?, 0)',
  ).run(TOKEN, now, now, now + 60_000, lastActive);
  const auth = makePortalAuth(db, makeAudit(db));
  const req = { cookies: { [PORTAL_COOKIE]: TOKEN } } as unknown as FastifyRequest;
  return {
    db,
    auth,
    req,
    done: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('yedek kilit: süre + 60 sn geçince oturum kilitlenir, kanca belirteçle ve bir kez çalışır', () => {
  const { db, auth, req, done } = setup('x', Date.now() - 7 * 60 * 1000);
  try {
    const seen: string[] = [];
    auth.onLocked((t) => seen.push(t));
    assert.equal(auth.authenticate(req)?.stage, 'locked');
    assert.equal(auth.authenticate(req)?.stage, 'locked');
    assert.deepEqual(seen, [TOKEN]);
    const audit = db.prepare("SELECT detail FROM audit WHERE action = 'portal.lock'").all() as unknown as { detail: string }[];
    assert.deepEqual(audit.map((a) => a.detail), ['neden=sunucu']);
  } finally {
    done();
  }
});

test('yedek kilit: süre dolmadan ve kurulum aşamalarında uygulanmaz', () => {
  const fresh = setup('x', Date.now());
  try {
    assert.equal(fresh.auth.authenticate(fresh.req)?.stage, 'ready');
  } finally {
    fresh.done();
  }
  const noPin = setup(null, 1);
  try {
    assert.equal(noPin.auth.authenticate(noPin.req)?.stage, 'setup_pin');
  } finally {
    noPin.done();
  }
  const noTotp = setup('x', 1, 0);
  try {
    assert.equal(noTotp.auth.authenticate(noTotp.req)?.stage, 'setup_totp');
  } finally {
    noTotp.done();
  }
});

test('tür denetimi: beklenen türde olmayan hesap satırı oturum vermez', () => {
  const { db, auth, req, done } = setup('x', Date.now());
  try {
    assert.equal(auth.authenticate(req)?.stage, 'ready');
    db.prepare("UPDATE portal_accounts SET must_change = 'evet' WHERE user_id = 7").run();
    assert.equal(auth.authenticate(req), null);
  } finally {
    done();
  }
});

test('kurulum aşaması: yalnızca kurulum uçları açık, hazır ve kilitli aşamalar etkilenmez', () => {
  const allowed = ['/papi/status', '/papi/password', '/papi/totp/begin', '/papi/totp/confirm', '/papi/pin', '/papi/logout', '/papi/lock/activity'];
  const closed = ['/papi/git/sync', '/papi/git/send', '/papi/git/projects', '/papi/preview/open', '/papi/me/profile', '/papi/me/avatar', '/papi/terminal', '/papi/agent', '/papi/lock/now', '/papi/lock/minutes', ''];
  for (const stage of ['change_password', 'setup_totp', 'setup_pin'] as const) {
    for (const r of allowed) assert.equal(setupIncomplete(stage, r, r), false, `${stage} ${r}`);
    for (const r of closed) assert.equal(setupIncomplete(stage, r, r), true, `${stage} ${r}`);
    assert.equal(setupIncomplete(stage, '/papi/password', '/papi/git/sync'), true);
  }
  for (const stage of ['ready', 'locked'] as const) {
    for (const r of [...allowed, ...closed]) assert.equal(setupIncomplete(stage, r, r), false, `${stage} ${r}`);
  }
});

const PORTAL_PASS = 'portal-parola-2026';
const NEW_PASS = 'yepyeni-parola-2026';

async function portalApp(opts: { totpSecret: string | null; pinHash?: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-portal-auth-'));
  const db = openDb({ dataDir: dir } as Config);
  const now = Date.now();
  db.prepare("INSERT INTO users(id, username, display, locked, created) VALUES (7, 'veli', '', 0, '')").run();
  db.prepare(
    'INSERT INTO portal_accounts(user_id, pass_hash, must_change, totp_secret, totp_enabled, enabled, pin_hash) VALUES (7, ?, 0, ?, ?, 1, ?)',
  ).run(await hashPassword(PORTAL_PASS), opts.totpSecret, opts.totpSecret ? 1 : 0, opts.pinHash === undefined ? 'x' : opts.pinHash);
  db.prepare(
    'INSERT INTO portal_sessions(token, user_id, created, last_seen, expires, last_active, locked) VALUES (?, 7, ?, ?, ?, ?, 0)',
  ).run(TOKEN, now, now, now + 60_000, now);
  const app = Fastify();
  await app.register(cookie);
  const auth = makePortalAuth(db, makeAudit(db));
  const loggedOut: PortalUser[] = [];
  auth.onLogout((u) => loggedOut.push(u));
  auth.registerRoutes(app);
  await app.ready();
  const post = (url: string, payload: Record<string, unknown>, withCookie = false) =>
    app.inject({ method: 'POST', url, payload, ...(withCookie ? { cookies: { [PORTAL_COOKIE]: TOKEN } } : {}) });
  return {
    db,
    post,
    loggedOut,
    done: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('portal girişi: eşzamanlı hatalı denemeler sınırı aşamaz', async () => {
  const { post, done } = await portalApp({ totpSecret: generateSecret() });
  try {
    const res = await Promise.all(Array.from({ length: 10 }, () => post('/papi/login', { username: 'veli', password: 'yanlis-parola' })));
    assert.deepEqual(res.map((r) => r.statusCode).sort(), [401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  } finally {
    await done();
  }
});

test('parola değiştirme: eşzamanlı hatalı denemeler sınırı aşamaz, doğru parola deneme sayılmaz', async () => {
  const { post, done } = await portalApp({ totpSecret: generateSecret() });
  try {
    for (let i = 0; i < 4; i += 1) {
      const r = await post('/papi/password', { current: PORTAL_PASS, new: 'kisa' }, true);
      assert.equal(r.statusCode, 400);
    }
    const res = await Promise.all(
      Array.from({ length: 10 }, () => post('/papi/password', { current: 'yanlis-parola', new: NEW_PASS }, true)),
    );
    assert.deepEqual(res.map((r) => r.statusCode).sort(), [400, 400, 400, 400, 400, 429, 429, 429, 429, 429]);
  } finally {
    await done();
  }
});

test('portal girişi: TOTP kodu girişte ve parola sıfırlamada ikinci kez kullanılamaz', async () => {
  const secret = generateSecret();
  const { post, done } = await portalApp({ totpSecret: secret });
  try {
    const code = totp(secret);
    const missing = await post('/papi/login', { username: 'veli', password: PORTAL_PASS });
    assert.deepEqual(missing.json(), { error: 'totp_required' });
    assert.equal((await post('/papi/login', { username: 'veli', password: PORTAL_PASS, totp: code })).statusCode, 200);
    const again = await post('/papi/login', { username: 'veli', password: PORTAL_PASS, totp: code });
    assert.deepEqual(again.json(), { error: 'invalid_totp' });
    const reset = await post('/papi/forgot', { username: 'veli', totp: code, new: NEW_PASS });
    assert.deepEqual(reset.json(), { error: 'invalid_reset' });
  } finally {
    await done();
  }
});

test('parola sıfırlama: oturumlar silinir, terminal ve ajan süreçleri için çıkış kancası çalışır', async () => {
  const secret = generateSecret();
  const { db, post, loggedOut, done } = await portalApp({ totpSecret: secret });
  try {
    const r = await post('/papi/forgot', { username: 'veli', totp: totp(secret), new: NEW_PASS });
    assert.deepEqual(r.json(), { ok: true });
    assert.deepEqual(loggedOut.map((u) => [u.userId, u.username]), [[7, 'veli']]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM portal_sessions WHERE user_id = 7').get() as unknown as { n: number };
    assert.equal(n.n, 0);
  } finally {
    await done();
  }
});

test('portal TOTP kurulumu: onay sayacı yazılır, onay kodu girişte tekrar kullanılamaz', async () => {
  const { db, post, done } = await portalApp({ totpSecret: null, pinHash: null });
  try {
    db.prepare('UPDATE portal_accounts SET totp_last_counter = ? WHERE user_id = 7').run(Math.floor(Date.now() / 30_000) + 5);
    const begun = await post('/papi/totp/begin', {}, true);
    const secret = begun.json().secret as string;
    const code = totp(secret);
    const confirmed = await post('/papi/totp/confirm', { code }, true);
    assert.deepEqual(confirmed.json(), { ok: true, stage: 'setup_pin' });
    const row = db.prepare('SELECT totp_last_counter AS c FROM portal_accounts WHERE user_id = 7').get() as unknown as { c: number };
    assert.ok(Math.abs(row.c - Math.floor(Date.now() / 30_000)) <= 1);
    const replay = await post('/papi/login', { username: 'veli', password: PORTAL_PASS, totp: code });
    assert.deepEqual(replay.json(), { error: 'invalid_totp' });
  } finally {
    await done();
  }
});
