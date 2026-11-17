import type { DatabaseSync } from 'node:sqlite';

export type AuditFn = (actor: string, action: string, detail?: string) => void;

export function makeAudit(db: DatabaseSync): AuditFn {
  const stmt = db.prepare('INSERT INTO audit(ts, actor, action, detail) VALUES (?, ?, ?, ?)');
  return (actor, action, detail) => {
    stmt.run(new Date().toISOString(), actor, action, detail ?? null);
  };
}
