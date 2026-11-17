import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE,
  pass_hash TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  created TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  admin_id INTEGER,
  created INTEGER,
  last_seen INTEGER,
  expires INTEGER
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  display TEXT,
  locked INTEGER DEFAULT 0,
  created TEXT
);
CREATE TABLE IF NOT EXISTS ssh_keys(
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  key TEXT,
  comment TEXT,
  fingerprint TEXT,
  created TEXT,
  UNIQUE(user_id, key)
);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  path TEXT,
  created TEXT
);
CREATE TABLE IF NOT EXISTS grants(
  user_id INTEGER,
  folder_id INTEGER,
  perm TEXT CHECK(perm IN ('r','rw')),
  PRIMARY KEY(user_id, folder_id)
);
CREATE TABLE IF NOT EXISTS gates(
  user_id INTEGER PRIMARY KEY,
  sftp INTEGER DEFAULT 0,
  forwarding INTEGER DEFAULT 0,
  egress TEXT DEFAULT 'none',
  egress_allow TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS skills(
  id INTEGER PRIMARY KEY,
  name TEXT,
  target_kind TEXT,
  target_user TEXT,
  source TEXT,
  content TEXT,
  version INTEGER DEFAULT 1,
  created TEXT,
  updated TEXT,
  UNIQUE(name, target_kind, target_user)
);
CREATE TABLE IF NOT EXISTS skill_versions(
  id INTEGER PRIMARY KEY,
  skill_id INTEGER,
  version INTEGER,
  content TEXT,
  source TEXT,
  created TEXT
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts TEXT,
  actor TEXT,
  action TEXT,
  detail TEXT
);
`;

export function openDb(cfg: Config): DatabaseSync {
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(cfg.dataDir, 'gate.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.exec(PORTAL_SCHEMA);
  db.exec(BOARD_SCHEMA);
  migrate(db);
  cleanupOrphans(db);
  return db;
}

const ORPHAN_TABLES = ['portal_sessions', 'portal_accounts', 'gates', 'grants', 'ssh_keys'] as const;

export function cleanupOrphans(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    for (const t of ORPHAN_TABLES) {
      db.exec(`DELETE FROM ${t} WHERE user_id NOT IN (SELECT id FROM users)`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const PORTAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS portal_accounts(
  user_id INTEGER PRIMARY KEY,
  pass_hash TEXT,
  must_change INTEGER DEFAULT 1,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created TEXT,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS portal_sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created INTEGER,
  last_seen INTEGER,
  expires INTEGER
);
CREATE TABLE IF NOT EXISTS term_sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  unit TEXT,
  started TEXT,
  ended TEXT,
  end_reason TEXT,
  bytes_out INTEGER DEFAULT 0,
  bytes_in INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('portal.idle_minutes', '15');
INSERT OR IGNORE INTO settings(key, value) VALUES ('portal.max_minutes', '240');
INSERT OR IGNORE INTO settings(key, value) VALUES ('portal.max_concurrent', '1');
INSERT OR IGNORE INTO settings(key, value) VALUES ('lock.maxMinutes', '15');
`;

const BOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS board_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  author TEXT,
  author_kind TEXT CHECK(author_kind IN ('user','admin')),
  project TEXT,
  text TEXT
);
CREATE TABLE IF NOT EXISTS dev_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  username TEXT,
  project TEXT,
  summary TEXT,
  files TEXT,
  file_count INTEGER,
  session_id TEXT,
  mode TEXT CHECK(mode IN ('claude','basic'))
);
CREATE TABLE IF NOT EXISTS admin_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  target TEXT,
  title TEXT,
  text TEXT
);
CREATE TABLE IF NOT EXISTS admin_note_reads(
  note_id INTEGER,
  username TEXT,
  read_ts TEXT,
  PRIMARY KEY(note_id, username)
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('devlog.interval_minutes', '10');
INSERT OR IGNORE INTO settings(key, value) VALUES ('devlog.summarize', '1');
`;

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return cols.some((c) => c.name === column);
}

const LOCK_ACCOUNT_COLUMNS = [
  ['pin_hash', 'TEXT'],
  ['pin_failures', 'INTEGER DEFAULT 0'],
  ['pin_locked_until', 'INTEGER'],
  ['lock_minutes', 'INTEGER'],
] as const;

function migrate(db: DatabaseSync): void {
  if (!hasColumn(db, 'users', 'portal_mode')) {
    db.exec('ALTER TABLE users ADD COLUMN portal_mode INTEGER DEFAULT 0');
  }
  if (!hasColumn(db, 'users', 'has_api_key')) {
    db.exec('ALTER TABLE users ADD COLUMN has_api_key INTEGER DEFAULT 0');
  }
  if (!hasColumn(db, 'users', 'avatar_ver')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_ver INTEGER DEFAULT 0');
  }
  if (!hasColumn(db, 'users', 'ranks')) {
    db.exec("ALTER TABLE users ADD COLUMN ranks TEXT DEFAULT '[]'");
  }
  if (!hasColumn(db, 'portal_accounts', 'max_effort')) {
    db.exec("ALTER TABLE portal_accounts ADD COLUMN max_effort TEXT DEFAULT 'xhigh'");
  }
  for (const table of ['portal_accounts', 'admins']) {
    for (const [column, type] of LOCK_ACCOUNT_COLUMNS) {
      if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    if (!hasColumn(db, table, 'totp_last_counter')) db.exec(`ALTER TABLE ${table} ADD COLUMN totp_last_counter INTEGER`);
  }
  for (const table of ['portal_sessions', 'sessions']) {
    if (!hasColumn(db, table, 'locked')) db.exec(`ALTER TABLE ${table} ADD COLUMN locked INTEGER DEFAULT 0`);
    if (!hasColumn(db, table, 'last_active')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN last_active INTEGER`);
      db.exec(`UPDATE ${table} SET last_active = last_seen`);
    }
  }
}
