import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOrphans, openDb } from './db.js';
import type { Config } from './types.js';

const TABLES = ['portal_sessions', 'portal_accounts', 'gates', 'grants', 'ssh_keys'];

function count(db: ReturnType<typeof openDb>, table: string, userId: number): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as unknown as { n: number };
  return r.n;
}

function seed(db: ReturnType<typeof openDb>, userId: number): void {
  db.prepare('INSERT INTO portal_accounts(user_id, pass_hash) VALUES (?, ?)').run(userId, 'x');
  db.prepare('INSERT INTO portal_sessions(token, user_id) VALUES (?, ?)').run(`tok-${userId}`, userId);
  db.prepare('INSERT INTO gates(user_id) VALUES (?)').run(userId);
  db.prepare("INSERT INTO grants(user_id, folder_id, perm) VALUES (?, 1, 'r')").run(userId);
  db.prepare('INSERT INTO ssh_keys(user_id, key) VALUES (?, ?)').run(userId, `key-${userId}`);
}

test('açılışta artık kayıtlar silinir, mevcut kullanıcınınkiler kalır', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-db-test-'));
  try {
    const cfg = { dataDir: dir } as Config;
    let db = openDb(cfg);
    const res = db
      .prepare("INSERT INTO users(username, display, locked, created) VALUES ('ali', '', 0, '')")
      .run();
    const liveId = Number(res.lastInsertRowid);
    const orphanId = liveId + 100;
    seed(db, liveId);
    seed(db, orphanId);
    db.close();

    db = openDb(cfg);
    for (const t of TABLES) {
      assert.equal(count(db, t, orphanId), 0, `${t} artık kayıt kaldı`);
      assert.equal(count(db, t, liveId), 1, `${t} geçerli kayıt silindi`);
    }

    seed(db, orphanId);
    cleanupOrphans(db);
    cleanupOrphans(db);
    for (const t of TABLES) {
      assert.equal(count(db, t, orphanId), 0, `${t} artık kayıt kaldı`);
      assert.equal(count(db, t, liveId), 1, `${t} geçerli kayıt silindi`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yeni kurulumda silinen kullanıcının id değeri yeniden kullanılmaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-db-test-'));
  try {
    const db = openDb({ dataDir: dir } as Config);
    const ins = db.prepare("INSERT INTO users(username, display, locked, created) VALUES (?, '', 0, '')");
    const first = Number(ins.run('ali').lastInsertRowid);
    db.prepare('DELETE FROM users WHERE id = ?').run(first);
    const second = Number(ins.run('veli').lastInsertRowid);
    assert.notEqual(second, first);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admins ve portal_accounts tablolarına TOTP sayaç sütunu eklenir, yeniden açılış zarar vermez', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-db-test-'));
  try {
    const cfg = { dataDir: dir } as Config;
    let db = openDb(cfg);
    db.close();
    db = openDb(cfg);
    for (const table of ['admins', 'portal_accounts']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
      assert.ok(cols.includes('totp_last_counter'), table);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
