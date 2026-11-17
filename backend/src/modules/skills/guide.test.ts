import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CREATOR_PATH, extractGuide, loadCreatorGuide } from './guide.js';
import { buildPrompt } from './index.js';

const body = 'x'.repeat(300);

test('extractGuide: Write the SKILL.md ile Test Cases arasını alır', () => {
  const md = `# A\n### Write the SKILL.md\n${body}\n### Test Cases\nTESTLER`;
  const g = extractGuide(md);
  assert.ok(g?.startsWith('### Write the SKILL.md'));
  assert.ok(!g?.includes('TESTLER'));
});

test('extractGuide: başlık yoksa ya da çok kısaysa null', () => {
  assert.equal(extractGuide('# başka dosya'), null);
  assert.equal(extractGuide('### Write the SKILL.md\nkısa\n### Test Cases'), null);
});

test('loadCreatorGuide: dosya yoksa null', async () => {
  assert.equal(await loadCreatorGuide('/yok/skill-creator/SKILL.md'), null);
});

test('loadCreatorGuide: kurulu skill-creator okunur', async (t) => {
  try {
    await readFile(CREATOR_PATH);
  } catch {
    t.skip('skill-creator kurulu değil');
    return;
  }
  const g = await loadCreatorGuide();
  assert.ok(g && g.includes('description'));
});

test('buildPrompt: rehber varsa komuta eklenir, yoksa eklenmez', () => {
  const withGuide = buildPrompt('ornek', 'kaynak metin', 'REHBER-METNİ');
  assert.ok(withGuide.includes('<skill-creator-rehberi>') && withGuide.includes('REHBER-METNİ'));
  assert.ok(withGuide.includes('name alanı tam olarak "ornek"'));
  assert.ok(!buildPrompt('ornek', 'kaynak metin').includes('skill-creator-rehberi'));
});
