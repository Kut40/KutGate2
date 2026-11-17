import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanOutCreateFailed, fanOutDeleteFailed, resolveTarget, targetFiles } from './target.js';

test('yayılım oluşturma: yalnızca hiç yazılamadıysa başarısız', () => {
  assert.equal(fanOutCreateFailed({ written: 0, failed: ['ali'] }), true);
  assert.equal(fanOutCreateFailed({ written: 1, failed: ['ali'] }), false);
  assert.equal(fanOutCreateFailed({ written: 2, failed: [] }), false);
  assert.equal(fanOutCreateFailed({ written: 0, failed: [] }), false);
});

test('yayılım silme: bir kullanıcı bile kalırsa kayıt korunur', () => {
  assert.equal(fanOutDeleteFailed(['ali']), true);
  assert.equal(fanOutDeleteFailed([]), false);
});

const roots = { homeRoot: '/home', rulesRoot: '/opt/claude-rules' };

test("rules + '*' global olarak çözülür", () => {
  const t = resolveTarget('rules', '*');
  assert.deepEqual(t, { kind: 'global', user: '' });
  if (typeof t === 'string') return;
  assert.deepEqual(targetFiles(roots, t, 'my-skill', ['ali', 'veli']), [
    { user: null, path: '/opt/claude-rules/global/skills/my-skill/SKILL.md' },
  ]);
});

test("home + '*' tüm kullanıcılara dağıtılır", () => {
  const t = resolveTarget('home', '*');
  assert.deepEqual(t, { kind: 'home', user: '*' });
  if (typeof t === 'string') return;
  assert.deepEqual(targetFiles(roots, t, 'my-skill', ['ali', 'veli']), [
    { user: 'ali', path: '/home/ali/.claude/skills/my-skill/SKILL.md' },
    { user: 'veli', path: '/home/veli/.claude/skills/my-skill/SKILL.md' },
  ]);
  assert.deepEqual(targetFiles(roots, t, 'my-skill', []), []);
});

test('tek kullanıcı hedefi tek dosya üretir', () => {
  const t = resolveTarget('rules', 'ali');
  assert.deepEqual(t, { kind: 'rules', user: 'ali' });
  if (typeof t === 'string') return;
  assert.deepEqual(targetFiles(roots, t, 'my-skill', ['ali', 'veli']), [
    { user: 'ali', path: '/opt/claude-rules/users/ali/skills/my-skill/SKILL.md' },
  ]);
});

test('geçersiz kullanıcı adı reddedilir', () => {
  for (const u of ['Ali', 'a', '../x', '**', '', undefined, null, 5, 'ali/veli', '1abc']) {
    assert.equal(typeof resolveTarget('home', u), 'string');
    assert.equal(typeof resolveTarget('rules', u), 'string');
  }
});

test('geçersiz tür ve kullanıcılı global reddedilir', () => {
  assert.equal(typeof resolveTarget('other', 'ali'), 'string');
  assert.equal(typeof resolveTarget('global', 'ali'), 'string');
  assert.deepEqual(resolveTarget('global', undefined), { kind: 'global', user: '' });
});
