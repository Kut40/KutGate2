import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAllowedExtension } from './index.js';

test('kurallar ağacı: yalnızca açılabilen uzantılar listelenir', () => {
  for (const p of ['a.md', 'b.sh', 'c.txt', 'd.json', 'alt/klasor/e.md']) assert.equal(hasAllowedExtension(p), true, p);
  for (const p of ['a.png', 'b', '.md', 'c.MD', 'd.md.bak', 'e.jsonl']) assert.equal(hasAllowedExtension(p), false, p);
});
