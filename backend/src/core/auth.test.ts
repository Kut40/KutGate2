import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyRequest } from 'fastify';
import { makeAudit } from './audit.js';
import {
  adminPasswordError,
  adminSessionActive,
  consumeTotp,
  findAdmin,
  hashPassword,
  makeAuth,
  proxiedAdminNeedsTotpSetup,
  SESSION_COOKIE,
  verifyPassword,
} from './auth.js';
import { openDb } from './db.js';
import { INTERNAL_HEADER } from './internal.js';
import { generateSecret, totp } from './totp.js';
import type { Config } from './types.js';

const PROXY_TOKEN = 'f'.repeat(64);

test('vekil girişi: TOTP kurulu değilse engellenir', () => {
  assert.equal(proxiedAdminNeedsTotpSetup(true, 0), true);
  assert.equal(proxiedAdminNeedsTotpSetup(true, 1), false);
});

test('doğrudan yerel giriş: TOTP durumu engel olmaz', () => {
  assert.equal(proxiedAdminNeedsTotpSetup(false, 0), false);
  assert.equal(proxiedAdminNeedsTotpSetup(false, 1), false);
});

test('findAdmin adı büyük/küçük harf ayırmadan bulur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  try {
    db.prepare("INSERT INTO admins(username, pass_hash, totp_enabled, created) VALUES ('Yonetici', 'x', 0, '')").run();
    for (const name of ['Yonetici', 'yonetici', 'YONETICI']) assert.equal(findAdmin(db, name)?.username, 'Yonetici', name);
    assert.equal(findAdmin(db, 'erka'), undefined);
    assert.equal(findAdmin(db, ''), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yönetici oturumu: PIN yoksa pinRequired, süre geçince kilit ve yayın', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  try {
    const token = 'a'.repeat(64);
    const now = Date.now();
    db.prepare("INSERT INTO admins(id, username, pass_hash, totp_enabled, created) VALUES (1, 'yonetici', 'x', 0, '')").run();
    db.prepare(
      'INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, 1, ?, ?, ?, ?, 0)',
    ).run(token, now, now, now + 60_000, now - 7 * 60 * 1000);
    const auth = makeAuth(db, makeAudit(db), PROXY_TOKEN);
    const req = { cookies: { [SESSION_COOKIE]: token } } as unknown as FastifyRequest;
    assert.deepEqual(auth.authenticate(req), { id: 1, username: 'yonetici', locked: false, pinRequired: true });

    const seen: string[] = [];
    auth.onSessionLocked((t) => seen.push(t));
    db.prepare("UPDATE admins SET pin_hash = 'p' WHERE id = 1").run();
    assert.deepEqual(auth.authenticate(req), { id: 1, username: 'yonetici', locked: true, pinRequired: false });
    assert.deepEqual(seen, [token]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yönetici parola kuralları', () => {
  assert.match(adminPasswordError('yonetici', 'eski-parola-1', 'kisa') ?? '', /en az 10/);
  assert.match(adminPasswordError('yonetici', 'eski-parola-1', 'eski-parola-1') ?? '', /aynı/);
  assert.match(adminPasswordError('yonetici', 'eski-parola-1', 'xxYONETICIxx-1234') ?? '', /kullanıcı adını/);
  assert.equal(adminPasswordError('yonetici', 'eski-parola-1', undefined) !== null, true);
  assert.equal(adminPasswordError('yonetici', 'eski-parola-1', 'yeni-guclu-parola'), null);
});

test('parola değiştirme ve TOTP kurulumu geçerli parola ister', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  const app = Fastify();
  try {
    await app.register(cookie);
    const auth = makeAuth(db, makeAudit(db), PROXY_TOKEN);
    app.addHook('onRequest', async (req) => {
      req.admin = auth.authenticate(req) ?? undefined;
    });
    auth.registerRoutes(app);
    await app.ready();

    const now = Date.now();
    const pass = 'eski-parola-1';
    db.prepare("INSERT INTO admins(id, username, pass_hash, totp_enabled, created) VALUES (1, 'yonetici', ?, 0, '')").run(await hashPassword(pass));
    const mine = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const ins = db.prepare('INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, 1, ?, ?, ?, ?, 0)');
    ins.run(mine, now, now, now + 60_000, now);
    ins.run(other, now, now, now + 60_000, now);
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, payload, cookies: { [SESSION_COOKIE]: mine } });

    assert.equal((await post('/api/auth/totp/begin', {})).statusCode, 403);
    assert.equal((await post('/api/auth/totp/begin', { password: 'yanlis' })).statusCode, 403);
    const begun = await post('/api/auth/totp/begin', { password: pass });
    assert.equal(begun.statusCode, 200);
    assert.ok(begun.json().secret);

    const wrong = await post('/api/auth/password', { current: 'yanlis', new: 'yeni-guclu-parola' });
    assert.equal(wrong.statusCode, 403);
    assert.deepEqual(wrong.json(), { error: 'invalid_current_password' });
    assert.equal((await post('/api/auth/password', { current: pass, new: 'kisa' })).statusCode, 400);
    const stored = () => db.prepare('SELECT pass_hash FROM admins WHERE id = 1').get() as unknown as { pass_hash: string };
    assert.equal(await verifyPassword(pass, stored().pass_hash), true);

    const done = await post('/api/auth/password', { current: pass, new: 'yeni-guclu-parola' });
    assert.deepEqual(done.json(), { ok: true });
    assert.equal(await verifyPassword('yeni-guclu-parola', stored().pass_hash), true);
    const tokens = (db.prepare('SELECT token FROM sessions').all() as unknown as { token: string }[]).map((r) => r.token);
    assert.deepEqual(tokens, [mine]);

    const rows = db.prepare('SELECT action, detail FROM audit').all() as unknown as { action: string; detail: string | null }[];
    assert.ok(rows.some((r) => r.action === 'auth.password_changed' && r.detail === 'kapanan_oturum=1'));
    assert.ok(rows.every((r) => !String(r.detail).includes('parola')));

    for (let i = 0; i < 5; i += 1) await post('/api/auth/password', { current: 'yanlis', new: 'yeni-guclu-parola-2' });
    assert.equal((await post('/api/auth/password', { current: 'yeni-guclu-parola', new: 'yeni-guclu-parola-2' })).statusCode, 429);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function adminApp() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  const app = Fastify();
  await app.register(cookie);
  const auth = makeAuth(db, makeAudit(db), PROXY_TOKEN);
  app.addHook('onRequest', async (req) => {
    req.admin = auth.authenticate(req) ?? undefined;
  });
  auth.registerRoutes(app);
  await app.ready();
  const login = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload, headers });
  return {
    db,
    app,
    login,
    done: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ADMIN_PASS = 'yonetici-parola-1';

async function seedLoginAdmin(db: ReturnType<typeof openDb>, totpSecret: string | null): Promise<void> {
  db.prepare("INSERT INTO admins(id, username, pass_hash, totp_secret, totp_enabled, created) VALUES (1, 'yonetici', ?, ?, ?, '')").run(
    await hashPassword(ADMIN_PASS),
    totpSecret,
    totpSecret ? 1 : 0,
  );
}

test('TOTP sayacı: aynı ya da eski sayaç reddedilir, yenisi kabul edilir; hesap türleri ayrı', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  try {
    const secret = generateSecret();
    db.prepare("INSERT INTO admins(id, username, pass_hash, totp_secret, totp_enabled, created) VALUES (1, 'yonetici', 'x', ?, 1, '')").run(secret);
    db.prepare("INSERT INTO users(id, username, display, locked, created) VALUES (7, 'veli', '', 0, '')").run();
    db.prepare('INSERT INTO portal_accounts(user_id, pass_hash, must_change, totp_secret, totp_enabled, enabled) VALUES (7, ?, 0, ?, 1, 1)').run('x', secret);
    const t = 1_800_000_000_000;
    const counter = Math.floor(t / 30_000);
    const code = totp(secret, t);
    assert.equal(consumeTotp(db, 'admin', 1, secret, code, t), true);
    const stored = db.prepare('SELECT totp_last_counter AS c FROM admins WHERE id = 1').get() as unknown as { c: number };
    assert.equal(stored.c, counter);
    assert.equal(consumeTotp(db, 'admin', 1, secret, code, t), false);
    assert.equal(consumeTotp(db, 'admin', 1, secret, code, t + 30_000), false);
    assert.equal(consumeTotp(db, 'admin', 1, secret, totp(secret, t - 30_000), t), false);
    assert.equal(consumeTotp(db, 'admin', 1, secret, totp(secret, t + 30_000), t + 30_000), true);
    assert.equal(consumeTotp(db, 'portal', 7, secret, code, t), true);
    assert.equal(consumeTotp(db, 'portal', 7, secret, code, t), false);
    assert.equal(consumeTotp(db, 'admin', 1, null, code, t), false);
    assert.equal(consumeTotp(db, 'admin', 99, secret, totp(secret, t + 60_000), t + 60_000), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yönetici oturumu geçerlilik denetimi: süre, boşta kalma, silinen satır', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-auth-test-'));
  const db = openDb({ dataDir: dir } as Config);
  try {
    const now = Date.now();
    db.prepare("INSERT INTO admins(id, username, pass_hash, totp_enabled, created) VALUES (1, 'yonetici', 'x', 0, '')").run();
    const ins = db.prepare('INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, 1, ?, ?, ?, ?, 0)');
    const live = 'a'.repeat(64);
    const expired = 'b'.repeat(64);
    const idle = 'c'.repeat(64);
    ins.run(live, now, now, now + 60_000, now);
    ins.run(expired, now, now, now - 1, now);
    ins.run(idle, now, now - 31 * 60 * 1000, now + 60_000, now);
    assert.equal(adminSessionActive(db, live, now), true);
    assert.equal(adminSessionActive(db, expired, now), false);
    assert.equal(adminSessionActive(db, idle, now), false);
    assert.equal(adminSessionActive(db, 'd'.repeat(64), now), false);
    assert.equal(adminSessionActive(db, '', now), false);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(live);
    assert.equal(adminSessionActive(db, live, now), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yönetici girişi: eşzamanlı hatalı denemeler sınırı aşamaz', async () => {
  const { db, login, done } = await adminApp();
  try {
    await seedLoginAdmin(db, null);
    const res = await Promise.all(Array.from({ length: 10 }, () => login({ username: 'yonetici', password: 'yanlis-parola' })));
    const codes = res.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
    assert.equal((await login({ username: 'yonetici', password: ADMIN_PASS })).statusCode, 429);
  } finally {
    await done();
  }
});

test('yönetici girişi: TOTP eksikliği deneme sayılmaz, doğru giriş sayacı sıfırlar', async () => {
  const secret = generateSecret();
  const { db, login, done } = await adminApp();
  try {
    await seedLoginAdmin(db, secret);
    for (let i = 0; i < 4; i += 1) await login({ username: 'yonetici', password: 'yanlis-parola' });
    for (let i = 0; i < 3; i += 1) {
      const r = await login({ username: 'yonetici', password: ADMIN_PASS });
      assert.deepEqual(r.json(), { error: 'totp_required' });
    }
    const ok = await login({ username: 'yonetici', password: ADMIN_PASS, totp: totp(secret) });
    assert.deepEqual(ok.json(), { ok: true });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await login({ username: 'yonetici', password: 'yanlis-parola' })).statusCode, 401);
    }
    assert.equal((await login({ username: 'yonetici', password: 'yanlis-parola' })).statusCode, 429);
  } finally {
    await done();
  }
});

