import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core, GateModule } from '../../core/types.js';
import { claudeRun } from '../../core/claudeRun.js';
import { readOptionalRow, type RowSpec } from '../../core/rows.js';
import { SKILL_NAME_RE, validateSkill } from './validate.js';
import { templateSkill } from './template.js';
import { loadCreatorGuide } from './guide.js';
import {
  ALL_USERS,
  describeTarget,
  fanOutCreateFailed,
  fanOutDeleteFailed,
  isFanOut,
  resolveTarget,
  skillPath,
  targetFiles,
  type Target,
  type TargetKind,
} from './target.js';

const CLAUDE_TIMEOUT_MS = 120 * 1000;

interface SkillRow {
  id: number;
  name: string;
  target_kind: TargetKind;
  target_user: string;
  source: string | null;
  content: string;
  version: number;
  created: string;
  updated: string;
}

const SKILL_ROW: RowSpec<SkillRow> = {
  id: 'number',
  name: 'string',
  target_kind: 'string',
  target_user: 'string',
  source: 'string?',
  content: 'string',
  version: 'number',
  created: 'string',
  updated: 'string',
};

interface WriteOutcome {
  written: number;
  failed: string[];
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

export function buildPrompt(name: string, source: string, guide: string | null = null): string {
  const guideBlock = guide
    ? [
        'Resmi skill-creator yazım rehberine uy (aşağıda). Rehberdeki görüşme, test, değerlendirme ve dosya paketleme adımlarını uygulama; yalnızca tek bir SKILL.md metni üret, ek dosya (scripts/, references/) önerme.',
        '<skill-creator-rehberi>',
        guide,
        '</skill-creator-rehberi>',
        '',
      ]
    : [];
  return [
    ...guideBlock,
    'Aşağıdaki açıklamadan bir Claude Code SKILL.md dosyası üret.',
    'Çıktı YALNIZCA geçerli SKILL.md içeriği olsun: açıklama, giriş cümlesi, kod bloğu işareti (```) veya başka metin ekleme.',
    'Dosya YAML frontmatter ile başlamalı: ilk satır ---, ardından name ve description alanları, sonra --- satırı, ardından Markdown gövde.',
    `name alanı tam olarak "${name}" olmalı.`,
    'description boş olmamalı, TODO olmamalı ve en fazla 1024 karakter olmalı.',
    'Bu skill, sunucudaki takım üyelerinin (Portal kullanıcıları) kendi Claude Code oturumlarında kullanılacak; yönetici/şef/alt ajan/model seçimi gibi yönetici iş akışı kavramlarını ekleme, yalnızca kaynak metindeki amaca odaklan.',
    'Portal oturumlarında şunlar yönetici kuralıyla yasaktır, skill bunları önermesin: dosya içeriğini ekrana döken komutlar (cat, head, tail, less, sed -n, awk print, base64, xxd, diff, git diff, git show, git log -p, git blame), tek seferde 80 satırdan uzun yazma/düzenleme, internete erişim (yalnızca Anthropic açık; npm/pip/git push gibi dış bağlantılar çalışmaz). Değişiklikleri incelemek için git status ve Read aracı kullanılsın.',
    '',
    'Açıklama:',
    source,
  ].join('\n');
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  const { db, cfg } = core;

  function allUsers(): string[] {
    const rows = db.prepare('SELECT username FROM users ORDER BY username').all() as unknown as { username: string }[];
    return rows.map((r) => r.username);
  }

  function parseTarget(kindRaw: unknown, userRaw: unknown): Target | string {
    const t = resolveTarget(kindRaw, userRaw);
    if (typeof t === 'string') return t;
    if (t.kind !== 'global' && t.user !== ALL_USERS) {
      if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(t.user)) return 'hedef kullanıcı bulunamadı';
    }
    return t;
  }

  function rowTarget(s: SkillRow): Target {
    return { kind: s.target_kind, user: s.target_user };
  }

  async function writeTarget(t: Target, name: string, content: string): Promise<WriteOutcome> {
    if (!isFanOut(t)) {
      await core.writeFile(skillPath(cfg, t.kind, t.user, name), content);
      return { written: 1, failed: [] };
    }
    const out: WriteOutcome = { written: 0, failed: [] };
    for (const f of targetFiles(cfg, t, name, allUsers())) {
      try {
        await core.writeFile(f.path, content);
        out.written++;
      } catch {
        out.failed.push(f.user ?? '');
      }
    }
    return out;
  }

  async function deleteTarget(t: Target, name: string): Promise<string[]> {
    if (!isFanOut(t)) {
      await core.deleteFile(skillPath(cfg, t.kind, t.user, name));
      return [];
    }
    const failed: string[] = [];
    for (const f of targetFiles(cfg, t, name, allUsers())) {
      try {
        await core.deleteFile(f.path);
      } catch {
        failed.push(f.user ?? '');
      }
    }
    return failed;
  }

  function failedNote(t: Target, failed: string[]): string {
    return isFanOut(t) && failed.length > 0 ? ` failed=${failed.join(',')}` : '';
  }

