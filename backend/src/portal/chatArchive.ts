import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Geçmiş sohbetler: sohbet listesi için yalnızca başlık ve zaman okunur. */

export const CHAT_ID_RE = /^[a-f0-9]{16}$/;
const MAX_TITLE = 60;
const HEAD_BYTES = 256 * 1024;
export const MAX_LISTED_CHATS = 50;

export interface ChatSummary {
  id: string;
  title: string;
  updated: number;
  active: boolean;
}

export function chatTitle(text: unknown, attachmentName?: unknown): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const base = clean !== '' ? clean : typeof attachmentName === 'string' ? attachmentName.trim() : '';
  if (base === '') return 'Yeni sohbet';
  const chars = [...base];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE).join('')}…` : base;
}

/** Olaydan başlık çıkarır: metin yoksa ilk ekin adı. */
export function titleOfUserEvent(ev: { text?: unknown; attachments?: unknown }): string {
  const first = Array.isArray(ev.attachments) ? (ev.attachments[0] as { name?: unknown } | undefined) : undefined;
  return chatTitle(ev.text, first?.name);
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readChatTitle(file: string): string {
  let head: string;
  try {
    head = readHead(file);
  } catch {
    return 'Yeni sohbet';
  }
  for (const line of head.split('\n')) {
    if (!line.includes('"user"')) continue;
    try {
      const o = JSON.parse(line) as { kind?: unknown; text?: unknown; attachments?: unknown };
      if (o.kind === 'user') return titleOfUserEvent(o);
    } catch {
      continue;
    }
  }
  return 'Yeni sohbet';
}

/** Arşiv klasöründeki sohbetler, en yeni önce. Geçersiz adlar atlanır. */
export function listArchivedChats(archiveDir: string, limit = MAX_LISTED_CHATS): ChatSummary[] {
  let names: string[];
  try {
    names = readdirSync(archiveDir);
  } catch {
    return [];
  }
  const rows: { id: string; file: string; updated: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!CHAT_ID_RE.test(id)) continue;
    const file = join(archiveDir, name);
    try {
      const st = statSync(file);
      if (st.isFile()) rows.push({ id, file, updated: Math.floor(st.mtimeMs) });
    } catch {
      continue;
    }
  }
  rows.sort((a, b) => b.updated - a.updated);
  return rows.slice(0, limit).map((r) => ({ id: r.id, title: readChatTitle(r.file), updated: r.updated, active: false }));
}

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const VIEW_KINDS = new Set(['user', 'text', 'thinking', 'tool', 'permission', 'question', 'turn_end', 'notice']);
const MAX_VIEW_EVENTS = 2000;

export function deletedDirOf(dataDir: string, username: string): string {
  return join(dataDir, 'agent', 'deleted', username);
}

/** Kullanıcının sildiği sohbet yok edilmez: yönetici kayıtlarına taşınır ve silinme zamanı işlenir. */
export function moveChatToDeleted(file: string, dataDir: string, username: string, id: string, now = Date.now()): void {
  const dir = deletedDirOf(dataDir, username);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ kind: 'deleted', ts: now })}\n`, { mode: 0o600 });
  renameSync(file, join(dir, `${id}.jsonl`));
}

export interface DeletedChat {
  username: string;
  id: string;
  title: string;
  deletedAt: number;
}

export function listDeletedChats(dataDir: string): DeletedChat[] {
  const root = join(dataDir, 'agent', 'deleted');
  let users: string[];
  try {
    users = readdirSync(root);
  } catch {
    return [];
  }
  const out: DeletedChat[] = [];
  for (const username of users) {
    if (!USERNAME_RE.test(username)) continue;
    for (const c of listArchivedChats(join(root, username), 500)) {
      out.push({ username, id: c.id, title: c.title, deletedAt: c.updated });
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Silinmiş sohbetin son halini okur. Kayıtlı olaylar zaten süzülmüştür, dosya içeriği taşımaz. */
export function readDeletedChat(dataDir: string, username: unknown, id: unknown): { events: unknown[] } | null {
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || typeof id !== 'string' || !CHAT_ID_RE.test(id)) return null;
  let text: string;
  try {
    text = readFileSync(join(deletedDirOf(dataDir, username), `${id}.jsonl`), 'utf8');
  } catch {
    return null;
  }
  const events = new Map<string, unknown>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const o = JSON.parse(line) as { kind?: unknown; id?: unknown };
      if (typeof o.kind === 'string' && VIEW_KINDS.has(o.kind) && typeof o.id === 'string') events.set(o.id, o);
    } catch {
      continue;
    }
  }
  return { events: [...events.values()].slice(-MAX_VIEW_EVENTS) };
}