test('yönetici girişi: aynı TOTP kodu ikinci kez kabul edilmez', async () => {
  const secret = generateSecret();
  const { db, login, done } = await adminApp();
  try {
    await seedLoginAdmin(db, secret);
    const code = totp(secret);
    assert.deepEqual((await login({ username: 'yonetici', password: ADMIN_PASS, totp: code })).json(), { ok: true });
    const again = await login({ username: 'yonetici', password: ADMIN_PASS, totp: code });
    assert.equal(again.statusCode, 401);
    assert.deepEqual(again.json(), { error: 'invalid_totp' });
  } finally {
    await done();
  }
});

test('TOTP kurulum onayı sayacı yazar, eski sayaç yeni kurulumu engellemez, onay kodu girişte tekrar kullanılamaz', async () => {
  const { db, app, login, done } = await adminApp();
  try {
    await seedLoginAdmin(db, null);
    db.prepare('UPDATE admins SET totp_last_counter = ? WHERE id = 1').run(Math.floor(Date.now() / 30_000) + 5);
    const token = 'a'.repeat(64);
    const now = Date.now();
    db.prepare('INSERT INTO sessions(token, admin_id, created, last_seen, expires, last_active, locked) VALUES (?, 1, ?, ?, ?, ?, 0)').run(
      token,
      now,
      now,
      now + 60_000,
      now,
    );
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, payload, cookies: { [SESSION_COOKIE]: token } });
    const begun = await post('/api/auth/totp/begin', { password: ADMIN_PASS });
    const secret = begun.json().secret as string;
    const code = totp(secret);
    assert.deepEqual((await post('/api/auth/totp/confirm', { code })).json(), { ok: true });
    const row = db.prepare('SELECT totp_enabled, totp_last_counter AS c FROM admins WHERE id = 1').get() as unknown as {
      totp_enabled: number;
      c: number;
    };
    assert.equal(row.totp_enabled, 1);
    assert.ok(Math.abs(row.c - Math.floor(Date.now() / 30_000)) <= 1);
    const replay = await login({ username: 'yonetici', password: ADMIN_PASS, totp: code });
    assert.deepEqual(replay.json(), { error: 'invalid_totp' });
  } finally {
    await done();
  }
});

