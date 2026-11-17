import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveList } from './live.js';

test('canlı liste: metin ve nesne kayıtları eşlenir', () => {
  const out = parseLiveList(['a', { id: 'b', attached: false }, { id: 'c', attached: true }, { id: 'd' }, 5, null, {}]);
  assert.deepEqual(
    out && [...out.entries()],
    [
      ['a', true],
      ['b', false],
      ['c', true],
      ['d', true],
    ],
  );
});

test('canlı liste: boş dizi hata değildir', () => {
  assert.equal(parseLiveList([])?.size, 0);
});

test('canlı liste: dizi olmayan yanıt bilinmiyor sayılır', () => {
  for (const v of [null, undefined, {}, 'x', 5]) assert.equal(parseLiveList(v), null);
});
