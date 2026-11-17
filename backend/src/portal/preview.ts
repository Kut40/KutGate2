import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AuditFn } from '../core/audit.js';
import type { PortalAuth } from './auth.js';
import { makeAdminProxy, type AdminProxy } from './proxy.js';
import { uidOf } from './uid.js';

const HOST_PREFIX_RE = /^onizle-([a-z][a-z0-9_-]{1,31})$/;
const COOKIE = 'kg_onizle';
const LOGIN_PATH = '/__kutgate/giris';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS_PER_USER = 50;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PORT_BASE = 5100;
const AUX_BASE = 5200;
const UID_BASE = 1000;
const PORT_SPAN = AUX_BASE - PORT_BASE;
const uidCache = new Map<string, Promise<number | null>>();
const NOT_RUNNING = JSON.stringify({
  error: 'preview_not_running',
  message: 'Önizleme uygulaması çalışmıyor. Uygulamanızı size ayrılan portta başlatın.',
});

function systemUid(username: string): Promise<number | null> {
  const cached = uidCache.get(username);
  if (cached) return cached;
  const pending = uidOf(username).then((uid) => {
    if (uid === null) uidCache.delete(username);
    return uid;
  });
  uidCache.set(username, pending);
  return pending;
}

async function previewPorts(username: string): Promise<{ web: number; aux: number } | null> {
  const uid = await systemUid(username);
  if (uid === null) return null;
  const offset = uid - UID_BASE;
  if (offset < 0 || offset >= PORT_SPAN) return null;
  return { web: PORT_BASE + offset, aux: AUX_BASE + offset };
}

/** Önizleme alan adı kurulumda verilmezse (null) hiçbir host önizleme sayılmaz → özellik kapalı. */
function hostUser(host: string | undefined, domain: string | null): string | null {
  if (!domain) return null;
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  const suffix = '.' + domain;
  if (!h.endsWith(suffix)) return null;
  const m = HOST_PREFIX_RE.exec(h.slice(0, -suffix.length));
  return m ? m[1] : null;
}

