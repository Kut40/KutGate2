import type { FastifyRequest } from 'fastify';
import { APIKEY_RE } from '../../core/exec.js';
import { claudeKeyHint, deleteClaudeKey, readClaudeKey, writeClaudeKey } from '../../core/claudeKey.js';
import type { Core, GateModule } from '../../core/types.js';

function actor(req: FastifyRequest): string {
  return req.admin?.username ?? 'unknown';
}

function status(dataDir: string): { set: boolean; hint: string | null } {
  const key = readClaudeKey(dataDir);
  return { set: key !== null, hint: key ? claudeKeyHint(key) : null };
}

/** Ayarlar → Gate'in kendi Claude anahtarı (skill üretici ve devlog özeti bunu kullanır). */
function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { dataDir } = core.cfg;

  app.get('/api/settings/claude-key', async () => status(dataDir));

  app.put('/api/settings/claude-key', async (req, reply) => {
    const body = req.body as { key?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.replace(/\s+/g, '') : '';
    if (!APIKEY_RE.test(key)) return reply.code(400).send({ error: 'geçersiz API anahtarı' });
    await writeClaudeKey(dataDir, key);
    core.audit(actor(req), 'settings.claude_key_set', claudeKeyHint(key));
    return status(dataDir);
  });

  app.delete('/api/settings/claude-key', async (req) => {
    await deleteClaudeKey(dataDir);
    core.audit(actor(req), 'settings.claude_key_delete');
    return status(dataDir);
  });
}

const mod: GateModule = { name: 'claudekey', register };
export default mod;