  function getSkill(id: number): SkillRow | undefined {
    return readOptionalRow<SkillRow>(SKILL_ROW, db.prepare('SELECT * FROM skills WHERE id = ?').get(id));
  }

  function exists(name: string, kind: TargetKind, user: string): boolean {
    if (db.prepare('SELECT 1 FROM skills WHERE name = ? AND target_kind = ? AND target_user = ?').get(name, kind, user)) {
      return true;
    }
    // home:'*' ile home:<kullanıcı> aynı dosyaya yazar; ikisi bir arada olamaz.
    if (kind !== 'home') return false;
    if (user === ALL_USERS) {
      return !!db.prepare("SELECT 1 FROM skills WHERE name = ? AND target_kind = 'home'").get(name);
    }
    return !!db.prepare("SELECT 1 FROM skills WHERE name = ? AND target_kind = 'home' AND target_user = ?").get(name, ALL_USERS);
  }

  function summary(s: SkillRow) {
    return {
      id: s.id,
      name: s.name,
      targetKind: s.target_kind,
      targetUser: s.target_kind === 'global' || s.target_user === '' ? null : s.target_user,
      version: s.version,
      updated: s.updated,
    };
  }

  function detail(s: SkillRow) {
    const old = db
      .prepare('SELECT version, created FROM skill_versions WHERE skill_id = ? ORDER BY version DESC')
      .all(s.id) as unknown as { version: number; created: string }[];
    return {
      ...summary(s),
      source: s.source ?? '',
      content: s.content,
      versions: [{ version: s.version, created: s.updated }, ...old.map((v) => ({ version: v.version, created: v.created }))],
    };
  }

  function withFailed(s: SkillRow, failed: string[]) {
    const d = detail(s);
    return isFanOut(rowTarget(s)) ? { ...d, failed } : d;
  }