test('vekil kanıtı: IP ve vekil başlıkları yalnızca iç anahtarla geçerli', async () => {
  const { db, app, login, done } = await adminApp();
  try {
    const proxied = { 'x-gate-proxied': '1', [INTERNAL_HEADER]: PROXY_TOKEN };
    const status = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/api/auth/status', headers }).then((r) => r.json().viaProxy as boolean);
    assert.equal(await status({}), false);
    assert.equal(await status({ 'x-gate-proxied': '1' }), true);
    assert.equal(await status({ 'x-gate-proxied': '1', [INTERNAL_HEADER]: 'e'.repeat(64) }), true);
    assert.equal(await status(proxied), true);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'yonetici', password: ADMIN_PASS },
      headers: proxied,
    });
    assert.deepEqual(setup.json(), { error: 'setup_not_allowed_via_proxy' });

    await seedLoginAdmin(db, null);
    const viaProxy = await login({ username: 'yonetici', password: ADMIN_PASS }, proxied);
    assert.deepEqual(viaProxy.json(), { error: 'admin_totp_setup_required' });
    const spoofed = await login({ username: 'yonetici', password: ADMIN_PASS }, { 'x-gate-proxied': '1' });
    assert.deepEqual(spoofed.json(), { error: 'admin_totp_setup_required' });

    for (let i = 0; i < 5; i += 1) {
      const r = await login({ username: 'yonetici', password: 'yanlis' }, { 'cf-connecting-ip': `203.0.113.${i + 1}` });
      assert.equal(r.statusCode, 401);
    }
    const blocked = await login({ username: 'yonetici', password: 'yanlis' }, { 'cf-connecting-ip': '203.0.113.99' });
    assert.equal(blocked.statusCode, 429);
    const fromProxy = await login(
      { username: 'yonetici', password: 'yanlis' },
      { ...proxied, 'cf-connecting-ip': '203.0.113.99' },
    );
    assert.equal(fromProxy.statusCode, 401);
  } finally {
    await done();
  }
});
