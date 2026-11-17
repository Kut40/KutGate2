import type { DatabaseSync } from 'node:sqlite';

/** Kullanıcıya bağlı kayıtları tek işlemde siler; denetim, günlük, oturum geçmişi ve silinmiş sohbetler korunur. */
export function purgeUserRecords(db: DatabaseSync, id: number, username: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM portal_sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM portal_accounts WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM gates WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM grants WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM ssh_keys WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE target_user = ?)').run(username);
    db.prepare('DELETE FROM skills WHERE target_user = ?').run(username);
    db.prepare(
      'DELETE FROM admin_note_reads WHERE username = ? OR note_id IN (SELECT id FROM admin_notes WHERE target = ?)',
    ).run(username, username);
    db.prepare('DELETE FROM admin_notes WHERE target = ?').run(username);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
