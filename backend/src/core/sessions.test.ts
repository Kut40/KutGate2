import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CastRecorder,
  castEvent,
  castHeader,
  castOutput,
  expiredReason,
  LiveHub,
  readCastOutput,
  sessionDeadline,
} from './sessions.js';

const MIN = 60 * 1000;

test('asciicast başlık satırı biçimi', () => {
  const line = castHeader(120, 40, 1700000000, 'ali');
  assert.equal(
    line,
    '{"version":2,"width":120,"height":40,"timestamp":1700000000,"env":{"TERM":"xterm-256color"},"title":"ali"}',
  );
  assert.ok(!line.includes('\n'));
});

test('asciicast olay satırı biçimi', () => {
  assert.equal(castEvent(1.5, 'o', 'merhaba\r\n'), '[1.5,"o","merhaba\\r\\n"]');
  assert.equal(castEvent(0, 'i', 'ls\r'), '[0,"i","ls\\r"]');
  assert.deepEqual(JSON.parse(castEvent(2.1234567891, 'o', 'x')), [2.123457, 'o', 'x']);
  assert.deepEqual(JSON.parse(castEvent(-1, 'o', 'x')), [0, 'o', 'x']);
});

test('olay satırı kontrol karakterlerini ve tırnakları kaçırır, tek satırdır', () => {
  const line = castEvent(3, 'o', '\x1b[31m"a"\nb\u0000');
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line), [3, 'o', '\x1b[31m"a"\nb\u0000']);
});

test('castOutput yalnızca "o" olaylarını birleştirir', () => {
  const text = [
    castHeader(80, 24, 1, 'ali'),
    castEvent(0.1, 'o', 'a'),
    castEvent(0.2, 'i', 'gizli'),
    castEvent(0.3, 'o', 'b'),
    'bozuk satır',
    '',
  ].join('\n');
  assert.equal(castOutput(text), 'ab');
  assert.equal(castOutput(''), '');
  assert.equal(castOutput(castHeader(80, 24, 1, 'ali') + '\n'), '');
});

test('sessionDeadline: boşta süresi önce dolarsa idle', () => {
  const d = sessionDeadline(0, 10 * MIN, 15 * MIN, 240 * MIN);
  assert.deepEqual(d, { at: 25 * MIN, reason: 'idle' });
});

test('sessionDeadline: toplam süre önce dolarsa max', () => {
  const d = sessionDeadline(0, 230 * MIN, 15 * MIN, 240 * MIN);
  assert.deepEqual(d, { at: 240 * MIN, reason: 'max' });
});

test('sessionDeadline: eşitlikte max öncelikli', () => {
  assert.equal(sessionDeadline(0, 225 * MIN, 15 * MIN, 240 * MIN).reason, 'max');
});

test('expiredReason sınırları', () => {
  const idle = 15 * MIN;
  const max = 240 * MIN;
  assert.equal(expiredReason(14 * MIN, 0, 0, idle, max), null);
  assert.equal(expiredReason(15 * MIN, 0, 0, idle, max), 'idle');
  assert.equal(expiredReason(20 * MIN, 0, 10 * MIN, idle, max), null);
  assert.equal(expiredReason(240 * MIN, 0, 239 * MIN, idle, max), 'max');
  assert.equal(expiredReason(300 * MIN, 0, 0, idle, max), 'max');
});

test('etkinlik boşta zamanlayıcısını ileri iter', () => {
  const idle = 15 * MIN;
  const max = 240 * MIN;
  let last = 0;
  const first = sessionDeadline(0, last, idle, max);
  last = 14 * MIN;
  assert.equal(expiredReason(first.at, 0, last, idle, max), null);
  const next = sessionDeadline(0, last, idle, max);
  assert.equal(next.at, 29 * MIN);
  assert.equal(expiredReason(next.at, 0, last, idle, max), 'idle');
});

test('LiveHub yayın, abonelik ve kapanış', () => {
  const hub = new LiveHub();
  const got: string[] = [];
  let ended = 0;
  assert.equal(hub.subscribe('x', { data: () => {}, end: () => {} }), null);
  hub.open('x');
  assert.equal(hub.isLive('x'), true);
  assert.deepEqual(hub.ids(), ['x']);
  const off = hub.subscribe('x', { data: (c) => got.push(c), end: () => ended++ });
  assert.ok(off);
  hub.publish('x', 'a');
  hub.publish('x', 'b');
  assert.deepEqual(got, ['a', 'b']);
  off();
  hub.publish('x', 'c');
  assert.deepEqual(got, ['a', 'b']);
  hub.subscribe('x', { data: () => {}, end: () => ended++ });
  hub.close('x');
  assert.equal(ended, 1);
  assert.equal(hub.isLive('x'), false);
  assert.deepEqual(hub.ids(), []);
});

test('CastRecorder kayıt dosyası biçimi aynı kalır', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cast-'));
  try {
    const file = join(dir, 'a.cast');
    let t = 1_700_000_000_000;
    const rec = new CastRecorder(file, 'ali', () => t);
    rec.resize(120, 40);
    t += 1500;
    rec.output('merhaba');
    rec.resize(10, 10);
    t += 500;
    rec.input('ls\r');
    rec.output('');
    await rec.close();
    await rec.close();
    rec.output('kapandıktan sonra');
    assert.equal(
      readFileSync(file, 'utf8'),
      [castHeader(120, 40, 1700000000, 'ali'), castEvent(1.5, 'o', 'merhaba'), castEvent(2, 'i', 'ls\r'), ''].join('\n'),
    );
    assert.throws(() => new CastRecorder(file, 'ali'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CastRecorder olay yoksa kapanışta yalnız başlık yazar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cast-'));
  try {
    const file = join(dir, 'b.cast');
    const rec = new CastRecorder(file, 'veli', () => 5000);
    await rec.close();
    assert.equal(readFileSync(file, 'utf8'), castHeader(80, 24, 5, 'veli') + '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCastOutput yalnız son kısmı okur, yarım satırı atlar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cast-'));
  try {
    const file = join(dir, 'c.cast');
    const lines = [castHeader(80, 24, 1, 'ali')];
    for (let i = 0; i < 100; i++) lines.push(castEvent(i, 'o', `satır-${i};`));
    writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(readCastOutput(file), Array.from({ length: 100 }, (_, i) => `satır-${i};`).join(''));
    const tail = Buffer.byteLength(lines.slice(-3).join('\n') + '\n', 'utf8');
    assert.equal(readCastOutput(file, tail), 'satır-97;satır-98;satır-99;');
    assert.equal(readCastOutput(file, tail - 1), 'satır-98;satır-99;');
    assert.equal(readCastOutput(join(dir, 'yok.cast')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
