import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killUserCloseCode } from './agent.js';

test('kullanıcı oturumları kapatılırken soket kodu: yönetici 1008, çıkış 1000', () => {
  assert.equal(killUserCloseCode('admin'), 1008);
  assert.equal(killUserCloseCode('logout'), 1000);
});

test('diğer nedenlerde soket açık kalır', () => {
  for (const reason of ['idle', 'max', 'closed', 'exit', 'error', 'detached_timeout'] as const) {
    assert.equal(killUserCloseCode(reason), null, reason);
  }
});
