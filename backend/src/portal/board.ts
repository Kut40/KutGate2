import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../core/types.js';
import type { RunFn } from '../core/exec.js';
import { isTreePath, parseTreeOutput } from './tree.js';
import {
  BOARD_RENDER_LIMIT,
  boardView,
  devlogView,
  DEVLOG_RENDER_LIMIT,
  isProjectFilter,
  listBoardNotes,
  listDevlog,
  visibleAdminNotes,
  writeAdminNotesFile,
} from '../core/board.js';
import type { PortalAuth, PortalUser } from './auth.js';

const DEFAULT_LIMIT = 100;

function parseLimit(raw: unknown, max: number): number | null {
  if (raw === undefined || raw === '') return Math.min(DEFAULT_LIMIT, max);
  const s = String(raw);
  if (!/^[1-9][0-9]{0,5}$/.test(s)) return null;
  return Math.min(Number(s), max);
}

function parseId(v: unknown): number | null {
  const s = String(v);
  return /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : null;
}

export function registerBoardRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseSync; cfg: Config; auth: PortalAuth; run: RunFn },
): void {
  const { db, cfg, auth, run } = deps;

  function ready(req: FastifyRequest, reply: FastifyReply): PortalUser | null {
    const u = auth.authenticate(req);
    if (!u) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (u.stage !== 'ready') {
      reply.code(403).send({ error: 'setup_incomplete' });
      return null;
    }
    return u;
  }

  app.get<{ Querystring: { project?: string; limit?: string } }>('/papi/devlog', async (req, reply) => {
    if (!ready(req, reply)) return reply;
    const limit = parseLimit(req.query.limit, DEVLOG_RENDER_LIMIT);
    if (limit === null) return reply.code(400).send({ error: 'geçersiz limit' });
    const project = req.query.project;
    if (project !== undefined && project !== '' && !isProjectFilter(project)) {
      return reply.code(400).send({ error: 'geçersiz proje' });
    }
    return listDevlog(db, { project: project || undefined, limit }).map(devlogView);
  });

  app.get('/papi/projects', async (req, reply) => {
    const u = ready(req, reply);
    if (!u) return reply;
    const rows = db
      .prepare(
        'SELECT f.name AS name, g.perm AS perm FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ? ORDER BY f.name',
      )
      .all(u.userId) as unknown as { name: string; perm: 'r' | 'rw' }[];
    return rows.map((r) => ({ name: r.name, perm: r.perm }));
  });

  app.get<{ Params: { name: string }; Querystring: { path?: string } }>('/papi/projects/:name/tree', async (req, reply) => {
    const u = ready(req, reply);
    if (!u) return reply;
    const rel = req.query.path ?? '';
    if (!isTreePath(rel)) return reply.code(400).send({ error: 'geçersiz yol' });
    const granted = db
      .prepare('SELECT 1 FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ? AND f.name = ?')
      .get(u.userId, req.params.name);
    if (!granted) return reply.code(403).send({ error: 'yetki yok' });
    const r = await run('project-list', rel === '' ? [u.username, req.params.name] : [u.username, req.params.name, rel]);
    if (!r.ok) return reply.code(404).send({ error: 'klasör okunamadı' });
    if (r.dryRun) return { entries: [], truncated: false };
    const listing = parseTreeOutput(r.stdout);
    if (!listing) return reply.code(500).send({ error: 'liste okunamadı' });
    return listing;
  });

  app.get<{ Querystring: { limit?: string } }>('/papi/board', async (req, reply) => {
    if (!ready(req, reply)) return reply;
    const limit = parseLimit(req.query.limit, BOARD_RENDER_LIMIT);
    if (limit === null) return reply.code(400).send({ error: 'geçersiz limit' });
    return listBoardNotes(db, limit).map(boardView);
  });

  app.get('/papi/admin-notes', async (req, reply) => {
    const u = ready(req, reply);
    if (!u) return reply;
    return visibleAdminNotes(db, u.username).map((n) => ({
      id: n.id,
      ts: n.ts,
      title: n.title,
      text: n.text,
      toAll: n.target === null,
      read: n.read,
    }));
  });

  app.post<{ Params: { id: string } }>('/papi/admin-notes/:id/read', async (req, reply) => {
    const u = ready(req, reply);
    if (!u) return reply;
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'geçersiz id' });
    const visible = db
      .prepare('SELECT 1 FROM admin_notes WHERE id = ? AND (target IS NULL OR target = ?)')
      .get(id, u.username);
    if (!visible) return reply.code(404).send({ error: 'not bulunamadı' });
    db.prepare('INSERT OR IGNORE INTO admin_note_reads(note_id, username, read_ts) VALUES (?, ?, ?)').run(
      id,
      u.username,
      new Date().toISOString(),
    );
    try {
      await writeAdminNotesFile(db, cfg, u.username);
    } catch (err) {
      req.log.error({ err }, 'yonetici_notlari.md yazılamadı');
    }
    return { ok: true };
  });
}
