import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../core/auth.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function fail(msg: string): never {
  console.error(`HATA: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const resetTotp = args.includes('--totp');
const names = args.filter((a) => !a.startsWith('--'));
const dataDir = process.env.GATE_DATA_DIR ?? '/srv/gate/data-real';
const dbPath = join(dataDir, 'gate.db');
if (!existsSync(dbPath)) fail(`veritabanı bulunamadı: ${dbPath}`);

const db = new DatabaseSync(dbPath);
const admins = db.prepare('SELECT id, username FROM admins ORDER BY id').all() as { id: number; username: string }[];
if (admins.length === 0) fail('yönetici hesabı yok');

let target = admins[0];
if (names.length > 0) {
  const found = admins.find((a) => a.username === names[0]);
  if (!found) fail(`"${names[0]}" adında yönetici yok. Mevcut: ${admins.map((a) => a.username).join(', ')}`);
  target = found;
} else if (admins.length > 1) {
  fail(`birden fazla yönetici var, adını yazın: ${admins.map((a) => a.username).join(', ')}`);
}

const password = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const hash = await hashPassword(password);

db.exec('BEGIN');
db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hash, target.id);
if (resetTotp) db.prepare('UPDATE admins SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(target.id);
const closed = db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
db.prepare('INSERT INTO audit(ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(
  new Date().toISOString(),
  target.username,
  'auth.password_reset_cli',
  `via=ssh totp_sifirlandi=${resetTotp ? 'evet' : 'hayir'} kapanan_oturum=${Number(closed.changes)}`,
);
db.exec('COMMIT');
db.close();

console.log('');
console.log(`Yönetici      : ${target.username}`);
console.log(`Yeni parola   : ${password}`);
console.log(`TOTP          : ${resetTotp ? 'sıfırlandı (girişten sonra yeniden kurun)' : 'değişmedi'}`);
console.log(`Kapanan oturum: ${Number(closed.changes)}`);
console.log('');
console.log('Giriş yaptıktan sonra Ayarlar sayfasından parolanızı değiştirin.');
