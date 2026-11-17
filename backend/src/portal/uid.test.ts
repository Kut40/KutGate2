import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { uidOf } from './uid.js';

test('uidOf: var olan kullanıcının uid değeri döner', async () => {
  assert.equal(await uidOf(userInfo().username), process.getuid?.() ?? null);
});

test('uidOf: olmayan kullanıcı ve seçenek gibi görünen ad için null döner', async () => {
  assert.equal(await uidOf('gate-olmayan-kullanici-x9'), null);
  assert.equal(await uidOf('-u'), null);
});
