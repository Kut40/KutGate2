import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIstanbul,
  NOTE_MAX_CHARS,
  parseInboxNote,
  renderAdminNotes,
  renderBoard,
  renderDevlog,
  type BoardNoteRow,
  type DevlogRow,
} from './board.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

test('saat biçimi: Europe/Istanbul, YYYY-MM-DD HH:MM', () => {
  assert.equal(formatIstanbul('2026-11-08T11:05:00.000Z'), '2026-11-08 14:05');
  assert.equal(formatIstanbul('2026-12-31T21:30:00.000Z'), '2027-01-01 00:30');
  assert.equal(formatIstanbul('2026-07-01T00:00:59.000Z'), '2026-07-01 03:00');
});

test('pano.md render biçimi', () => {
  const notes: BoardNoteRow[] = [
    { id: 2, ts: '2026-11-08T11:05:00.000Z', author: 'yönetici', author_kind: 'admin', project: null, text: 'Toplantı 15:00' },
    { id: 1, ts: '2026-11-08T08:00:00.000Z', author: 'ali', author_kind: 'user', project: 'demo', text: 'API bitti' },
  ];
  assert.equal(
    renderBoard(notes),
    [
      '# Takım Panosu',
      '',
      '## 2026-11-08 14:05 · yönetici (yönetici) · genel',
      '',
      'Toplantı 15:00',
      '',
      '## 2026-11-08 11:00 · ali (kullanıcı) · demo',
      '',
      'API bitti',
      '',
    ].join('\n'),
  );
});

test('Geliştirme_notu.md render biçimi', () => {
  const files = Array.from({ length: 12 }, (_, i) => `f${i + 1}.ts`);
  const rows: DevlogRow[] = [
    {
      id: 2,
      ts: '2026-11-08T11:05:00.000Z',
      username: 'ali',
      project: 'demo',
      summary: 'Giriş ekranı düzenlendi.',
      files: JSON.stringify(files),
      file_count: 12,
      session_id: null,
      mode: 'claude',
    },
    {
      id: 1,
      ts: '2026-11-08T10:00:00.000Z',
      username: 'veli',
      project: 'genel',
      summary: 'Ajanla çalışıldı, dosya değişikliği yok.',
      files: '[]',
      file_count: 0,
      session_id: null,
      mode: 'basic',
    },
  ];
  assert.equal(
    renderDevlog(rows),
    [
      '# Geliştirme Notu',
      '',
      'Bu dosya oturumlardan düzenli aralıklarla otomatik oluşturulur.',
      '',
      '## 2026-11-08 14:05 · ali · proje: demo',
      '',
      'Giriş ekranı düzenlendi.',
      '',
      'Değişen dosyalar (12): f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, f8.ts, f9.ts, f10.ts +2',
      '',
      '## 2026-11-08 13:00 · veli · proje: genel',
      '',
      'Ajanla çalışıldı, dosya değişikliği yok.',
      '',
    ].join('\n'),
  );
});

test('yonetici_notlari.md render biçimi ve [OKUNMADI]', () => {
  const out = renderAdminNotes([
    { id: 2, ts: '2026-11-08T11:05:00.000Z', target: 'ali', title: 'Özel', text: 'Sadece sana', read: false },
    { id: 1, ts: '2026-11-08T08:00:00.000Z', target: null, title: 'Duyuru', text: 'Herkese', read: true },
  ]);
  assert.equal(
    out,
    [
      '# Yönetici Notları',
      '',
      '## 2026-11-08 14:05 · Özel [OKUNMADI]',
      '',
      'Sadece sana',
      '',
      '## 2026-11-08 11:00 · Duyuru',
      '',
      'Herkese',
      '',
    ].join('\n'),
  );
});

