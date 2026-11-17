import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../core/db.js';
import type { Config } from '../../core/types.js';
import { purgeUserRecords } from './purge.js';

type Db = ReturnType<typeof openDb>;

function addUser(db: Db, username: string): number {
  const res = db.prepare("INSERT INTO users(username, display, locked, created) VALUES (?, '', 0, '')").run(username);
  return Number(res.lastInsertRowid);
}

function addSkill(db: Db, kind: string, user: string): number {
  const res = db
    .prepare("INSERT INTO skills(name, target_kind, target_user, content) VALUES ('s', ?, ?, 'c')")
    .run(kind, user);
  const id = Number(res.lastInsertRowid);
  db.prepare("INSERT INTO skill_versions(skill_id, version, content) VALUES (?, 1, 'eski')").run(id);
  return id;
}

function addNote(db: Db, target: string | null): number {
  const res = db.prepare("INSERT INTO admin_notes(ts, target, title, text) VALUES ('', ?, 't', 'x')").run(target);
  return Number(res.lastInsertRowid);
}

function ids(db: Db, sql: string): number[] {
  return (db.prepare(sql).all() as unknown as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
}

function count(db: Db, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as unknown as { n: number }).n;
}

test('kullanıcı silme: hedefli skill ve notlar gider, ortak olanlar ve geçmiş kalır', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-purge-test-'));
  const db = openDb({ dataDir: dir } as Config);
  try {
    const ali = addUser(db, 'ali');
    const veli = addUser(db, 'veli');
    addSkill(db, 'home', 'ali');
    addSkill(db, 'rules', 'ali');
    const fanOut = addSkill(db, 'home', '*');
    const global = addSkill(db, 'global', '');
    const veliSkill = addSkill(db, 'home', 'veli');
    const aliNote = addNote(db, 'ali');
    const veliNote = addNote(db, 'veli');
    const allNote = addNote(db, null);
    const read = db.prepare("INSERT INTO admin_note_reads(note_id, username, read_ts) VALUES (?, ?, '')");
    read.run(aliNote, 'ali');
    read.run(allNote, 'ali');
    read.run(allNote, 'veli');
    read.run(veliNote, 'veli');
    db.prepare("INSERT INTO audit(ts, actor, action, detail) VALUES ('', 'ali', 'x', '')").run();
    db.prepare("INSERT INTO dev_log(ts, username, project, summary) VALUES ('', 'ali', 'p', 's')").run();
    db.prepare("INSERT INTO term_sessions(id, user_id, unit, started) VALUES ('t1', ?, 'u', '')").run(ali);
    db.prepare('INSERT INTO portal_accounts(user_id, pass_hash) VALUES (?, ?)').run(ali, 'x');
    db.prepare('INSERT INTO portal_accounts(user_id, pass_hash) VALUES (?, ?)').run(veli, 'x');

    purgeUserRecords(db, ali, 'ali');

    assert.deepEqual(ids(db, 'SELECT id FROM users'), [veli]);
    assert.deepEqual(ids(db, 'SELECT user_id AS id FROM portal_accounts'), [veli]);
    assert.deepEqual(ids(db, 'SELECT id FROM skills'), [fanOut, global, veliSkill]);
    assert.deepEqual(ids(db, 'SELECT skill_id AS id FROM skill_versions'), [fanOut, global, veliSkill]);
    assert.deepEqual(ids(db, 'SELECT id FROM admin_notes'), [veliNote, allNote]);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM admin_note_reads WHERE username = 'ali'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM admin_note_reads WHERE username = 'veli'"), 2);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE actor = 'ali'"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM dev_log WHERE username = 'ali'"), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM term_sessions WHERE user_id = ?', ali), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
