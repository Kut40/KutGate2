import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardHeaders, HTTP_TIMEOUT_MS, isProxyPath, isWsProxyPath, pathOf, stripHopByHop } from './proxy.js';
import { INTERNAL_HEADER } from '../core/internal.js';

test('vekil zaman aşımı skill üretim süresinden (120 sn) uzun', () => {
  assert.equal(HTTP_TIMEOUT_MS, 130 * 1000);
});

test('x-gate-proxied istemciden gelen değerle ne olursa olsun 1 olarak iletilir (HTTP ve WS)', () => {
  for (const websocket of [false, true]) {
    for (const peer of ['127.0.0.1', '192.168.1.20']) {
      for (const given of [undefined, '0', '', 'false', ['0', '0']]) {
        const out = forwardHeaders(
          {
            socket: { remoteAddress: peer },
            headers: { host: 'gate.example.com', ...(given === undefined ? {} : { 'x-gate-proxied': given }) },
          },
          websocket,
        );
        assert.equal(out['x-gate-proxied'], '1');
      }
    }
  }
});

test('vekil: yalnızca izinli önekler', () => {
  for (const p of ['/admin', '/admin/', '/admin/x', '/admin/assets/a.js', '/api/x', '/api/auth/status']) {
    assert.equal(isProxyPath(p), true, p);
  }
  for (const p of ['/', '/adminx', '/admin-x', '/apix', '/api', '/papi/x', '/papi/login', '/assets/x', '/portal.html']) {
    assert.equal(isProxyPath(p), false, p);
  }
});

test('vekil: sorgu dizgisi yol kararını etkilemez', () => {
  assert.equal(isProxyPath(pathOf('/api/audit?limit=5')), true);
  assert.equal(isProxyPath(pathOf('/papi/status?x=/api/y')), false);
  assert.equal(pathOf(undefined), '');
});

test('vekil WS: yalnızca /api/ öneki', () => {
  assert.equal(isWsProxyPath('/api/terminal'), true);
  assert.equal(isWsProxyPath('/api/sessions/abc/watch'), true);
  assert.equal(isWsProxyPath('/papi/terminal'), false);
  assert.equal(isWsProxyPath('/admin/'), false);
  assert.equal(isWsProxyPath('/apix'), false);
});

test('hop-by-hop başlıklar temizlenir', () => {
  const out = stripHopByHop({
    host: 'gate.example.com',
    origin: 'https://gate.example.com',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'proxy-authorization': 'Basic x',
    'proxy-connection': 'keep-alive',
    te: 'trailers',
    trailer: 'x-a',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    cookie: 'gate_sid=abc',
    'content-type': 'application/json',
    'set-cookie': ['a=1', 'b=2'],
  });
  assert.deepEqual(out, {
    host: 'gate.example.com',
    origin: 'https://gate.example.com',
    cookie: 'gate_sid=abc',
    'content-type': 'application/json',
    'set-cookie': ['a=1', 'b=2'],
  });
});

test('hop-by-hop: WebSocket için upgrade korunur', () => {
  const out = stripHopByHop(
    {
      host: 'gate.example.com',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'k',
      'sec-websocket-version': '13',
      'keep-alive': 'timeout=5',
      'proxy-authorization': 'Basic x',
    },
    true,
  );
  assert.deepEqual(out, {
    host: 'gate.example.com',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': 'k',
    'sec-websocket-version': '13',
  });
});

test('iletilen başlıklar: Host/Origin aynen, x-forwarded-* ve x-gate-proxied eklenir', () => {
  const out = forwardHeaders(
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: 'gate.example.com',
        origin: 'https://gate.example.com',
        'cf-connecting-ip': '203.0.113.7',
        'cf-visitor': '{"scheme":"https"}',
        connection: 'keep-alive',
      },
    },
    false,
  );
  assert.equal(out.host, 'gate.example.com');
  assert.equal(out.origin, 'https://gate.example.com');
  assert.equal(out['x-forwarded-for'], '203.0.113.7');
  assert.equal(out['x-forwarded-proto'], 'https');
  assert.equal(out['x-gate-proxied'], '1');
  assert.equal(out.connection, undefined);
});

test('iletilen başlıklar: güvenilmez kaynakta sahte IP/proto başlıkları kullanılmaz', () => {
  const out = forwardHeaders(
    {
      socket: { remoteAddress: '192.168.1.20' },
      headers: {
        host: 'sunucu:4180',
        'cf-connecting-ip': '1.1.1.1',
        'cf-visitor': '{"scheme":"https"}',
        'x-forwarded-for': '8.8.8.8',
        'x-forwarded-proto': 'https',
        'x-gate-proxied': '0',
      },
    },
    false,
  );
  assert.equal(out['cf-connecting-ip'], undefined);
  assert.equal(out['cf-visitor'], undefined);
  assert.equal(out['x-forwarded-for'], '192.168.1.20');
  assert.equal(out['x-forwarded-proto'], 'http');
  assert.equal(out['x-gate-proxied'], '1');
});

test('iç anahtar: yönetim vekilinde eklenir, istemcinin gönderdiği değer ezilir (HTTP ve WS)', () => {
  const token = 'e'.repeat(64);
  for (const websocket of [false, true]) {
    for (const given of [undefined, 'f'.repeat(64), token, ['x', 'y']]) {
      const headers = { host: 'gate.example.com', ...(given === undefined ? {} : { [INTERNAL_HEADER]: given }) };
      const out = forwardHeaders({ socket: { remoteAddress: '127.0.0.1' }, headers }, websocket, token);
      assert.equal(out[INTERNAL_HEADER], token);
    }
  }
});

test('iç anahtar: anahtarsız vekil (paylaşımlı uygulama, önizleme) istemcinin değerini iletmez', () => {
  for (const websocket of [false, true]) {
    const out = forwardHeaders(
      { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'gate.example.com', [INTERNAL_HEADER]: 'f'.repeat(64) } },
      websocket,
    );
    assert.equal(out[INTERNAL_HEADER], undefined);
    assert.equal(INTERNAL_HEADER in out, false);
  }
});
