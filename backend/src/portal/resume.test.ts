import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTerminal, type SessionView } from './resume.js';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

function s(id: string, userId: number, startedMs: number, attached: boolean, ended = false): SessionView {
  return { id, userId, startedMs, attached, ended };
}

test('geçerli resume: kendi bağlantısız oturumuna bağlanır', () => {
  const d = decideTerminal({ resume: A, userId: 1, sessions: [s(A, 1, 100, false)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'resume', id: A });
});

test('geçersiz id biçimi → yeni oturum', () => {
  for (const resume of ['xyz', A.toUpperCase(), A + 'a', '', undefined, 123, [A]]) {
    const d = decideTerminal({ resume, userId: 1, sessions: [], maxConcurrent: 1 });
    assert.deepEqual(d, { kind: 'new' });
  }
});

test('bulunamayan id → yeni oturum', () => {
  const d = decideTerminal({ resume: B, userId: 1, sessions: [], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'new' });
});

test('başka kullanıcının oturumu → yeni oturum', () => {
  const d = decideTerminal({ resume: A, userId: 1, sessions: [s(A, 2, 100, false)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'new' });
});

test('bitmiş oturum → yeni oturum', () => {
  const d = decideTerminal({ resume: A, userId: 1, sessions: [s(A, 1, 100, false, true)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'new' });
});

test('bağlı oturuma resume → devralma', () => {
  const d = decideTerminal({ resume: A, userId: 1, sessions: [s(A, 1, 100, true)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'resume', id: A });
});

test('max_concurrent dolu ve bağlantısız oturum var → en eskisine bağlanır', () => {
  const sessions = [s(A, 1, 300, false), s(B, 1, 100, false), s(C, 1, 50, true)];
  const d = decideTerminal({ resume: undefined, userId: 1, sessions, maxConcurrent: 3 });
  assert.deepEqual(d, { kind: 'resume', id: B });
});

test('max_concurrent dolu, geçersiz resume ve bağlantısız oturum var → ona bağlanır', () => {
  const d = decideTerminal({ resume: 'bozuk', userId: 1, sessions: [s(A, 1, 100, false)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'resume', id: A });
});

test('max_concurrent dolu ve tümü bağlı → ret', () => {
  const d = decideTerminal({ resume: undefined, userId: 1, sessions: [s(A, 1, 100, true)], maxConcurrent: 1 });
  assert.deepEqual(d, { kind: 'reject' });
});

test('sınır altında resume yoksa yeni oturum; başka kullanıcının ve bitmiş oturumlar sayılmaz', () => {
  const sessions = [s(A, 1, 100, false), s(B, 2, 100, false), s(C, 1, 100, false, true)];
  const d = decideTerminal({ resume: undefined, userId: 1, sessions, maxConcurrent: 2 });
  assert.deepEqual(d, { kind: 'new' });
});
