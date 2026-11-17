import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_ID_RE, chatTitle, deletedDirOf, listArchivedChats, listDeletedChats, moveChatToDeleted, readChatTitle, readDeletedChat, titleOfUserEvent } from './chatArchive.js';

test('sohbet kimliği yol kaçışına izin vermez', () => {
  assert.equal(CHAT_ID_RE.test('0123456789abcdef'), true);
  for (const id of ['../../etc/passwd', '0123456789abcde', '0123456789ABCDEF', '0123456789abcdef/', '']) {
    assert.equal(CHAT_ID_RE.test(id), false, id);
  }
});

test('başlık kısaltılır, boşluklar temizlenir, boşsa varsayılan döner', () => {
  assert.equal(chatTitle('  merhaba\n  dünya '), 'merhaba dünya');
  assert.equal(chatTitle(''), 'Yeni sohbet');
  assert.equal(chatTitle(null), 'Yeni sohbet');
  assert.equal(chatTitle('ç'.repeat(80)), `${'ç'.repeat(60)}…`);
  assert.equal(titleOfUserEvent({ text: '', attachments: [{ name: 'resim.png' }] }), 'resim.png');
});

test('liste yeniden eskiye sıralanır, geçersiz dosyalar atlanır', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-arsiv-'));
  try {
    const a = join(dir, 'aaaaaaaaaaaaaaaa.jsonl');
    const b = join(dir, 'bbbbbbbbbbbbbbbb.jsonl');
    writeFileSync(a, `${JSON.stringify({ kind: 'meta', claudeSessionId: null })}\n${JSON.stringify({ kind: 'user', id: 'u', ts: 1, text: 'eski soru' })}\n`);
    writeFileSync(b, `${JSON.stringify({ kind: 'user', id: 'u', ts: 2, text: 'yeni soru' })}\n`);
    utimesSync(a, new Date(1000), new Date(1000));
    utimesSync(b, new Date(2000), new Date(2000));
    writeFileSync(join(dir, 'gecersiz-ad.jsonl'), 'x');
    writeFileSync(join(dir, 'cccccccccccccccc.txt'), 'x');
    mkdirSync(join(dir, 'dddddddddddddddd.jsonl'));
    symlinkSync('/etc/passwd', join(dir, 'eeeeeeeeeeeeeeee.jsonl.bag'));
    const list = listArchivedChats(dir);
    assert.deepEqual(list.map((c) => c.title), ['yeni soru', 'eski soru']);
    assert.deepEqual(list.map((c) => c.id), ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
    assert.equal(listArchivedChats(dir, 1).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('olmayan klasör ve dosya hata vermez', () => {
  assert.deepEqual(listArchivedChats('/yok/klasor'), []);
  assert.equal(readChatTitle('/yok/dosya'), 'Yeni sohbet');
});

test('silinen sohbet kullanıcı listesinden kalkar, yönetici kaydında kalır', () => {
  const data = mkdtempSync(join(tmpdir(), 'kg-silinen-'));
  try {
    const arc = join(data, 'arsiv');
    mkdirSync(arc);
    const id = 'aaaaaaaaaaaaaaaa';
    const file = join(arc, `${id}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ kind: 'user', id: 'u', ts: 1, text: 'gizli soru' })}\n${JSON.stringify({ kind: 'text', id: 't', ts: 2, text: 'ilk', done: false })}\n${JSON.stringify({ kind: 'text', id: 't', ts: 2, text: 'son', done: true })}\n${JSON.stringify({ kind: 'meta', claudeSessionId: null })}\n`,
    );
    moveChatToDeleted(file, data, 'ornek', id, 5000);
    assert.equal(existsSync(file), false);
    assert.deepEqual(listArchivedChats(arc), []);
    assert.equal(existsSync(join(deletedDirOf(data, 'ornek'), `${id}.jsonl`)), true);
    const list = listDeletedChats(data);
    assert.equal(list.length, 1);
    assert.equal(list[0].username, 'ornek');
    assert.equal(list[0].title, 'gizli soru');
    const chat = readDeletedChat(data, 'ornek', id);
    assert.deepEqual(chat?.events.map((e) => (e as { kind: string }).kind), ['user', 'text']);
    assert.equal((chat?.events[1] as { text: string }).text, 'son');
    for (const [u, i] of [['../..', id], ['ornek', '../../x'], ['ornek', 'bbbbbbbbbbbbbbbb'], [5, id]] as const) {
      assert.equal(readDeletedChat(data, u, i), null);
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
