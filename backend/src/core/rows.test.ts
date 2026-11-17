import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readOptionalRow, readRow, readRows, type RowSpec } from './rows.js';

interface Row {
  id: number;
  name: string;
  note: string | null;
  count: number | null;
}

const SPEC: RowSpec<Row> = { id: 'number', name: 'string', note: 'string?', count: 'number?' };

test('uygun satır aynı nesne olarak döner', () => {
  const row = { id: 1, name: 'ali', note: null, count: 3, extra: 'x' };
  assert.equal(readRow<Row>(SPEC, row), row);
});

test('null yalnız boş olabilen sütunlarda kabul edilir', () => {
  assert.doesNotThrow(() => readRow<Row>(SPEC, { id: 1, name: 'a', note: null, count: null }));
  assert.throws(() => readRow<Row>(SPEC, { id: 1, name: null, note: null, count: null }), /name/);
});

test('eksik ya da türü farklı sütun hata verir', () => {
  assert.throws(() => readRow<Row>(SPEC, { id: 1, note: null, count: null }), /name/);
  assert.throws(() => readRow<Row>(SPEC, { id: '1', name: 'a', note: null, count: null }), /id/);
  assert.throws(() => readRow<Row>(SPEC, { id: 1, name: 'a', note: 5, count: null }), /note/);
  assert.throws(() => readRow<Row>(SPEC, null));
});

test('readOptionalRow undefined için undefined döner', () => {
  assert.equal(readOptionalRow<Row>(SPEC, undefined), undefined);
});

test('SQLite satırları okunur', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, note TEXT, count INTEGER)');
  db.prepare('INSERT INTO t(name, note, count) VALUES (?, ?, ?)').run('ali', null, 2);
  db.prepare('INSERT INTO t(name, note, count) VALUES (?, ?, ?)').run('veli', 'not', null);
  const rows = readRows<Row>(SPEC, db.prepare('SELECT id, name, note, count FROM t ORDER BY id').all());
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { id: 1, name: 'ali', note: null, count: 2 },
      { id: 2, name: 'veli', note: 'not', count: null },
    ],
  );
  assert.equal(readOptionalRow<Row>(SPEC, db.prepare('SELECT id, name, note, count FROM t WHERE id = ?').get(9)), undefined);
  db.close();
});
