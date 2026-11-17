import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { startWsHeartbeat } from './core/wsHeartbeat.js';
import fastifyStatic from '@fastify/static';
import { ensureSandbox, ensureSessionsDir, loadConfig } from './core/config.js';
import { requireLicense, watchLicense } from './core/license.js';
import { ensureUserBoardDirs, writeBoardFile, writeDevlogFile } from './core/board.js';
import { makeDevlogScheduler } from './portal/devlog.js';
import { startInboxScanner } from './portal/inbox.js';
import { registerBoardRoutes } from './portal/board.js';
import { registerGitRoutes } from './portal/gitSend.js';
import { makePreview, registerPreviewRoutes } from './portal/preview.js';
import { openDb } from './core/db.js';
import { clientIp } from './core/clientip.js';
import { parseRanks } from './core/ranks.js';
import { avatarVer, parseAvatar, publicAvatarUrl, readAvatar, removeAvatar, saveAvatar } from './core/avatars.js';
import { makeAudit } from './core/audit.js';
import { makeRunner, SESSION_ID_RE } from './core/exec.js';
import { INTERNAL_HEADER, internalPort, internalTokenMatches, loadInternalToken } from './core/internal.js';
import { makePortalAuth, setupIncomplete } from './portal/auth.js';
import { registerTerminal, type SessionHooks } from './portal/terminal.js';
import { MAX_FRAME_BYTES, registerAgent } from './portal/agent.js';
import { attachUpgradeProxy, isProxyPath, makeAdminProxy, type AdminProxy } from './portal/proxy.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { lockGate, PORTAL_LOCK_PATHS } from './core/screenLock.js';

const PUBLIC_PAPI = new Set(['/papi/status', '/papi/login', '/papi/meta', '/papi/team', '/papi/forgot', '/papi/preview/go']);
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const CLIENT_ERROR_TEXT: Record<number, string> = { 413: 'istek çok büyük', 415: 'desteklenmeyen içerik türü' };

function isPapiPath(p: string): boolean {
  return p === '/papi' || p.startsWith('/papi/');
}

const cfg = loadConfig();
requireLicense(cfg);
watchLicense(cfg);
ensureSandbox(cfg);
ensureSessionsDir(cfg);
const db = openDb(cfg);
const audit = makeAudit(db);
const run = makeRunner(cfg, audit);
const auth = makePortalAuth(db, audit);
const internalToken = loadInternalToken(cfg);
const adminProxy = makeAdminProxy(cfg.port, undefined, internalToken);
const preview = makePreview(db, audit, cfg.previewDomain, cfg.portalHostname);
const SHARED_APPS = new Map<string, AdminProxy>(
  cfg.sharedApps.map((a) => [a.host, makeAdminProxy(a.port, JSON.stringify({ error: 'app_unavailable' }))]),
);
const sharedApp = (host: string | undefined): AdminProxy | undefined =>
  SHARED_APPS.get((host ?? '').toLowerCase().replace(/:\d+$/, ''));

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES.send } });
startWsHeartbeat(app);

app.addHook('onRequest', async (req, reply) => {
  const previewOwner = preview.owner(req);
  if (previewOwner) {
    reply.hijack();
    preview.handle(req.raw, reply.raw, previewOwner);
    return;
  }
  const shared = sharedApp(req.headers.host);
  if (shared) {
    reply.hijack();
    shared.forward(req.raw, reply.raw);
    return;
  }
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  // Joker alan adının portal dışındaki alt adları portalı sunmaz.
  if (cfg.previewDomain && host.endsWith('.' + cfg.previewDomain) && host !== cfg.portalHostname) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Bulunamadı');
  }
  const rawPath = req.url.split('?')[0];
  if (isProxyPath(rawPath)) {
    reply.hijack();
    adminProxy.forward(req.raw, reply.raw);
    return;
  }

  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('content-security-policy', CSP);

  const route = req.routeOptions.url ?? '';
  if (!isPapiPath(rawPath) && !isPapiPath(route)) return;

  if (req.method !== 'GET' && req.headers['x-gate-csrf'] !== '1') {
    return reply.code(403).send({ error: 'csrf' });
  }
  if (PUBLIC_PAPI.has(route) && PUBLIC_PAPI.has(rawPath)) return;
  if (req.method === 'GET' && route === '/papi/avatar/:id' && /^\/papi\/avatar\/[1-9][0-9]{0,15}$/.test(rawPath)) return;

  const u = auth.authenticate(req);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  const blocked = lockGate({ locked: u.stage === 'locked', pinRequired: false }, req.method, route, PORTAL_LOCK_PATHS);
  if (blocked) return reply.code(blocked.code).send(blocked.body);
  if (setupIncomplete(u.stage, route, rawPath)) return reply.code(403).send({ error: 'setup_incomplete' });
});

