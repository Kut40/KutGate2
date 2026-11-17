import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOs, MAX_PENDING_PER_USER, TOKEN_RE, TOKEN_TTL_MS, TokenStore } from './tokens.js';

const DATA = { privateKey: 'PRIVATE', host: 'srv.example.com', port: 22 };

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function ready(store: TokenStore, userId = 1, username = 'ali'): string {
  const token = store.reserve(userId, username);
  assert.ok(token);
  assert.equal(store.activate(token, DATA), true);
  return token;
}

test('sabitler', () => {
  assert.equal(TOKEN_TTL_MS, 600_000);
  assert.equal(MAX_PENDING_PER_USER, 3);
  assert.equal(new TokenStore().ttlSeconds, 600);
});

test('token 32 bayt hex ve benzersiz', () => {
  const store = new TokenStore();
  const a = ready(store, 1);
  const b = ready(store, 2);
  assert.match(a, TOKEN_RE);
  assert.match(b, TOKEN_RE);
  assert.notEqual(a, b);
});

test('her os için tek kullanımlık indirme, ikinci istek 410', () => {
  const store = new TokenStore();
  const token = ready(store);
  const w = store.take(token, 'windows');
  assert.equal(w.status, 200);
  if (w.status === 200) {
    assert.equal(w.key.username, 'ali');
    assert.equal(w.key.userId, 1);
    assert.equal(w.key.privateKey, 'PRIVATE');
    assert.equal(w.key.host, 'srv.example.com');
    assert.equal(w.key.port, 22);
  }
  assert.equal(store.take(token, 'windows').status, 410);
  assert.equal(store.take(token, 'windows').status, 410);
  assert.equal(store.size, 1);
});

test('iki dosya da indirilince token silinir, sonraki istek 404', () => {
  const store = new TokenStore();
  const token = ready(store);
  assert.equal(store.take(token, 'unix').status, 200);
  assert.equal(store.take(token, 'unix').status, 410);
  assert.equal(store.take(token, 'windows').status, 200);
  assert.equal(store.size, 0);
  assert.equal(store.take(token, 'windows').status, 404);
  assert.equal(store.take(token, 'unix').status, 404);
});

test('geçersiz veya bilinmeyen token 404', () => {
  const store = new TokenStore();
  ready(store);
  assert.equal(store.take('', 'windows').status, 404);
  assert.equal(store.take('abc', 'windows').status, 404);
  assert.equal(store.take('Z'.repeat(64), 'windows').status, 404);
  assert.equal(store.take('a'.repeat(63), 'windows').status, 404);
  assert.equal(store.take('a'.repeat(64), 'windows').status, 404);
  assert.equal(store.take('../' + 'a'.repeat(61), 'unix').status, 404);
});

test('etkinleştirilmemiş token indirilemez (404)', () => {
  const store = new TokenStore();
  const token = store.reserve(1, 'ali');
  assert.ok(token);
  assert.equal(store.take(token, 'windows').status, 404);
});

test('TTL: 10 dakika dolunca 404 ve token silinir', () => {
  const c = clock();
  const store = new TokenStore({ now: c.now });
  const token = ready(store);
  c.advance(TOKEN_TTL_MS - 1);
  assert.equal(store.take(token, 'windows').status, 200);
  c.advance(1);
  assert.equal(store.take(token, 'unix').status, 404);
  assert.equal(store.take(token, 'windows').status, 404);
  assert.equal(store.size, 0);
});

test('TTL: hiç indirilmeyen token süre dolunca temizlenir', () => {
  const c = clock();
  const store = new TokenStore({ now: c.now });
  ready(store);
  ready(store, 2, 'veli');
  assert.equal(store.size, 2);
  c.advance(TOKEN_TTL_MS);
  store.sweep();
  assert.equal(store.size, 0);
});

test('TTL etkinleştirme anından başlar', () => {
  const c = clock();
  const store = new TokenStore({ now: c.now });
  const token = store.reserve(1, 'ali');
  assert.ok(token);
  c.advance(5000);
  assert.equal(store.activate(token, DATA), true);
  c.advance(TOKEN_TTL_MS - 1);
  assert.equal(store.take(token, 'windows').status, 200);
});

test('süresi dolmuş rezervasyon etkinleştirilemez', () => {
  const c = clock();
  const store = new TokenStore({ now: c.now });
  const token = store.reserve(1, 'ali');
  assert.ok(token);
  c.advance(TOKEN_TTL_MS);
  assert.equal(store.activate(token, DATA), false);
  assert.equal(store.take(token, 'windows').status, 404);
});

test('aynı token iki kez etkinleştirilemez', () => {
  const store = new TokenStore();
  const token = ready(store);
  assert.equal(store.activate(token, DATA), false);
});

test('kullanıcı başına en fazla 3 bekleyen token', () => {
  const store = new TokenStore();
  const t1 = ready(store, 1);
  ready(store, 1);
  const t3 = store.reserve(1, 'ali');
  assert.ok(t3);
  assert.equal(store.pendingCount(1), 3);
  assert.equal(store.reserve(1, 'ali'), null);
  assert.ok(store.reserve(2, 'veli'));
  store.release(t3);
  assert.equal(store.pendingCount(1), 2);
  const t4 = store.reserve(1, 'ali');
  assert.ok(t4);
  assert.equal(store.reserve(1, 'ali'), null);
  assert.equal(store.take(t1, 'windows').status, 200);
  assert.equal(store.reserve(1, 'ali'), null);
  assert.equal(store.take(t1, 'unix').status, 200);
  assert.ok(store.reserve(1, 'ali'));
});

test('sınır süre dolunca serbest kalır', () => {
  const c = clock();
  const store = new TokenStore({ now: c.now });
  ready(store, 1);
  ready(store, 1);
  ready(store, 1);
  assert.equal(store.reserve(1, 'ali'), null);
  c.advance(TOKEN_TTL_MS);
  assert.ok(store.reserve(1, 'ali'));
});

test('release sonrası token 404', () => {
  const store = new TokenStore();
  const token = ready(store);
  store.release(token);
  assert.equal(store.take(token, 'windows').status, 404);
});

test('isOs', () => {
  assert.equal(isOs('windows'), true);
  assert.equal(isOs('unix'), true);
  for (const v of ['mac', 'linux', '', 'Windows', undefined, null, 1]) assert.equal(isOs(v), false, String(v));
});
