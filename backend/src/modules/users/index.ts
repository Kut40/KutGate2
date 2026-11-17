import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { purgeUserRecords } from './purge.js';
import { archiveUserChats } from './chats.js';
import { parseRanks, RANKS } from '../../core/ranks.js';
import { parseAvatar, readAvatar, removeAvatar, saveAvatar } from '../../core/avatars.js';
import { sendScriptFailure } from '../../core/scriptError.js';
import { readOptionalRow, readRows, type RowSpec } from '../../core/rows.js';
import { internalFetch, loadInternalToken } from '../../core/internal.js';
import { DEFAULT_EGRESS_ALLOW } from '../gates/index.js';

const USER_RE = /^[a-z][a-z0-9_-]{1,31}$/;

interface UserRow {
  id: number;
  username: string;
  display: string | null;
  locked: number;
  created: string;
  ranks: string | null;
  avatar_ver: number | null;
}

const USER_ROW: RowSpec<UserRow> = {
  id: 'number',
  username: 'string',
  display: 'string?',
  locked: 'number',
  created: 'string',
  ranks: 'string?',
  avatar_ver: 'number?',
};

interface GrantRow {
  folderId: number;
  perm: string;
}

interface FolderNameRow {
  name: string;
}

const FOLDER_NAME_ROW: RowSpec<FolderNameRow> = { name: 'string' };

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
  const { db } = core;
  const internalToken = loadInternalToken(core.cfg);

  async function killPortalSessions(req: FastifyRequest, u: UserRow): Promise<void> {
    const res = await internalFetch(core.cfg, internalToken, `/internal/kill-user/${u.id}`, 'POST');
    if (res?.ok) return;
    req.log.error({ userId: u.id, username: u.username, status: res?.status ?? null }, 'portal oturumları kapatılamadı');
  }

  function getUser(id: number): UserRow | undefined {
    return readOptionalRow<UserRow>(
      USER_ROW,
      db.prepare('SELECT id, username, display, locked, created, ranks, avatar_ver FROM users WHERE id = ?').get(id),
    );
  }

  function toView(u: UserRow, keyCount: number, grants: GrantRow[]) {
    return {
      id: u.id,
      username: u.username,
      display: u.display ?? '',
      ranks: parseRanks(u.ranks),
      avatar: u.avatar_ver ? `/api/users/${u.id}/avatar?v=${u.avatar_ver}` : null,
      locked: u.locked === 1,
      created: u.created,
      keyCount,
      grants: grants.map((g) => ({ folderId: g.folderId, perm: g.perm })),
    };
  }

  function view(u: UserRow) {
    const kc = db.prepare('SELECT COUNT(*) AS n FROM ssh_keys WHERE user_id = ?').get(u.id) as unknown as { n: number };
    const grants = db
      .prepare('SELECT folder_id AS folderId, perm FROM grants WHERE user_id = ? ORDER BY folder_id')
      .all(u.id) as unknown as GrantRow[];
    return toView(u, kc.n, grants);
  }

  app.get('/api/users', async () => {
    const rows = readRows<UserRow>(
      USER_ROW,
      db.prepare('SELECT id, username, display, locked, created, ranks, avatar_ver FROM users ORDER BY username').all(),
    );
    const keyCounts = new Map<number, number>();
    const counted = db.prepare('SELECT user_id AS userId, COUNT(*) AS n FROM ssh_keys GROUP BY user_id').all() as unknown as {
      userId: number;
      n: number;
    }[];
    for (const k of counted) keyCounts.set(k.userId, k.n);
    const grantsByUser = new Map<number, GrantRow[]>();
    const allGrants = db
      .prepare('SELECT user_id AS userId, folder_id AS folderId, perm FROM grants ORDER BY user_id, folder_id')
      .all() as unknown as (GrantRow & { userId: number })[];
    for (const g of allGrants) {
      const list = grantsByUser.get(g.userId);
      if (list) list.push(g);
      else grantsByUser.set(g.userId, [g]);
    }
    return rows.map((u) => toView(u, keyCounts.get(u.id) ?? 0, grantsByUser.get(u.id) ?? []));
  });

  app.post('/api/users', async (req, reply) => {
    const b = obj(req.body);
    const username = b.username;
    const display = b.display;
    if (typeof username !== 'string' || !USER_RE.test(username)) {
      return fail(reply, 400, 'geçersiz kullanıcı adı');
    }
    if (display !== undefined && display !== null && (typeof display !== 'string' || display.trim().length > 64)) {
      return fail(reply, 400, 'geçersiz görünen ad');
    }
    if (db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username)) {
      return fail(reply, 409, 'name_reserved');
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return fail(reply, 409, 'kullanıcı zaten var');
    }
    const add = await core.run('user-add', [username]);
    if (!add.ok) return sendScriptFailure(req, reply, 'user-add', add);
    const res = db
      .prepare('INSERT INTO users(username, display, locked, created) VALUES (?, ?, 0, ?)')
      .run(username, typeof display === 'string' ? display.trim() : '', new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    core.audit(actor(req), 'users.create', `${username}${add.dryRun ? ' (DRY)' : ''}`);
    const init = await core.run('rules-init', [username]);
    if (!init.ok) return sendScriptFailure(req, reply, 'rules-init', init);
    core.audit(actor(req), 'users.rules_init', `${username}${init.dryRun ? ' (DRY)' : ''}`);
    const csv = DEFAULT_EGRESS_ALLOW.join(',');
    const egress = await core.run('egress-profile', [username, '0', '0', 'allowlist', csv]);
    if (!egress.ok) return sendScriptFailure(req, reply, 'egress-profile', egress);
    db.prepare(
      `INSERT INTO gates(user_id, sftp, forwarding, egress, egress_allow) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET sftp = excluded.sftp, forwarding = excluded.forwarding,
         egress = excluded.egress, egress_allow = excluded.egress_allow`,
    ).run(id, 0, 0, 'allowlist', csv);
    core.audit(
      actor(req),
      'gates.set',
      `${username} sftp=0 forwarding=0 egress=allowlist allow=${csv}${egress.dryRun ? ' (DRY)' : ''}`,
    );
    await core.events.emit('user.created', { username });
    const u = getUser(id);
    if (!u) return fail(reply, 500, 'kullanıcı kaydı okunamadı');
    return view(u);
  });

  app.put<{ Params: { id: string } }>('/api/users/:id/profile', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const b = obj(req.body);
    if (typeof b.display !== 'string' || b.display.trim().length > 64) return fail(reply, 400, 'geçersiz görünen ad');
    if (!Array.isArray(b.ranks) || !b.ranks.every((r) => typeof r === 'string' && (RANKS as readonly string[]).includes(r))) {
      return fail(reply, 400, 'geçersiz rütbe');
    }
    const display = b.display.trim();
    const ranks = RANKS.filter((r) => (b.ranks as string[]).includes(r));
    db.prepare('UPDATE users SET display = ?, ranks = ? WHERE id = ?').run(display, JSON.stringify(ranks), id);
    core.audit(actor(req), 'users.profile', `${u.username} ranks=${ranks.join(',') || '-'}`);
    const nu = getUser(id);
    if (!nu) return fail(reply, 500, 'kullanıcı kaydı okunamadı');
    return view(nu);
  });

  app.get<{ Params: { id: string } }>('/api/users/:id/avatar', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    if (!getUser(id)) return fail(reply, 404, 'kullanıcı bulunamadı');
    const buf = await readAvatar(core.cfg, id);
    if (!buf) return fail(reply, 404, 'fotoğraf yok');
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=31536000, immutable').send(buf);
  });

  app.put<{ Params: { id: string } }>('/api/users/:id/avatar', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const buf = parseAvatar(obj(req.body).image);
    if (!buf) return fail(reply, 400, 'geçersiz fotoğraf');
    await saveAvatar(core.cfg, db, id, buf);
    core.audit(actor(req), 'users.avatar', u.username);
    const nu = getUser(id);
    return nu ? view(nu) : fail(reply, 500, 'kullanıcı kaydı okunamadı');
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id/avatar', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    await removeAvatar(core.cfg, db, id);
    core.audit(actor(req), 'users.avatar_remove', u.username);
    const nu = getUser(id);
    return nu ? view(nu) : fail(reply, 500, 'kullanıcı kaydı okunamadı');
  });

  app.get('/api/ranks', async () => ({ ranks: RANKS }));

  app.post<{ Params: { id: string } }>('/api/users/:id/lock', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const b = obj(req.body);
    if (typeof b.locked !== 'boolean') return fail(reply, 400, 'geçersiz kilit durumu');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const r = await core.run('user-lock', [u.username, b.locked ? 'lock' : 'unlock']);
    if (!r.ok) return sendScriptFailure(req, reply, 'user-lock', r);
    db.prepare('UPDATE users SET locked = ? WHERE id = ?').run(b.locked ? 1 : 0, id);
    core.audit(actor(req), b.locked ? 'users.lock' : 'users.unlock', `${u.username}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    await killPortalSessions(req, u);
    const folders = readRows<FolderNameRow>(
      FOLDER_NAME_ROW,
      db
        .prepare('SELECT f.name AS name FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ? ORDER BY f.name')
        .all(id),
    );
    for (const f of folders) {
      const rv = await core.run('revoke', [u.username, f.name]);
      if (!rv.ok) return sendScriptFailure(req, reply, 'revoke', rv);
    }
    const r = await core.run('user-del', [u.username]);
    if (!r.ok) return sendScriptFailure(req, reply, 'user-del', r);
    purgeUserRecords(db, id, u.username);
    try {
      archiveUserChats(core.cfg.dataDir, u.username);
    } catch (err) {
      req.log.error({ err, username: u.username }, 'sohbet dosyaları taşınamadı');
    }
    await removeAvatar(core.cfg, db, id);
    core.audit(actor(req), 'users.delete', `${u.username}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });
}

const mod: GateModule = { name: 'users', register };
export default mod;
