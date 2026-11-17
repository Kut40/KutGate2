import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIp,
  isHttps,
  isProxied,
  isTrustedPeer,
  resolveClientIp,
  resolveForwardedProto,
  trustInternalProxy,
} from './clientip.js';
import { INTERNAL_HEADER } from './internal.js';

test('güvenilir kaynak: 127.0.0.1 ve ::1', () => {
  assert.equal(isTrustedPeer('127.0.0.1'), true);
  assert.equal(isTrustedPeer('::1'), true);
  assert.equal(isTrustedPeer('10.0.0.5'), false);
  assert.equal(isTrustedPeer('192.168.1.10'), false);
  assert.equal(isTrustedPeer(undefined), false);
});

test('güvenilir kaynak: önce cf-connecting-ip', () => {
  assert.equal(
    resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
    '203.0.113.7',
  );
  assert.equal(resolveClientIp('::1', { 'cf-connecting-ip': '2001:db8::1' }), '2001:db8::1');
});

test('güvenilir kaynak: cf yoksa x-forwarded-for ilk değeri', () => {
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '198.51.100.1, 10.0.0.1, 127.0.0.1' }), '198.51.100.1');
  assert.equal(resolveClientIp('::1', { 'x-forwarded-for': ' 2001:db8::2 ,10.0.0.1' }), '2001:db8::2');
});

test('güvenilir kaynak: geçersiz IP yok sayılır', () => {
  assert.equal(
    resolveClientIp('127.0.0.1', { 'cf-connecting-ip': 'evil', 'x-forwarded-for': '198.51.100.1' }),
    '198.51.100.1',
  );
  assert.equal(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '999.1.1.1' }), '127.0.0.1');
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': 'bilinmeyen, 198.51.100.1' }), '127.0.0.1');
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '' }), '127.0.0.1');
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '1.2.3.4\r\nx: y' }), '127.0.0.1');
});

test('güvenilir kaynak: başlık yoksa soket adresi', () => {
  assert.equal(resolveClientIp('127.0.0.1', {}), '127.0.0.1');
  assert.equal(resolveClientIp('::1', {}), '::1');
});

test('güvenilmez kaynak: başlıklar yok sayılır, soket adresi', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' };
  assert.equal(resolveClientIp('192.168.1.20', headers), '192.168.1.20');
  assert.equal(resolveClientIp('100.64.0.3', headers), '100.64.0.3');
  assert.equal(resolveClientIp(undefined, headers), '');
});

test('clientIp: istek nesnesinden', () => {
  assert.equal(
    clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } }),
    '203.0.113.9',
  );
  assert.equal(
    clientIp({ socket: { remoteAddress: '10.1.1.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } }),
    '10.1.1.1',
  );
});

test('HTTPS tespiti: yalnızca güvenilir kaynakta', () => {
  assert.equal(resolveForwardedProto('127.0.0.1', { 'x-forwarded-proto': 'https' }), 'https');
  assert.equal(resolveForwardedProto('127.0.0.1', { 'cf-visitor': '{"scheme":"https"}' }), 'https');
  assert.equal(resolveForwardedProto('127.0.0.1', { 'cf-visitor': '{"scheme":"http"}' }), 'http');
  assert.equal(resolveForwardedProto('127.0.0.1', { 'cf-visitor': 'bozuk' }), 'http');
  assert.equal(resolveForwardedProto('127.0.0.1', {}), 'http');
  assert.equal(resolveForwardedProto('192.168.1.20', { 'x-forwarded-proto': 'https' }), 'http');
  assert.equal(isHttps({ socket: { remoteAddress: '::1' }, headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isHttps({ socket: { remoteAddress: '10.0.0.2' }, headers: { 'cf-visitor': '{"scheme":"https"}' } }), false);
});

test('iç anahtarlı güven: başlıklar yalnızca doğru anahtar ve yerel eşle kullanılır', () => {
  const token = 'c'.repeat(64);
  const trust = trustInternalProxy(token);
  const forwarded = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-gate-proxied': '1' };
  const proxied = { socket: { remoteAddress: '127.0.0.1' }, headers: { ...forwarded, [INTERNAL_HEADER]: token } };
  assert.equal(clientIp(proxied, trust), '203.0.113.9');
  assert.equal(isHttps(proxied, trust), true);
  assert.equal(isProxied(proxied), true);

  for (const given of [undefined, '', 'd'.repeat(64), token.toUpperCase(), [token, token]]) {
    const headers = given === undefined ? { ...forwarded } : { ...forwarded, [INTERNAL_HEADER]: given };
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers };
    assert.equal(clientIp(req, trust), '127.0.0.1', String(given));
    assert.equal(isHttps(req, trust), false, String(given));
    assert.equal(isProxied(req), true, String(given));
  }

  const remote = { socket: { remoteAddress: '10.0.0.4' }, headers: { ...forwarded, [INTERNAL_HEADER]: token } };
  assert.equal(clientIp(remote, trust), '10.0.0.4');
  assert.equal(isProxied(remote), true);

  const noFlag = { socket: { remoteAddress: '127.0.0.1' }, headers: { [INTERNAL_HEADER]: token } };
  assert.equal(isProxied(noFlag), false);
});

test('varsayılan güven değişmedi: yerel eşten gelen Cloudflare başlıkları kullanılır', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } };
  assert.equal(clientIp(req), '203.0.113.9');
  assert.equal(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }, false), '127.0.0.1');
  assert.equal(resolveForwardedProto('127.0.0.1', { 'x-forwarded-proto': 'https' }, false), 'http');
});