  function insertSkill(name: string, kind: TargetKind, user: string, source: string, content: string): number {
    const now = new Date().toISOString();
    const res = db
      .prepare(
        'INSERT INTO skills(name, target_kind, target_user, source, content, version, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(name, kind, user, source, content, now, now);
    return Number(res.lastInsertRowid);
  }

  core.events.on('user.created', async ({ username }) => {
    const rows = db
      .prepare('SELECT * FROM skills WHERE target_kind = ? AND target_user = ? ORDER BY name')
      .all('home', ALL_USERS) as unknown as SkillRow[];
    for (const s of rows) {
      const path = skillPath(cfg, 'home', username, s.name);
      try {
        await core.writeFile(path, s.content);
        core.audit('system', 'skills.user_sync', `home:${username}/${s.name}${cfg.dryRun ? ' (DRY)' : ''}`);
      } catch (e) {
        core.audit(
          'system',
          'skills.user_sync_failed',
          `home:${username}/${s.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  });

  app.get('/api/skills', async () => {
    const rows = db
      .prepare('SELECT * FROM skills ORDER BY name, target_kind, target_user')
      .all() as unknown as SkillRow[];
    return rows.map(summary);
  });

  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const s = getSkill(id);
    if (!s) return fail(reply, 404, 'skill bulunamadı');
    return detail(s);
  });

  app.post('/api/skills/generate', async (req, reply) => {
    const b = obj(req.body);
    if (typeof b.name !== 'string' || !SKILL_NAME_RE.test(b.name)) return fail(reply, 400, 'geçersiz skill adı');
    if (typeof b.source !== 'string' || b.source.trim() === '') return fail(reply, 400, 'açıklama gerekli');
    const guide = await loadCreatorGuide();
    const raw = await claudeRun(cfg.claudeBin, cfg.dataDir, buildPrompt(b.name, b.source, guide), CLAUDE_TIMEOUT_MS);
    const out = raw === null ? '' : raw.trim();
    if (out !== '') return { content: out + '\n', mode: 'claude' as const };
    return { content: templateSkill(b.name, b.source), mode: 'template' as const };
  });

  app.post('/api/skills/validate', async (req, reply) => {
    const b = obj(req.body);
    if (typeof b.name !== 'string' || typeof b.content !== 'string') {
      return fail(reply, 400, 'ad ve içerik metin olmalı');
    }
    return validateSkill(b.name, b.content);
  });

  app.post('/api/skills', async (req, reply) => {
    const b = obj(req.body);
    if (typeof b.name !== 'string' || !SKILL_NAME_RE.test(b.name)) return fail(reply, 400, 'geçersiz skill adı');
    if (typeof b.content !== 'string') return fail(reply, 400, 'içerik gerekli');
    if (b.source !== undefined && b.source !== null && typeof b.source !== 'string') {
      return fail(reply, 400, 'açıklama metin olmalı');
    }
    const t = parseTarget(b.targetKind, b.targetUser);
    if (typeof t === 'string') return fail(reply, 400, t);
    const v = validateSkill(b.name, b.content);
    if (!v.ok) return fail(reply, 400, v.errors.join('; '));
    if (exists(b.name, t.kind, t.user)) return fail(reply, 409, 'bu hedefte aynı adlı skill var');
    const w = await writeTarget(t, b.name, b.content);
    if (fanOutCreateFailed(w)) {
      return reply.code(500).send({ error: 'skill hiçbir kullanıcıya yazılamadı', failed: w.failed });
    }
    const id = insertSkill(b.name, t.kind, t.user, typeof b.source === 'string' ? b.source : '', b.content);
    core.audit(
      actor(req),
      'skills.create',
      `${describeTarget(t.kind, t.user, b.name)}${failedNote(t, w.failed)}${cfg.dryRun ? ' (DRY)' : ''}`,
    );
    const s = getSkill(id);
    if (!s) return fail(reply, 500, 'skill kaydı okunamadı');
    return withFailed(s, w.failed);
  });

  app.put<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const s = getSkill(id);
    if (!s) return fail(reply, 404, 'skill bulunamadı');
    const b = obj(req.body);
    if (typeof b.content !== 'string') return fail(reply, 400, 'içerik gerekli');
    if (b.source !== undefined && b.source !== null && typeof b.source !== 'string') {
      return fail(reply, 400, 'açıklama metin olmalı');
    }
    const v = validateSkill(s.name, b.content);
    if (!v.ok) return fail(reply, 400, v.errors.join('; '));
    const t = rowTarget(s);
    const w = await writeTarget(t, s.name, b.content);
    if (fanOutCreateFailed(w)) {
      return reply.code(500).send({ error: 'skill hiçbir kullanıcıya yazılamadı', failed: w.failed });
    }
    const now = new Date().toISOString();
    const source = typeof b.source === 'string' ? b.source : (s.source ?? '');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO skill_versions(skill_id, version, content, source, created) VALUES (?, ?, ?, ?, ?)').run(
        s.id,
        s.version,
        s.content,
        s.source ?? '',
        s.updated,
      );
      db.prepare('UPDATE skills SET content = ?, source = ?, version = ?, updated = ? WHERE id = ?').run(
        b.content,
        source,
        s.version + 1,
        now,
        s.id,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(
      actor(req),
      'skills.update',
      `${describeTarget(s.target_kind, s.target_user, s.name)} v${s.version + 1}${failedNote(t, w.failed)}${cfg.dryRun ? ' (DRY)' : ''}`,
    );
    const updated = getSkill(id);
    if (!updated) return fail(reply, 500, 'skill kaydı okunamadı');
    return withFailed(updated, w.failed);
  });

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const s = getSkill(id);
    if (!s) return fail(reply, 404, 'skill bulunamadı');
    const t = rowTarget(s);
    const failed = await deleteTarget(t, s.name);
    if (fanOutDeleteFailed(failed)) {
      return reply.code(500).send({ error: 'skill bazı kullanıcılardan silinemedi', failed });
    }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM skill_versions WHERE skill_id = ?').run(id);
      db.prepare('DELETE FROM skills WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    core.audit(
      actor(req),
      'skills.delete',
      `${describeTarget(s.target_kind, s.target_user, s.name)}${failedNote(t, failed)}${cfg.dryRun ? ' (DRY)' : ''}`,
    );
    return isFanOut(t) ? { ok: true, failed } : { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/skills/:id/sync', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const s = getSkill(id);
    if (!s) return fail(reply, 404, 'skill bulunamadı');
    const t = rowTarget(s);
    if (!isFanOut(t)) return fail(reply, 400, "yalnızca tüm kullanıcılara dağıtılan (home + '*') skill'ler eşitlenebilir");
    const w = await writeTarget(t, s.name, s.content);
    core.audit(
      actor(req),
      'skills.sync',
      `${describeTarget(s.target_kind, s.target_user, s.name)} written=${w.written}${failedNote(t, w.failed)}${cfg.dryRun ? ' (DRY)' : ''}`,
    );
    return { ok: true, written: w.written, failed: w.failed };
  });

  app.post<{ Params: { id: string } }>('/api/skills/:id/copy', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return fail(reply, 400, 'geçersiz id');
    const s = getSkill(id);
    if (!s) return fail(reply, 404, 'skill bulunamadı');
    const b = obj(req.body);
    const t = parseTarget(b.targetKind, b.targetUser);
    if (typeof t === 'string') return fail(reply, 400, t);
    if (exists(s.name, t.kind, t.user)) return fail(reply, 409, 'bu hedefte aynı adlı skill var');
    const w = await writeTarget(t, s.name, s.content);
    if (fanOutCreateFailed(w)) {
      return reply.code(500).send({ error: 'skill hiçbir kullanıcıya yazılamadı', failed: w.failed });
    }
    const newId = insertSkill(s.name, t.kind, t.user, s.source ?? '', s.content);
    core.audit(
      actor(req),
      'skills.copy',
      `${describeTarget(s.target_kind, s.target_user, s.name)} -> ${describeTarget(t.kind, t.user, s.name)}${failedNote(t, w.failed)}${cfg.dryRun ? ' (DRY)' : ''}`,
    );
    const created = getSkill(newId);
    if (!created) return fail(reply, 500, 'skill kaydı okunamadı');
    return withFailed(created, w.failed);
  });
}

const mod: GateModule = { name: 'skills', register };
export default mod;
