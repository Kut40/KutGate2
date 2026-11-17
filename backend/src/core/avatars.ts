import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './types.js';

const MAX_BYTES = 600 * 1024;
const DATA_URL_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

function dir(cfg: Config): string {
  const d = join(cfg.dataDir, 'avatars');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function file(cfg: Config, userId: number): string {
  return join(dir(cfg), `${userId}.jpg`);
}

export function parseAvatar(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length > MAX_BYTES * 2) return null;
  const m = DATA_URL_RE.exec(v);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

export async function saveAvatar(cfg: Config, db: DatabaseSync, userId: number, buf: Buffer): Promise<number> {
  const target = file(cfg, userId);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, buf, { mode: 0o600 });
  await rename(tmp, target);
  const ver = Date.now();
  db.prepare('UPDATE users SET avatar_ver = ? WHERE id = ?').run(ver, userId);
  return ver;
}

export async function removeAvatar(cfg: Config, db: DatabaseSync, userId: number): Promise<void> {
  db.prepare('UPDATE users SET avatar_ver = 0 WHERE id = ?').run(userId);
  await unlink(file(cfg, userId)).catch(() => undefined);
}

export async function readAvatar(cfg: Config, userId: number): Promise<Buffer | null> {
  return readFile(file(cfg, userId)).catch(() => null);
}

export function avatarVer(db: DatabaseSync, userId: number): number {
  const r = db.prepare('SELECT avatar_ver FROM users WHERE id = ?').get(userId) as { avatar_ver: number | null } | undefined;
  return r?.avatar_ver ?? 0;
}

export function publicAvatarUrl(userId: number, ver: number | null | undefined): string | null {
  return ver ? `/papi/avatar/${userId}?v=${ver}` : null;
}