function readCookie(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

function stripCookie(header: string | undefined): string | undefined {
  const rest = (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${COOKIE}=`));
  return rest.length ? rest.join('; ') : undefined;
}

function page(res: ServerResponse, status: number, text: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>KutGate önizleme</title><p style="font:15px system-ui;margin:3rem auto;max-width:32rem">${text}</p>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function makePreview(db: DatabaseSync, audit: AuditFn, domain: string | null, portalHostname: string | null) {
  const tokens = new Map<string, { u: string; exp: number }>();
  const sessions = new Map<string, { u: string; exp: number }>();
  const proxies = new Map<number, AdminProxy>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.exp < now) tokens.delete(k);
    for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  };

  const active = (username: string): boolean =>
    !!db.prepare('SELECT 1 FROM users WHERE username = ? AND locked = 0').get(username);

  const allowed = (req: IncomingMessage, owner: string): boolean => {
    const sid = readCookie(req.headers.cookie);
    if (!sid) return false;
    const s = sessions.get(sid);
    return !!s && s.exp > Date.now() && s.u === owner;
  };

  const target = async (req: IncomingMessage, owner: string): Promise<AdminProxy | null> => {
    const ports = active(owner) ? await previewPorts(owner) : null;
    if (!ports) return null;
    const port = ports.web;
    req.headers.host = `127.0.0.1:${port}`;
    const cookie = stripCookie(req.headers.cookie);
    if (cookie === undefined) delete req.headers.cookie;
    else req.headers.cookie = cookie;
    let p = proxies.get(port);
    if (!p) {
      p = makeAdminProxy(port, NOT_RUNNING);
      proxies.set(port, p);
    }
    return p;
  };

  return {
    owner(req: { headers: { host?: string } }): string | null {
      return hostUser(req.headers.host, domain);
    },

    issue(username: string): string {
      sweep();
      const own = [...tokens].filter(([, v]) => v.u === username).map(([k]) => k);
      for (const k of own.slice(0, Math.max(0, own.length - MAX_TOKENS_PER_USER + 1))) tokens.delete(k);
      const t = randomBytes(24).toString('base64url');
      tokens.set(t, { u: username, exp: Date.now() + TOKEN_TTL_MS });
      return `https://onizle-${username}.${domain}${LOGIN_PATH}?t=${t}`;
    },

    handle(req: IncomingMessage, res: ServerResponse, owner: string): void {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === LOGIN_PATH) {
        sweep();
        const t = url.searchParams.get('t') ?? '';
        const tok = tokens.get(t);
        tokens.delete(t);
        if (!tok || tok.exp < Date.now() || tok.u !== owner) {
          page(res, 403, 'Bağlantının süresi dolmuş. KutGate panelinden <b>Önizleme</b> penceresini yeniden açın.');
          return;
        }
        const sid = randomBytes(24).toString('base64url');
        sessions.set(sid, { u: owner, exp: Date.now() + SESSION_TTL_MS });
        audit(owner, 'portal.preview.open', '');
        res.writeHead(302, {
          location: '/',
          'set-cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      if (!allowed(req, owner)) {
        res.writeHead(302, { location: portalHostname ? `https://${portalHostname}/papi/preview/go?u=${encodeURIComponent(owner)}` : '/', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      void target(req, owner)
        .then((p) => {
          if (res.destroyed) return;
          if (p) p.forward(req, res);
          else page(res, 404, 'Önizleme bulunamadı.');
        })
        .catch(() => {
          if (res.headersSent) res.destroy();
          else page(res, 502, 'Önizleme şu anda açılamıyor.');
        });
    },

    attach(server: Server): void {
      const previous = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
      server.removeAllListeners('upgrade');
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const owner = hostUser(req.headers.host, domain);
        if (owner) {
          if (!allowed(req, owner)) {
            socket.destroy();
            return;
          }
          socket.on('error', () => socket.destroy());
          void target(req, owner)
            .then((p) => {
              if (p && !socket.destroyed) p.upgrade(req, socket, head);
              else socket.destroy();
            })
            .catch(() => socket.destroy());
          return;
        }
        for (const fn of previous) fn.call(server, req, socket, head);
      });
    },
  };
}

type Preview = ReturnType<typeof makePreview>;

export function registerPreviewRoutes(
  app: FastifyInstance,
  deps: { auth: PortalAuth; preview: Preview; db: DatabaseSync; shared: { project: string; host: string }[]; domain: string | null },
): void {
  const { auth, preview, db, shared } = deps;
  const enabled = deps.domain !== null;
  const granted = db.prepare('SELECT f.name AS name FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ?');
  app.get('/papi/preview/go', async (req, reply) => {
    const u = auth.authenticate(req);
    const q = req.query as Record<string, unknown>;
    const want = typeof q.u === 'string' ? q.u : '';
    reply.header('cache-control', 'no-store');
    if (!enabled || !u || u.stage !== 'ready') return reply.redirect('/');
    if (want && want !== u.username) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;margin:3rem auto;max-width:32rem">Bu önizleme başka bir kullanıcıya ait.</p>');
    }
    return reply.redirect(preview.issue(u.username));
  });

  app.post('/papi/preview/open', async (req, reply) => {
    const u = auth.authenticate(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized' });
    if (!enabled) return reply.code(404).send({ error: 'preview_disabled' });
    const ports = await previewPorts(u.username);
    if (!ports) return reply.code(500).send({ error: 'preview_unavailable' });
    const mine = new Set((granted.all(u.userId) as { name: string }[]).map((r) => r.name));
    const apps = shared.filter((a) => mine.has(a.project)).map((a) => ({ project: a.project, url: `https://${a.host}/` }));
    return { url: preview.issue(u.username), port: ports.web, aux: ports.aux, host: `onizle-${u.username}.${deps.domain}`, shared: apps };
  });
}
