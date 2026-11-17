import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, validateSkill } from './validate.js';
import { firstSentence, templateSkill } from './template.js';

const good = '---\nname: my-skill\ndescription: Dosyaları özetler.\n---\n\n# Gövde\n';

test('geçerli skill kabul edilir', () => {
  assert.deepEqual(validateSkill('my-skill', good), { ok: true, errors: [] });
});

test('frontmatter yoksa hata', () => {
  const r = validateSkill('my-skill', '# başlık\nmetin');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('frontmatter')));
});

test('kapanmayan frontmatter hata', () => {
  const r = validateSkill('my-skill', '---\nname: my-skill\ndescription: x\n');
  assert.equal(r.ok, false);
});

test('name klasör adıyla aynı olmalı', () => {
  const r = validateSkill('other-skill', good);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('name')));
});

test('description boş, TODO veya uzun olamaz', () => {
  assert.equal(validateSkill('my-skill', '---\nname: my-skill\ndescription:\n---\n').ok, false);
  assert.equal(validateSkill('my-skill', '---\nname: my-skill\ndescription: TODO\n---\n').ok, false);
  const long = 'a'.repeat(1025);
  assert.equal(validateSkill('my-skill', `---\nname: my-skill\ndescription: ${long}\n---\n`).ok, false);
  const max = 'a'.repeat(1024);
  assert.equal(validateSkill('my-skill', `---\nname: my-skill\ndescription: ${max}\n---\n`).ok, true);
});

test('içerik 200 KB sınırı', () => {
  const big = good + 'x'.repeat(200 * 1024);
  const r = validateSkill('my-skill', big);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('200 KB')));
});

test('geçersiz ad reddedilir', () => {
  assert.equal(validateSkill('My_Skill', good.replace('my-skill', 'My_Skill')).ok, false);
  assert.equal(validateSkill('a', good.replace('my-skill', 'a')).ok, false);
});

test('tırnaklı ve blok description ayrıştırılır', () => {
  assert.equal(parseFrontmatter('---\nname: x\ndescription: "a: b"\n---\n')?.description, 'a: b');
  assert.equal(parseFrontmatter('---\nname: x\ndescription: >\n  satır bir\n  satır iki\n---\n')?.description, 'satır bir satır iki');
});

test('şablon çıktısı doğrulamadan geçer', () => {
  const src = 'Git commit mesajlarını düzenler. Ayrıntılı kurallar burada.';
  assert.equal(firstSentence(src), 'Git commit mesajlarını düzenler.');
  const content = templateSkill('git-commit', src);
  assert.deepEqual(validateSkill('git-commit', content), { ok: true, errors: [] });
});