app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
  const status =
    typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error(err);
    return reply.code(status).send({ error: 'internal_error' });
  }
  req.log.info({ err }, 'istek reddedildi');
  return reply.code(status).send({ error: CLIENT_ERROR_TEXT[status] ?? 'geçersiz istek' });
});

const assetsDir = join(cfg.frontendDir, 'assets');
const hasPortalHtml = existsSync(join(cfg.frontendDir, 'portal.html'));
if (existsSync(assetsDir)) {
  await app.register(fastifyStatic, { root: assetsDir, prefix: '/assets/', index: false, wildcard: true });
} else if (hasPortalHtml) {
  await app.register(fastifyStatic, { root: cfg.frontendDir, serve: false });
}

app.setNotFoundHandler((req, reply) => {
  const rawPath = req.url.split('?')[0];
  if (req.method === 'GET' && !isPapiPath(rawPath) && hasPortalHtml) {
    return reply.sendFile('portal.html', cfg.frontendDir);
  }
  return reply.code(404).send({ error: 'not_found' });
});

auth.registerRoutes(app);
app.get<{ Params: { id: string } }>('/papi/avatar/:id', async (req, reply) => {
  const id = /^[1-9][0-9]{0,15}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const visible = id
    ? db
        .prepare('SELECT 1 FROM users u JOIN portal_accounts p ON p.user_id = u.id WHERE u.id = ? AND p.enabled = 1 AND u.locked = 0 AND u.avatar_ver > 0')
        .get(id)
    : undefined;
  const buf = visible ? await readAvatar(cfg, id) : null;
  if (!buf) return reply.code(404).send({ error: 'not_found' });
  return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(buf);
});

app.get('/papi/me/profile', async (req, reply) => {
  const u = auth.authenticate(req);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  const row = db.prepare('SELECT display FROM users WHERE id = ?').get(u.userId) as { display: string | null } | undefined;
  return { avatar: publicAvatarUrl(u.userId, avatarVer(db, u.userId)), display: row?.display?.trim() || null };
});

app.put('/papi/me/avatar', async (req, reply) => {
  const u = auth.authenticate(req);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  const b = req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const buf = parseAvatar(b.image);
  if (!buf) return reply.code(400).send({ error: 'invalid_image' });
  const ver = await saveAvatar(cfg, db, u.userId, buf);
  audit(u.username, 'portal.avatar', '');
  return { avatar: publicAvatarUrl(u.userId, ver) };
});

app.delete('/papi/me/avatar', async (req, reply) => {
  const u = auth.authenticate(req);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  await removeAvatar(cfg, db, u.userId);
  audit(u.username, 'portal.avatar_remove', '');
  return { avatar: null };
});

