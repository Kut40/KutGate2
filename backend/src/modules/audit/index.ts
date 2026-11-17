import type { Core, GateModule } from '../../core/types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  detail: string | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db } = core;

  app.get('/api/audit', async (req) => {
    const q = obj(req.query);
    let limit = DEFAULT_LIMIT;
    if (typeof q.limit === 'string' && /^\d+$/.test(q.limit)) limit = Number(q.limit);
    limit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const term = typeof q.q === 'string' ? q.q.trim() : '';
    let rows: AuditRow[];
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      rows = db
        .prepare(
          `SELECT id, ts, actor, action, detail FROM audit
           WHERE actor LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\'
           ORDER BY id DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as unknown as AuditRow[];
    } else {
      rows = db
        .prepare('SELECT id, ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit) as unknown as AuditRow[];
    }
    return rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail: r.detail ?? '' }));
  });
}

const mod: GateModule = { name: 'audit', register };
export default mod;
