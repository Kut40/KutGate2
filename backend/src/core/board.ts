import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './types.js';
import { MODULE_RE, USER_RE } from './exec.js';

export const DEVLOG_FILE = 'Geliştirme_notu.md';
export const BOARD_FILE = 'pano.md';
export const ADMIN_NOTES_FILE = 'yonetici_notlari.md';
export const INBOX_MAX_BYTES = 4096;
export const NOTE_MAX_CHARS = 2000;
export const BOARD_RENDER_LIMIT = 200;
export const DEVLOG_RENDER_LIMIT = 300;
export const DEVLOG_LIST_NAMES = 10;
export const ADMIN_AUTHOR = 'yönetici';
export const GENERAL_PROJECT = 'genel';

const TIME_ZONE = 'Europe/Istanbul';
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const PROJECT_LINE_RE = /^proje:[ \t]*(\S*)[ \t]*$/;
const INBOX_NAME_RE = /\.(md|txt)$/;
const LINE_START_HASH_RE = /^([ \t]*)#/gm;

export type AuthorKind = 'user' | 'admin';

export interface BoardNoteRow {
  id: number;
  ts: string;
  author: string;
  author_kind: AuthorKind;
  project: string | null;
  text: string;
}

export interface DevlogRow {
  id: number;
  ts: string;
  username: string;
  project: string;
  summary: string;
  files: string | null;
  file_count: number;
  session_id: string | null;
  mode: 'claude' | 'basic';
}

export interface AdminNoteRow {
  id: number;
  ts: string;
  target: string | null;
  title: string;
  text: string;
}

export interface AdminNoteView extends AdminNoteRow {
  read: boolean;
}

export function formatIstanbul(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p: Record<string, string> = {};
  for (const part of TIME_FORMAT.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function hasForbiddenControl(s: string): boolean {
  return CONTROL_RE.test(s);
}

export function charLength(s: string): number {
  return Array.from(s).length;
}

export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

export function cleanText(v: unknown, maxChars: number, multiline: boolean): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').trim();
  const n = charLength(s);
  if (n < 1 || n > maxChars) return null;
  if (hasForbiddenControl(s)) return null;
  if (!multiline && /[\n\t]/.test(s)) return null;
  return s;
}

export function parseFilesJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function formatFileList(files: string[], count: number): string {
  const shown = files.slice(0, DEVLOG_LIST_NAMES);
  const rest = Math.max(0, count - shown.length);
  const list = shown.join(', ');
  return rest > 0 ? `${list} +${rest}` : list;
}

export function isInboxFileName(name: string): boolean {
  return INBOX_NAME_RE.test(name);
}

export type InboxParse = { ok: true; project: string | null; text: string } | { ok: false; reason: string };

export function parseInboxNote(buf: Uint8Array): InboxParse {
  if (buf.length > INBOX_MAX_BYTES) return { ok: false, reason: 'size' };
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, reason: 'utf8' };
  }
  if (hasForbiddenControl(s)) return { ok: false, reason: 'control' };
  let project: string | null = null;
  let body = s;
  const nl = s.indexOf('\n');
  const first = nl === -1 ? s : s.slice(0, nl);
  if (first.startsWith('proje:')) {
    const m = PROJECT_LINE_RE.exec(first);
    if (!m || !MODULE_RE.test(m[1])) return { ok: false, reason: 'project' };
    project = m[1];
    body = nl === -1 ? '' : s.slice(nl + 1);
  }
  const text = body.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  return { ok: true, project, text: truncateChars(text, NOTE_MAX_CHARS) };
}

export function escapeLineStartHash(s: string): string {
  return s.replace(LINE_START_HASH_RE, '$1\\#');
}

export function renderBoard(notes: BoardNoteRow[]): string {
  const out = ['# Takım Panosu', ''];
  for (const n of notes) {
    const kind = n.author_kind === 'admin' ? 'yönetici' : 'kullanıcı';
    const head = `## ${formatIstanbul(n.ts)} · ${n.author} (${kind}) · ${n.project || GENERAL_PROJECT}`;
    out.push(head, '', escapeLineStartHash(n.text), '');
  }
  return out.join('\n');
}

export function renderDevlog(rows: DevlogRow[]): string {
  const out = ['# Geliştirme Notu', '', 'Bu dosya oturumlardan düzenli aralıklarla otomatik oluşturulur.', ''];
  for (const r of rows) {
    out.push(`## ${formatIstanbul(r.ts)} · ${r.username} · proje: ${r.project}`, '', escapeLineStartHash(r.summary), '');
    if (r.file_count > 0) {
      out.push(
        escapeLineStartHash(`Değişen dosyalar (${r.file_count}): ${formatFileList(parseFilesJson(r.files), r.file_count)}`),
        '',
      );
    }
  }
  return out.join('\n');
}

export function renderAdminNotes(notes: AdminNoteView[]): string {
  const out = ['# Yönetici Notları', ''];
  for (const n of notes) {
    out.push(`## ${formatIstanbul(n.ts)} · ${n.title}${n.read ? '' : ' [OKUNMADI]'}`, '', escapeLineStartHash(n.text), '');
  }
  return out.join('\n');
}

