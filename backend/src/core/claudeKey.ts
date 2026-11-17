import { readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { APIKEY_RE } from './exec.js';

/** Gate'in kendi `claude -p` çağrıları (skill üretici, devlog özeti) için Anthropic anahtarı. */
export const CLAUDE_KEY_FILE = 'claude-api.key';

export function claudeKeyPath(dataDir: string): string {
  return join(dataDir, CLAUDE_KEY_FILE);
}

/** Kayıtlı anahtar; yoksa veya biçimi bozuksa null. Her çağrıda diskten okunur (yeniden başlatma gerekmez). */
export function readClaudeKey(dataDir: string): string | null {
  try {
    const k = readFileSync(claudeKeyPath(dataDir), 'utf8').trim();
    return APIKEY_RE.test(k) ? k : null;
  } catch {
    return null;
  }
}

export async function writeClaudeKey(dataDir: string, key: string): Promise<void> {
  if (!APIKEY_RE.test(key)) throw new Error('geçersiz API anahtarı');
  const tmp = join(dataDir, `.${CLAUDE_KEY_FILE}.${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, key, { mode: 0o600, flag: 'wx' });
    await rename(tmp, claudeKeyPath(dataDir));
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function deleteClaudeKey(dataDir: string): Promise<void> {
  await rm(claudeKeyPath(dataDir), { force: true });
}

/** Ekranda gösterilecek ipucu: yalnızca son 4 karakter. */
export function claudeKeyHint(key: string): string {
  return `sk-ant-…${key.slice(-4)}`;
}

/** Anahtarı Claude Code'un beklediği ortam değişkenine koyar (abonelik token'ı → OAuth, diğerleri → API key). */
export function claudeKeyEnv(key: string | null): NodeJS.ProcessEnv {
  if (!key) return {};
  return key.startsWith('sk-ant-oat') ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key };
}
