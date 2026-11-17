import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../core/types.js';
import type { AuditFn } from '../core/audit.js';
import { USER_RE } from '../core/exec.js';
import { boardPaths, INBOX_MAX_BYTES, isInboxFileName, parseInboxNote, writeBoardFile } from '../core/board.js';
import { uidOf } from './uid.js';

const SCAN_INTERVAL_MS = 5 * 1000;

interface InboxScanner {
  stop(): void;
}

type ReadOutcome = { kind: 'data'; buf: Buffer } | { kind: 'invalid'; reason: string } | { kind: 'wait' };

/** Yazılması sürüyor olabilecek dosyalar (son 2 sn'de değişmiş) bir sonraki taramaya bırakılır. */
const SETTLE_MS = 2000;

async function readNote(path: string): Promise<ReadOutcome> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: 'invalid', reason: 'not_regular' };
    if (st.size > INBOX_MAX_BYTES) return { kind: 'invalid', reason: 'size' };
    if (Date.now() - st.mtimeMs < SETTLE_MS) return { kind: 'wait' };
    const buf = Buffer.alloc(INBOX_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > INBOX_MAX_BYTES) return { kind: 'invalid', reason: 'size' };
    return { kind: 'data', buf: buf.subarray(0, total) };
  } finally {
    await fh.close();
  }
}

export function startInboxScanner(deps: {
  db: DatabaseSync;
  cfg: Config;
  audit: AuditFn;
  log: FastifyBaseLogger;
}): InboxScanner {
  const { db, cfg, audit, log } = deps;
  const insert = db.prepare(
    "INSERT INTO board_notes(ts, author, author_kind, project, text) VALUES (?, ?, 'user', ?, ?)",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function reject(username: string, name: string, reason: string): void {
    audit(username, 'board.reject', `${JSON.stringify(name.slice(0, 200))} ${reason}`);
  }

  async function processFile(username: string, dir: string, name: string, isFile: boolean): Promise<boolean> {
    const path = join(dir, name);
    let outcome: ReadOutcome;
    if (!isFile) outcome = { kind: 'invalid', reason: 'not_regular' };
    else if (!isInboxFileName(name)) outcome = { kind: 'invalid', reason: 'extension' };
    else {
      try {
        outcome = await readNote(path);
      } catch {
        outcome = { kind: 'invalid', reason: 'not_regular' };
      }
    }
    if (outcome.kind === 'wait') return false;
    try {
      await unlink(path);
    } catch (err) {
      log.warn({ err, username }, 'inbox dosyası silinemedi');
      return false;
    }
    if (outcome.kind === 'invalid') {
      reject(username, name, outcome.reason);
      return false;
    }
    const parsed = parseInboxNote(outcome.buf);
    if (!parsed.ok) {
      reject(username, name, parsed.reason);
      return false;
    }
    const res = insert.run(new Date().toISOString(), username, parsed.project, parsed.text);
    audit(username, 'board.note', `id=${Number(res.lastInsertRowid)} project=${parsed.project ?? 'genel'}`);
    return true;
  }

  async function scanUser(inboxDir: string, username: string): Promise<number> {
    const dir = join(inboxDir, username);
    const st = await lstat(dir);
    if (!st.isDirectory()) return 0;
    const entries = await readdir(dir, { withFileTypes: true });
    const candidates = entries.filter((e) => !e.isDirectory());
    if (candidates.length === 0) return 0;
    const expected = cfg.dryRun ? (process.getuid?.() ?? null) : await uidOf(username);
    if (expected === null || st.uid !== expected) return 0;
    let added = 0;
    for (const e of candidates) {
      if (await processFile(username, dir, e.name, e.isFile())) added++;
    }
    return added;
  }

  async function scan(): Promise<void> {
    const { inboxDir } = boardPaths(cfg);
    let dirs: Dirent[];
    try {
      dirs = await readdir(inboxDir, { withFileTypes: true });
    } catch {
      return;
    }
    let added = 0;
    for (const d of dirs) {
      if (!d.isDirectory() || !USER_RE.test(d.name)) continue;
      try {
        added += await scanUser(inboxDir, d.name);
      } catch (err) {
        log.warn({ err, username: d.name }, 'inbox taranamadı');
      }
    }
    if (added > 0) {
      try {
        await writeBoardFile(db, cfg);
      } catch (err) {
        log.error({ err }, 'pano.md yazılamadı');
      }
    }
  }

  const loop = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void scan().finally(loop);
    }, SCAN_INTERVAL_MS);
  };
  loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
