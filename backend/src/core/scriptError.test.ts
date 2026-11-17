import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptErrorLine } from './scriptError.js';

test('betiğin die ile yazdığı son satır seçilir', () => {
  const stderr = [
    'Adding user `ali` to group `gate-proj-x` ...',
    'grant: ilk hata',
    'Done.',
    'grant: modül klasörü yok: x',
    'useradd: warning',
  ].join('\n');
  assert.equal(scriptErrorLine('grant', stderr), 'grant: modül klasörü yok: x');
});

test('die satırı yoksa son boş olmayan satır seçilir', () => {
  assert.equal(scriptErrorLine('user-add', 'ilk\n\nikinci satır  \n\n'), 'ikinci satır');
  assert.equal(scriptErrorLine('user-add', 'geçersiz argüman: user-add'), 'geçersiz argüman: user-add');
  assert.equal(scriptErrorLine('grant', 'Adding user\nzaman aşımı (30 sn)'), 'zaman aşımı (30 sn)');
});

test('başka betiğin öneki eşleşmez', () => {
  assert.equal(scriptErrorLine('key-add', 'key-del: yok\nson'), 'son');
});

test('boş stderr için sabit ileti döner', () => {
  assert.equal(scriptErrorLine('user-del', ''), 'user-del: başarısız');
  assert.equal(scriptErrorLine('user-del', ' \n\n'), 'user-del: başarısız');
});
