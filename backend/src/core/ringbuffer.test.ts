import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropLeadingBytes, RING_BUFFER_BYTES, RingBuffer } from './ringbuffer.js';

test('varsayılan sınır 256 KB', () => {
  assert.equal(RING_BUFFER_BYTES, 256 * 1024);
});

test('sınırın altında tüm çıktı korunur', () => {
  const r = new RingBuffer();
  r.push('merhaba ');
  r.push('');
  r.push('dünya');
  assert.equal(r.toString(), 'merhaba dünya');
  assert.equal(r.byteLength, Buffer.byteLength('merhaba dünya', 'utf8'));
});

test('256 KB aşılınca yalnızca son 256 KB kalır', () => {
  const r = new RingBuffer();
  const block = 'a'.repeat(1000) + 'b'.repeat(24);
  let all = '';
  for (let i = 0; i < 300; i++) {
    const chunk = `${i % 10}` + block;
    r.push(chunk);
    all += chunk;
  }
  assert.equal(r.byteLength, RING_BUFFER_BYTES);
  assert.equal(r.toString(), all.slice(all.length - RING_BUFFER_BYTES));
});

test('tek parça sınırdan büyükse sonu tutulur', () => {
  const r = new RingBuffer();
  const big = 'x'.repeat(RING_BUFFER_BYTES) + 'SON';
  r.push(big);
  assert.equal(r.byteLength, RING_BUFFER_BYTES);
  assert.ok(r.toString().endsWith('SON'));
});

test('iki baytlı karakter bölünmeden kırpılır', () => {
  const r = new RingBuffer(10);
  r.push('ğ'.repeat(6));
  assert.equal(r.toString(), 'ğ'.repeat(5));
  assert.equal(r.byteLength, 10);
});

test('üç baytlı karakter bölünmeden kırpılır', () => {
  const r = new RingBuffer(10);
  r.push('€€€€');
  assert.equal(r.toString(), '€€€');
  assert.equal(r.byteLength, 9);
});

test('dört baytlı (vekil çift) karakter bölünmeden kırpılır', () => {
  const r = new RingBuffer(10);
  r.push('😀😀😀');
  assert.equal(r.toString(), '😀😀');
  assert.equal(r.byteLength, 8);
  assert.doesNotMatch(r.toString(), /^[\uDC00-\uDFFF]/);
});

test('256 KB sınırında çok baytlı içerik geçerli UTF-8 kalır', () => {
  const r = new RingBuffer();
  for (let i = 0; i < 200; i++) r.push('ş€😀a'.repeat(250));
  const s = r.toString();
  assert.ok(r.byteLength <= RING_BUFFER_BYTES);
  assert.ok(r.byteLength > RING_BUFFER_BYTES - 4);
  assert.equal(Buffer.byteLength(s, 'utf8'), r.byteLength);
  assert.equal(Buffer.from(s, 'utf8').toString('utf8'), s);
  assert.doesNotMatch(s, /^[\uDC00-\uDFFF]/);
});

test('dropLeadingBytes karakter sınırında keser', () => {
  assert.deepEqual(dropLeadingBytes('ğab', 1), { text: 'ab', removed: 2 });
  assert.deepEqual(dropLeadingBytes('abc', 2), { text: 'c', removed: 2 });
  assert.deepEqual(dropLeadingBytes('😀x', 1), { text: 'x', removed: 4 });
  assert.deepEqual(dropLeadingBytes('abc', 0), { text: 'abc', removed: 0 });
});

test('clear tamponu boşaltır', () => {
  const r = new RingBuffer();
  r.push('abc');
  r.clear();
  assert.equal(r.toString(), '');
  assert.equal(r.byteLength, 0);
});
