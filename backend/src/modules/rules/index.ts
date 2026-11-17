import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';

const EXTENSIONS = new Set(['.md', '.sh', '.txt', '.json']);

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function actor(req: FastifyRequest): string {
  return req.admin?.username ?? 'unknown';
}
function fail(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}
function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

/** Kurallar ağacında listelenip açılabilen dosya uzantıları. */
export function hasAllowedExtension(p: string): boolean {
  return EXTENSIONS.has(extname(p));
}

/** Kökten göreli yolu doğrular ve mutlak yolu döner; geçersizse null. */
function resolveRel(root: string, p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (p.includes('\0') || p.includes('\\') || p.includes('..') || p.startsWith('/')) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.')) return null;
  if (!hasAllowedExtension(p)) return null;
  const abs = resolve(root, p);
  if (!abs.startsWith(root + sep)) return null;
  return abs;
}

/** Sembolik bağlantı üzerinden kök dışına çıkılmadığını doğrular. */
async function staysInside(root: string, abs: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return false;
  }
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return false;
  } catch (e) {
    if (!isNotFound(e)) return false;
  }
  let cur = dirname(abs);
  while (cur.startsWith(root + sep) || cur === root) {
    try {
      const real = await realpath(cur);
      return real === realRoot || real.startsWith(realRoot + sep);
    } catch (e) {
      if (!isNotFound(e)) return false;
      cur = dirname(cur);
    }
  }
  return false;
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const root = resolve(core.cfg.rulesRoot);

  async function walk(dirAbs: string, rel: string, out: { path: string; kind: 'dir' | 'file' }[]): Promise<void> {
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch((e: unknown) => {
      if (isNotFound(e)) return null;
      throw e;
    });
    if (!entries) return;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: relPath, kind: 'dir' });
        await walk(`${dirAbs}${sep}${e.name}`, relPath, out);
      } else if (e.isFile() && hasAllowedExtension(e.name)) {
        out.push({ path: relPath, kind: 'file' });
      }
    }
  }

  app.get('/api/rules/tree', async () => {
    const out: { path: string; kind: 'dir' | 'file' }[] = [];
    await walk(root, '', out);
    return out;
  });

  app.get('/api/rules/file', async (req, reply) => {
    const q = obj(req.query);
    const abs = resolveRel(root, q.path);
    if (!abs) return fail(reply, 400, 'geçersiz yol');
    if (!(await staysInside(root, abs))) return fail(reply, 400, 'geçersiz yol');
    try {
      const content = await readFile(abs, 'utf8');
      return { path: q.path as string, content };
    } catch (e) {
      if (isNotFound(e)) return fail(reply, 404, 'dosya bulunamadı');
      throw e;
    }
  });

  app.put('/api/rules/file', async (req, reply) => {
    const b = obj(req.body);
    const abs = resolveRel(root, b.path);
    if (!abs) return fail(reply, 400, 'geçersiz yol');
    if (typeof b.content !== 'string') return fail(reply, 400, 'içerik metin olmalı');
    if (!(await staysInside(root, abs))) return fail(reply, 400, 'geçersiz yol');
    await core.writeFile(abs, b.content);
    core.audit(actor(req), 'rules.write', `${b.path as string}${core.cfg.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });

  app.delete('/api/rules/file', async (req, reply) => {
    const q = obj(req.query);
    const abs = resolveRel(root, q.path);
    if (!abs) return fail(reply, 400, 'geçersiz yol');
    if (!(await staysInside(root, abs))) return fail(reply, 400, 'geçersiz yol');
    await core.deleteFile(abs);
    core.audit(actor(req), 'rules.delete', `${q.path as string}${core.cfg.dryRun ? ' (DRY)' : ''}`);
    return { ok: true };
  });
}

const mod: GateModule = { name: 'rules', register };
export default mod;
