import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { MODULE_RE, USER_RE } from '../../core/exec.js';
import {
  ADMIN_AUTHOR,
  adminNoteRecipients,
  boardView,
  cleanText,
  devlogView,
  hasPortalAccount,
  isProjectFilter,
  listBoardNotes,
  listDevlog,
  NOTE_MAX_CHARS,
  writeAdminNotesFiles,
  writeBoardFile,
  writeDevlogFile,
  type AdminNoteRow,
} from '../../core/board.js';
import { readDevlogSettings, validateDevlogSettings, writeDevlogSettings } from '../../core/settings.js';

const LIST_MAX = 500;
const DEVLOG_DEFAULT_LIMIT = 200;
const TITLE_MAX = 120;
const ADMIN_NOTE_MAX = 4000;

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function parseId(v: unknown): number | null {
  const s = String(v);
  return /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : null;
}
function parseLimit(raw: unknown, def: number): number | null {
  if (raw === undefined || raw === '') return def;
  const s = String(raw);
  if (!/^[1-9][0-9]{0,5}$/.test(s)) return null;
  return Math.min(Number(s), LIST_MAX);
}
function actor(req: FastifyRequest): string {
  return req.admin?.username ?? 'unknown';
}
function fail(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db, cfg } = core;

  async function render(req: FastifyRequest, what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      req.log.error({ err }, `${what} yazılamadı`);
    }
  }

  async function renderNotes(req: FastifyRequest, usernames: string[]): Promise<void> {
    const failed = await writeAdminNotesFiles(db, cfg, usernames);
    if (failed.length > 0) req.log.error({ users: failed }, 'yonetici_notlari.md yazılamadı');
  }

  function readsByNote(): Map<number, { username: string; readTs: string }[]> {
    const rows = db
      .prepare('SELECT note_id AS noteId, username, read_ts FROM admin_note_reads ORDER BY read_ts')
      .all() as unknown as { noteId: number; username: string; read_ts: string }[];
    const out = new Map<number, { username: string; readTs: string }[]>();
    for (const r of rows) {
      const item = { username: r.username, readTs: r.read_ts };
      const list = out.get(r.noteId);
      if (list) list.push(item);
      else out.set(r.noteId, [item]);
    }
    return out;
  }

  function noteView(n: AdminNoteRow, reads: Map<number, { username: string; readTs: string }[]>) {
    return {
      id: n.id,
      ts: n.ts,
      target: n.target,
      title: n.title,
      text: n.text,
      reads: reads.get(n.id) ?? [],
    };
  }

  app.get<{ Querystring: { user?: string; project?: string; limit?: string } }>('/api/devlog', async (req, reply) => {
    const { user, project } = req.query;
    if (user !== undefined && user !== '' && !USER_RE.test(user)) return fail(reply, 400, 'geçersiz kullanıcı adı');
    if (project !== undefined && project !== '' && !isProjectFilter(project)) return fail(reply, 400, 'geçersiz proje');
    const limit = parseLimit(req.query.limit, DEVLOG_DEFAULT_LIMIT);
    if (limit === null) return fail(reply, 400, 'geçersiz limit');
    return listDevlog(db, { user: user || undefined, project: project || undefined, limit }).map((r) => ({
      ...devlogView(r),
      mode: r.mode,
    }));
  });

  app.get('/api/devlog/settings', async () => readDevlogSettings(db));

  app.put('/api/devlog/settings', async (req, reply) => {
    const s = validateDevlogSettings(req.body);
    if (!s) return fail(reply, 400, 'geçersiz ayar: aralık 1-120 dakika arasında tamsayı, özetleme açık ya da kapalı olmalı');
    writeDevlogSettings(db, s);
    core.audit(actor(req), 'devlog.settings', `interval=${s.intervalMinutes} summarize=${s.summarize ? 1 : 0}`);
    return s;
  });

  app.delete<{ Params: { id: string } }>('/api/devlog/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const res = db.prepare('DELETE FROM dev_log WHERE id = ?').run(id);
    if (Number(res.changes) === 0) return fail(reply, 404, 'kayıt bulunamadı');
    core.audit(actor(req), 'devlog.delete', String(id));
    await render(req, 'Geliştirme_notu.md', () => writeDevlogFile(db, cfg));
    return { ok: true };
  });

  app.get('/api/board', async () => listBoardNotes(db, LIST_MAX).map(boardView));

  app.post('/api/board', async (req, reply) => {
    const b = obj(req.body);
    const text = cleanText(b.text, NOTE_MAX_CHARS, true);
    if (text === null) return fail(reply, 400, `metin 1-${NOTE_MAX_CHARS} karakter olmalı`);
    let project: string | null = null;
    if (b.project !== undefined && b.project !== null && b.project !== '') {
      if (typeof b.project !== 'string' || !MODULE_RE.test(b.project)) return fail(reply, 400, 'geçersiz proje');
      project = b.project;
    }
    const ts = new Date().toISOString();
    const res = db
      .prepare("INSERT INTO board_notes(ts, author, author_kind, project, text) VALUES (?, ?, 'admin', ?, ?)")
      .run(ts, ADMIN_AUTHOR, project, text);
    const id = Number(res.lastInsertRowid);
    core.audit(actor(req), 'board.note', `id=${id} project=${project ?? 'genel'}`);
    await render(req, 'pano.md', () => writeBoardFile(db, cfg));
    return { id, ts, author: ADMIN_AUTHOR, authorKind: 'admin' as const, project, text };
  });

  app.delete<{ Params: { id: string } }>('/api/board/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const res = db.prepare('DELETE FROM board_notes WHERE id = ?').run(id);
    if (Number(res.changes) === 0) return fail(reply, 404, 'not bulunamadı');
    core.audit(actor(req), 'board.delete', String(id));
    await render(req, 'pano.md', () => writeBoardFile(db, cfg));
    return { ok: true };
  });

  app.get('/api/admin-notes', async () => {
    const rows = db
      .prepare('SELECT id, ts, target, title, text FROM admin_notes ORDER BY id DESC')
      .all() as unknown as AdminNoteRow[];
    const reads = readsByNote();
    return rows.map((n) => noteView(n, reads));
  });

  app.post('/api/admin-notes', async (req, reply) => {
    const b = obj(req.body);
    let target: string | null = null;
    if (b.target !== null && b.target !== undefined) {
      if (typeof b.target !== 'string' || !USER_RE.test(b.target)) return fail(reply, 400, 'geçersiz hedef');
      if (!hasPortalAccount(db, b.target)) return fail(reply, 400, 'hedef kullanıcının portal hesabı yok');
      target = b.target;
    }
    const title = cleanText(b.title, TITLE_MAX, false);
    if (title === null) return fail(reply, 400, `başlık 1-${TITLE_MAX} karakter, tek satır olmalı`);
    const text = cleanText(b.text, ADMIN_NOTE_MAX, true);
    if (text === null) return fail(reply, 400, `metin 1-${ADMIN_NOTE_MAX} karakter olmalı`);
    const ts = new Date().toISOString();
    const res = db
      .prepare('INSERT INTO admin_notes(ts, target, title, text) VALUES (?, ?, ?, ?)')
      .run(ts, target, title, text);
    const id = Number(res.lastInsertRowid);
    core.audit(actor(req), 'admin_notes.create', `id=${id} target=${target ?? '*'}`);
    await renderNotes(req, adminNoteRecipients(db, target));
    return { id, ts, target, title, text, reads: [] };
  });

  app.delete<{ Params: { id: string } }>('/api/admin-notes/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const note = db.prepare('SELECT id, ts, target, title, text FROM admin_notes WHERE id = ?').get(id) as unknown as
      | AdminNoteRow
      | undefined;
    if (!note) return fail(reply, 404, 'not bulunamadı');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM admin_note_reads WHERE note_id = ?').run(id);
      db.prepare('DELETE FROM admin_notes WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(actor(req), 'admin_notes.delete', `id=${id} target=${note.target ?? '*'}`);
    await renderNotes(req, adminNoteRecipients(db, note.target));
    return { ok: true };
  });
}

const mod: GateModule = { name: 'board', register };
export default mod;
