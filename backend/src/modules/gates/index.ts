import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { sendScriptFailure } from '../../core/scriptError.js';

type Egress = 'none' | 'allowlist' | 'open';
const EGRESS = new Set<string>(['none', 'allowlist', 'open']);
export const DEFAULT_EGRESS_ALLOW: readonly string[] = ['160.79.104.0/23', '2607:6bc0::/48'];

interface GateRow {
  userId: number;
  username: string;
  sftp: number | null;
  forwarding: number | null;
  egress: string | null;
  egressAllow: string | null;
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

/** Yalnızca IPv4/IPv6 adresi veya CIDR; alan adı kabul edilmez. */
function isIpOrCidr(s: string): boolean {
  if (s.includes('%')) return false;
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return false;
  const v = isIP(m[1]);
  if (v === 0) return false;
  if (m[2] === undefined) return true;
  return Number(m[2]) <= (v === 4 ? 32 : 128);
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db } = core;

  app.get('/api/gates', async () => {
    const rows = db
      .prepare(
        `SELECT u.id AS userId, u.username AS username, g.sftp AS sftp, g.forwarding AS forwarding,
                g.egress AS egress, g.egress_allow AS egressAllow
         FROM users u LEFT JOIN gates g ON g.user_id = u.id ORDER BY u.username`,
      )
      .all() as unknown as GateRow[];
    return rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      sftp: r.sftp === 1,
      forwarding: r.forwarding === 1,
      egress: (r.egress && EGRESS.has(r.egress) ? r.egress : 'none') as Egress,
      egressAllow: r.egressAllow ? r.egressAllow.split(',').filter((x) => x.length > 0) : [],
    }));
  });

  app.put<{ Params: { userId: string } }>('/api/gates/:userId', async (req, reply) => {
    const userId = parseId(req.params.userId);
    if (userId === null) return fail(reply, 400, 'geçersiz id');
    const b = obj(req.body);
    if (typeof b.sftp !== 'boolean' || typeof b.forwarding !== 'boolean') {
      return fail(reply, 400, 'geçersiz SFTP ya da port yönlendirme ayarı');
    }
    if (typeof b.egress !== 'string' || !EGRESS.has(b.egress)) {
      return fail(reply, 400, "dışa çıkış 'none', 'allowlist' veya 'open' olmalı");
    }
    if (!Array.isArray(b.egressAllow) || !b.egressAllow.every((x): x is string => typeof x === 'string')) {
      return fail(reply, 400, 'izinli IP listesi dizi olmalı');
    }
    const allow = (b.egressAllow as string[]).map((x) => x.trim()).filter((x) => x.length > 0);
    const bad = allow.filter((x) => !isIpOrCidr(x));
    if (bad.length) return fail(reply, 400, `geçersiz IP/CIDR: ${bad.join(', ')}`);
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as unknown as
      | { username: string }
      | undefined;
    if (!u) return fail(reply, 404, 'kullanıcı bulunamadı');

    const csv = allow.join(',');
    const args = [u.username, b.sftp ? '1' : '0', b.forwarding ? '1' : '0', b.egress];
    if (csv) args.push(csv);
    const r = await core.run('egress-profile', args);
    if (!r.ok) return sendScriptFailure(req, reply, 'egress-profile', r);
    db.prepare(
      `INSERT INTO gates(user_id, sftp, forwarding, egress, egress_allow) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET sftp = excluded.sftp, forwarding = excluded.forwarding,
         egress = excluded.egress, egress_allow = excluded.egress_allow`,
    ).run(userId, b.sftp ? 1 : 0, b.forwarding ? 1 : 0, b.egress, csv);
    core.audit(
      actor(req),
      'gates.set',
      `${u.username} sftp=${b.sftp ? 1 : 0} forwarding=${b.forwarding ? 1 : 0} egress=${b.egress}${csv ? ` allow=${csv}` : ''}${r.dryRun ? ' (DRY)' : ''}`,
    );
    return { ok: true };
  });
}

const mod: GateModule = { name: 'gates', register };
export default mod;