app.get('/papi/meta', async (req) => ({ dryRun: cfg.dryRun, ip: clientIp(req), teamName: cfg.teamName }));
app.get('/papi/team', async () => {
  const rows = db
    .prepare(
      `SELECT u.id AS id, u.display AS display, u.ranks AS ranks, u.avatar_ver AS avatar_ver FROM users u JOIN portal_accounts p ON p.user_id = u.id
       WHERE p.enabled = 1 AND u.locked = 0 ORDER BY u.id`,
    )
    .all() as { id: number; display: string | null; ranks: string | null; avatar_ver: number | null }[];
  const projects = db.prepare(
    'SELECT f.name AS name FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ? ORDER BY f.name',
  );
  return {
    members: rows.map((r) => ({
      name: (r.display ?? '').trim() || 'Takım üyesi',
      ranks: parseRanks(r.ranks),
      avatar: publicAvatarUrl(r.id, r.avatar_ver),
      projects: (projects.all(r.id) as { name: string }[]).map((p) => p.name),
    })),
  };
});
registerBoardRoutes(app, { db, cfg, auth, run });
registerGitRoutes(app, { auth, run, audit, db, githubOrg: cfg.githubOrg });
registerPreviewRoutes(app, { auth, preview, db, shared: cfg.sharedApps, domain: cfg.previewDomain });
const devlog = makeDevlogScheduler({ db, cfg, run, audit, log: app.log });
const hooks: SessionHooks = {
  onStart: (username, id, startMs) => {
    if (cfg.dryRun) {
      ensureUserBoardDirs(cfg, username).catch((err: unknown) => app.log.error({ err }, 'pano dizinleri oluşturulamadı'));
    }
    devlog.sessionStarted(username, id, startMs);
  },
  onEnd: (username, id) => devlog.sessionEnded(username, id),
};
const terminal = registerTerminal(app, { db, cfg, audit, run, auth, hooks });
const agent = registerAgent(app, { db, cfg, audit, run, auth, hooks });
auth.onLogout((u) => {
  terminal.killUser(u.userId, 'logout');
  agent.killUser(u.userId, 'logout');
});
auth.onLocked((token) => {
  for (const controller of [terminal, agent]) {
    try {
      controller.detachSession(token);
    } catch (err) {
      app.log.error({ err }, 'kilit sonrası soket kapatılamadı');
    }
  }
});
const inbox = startInboxScanner({ db, cfg, audit, log: app.log });
for (const write of [writeBoardFile, writeDevlogFile]) {
  write(db, cfg).catch((err: unknown) => app.log.error({ err }, 'pano dosyası yazılamadı'));
}

const internal = Fastify({ logger: true });
await internal.register(websocket);

internal.addHook('onRequest', async (req, reply) => {
  if (!internalTokenMatches(req.headers[INTERNAL_HEADER], internalToken)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

internal.get('/internal/live', async () => [...terminal.live(), ...agent.live()]);

internal.get<{ Params: { id: string } }>('/internal/watch/:id', { websocket: true }, (socket, req) => {
  const id = req.params.id;
  if (!SESSION_ID_RE.test(id)) {
    socket.close(1008, 'invalid');
    return;
  }
  const sink = {
    send: (data: string) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    close: (code: number, reason: string) => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    },
  };
  socket.on('message', () => {});
  const unsubscribe = (agent.owns(id) ? agent : terminal).watch(id, sink);
  if (!unsubscribe) {
    sink.close(1008, 'invalid');
    return;
  }
  socket.on('close', unsubscribe);
  socket.on('error', unsubscribe);
});

internal.post<{ Params: { id: string } }>('/internal/kill/:id', async (req, reply) => {
  const id = req.params.id;
  if (!SESSION_ID_RE.test(id)) return reply.code(400).send({ error: 'geçersiz id' });
  if (!terminal.kill(id, 'admin') && !agent.kill(id, 'admin')) return reply.code(404).send({ error: 'oturum aktif değil' });
  return { ok: true };
});

internal.post<{ Params: { userId: string } }>('/internal/kill-user/:userId', async (req, reply) => {
  const raw = req.params.userId;
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return reply.code(400).send({ error: 'geçersiz id' });
  const id = Number(raw);
  terminal.killUser(id, 'admin');
  agent.killUser(id, 'admin');
  return { ok: true };
});

const shutdown = async (): Promise<void> => {
  try {
    inbox.stop();
    await Promise.all([terminal.killAll('closed'), agent.killAll('closed')]);
    devlog.stop();
    await internal.close();
    await app.close();
  } finally {
    db.close();
    process.exit(0);
  }
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await internal.listen({ host: '127.0.0.1', port: internalPort(cfg) });
await app.ready();
attachUpgradeProxy(app.server, adminProxy);
preview.attach(app.server);
{
  const previous = app.server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  app.server.removeAllListeners('upgrade');
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const shared = sharedApp(req.headers.host);
    if (shared) {
      shared.upgrade(req, socket, head);
      return;
    }
    for (const fn of previous) fn.call(app.server, req, socket, head);
  });
}
await app.listen({ host: cfg.portalHost, port: cfg.portalPort });
