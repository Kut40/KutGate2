import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { sendScriptFailure } from '../../core/scriptError.js';
import { generateEd25519 } from './keygen.js';
import {
  isValidComment,
  isValidHost,
  isValidUsername,
  parsePort,
  privateKeyLines,
  unixScript,
  windowsScript,
} from './scripts.js';
import { isOs, TokenStore } from './tokens.js';

const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[A-Za-z0-9-]+) ([A-Za-z0-9+/]+={0,3})(?: (.*))?$/;

interface KeyRow {
  id: number;
  user_id: number;
  key: string;
  comment: string | null;
  fingerprint: string;
}

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

function parseKey(raw: string): { key: string; comment: string; fingerprint: string } | null {
  if (/[\r\n\0]/.test(raw)) return null;
  const line = raw.trim().replace(/[ \t]+/g, ' ');
  const m = KEY_RE.exec(line);
  if (!m) return null;
  const blob = Buffer.from(m[2], 'base64');
  if (blob.length === 0) return null;
  const fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { key: line, comment: m[3] ?? '', fingerprint };
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db } = core;
  const tokens = new TokenStore();
  const sweeper = setInterval(() => tokens.sweep(), 60 * 1000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  function getUser(id: number): { id: number; username: string } | undefined {
    return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as unknown as
      | { id: number; username: string }
      | undefined;
  }

  async function addKey(
    u: { id: number; username: string },
    parsed: { key: string; fingerprint: string },
    comment: string,
  ): Promise<{ ok: true; id: number; dryRun: boolean } | { ok: false; code: number; stderr: string }> {
    const r = await core.run('key-add', [u.username], parsed.key + '\n');
    if (!r.ok) return { ok: false, code: r.code, stderr: r.stderr };
    const res = db
      .prepare('INSERT INTO ssh_keys(user_id, key, comment, fingerprint, created) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, parsed.key, comment, parsed.fingerprint, new Date().toISOString());
    return { ok: true, id: Number(res.lastInsertRowid), dryRun: r.dryRun };
  }

  app.get<{ Params: { id: string } }>('/api/users/:id/keys', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    if (!getUser(id)) return fail(reply, 404, 'kullanıcı bulunamadı');
    const rows = db
      .prepare('SELECT id, user_id, key, comment, fingerprint FROM ssh_keys WHERE user_id = ? ORDER BY id')
      .all(id) as unknown as KeyRow[];
    return rows.map((r) => ({ id: r.id, comment: r.comment ?? '', fingerprint: r.fingerprint, key: r.key }));
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/keys', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const b = obj(req.body);
    if (typeof b.key !== 'string') return fail(reply, 400, 'anahtar gerekli');
    if (b.comment !== undefined && b.comment !== null && typeof b.comment !== 'string') {
      return fail(reply, 400, 'geçersiz açıklama');
    }
    const parsed = parseKey(b.key);
    if (!parsed) return fail(reply, 400, 'anahtar tek satır olmalı ve ssh-ed25519, ssh-rsa veya ecdsa-sha2-* ile başlamalı');
    if (db.prepare('SELECT 1 FROM ssh_keys WHERE user_id = ? AND key = ?').get(id, parsed.key)) {
      return fail(reply, 409, 'anahtar zaten ekli');
    }
    const comment = typeof b.comment === 'string' && b.comment !== '' ? b.comment : parsed.comment;
    const r = await addKey(u, parsed, comment);
    if (!r.ok) return sendScriptFailure(req, reply, 'key-add', r);
    core.audit(actor(req), 'keys.add', `${u.username} ${parsed.fingerprint}${r.dryRun ? ' (DRY)' : ''}`);
    return { id: r.id, comment, fingerprint: parsed.fingerprint, key: parsed.key };
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/keys/generate', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const u = getUser(id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    if (!isValidUsername(u.username)) return fail(reply, 400, 'geçersiz kullanıcı adı');
    const b = obj(req.body);
    const host = b.host;
    if (!isValidHost(host)) return fail(reply, 400, 'geçersiz sunucu adresi');
    const port = parsePort(b.port);
    if (port === null) return fail(reply, 400, 'geçersiz port');
    let comment = `gate-${u.username}`;
    const rawComment = b.comment;
    if (rawComment !== undefined && rawComment !== null && rawComment !== '') {
      if (!isValidComment(rawComment)) return fail(reply, 400, 'geçersiz açıklama');
      comment = rawComment;
    }

    const token = tokens.reserve(id, u.username);
    if (token === null) return fail(reply, 429, 'bu kullanıcı için en fazla 3 bekleyen indirme olabilir');
    let activated = false;
    try {
      let generated: { publicKey: string; privateKey: string };
      try {
        generated = await generateEd25519(core.cfg.dataDir, comment);
      } catch (e) {
        req.log.error({ err: e }, 'ssh-keygen başarısız');
        return fail(reply, 500, 'anahtar üretilemedi');
      }
      const parsed = parseKey(generated.publicKey);
      if (!parsed || !privateKeyLines(generated.privateKey)) return fail(reply, 500, 'üretilen anahtar geçersiz');
      const r = await addKey(u, parsed, comment);
      if (!r.ok) return sendScriptFailure(req, reply, 'key-add', r);
      activated = tokens.activate(token, { privateKey: generated.privateKey, host, port });
      if (!activated) return fail(reply, 500, 'indirme bağlantısı oluşturulamadı');
      core.audit(
        actor(req),
        'keys.generate',
        `${u.username} ${parsed.fingerprint} ${host}:${port}${r.dryRun ? ' (DRY)' : ''}`,
      );
      return {
        keyId: r.id,
        fingerprint: parsed.fingerprint,
        expiresIn: tokens.ttlSeconds,
        downloads: {
          windows: `/api/keys/download/${token}?os=windows`,
          unix: `/api/keys/download/${token}?os=unix`,
        },
      };
    } finally {
      if (!activated) tokens.release(token);
    }
  });

  app.get<{ Params: { token: string }; Querystring: { os?: string } }>(
    '/api/keys/download/:token',
    async (req, reply) => {
      const os = req.query.os;
      if (!isOs(os)) return fail(reply, 400, "işletim sistemi 'windows' ya da 'unix' olmalı");
      const t = tokens.take(req.params.token, os);
      if (t.status === 404) return fail(reply, 404, 'bağlantı geçersiz veya süresi dolmuş');
      if (t.status === 410) return fail(reply, 410, 'bu dosya zaten indirildi');
      const k = t.key;
      const input = { username: k.username, host: k.host, port: k.port, privateKey: k.privateKey };
      const content = os === 'windows' ? windowsScript(input) : unixScript(input);
      const ext = os === 'windows' ? 'cmd' : 'sh';
      core.audit(actor(req), 'keys.download', `${k.username} ${os}`);
      return reply
        .code(200)
        .header('Content-Disposition', `attachment; filename="baglan-${k.username}.${ext}"`)
        .header('Cache-Control', 'no-store')
        .type('application/octet-stream')
        .send(Buffer.from(content, 'utf8'));
    },
  );

  app.delete<{ Params: { keyId: string } }>('/api/keys/:keyId', async (req, reply) => {
    const keyId = parseId(req.params.keyId);
    if (keyId === null) return fail(reply, 400, 'geçersiz id');
    const k = db
      .prepare('SELECT id, user_id, key, comment, fingerprint FROM ssh_keys WHERE id = ?')
      .get(keyId) as unknown as KeyRow | undefined;
    if (!k) return fail(reply, 404, 'anahtar bulunamadı');
    const u = getUser(k.user_id);
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');
    const r = await core.run('key-del', [u.username], k.key + '\n');
    if (!r.ok) return sendScriptFailure(req, reply, 'key-del', r);
    db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(keyId);
    core.audit(actor(req), 'keys.delete', `${u.username} ${k.fingerprint}${r.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });
}

const mod: GateModule = { name: 'sshkeys', register };
export default mod;
