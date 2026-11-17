import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ONLY_SUMMARY,
  AGENT_TEXT_MAX,
  basicSummary,
  clipText,
  extractAgentText,
  SUMMARY_MAX,
  validateSummary,
} from './devlog.js';
import { formatFileList } from './board.js';

const SINCE = Date.parse('2026-11-08T10:00:00.000Z');

function line(v: unknown): string {
  return JSON.stringify(v);
}

const JSONL = [
  line({
    type: 'user',
    timestamp: '2026-11-08T09:59:59.000Z',
    message: { role: 'user', content: 'eski mesaj' },
  }),
  line({
    type: 'user',
    timestamp: '2026-11-08T10:00:00.000Z',
    message: { role: 'user', content: 'giriş formunu düzelt' },
  }),
  line({
    type: 'assistant',
    timestamp: '2026-11-08T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Formu inceliyorum.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/srv/projects/demo/GIZLI.ts' } },
      ],
    },
  }),
  line({
    type: 'user',
    timestamp: '2026-11-08T10:00:06.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'const sifre = "ARAC_CIKTISI";' }],
    },
  }),
  line({
    type: 'assistant',
    timestamp: '2026-11-08T10:00:07.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'DUSUNCE' }, { type: 'text', text: 'Düzelttim.' }] },
  }),
  line({ type: 'summary', summary: 'OZET_SATIRI' }),
  'bozuk json {',
  '',
].join('\n');

test('ajan kaydı: since sonrası yalnızca kullanıcı/asistan metinleri alınır', () => {
  assert.equal(
    extractAgentText(JSONL, SINCE),
    ['Kullanıcı: giriş formunu düzelt', 'Asistan: Formu inceliyorum.', 'Asistan: Düzelttim.'].join('\n'),
  );
});

test('ajan kaydı: araç girdileri ve çıktıları dışlanır', () => {
  const out = extractAgentText(JSONL, SINCE);
  assert.ok(!out.includes('eski mesaj'));
  assert.ok(!out.includes('GIZLI'));
  assert.ok(!out.includes('ARAC_CIKTISI'));
  assert.ok(!out.includes('DUSUNCE'));
  assert.ok(!out.includes('OZET_SATIRI'));
});

test('ajan kaydı: since sonrası kayıt yoksa boş metin', () => {
  assert.equal(extractAgentText(JSONL, Date.parse('2026-11-08T11:00:00.000Z')), '');
});

test('ajan metni 12000 karakterde sondan kırpılır', () => {
  const s = 'a'.repeat(AGENT_TEXT_MAX) + 'SON';
  const out = clipText(s);
  assert.equal(out.length, AGENT_TEXT_MAX);
  assert.ok(!out.includes('SON'));
  assert.equal(clipText('kısa'), 'kısa');
});

test('özet doğrulama: ``` içeren çıktı reddedilir', () => {
  assert.equal(validateSummary('Özet:\n```js\nx\n```'), null);
});

test('özet doğrulama: boş çıktı reddedilir', () => {
  assert.equal(validateSummary(''), null);
  assert.equal(validateSummary('  \n\t '), null);
  assert.equal(validateSummary(null), null);
});

test('özet doğrulama: tek paragraf ve 400 karakter kırpma', () => {
  assert.equal(validateSummary('  Birinci cümle.\n\nİkinci cümle.  '), 'Birinci cümle. İkinci cümle.');
  const out = validateSummary('ç'.repeat(500));
  assert.ok(out !== null);
  assert.equal(Array.from(out ?? '').length, SUMMARY_MAX);
});

test('basic mod metinleri', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
  assert.equal(basicSummary(7, files), '7 dosyada değişiklik: a.ts, b.ts, c.ts, d.ts, e.ts');
  assert.equal(basicSummary(2, ['x.py', 'y.py']), '2 dosyada değişiklik: x.py, y.py');
  assert.equal(AGENT_ONLY_SUMMARY, 'Ajanla çalışıldı, dosya değişikliği yok.');
});

test('dosya listesi: en fazla 10 ad, fazlası +K', () => {
  const files = Array.from({ length: 50 }, (_, i) => `f${i + 1}`);
  assert.equal(formatFileList(files.slice(0, 3), 3), 'f1, f2, f3');
  assert.equal(formatFileList(files.slice(0, 10), 10), 'f1, f2, f3, f4, f5, f6, f7, f8, f9, f10');
  assert.equal(formatFileList(files.slice(0, 12), 12), 'f1, f2, f3, f4, f5, f6, f7, f8, f9, f10 +2');
  assert.equal(formatFileList(files, 75), 'f1, f2, f3, f4, f5, f6, f7, f8, f9, f10 +65');
});