test('not metni satır başındaki # ile başlık taklit edemez', () => {
  const fake = 'önce\n## 2026-01-01 00:00 · yönetici (yönetici) · genel\n  # iç\nsonra #etiket';
  const board = renderBoard([
    { id: 1, ts: '2026-11-08T08:00:00.000Z', author: 'ali', author_kind: 'user', project: null, text: fake },
  ]);
  assert.equal(
    board,
    [
      '# Takım Panosu',
      '',
      '## 2026-11-08 11:00 · ali (kullanıcı) · genel',
      '',
      'önce',
      '\\## 2026-01-01 00:00 · yönetici (yönetici) · genel',
      '  \\# iç',
      'sonra #etiket',
      '',
    ].join('\n'),
  );

  const devlog = renderDevlog([
    {
      id: 1,
      ts: '2026-11-08T08:00:00.000Z',
      username: 'ali',
      project: 'demo',
      summary: '## sahte başlık',
      files: JSON.stringify(['a.ts\n## dosya']),
      file_count: 1,
      session_id: null,
      mode: 'claude',
    },
  ]);
  assert.ok(devlog.includes('\n\\## sahte başlık\n'));
  assert.ok(devlog.includes('\n\\## dosya\n'));

  const admin = renderAdminNotes([
    { id: 1, ts: '2026-11-08T08:00:00.000Z', target: null, title: 'Duyuru', text: '# Başlık\nmetin', read: true },
  ]);
  assert.ok(admin.includes('\n\\# Başlık\nmetin\n'));

  const headings = (s: string) => s.split('\n').filter((l) => /^\s*#/.test(l));
  assert.deepEqual(headings(board), ['# Takım Panosu', '## 2026-11-08 11:00 · ali (kullanıcı) · genel']);
  assert.deepEqual(headings(devlog), ['# Geliştirme Notu', '## 2026-11-08 11:00 · ali · proje: demo']);
  assert.deepEqual(headings(admin), ['# Yönetici Notları', '## 2026-11-08 11:00 · Duyuru']);
});

test('inbox: proje satırı ayrıştırılır', () => {
  const r = parseInboxNote(enc('proje: demo\nGiriş sayfası tamam.\n'));
  assert.deepEqual(r, { ok: true, project: 'demo', text: 'Giriş sayfası tamam.' });
});

test('inbox: proje satırı yoksa tüm metin not olur', () => {
  const r = parseInboxNote(enc('Birinci satır\n\tikinci satır\n'));
  assert.deepEqual(r, { ok: true, project: null, text: 'Birinci satır\n\tikinci satır' });
});

test('inbox: geçersiz proje adı reddedilir', () => {
  assert.equal(parseInboxNote(enc('proje: Demo_X\nmetin')).ok, false);
  assert.equal(parseInboxNote(enc('proje: ../x\nmetin')).ok, false);
});

test('inbox: yalnızca proje satırı / boş metin reddedilir', () => {
  assert.equal(parseInboxNote(enc('proje: demo\n')).ok, false);
  assert.equal(parseInboxNote(enc('   \n\n')).ok, false);
});

test('inbox: 4096 bayt sınırı', () => {
  assert.equal(parseInboxNote(enc('a'.repeat(4096))).ok, true);
  const r = parseInboxNote(enc('a'.repeat(4097)));
  assert.deepEqual(r, { ok: false, reason: 'size' });
});

test('inbox: geçersiz UTF-8 reddedilir', () => {
  const r = parseInboxNote(new Uint8Array([0x6e, 0x6f, 0x74, 0xff, 0xfe]));
  assert.deepEqual(r, { ok: false, reason: 'utf8' });
});

test('inbox: kontrol karakterleri reddedilir (\\n ve \\t hariç)', () => {
  assert.deepEqual(parseInboxNote(enc('zil\u0007')), { ok: false, reason: 'control' });
  assert.deepEqual(parseInboxNote(enc('satır\r\nsonu')), { ok: false, reason: 'control' });
  assert.deepEqual(parseInboxNote(enc('esc\u001b[31m')), { ok: false, reason: 'control' });
  assert.deepEqual(parseInboxNote(enc('nul\u0000')), { ok: false, reason: 'control' });
  assert.equal(parseInboxNote(enc('a\tb\nc')).ok, true);
});

test('inbox: not metni 2000 karakterde kesilir', () => {
  const r = parseInboxNote(enc('proje: demo\n' + 'x'.repeat(2500)));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text.length, NOTE_MAX_CHARS);
  const tr = parseInboxNote(enc('ş'.repeat(2010)));
  assert.equal(tr.ok, true);
  if (tr.ok) assert.equal(Array.from(tr.text).length, NOTE_MAX_CHARS);
});