export function listBoardNotes(db: DatabaseSync, limit: number): BoardNoteRow[] {
  return db
    .prepare('SELECT id, ts, author, author_kind, project, text FROM board_notes ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as BoardNoteRow[];
}

export function listDevlog(
  db: DatabaseSync,
  opts: { user?: string; project?: string; limit: number },
): DevlogRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.user) {
    where.push('username = ?');
    params.push(opts.user);
  }
  if (opts.project) {
    where.push('project = ?');
    params.push(opts.project);
  }
  params.push(opts.limit);
  return db
    .prepare(
      `SELECT id, ts, username, project, summary, files, file_count, session_id, mode FROM dev_log${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as unknown as DevlogRow[];
}

export function devlogView(r: DevlogRow) {
  return {
    id: r.id,
    ts: r.ts,
    username: r.username,
    project: r.project,
    summary: r.summary,
    fileCount: r.file_count,
    files: parseFilesJson(r.files),
  };
}

export function boardView(n: BoardNoteRow) {
  return { id: n.id, ts: n.ts, author: n.author, authorKind: n.author_kind, project: n.project, text: n.text };
}

export function isProjectFilter(s: string): boolean {
  return s === GENERAL_PROJECT || MODULE_RE.test(s);
}

export function visibleAdminNotes(db: DatabaseSync, username: string): AdminNoteView[] {
  const rows = db
    .prepare(
      'SELECT n.id, n.ts, n.target, n.title, n.text, r.read_ts FROM admin_notes n LEFT JOIN admin_note_reads r ON r.note_id = n.id AND r.username = ? WHERE n.target IS NULL OR n.target = ? ORDER BY n.id DESC',
    )
    .all(username, username) as unknown as (AdminNoteRow & { read_ts: string | null })[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    target: r.target,
    title: r.title,
    text: r.text,
    read: r.read_ts !== null,
  }));
}

export function unreadAdminNoteCount(db: DatabaseSync, username: string): number {
  const r = db
    .prepare(
      'SELECT COUNT(*) AS n FROM admin_notes n WHERE (n.target IS NULL OR n.target = ?) AND NOT EXISTS (SELECT 1 FROM admin_note_reads r WHERE r.note_id = n.id AND r.username = ?)',
    )
    .get(username, username) as unknown as { n: number };
  return r.n;
}

export function portalUsernames(db: DatabaseSync): string[] {
  const rows = db
    .prepare('SELECT u.username FROM portal_accounts p JOIN users u ON u.id = p.user_id ORDER BY u.username')
    .all() as unknown as { username: string }[];
  return rows.map((r) => r.username);
}

export function hasPortalAccount(db: DatabaseSync, username: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM portal_accounts p JOIN users u ON u.id = p.user_id WHERE u.username = ?')
    .get(username);
}

export function adminNoteRecipients(db: DatabaseSync, target: string | null): string[] {
  return target === null ? portalUsernames(db) : [target];
}

export function boardPaths(cfg: Config) {
  return {
    publicDir: join(cfg.boardDir, 'public'),
    usersDir: join(cfg.boardDir, 'users'),
    inboxDir: join(cfg.boardDir, 'inbox'),
  };
}

export async function atomicWrite(path: string, content: string, mode = 0o644): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeBoardFile(db: DatabaseSync, cfg: Config): Promise<void> {
  const { publicDir } = boardPaths(cfg);
  await atomicWrite(join(publicDir, BOARD_FILE), renderBoard(listBoardNotes(db, BOARD_RENDER_LIMIT)));
}

export async function writeDevlogFile(db: DatabaseSync, cfg: Config): Promise<void> {
  const { publicDir } = boardPaths(cfg);
  await atomicWrite(join(publicDir, DEVLOG_FILE), renderDevlog(listDevlog(db, { limit: DEVLOG_RENDER_LIMIT })));
}

export async function writeAdminNotesFile(db: DatabaseSync, cfg: Config, username: string): Promise<void> {
  if (!USER_RE.test(username)) throw new Error('geçersiz kullanıcı adı');
  const dir = join(boardPaths(cfg).usersDir, username);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await atomicWrite(join(dir, ADMIN_NOTES_FILE), renderAdminNotes(visibleAdminNotes(db, username)));
}

export async function writeAdminNotesFiles(db: DatabaseSync, cfg: Config, usernames: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const u of usernames) {
    try {
      await writeAdminNotesFile(db, cfg, u);
    } catch {
      failed.push(u);
    }
  }
  return failed;
}

export async function ensureUserBoardDirs(cfg: Config, username: string): Promise<void> {
  if (!cfg.dryRun || !USER_RE.test(username)) return;
  const { inboxDir, usersDir } = boardPaths(cfg);
  await mkdir(join(inboxDir, username), { recursive: true, mode: 0o770 });
  await mkdir(join(usersDir, username), { recursive: true, mode: 0o755 });
}
