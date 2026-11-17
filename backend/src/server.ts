import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { startWsHeartbeat } from './core/wsHeartbeat.js';
import fastifyStatic from '@fastify/static';
import type { Core } from './core/types.js';
import { ensureSandbox, loadConfig } from './core/config.js';
import { requireLicense, watchLicense } from './core/license.js';
import { openDb } from './core/db.js';
import { makeAudit } from './core/audit.js';
import { makeRunner } from './core/exec.js';
import { makeFiles } from './core/files.js';
import { makeAuth } from './core/auth.js';
import { loadModules } from './core/modules.js';
import { makeEvents } from './core/events.js';
import { ADMIN_LOCK_PATHS, lockGate } from './core/screenLock.js';

const PUBLIC_API = new Set(['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const CLIENT_ERROR_TEXT: Record<number, string> = { 413: 'istek çok büyük', 415: 'desteklenmeyen içerik türü' };

function isApiPath(p: string): boolean {
  return p === '/api' || p.startsWith('/api/');
}

const cfg = loadConfig();
requireLicense(cfg);
watchLicense(cfg);
ensureSandbox(cfg);
const db = openDb(cfg);
const audit = makeAudit(db);
const run = makeRunner(cfg, audit);
const files = makeFiles(cfg, run);
const auth = makeAuth(db, audit);

const events = makeEvents((event, err) => {
  audit('system', 'events.error', `${event}: ${err instanceof Error ? err.message : String(err)}`);
});

const core: Core = {
  db,
  events,
  cfg,
  audit,
  run,
  writeFile: files.writeFile,
  deleteFile: files.deleteFile,
  onSessionLocked: auth.onSessionLocked,
  sessionFrameLocked: auth.frameLocked,
  touchSessionActivity: auth.touchActivity,
};

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(websocket);
startWsHeartbeat(app);

app.addHook('onRequest', async (req, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('content-security-policy', CSP);

  const rawPath = req.url.split('?')[0];
  const route = req.routeOptions.url ?? '';
  if (!isApiPath(rawPath) && !isApiPath(route)) return;

  if (req.method !== 'GET' && req.headers['x-gate-csrf'] !== '1') {
    return reply.code(403).send({ error: 'csrf' });
  }
  if (PUBLIC_API.has(route) && PUBLIC_API.has(rawPath)) return;

  const admin = auth.authenticate(req);
  if (!admin) return reply.code(401).send({ error: 'unauthorized' });
  req.admin = admin;
  const blocked = lockGate(admin, req.method, route, ADMIN_LOCK_PATHS);
  if (blocked) return reply.code(blocked.code).send(blocked.body);
});

app.setErrorHandler((err: { statusCode?: number; message?: string; expose?: boolean }, req, reply) => {
  const status =
    typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error(err);
    if (err.expose === true && err.message) return reply.code(status).send({ error: err.message });
    return reply.code(status).send({ error: 'internal_error' });
  }
  if (err.expose === true && err.message) return reply.code(status).send({ error: err.message });
  req.log.info({ err }, 'istek reddedildi');
  return reply.code(status).send({ error: CLIENT_ERROR_TEXT[status] ?? 'geçersiz istek' });
});

const adminDir = join(cfg.frontendDir, 'admin');
const assetsDir = join(cfg.frontendDir, 'assets');
const hasAdminHtml = existsSync(join(adminDir, 'index.html'));
if (existsSync(assetsDir)) {
  await app.register(fastifyStatic, { root: assetsDir, prefix: '/assets/', index: false, wildcard: true });
} else if (hasAdminHtml) {
  await app.register(fastifyStatic, { root: adminDir, serve: false });
}

app.get('/', async (_req, reply) => reply.redirect('/admin/', 302));
app.get('/admin', async (_req, reply) => reply.redirect('/admin/', 301));

app.setNotFoundHandler((req, reply) => {
  const rawPath = req.url.split('?')[0];
  if (req.method === 'GET' && rawPath.startsWith('/admin/') && hasAdminHtml) {
    return reply.sendFile('index.html', adminDir);
  }
  return reply.code(404).send({ error: 'not_found' });
});

auth.registerRoutes(app);

let loadedModules: string[] = [];
app.get('/api/meta', async () => ({
  dryRun: cfg.dryRun,
  rulesRoot: cfg.rulesRoot,
  homeRoot: cfg.homeRoot,
  projectsRoot: cfg.projectsRoot,
  modules: loadedModules,
}));

loadedModules = await loadModules(app, core);

const shutdown = async (): Promise<void> => {
  try {
    await app.close();
  } finally {
    db.close();
    process.exit(0);
  }
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await app.listen({ host: cfg.host, port: cfg.port });
