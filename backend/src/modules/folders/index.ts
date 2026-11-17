import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { sendScriptFailure } from '../../core/scriptError.js';
import { readOptionalRow, readRows, type RowSpec } from '../../core/rows.js';

const MODULE_RE = /^[a-z][a-z0-9-]{1,31}$/;

interface FolderRow {
  id: number;
  name: string;
  path: string;
}

const FOLDER_ROW: RowSpec<FolderRow> = { id: 'number', name: 'string', path: 'string' };

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function parseId(v: unknown): number | null {
  const s = String(v);
  return /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : null;
}
function actor(req: FastifyRequest): string {
  return req.admin?.username ?? 'unknown';
}
function fail(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db, cfg } = core;

  app.get('/api/folders', async () => {
    const rows = readRows<FolderRow>(FOLDER_ROW, db.prepare('SELECT id, name, path FROM folders ORDER BY name').all());
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path }));
  });

  app.post('/api/folders', async (req, reply) => {
    const b = obj(req.body);
    const name = b.name;
    if (typeof name !== 'string' || !MODULE_RE.test(name)) return fail(reply, 400, 'geçersiz klasör adı');
    if (db.prepare('SELECT 1 FROM folders WHERE name = ?').get(name)) return fail(reply, 409, 'klasör zaten var');
    const path = join(cfg.projectsRoot, name);
    const r = await core.run('module-add', [name]);
    if (!r.ok) return sendScriptFailure(req, reply, 'module-add', r);
    const res = db
      .prepare('INSERT INTO folders(name, path, created) VALUES (?, ?, ?)')
      .run(name, path, new Date().toISOString());
    core.audit(actor(req), 'folders.create', `${name}${r.dryRun ? ' (DRY)' : ''}`);
    return { id: Number(res.lastInsertRowid), name, path };
  });

  app.delete<{ Params: { id: string } }>('/api/folders/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const f = readOptionalRow<FolderRow>(FOLDER_ROW, db.prepare('SELECT id, name, path FROM folders WHERE id = ?').get(id));
    if (!f) return fail(reply, 404, 'klasör bulunamadı');
    const r = await core.run('module-del', [f.name]);
    if (!r.ok) return sendScriptFailure(req, reply, 'module-del', r);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM grants WHERE folder_id = ?').run(id);
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(actor(req), 'folders.delete', `${f.name}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });

  app.get('/api/grants', async () => {
    const rows = db
      .prepare('SELECT user_id AS userId, folder_id AS folderId, perm FROM grants ORDER BY user_id, folder_id')
      .all() as unknown as { userId: number; folderId: number; perm: string }[];
    return rows.map((g) => ({ userId: g.userId, folderId: g.folderId, perm: g.perm }));
  });

  app.put('/api/grants', async (req, reply) => {
    const b = obj(req.body);
    const userId = typeof b.userId === 'number' && Number.isInteger(b.userId) ? b.userId : null;
    const folderId = typeof b.folderId === 'number' && Number.isInteger(b.folderId) ? b.folderId : null;
    const perm = b.perm;
    if (userId === null || folderId === null) return fail(reply, 400, 'kullanıcı ve klasör gerekli');
    if (perm !== 'none' && perm !== 'r' && perm !== 'rw') return fail(reply, 400, "yetki 'none', 'r' veya 'rw' olmalı");
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as unknown as
      | { username: string }
      | undefined;
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const f = db.prepare('SELECT name FROM folders WHERE id = ?').get(folderId) as unknown as
      | { name: string }
      | undefined;
    if (!f) return fail(reply, 404, 'klasör bulunamadı');
    if (perm === 'none') {
      const r = await core.run('revoke', [u.username, f.name]);
      if (!r.ok) return sendScriptFailure(req, reply, 'revoke', r);
      db.prepare('DELETE FROM grants WHERE user_id = ? AND folder_id = ?').run(userId, folderId);
      core.audit(actor(req), 'grants.revoke', `${u.username} ${f.name}${r.dryRun ? ' (DRY)' : ''}`);
    } else {
      const r = await core.run('grant', [u.username, f.name, perm]);
      if (!r.ok) return sendScriptFailure(req, reply, 'grant', r);
      db.prepare(
        'INSERT INTO grants(user_id, folder_id, perm) VALUES (?, ?, ?) ON CONFLICT(user_id, folder_id) DO UPDATE SET perm = excluded.perm',
      ).run(userId, folderId, perm);
      core.audit(actor(req), 'grants.set', `${u.username} ${f.name} ${perm}${r.dryRun ? ' (DRY)' : ''}`);
    }
    return { ok: true };
  });
}

const mod: GateModule = { name: 'folders', register };
export default mod;
