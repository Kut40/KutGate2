import test from 'node:test';
import assert from 'node:assert/strict';
import { isTreePath, parseTreeOutput } from './tree.js';

test('isTreePath: geçerli göreli yollar', () => {
  for (const p of ['', 'src', 'src/portal', 'a b/ç.ts', '.github/workflows']) assert.equal(isTreePath(p), true, p);
});

test('isTreePath: proje dışına çıkan ve bozuk yollar reddedilir', () => {
  for (const p of ['/etc', '..', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', 'a\nb', 'a\u0000b', 'x'.repeat(1025), 5, null, undefined, ['a']]) {
    assert.equal(isTreePath(p), false, String(p));
  }
});

test('parseTreeOutput: yalnızca izinli alanlar geçer', () => {
  const out = parseTreeOutput(
    JSON.stringify({
      ok: true,
      truncated: true,
      secret: 'x',
      entries: [
        { n: 'src', t: 'd', content: 'GIZLI' },
        { n: 'a.ts', t: 'f', s: 12, content: 'GIZLI' },
        { n: 'bag', t: 'l' },
        { n: 'soket', t: 's' },
        { n: '../kacis', t: 'f' },
        { t: 'f' },
      ],
    }),
  );
  assert.deepEqual(out, {
    truncated: true,
    entries: [
      { name: 'src', type: 'dir' },
      { name: 'a.ts', type: 'file', size: 12 },
      { name: 'bag', type: 'link' },
    ],
  });
  assert.equal(JSON.stringify(out).includes('GIZLI'), false);
});

test('parseTreeOutput: geçersiz çıktı null döner', () => {
  for (const s of ['', 'x', '{}', '{"ok":false,"entries":[]}', '{"ok":true}', 'null']) assert.equal(parseTreeOutput(s), null, s);
});
