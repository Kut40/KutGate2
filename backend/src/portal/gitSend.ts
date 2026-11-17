import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RunFn } from '../core/exec.js';
import type { AuditFn } from '../core/audit.js';
import type { PortalAuth } from './auth.js';

const GIT_ROOT = '/srv/gate/git';
const PROJECT_RE = /^[a-z][a-z0-9-]{1,31}$/;
const REMOTE_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120 * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function repoWeb(bare: string): Promise<string | null> {
  const url = await git(['config', '--get', 'remote.origin.url'], bare).catch(() => '');
  const m = REMOTE_RE.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export function registerGitRoutes(
  app: FastifyInstance,
  deps: { auth: PortalAuth; run: RunFn; audit: AuditFn; db: DatabaseSync; githubOrg: string | null },
): void {
  const { auth, run, audit, db } = deps;
  // İzin verilen GitHub hesabı kurulumda verilir; verilmezse yeni depo bağlanamaz (fail-closed).
  const originRe = deps.githubOrg ? new RegExp(`^git@github\\.com:${deps.githubOrg}/[A-Za-z0-9_.-]{1,100}\\.git$`) : null;
  const busy = new Set<string>();
  const rwGrants = db.prepare(
    "SELECT f.name AS name FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.user_id = ? AND g.perm = 'rw' ORDER BY f.name",
  );
  const projects = (userId: number): string[] => {
    const set = new Set((rwGrants.all(userId) as { name: string }[]).map((r) => r.name).filter((n) => PROJECT_RE.test(n)));
    return [...set].sort();
  };

  app.get('/papi/git/projects', async (req, reply) => {
    const u = auth.authenticate(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized' });
    return { projects: projects(u.userId) };
  });

  app.post('/papi/git/sync', async (req, reply) => {
    const u = auth.authenticate(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized' });
    const b = req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const project = typeof b.project === 'string' ? b.project : '';
    if (!projects(u.userId).includes(project)) return reply.code(400).send({ error: 'invalid_project' });
    if (busy.has(u.username)) return reply.code(409).send({ error: 'git_busy' });
    busy.add(u.username);
    try {
      const r = await run('git-proje', [u.username, project, 'sync']);
      let out: { ok?: boolean; error?: string; detail?: unknown; sonuc?: string } = {};
      try {
        out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      } catch {
        out = {};
      }
      if (!r.ok || !out.ok) {
        const code = out.error ?? 'git_hata';
        audit(u.username, 'portal.git.sync_failed', `proje=${project} neden=${code}`);
        return reply
          .code(code === 'cakisma' || code === 'yerel_degisiklik' ? 409 : 500)
          .send({ error: `git_${code}`, detail: typeof out.detail === 'string' ? out.detail : undefined });
      }
      audit(u.username, 'portal.git.sync', `proje=${project} sonuc=${out.sonuc ?? ''}`);
      return { result: out.sonuc === 'guncel' ? 'guncel' : 'birlesti' };
    } finally {
      busy.delete(u.username);
    }
  });

  app.post('/papi/git/send', async (req, reply) => {
    const u = auth.authenticate(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized' });
    const b = req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const project = typeof b.project === 'string' ? b.project : '';
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!projects(u.userId).includes(project)) return reply.code(400).send({ error: 'invalid_project' });
    if (message.length < 3 || message.length > 500) return reply.code(400).send({ error: 'invalid_message' });
    if (busy.has(u.username)) return reply.code(409).send({ error: 'git_busy' });
    busy.add(u.username);
    const bundle = join(GIT_ROOT, 'incoming', `${u.username}-${project}.bundle`);
    try {
      const r = await run('git-proje', [u.username, project, 'send'], message);
      let out: { ok?: boolean; error?: string; detail?: unknown; bundle?: string; origin?: string } = {};
      try {
        out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      } catch {
        out = {};
      }
      if (!r.ok || !out.ok || out.bundle !== bundle) {
        const code = out.error ?? 'git_failed';
        audit(u.username, 'portal.git.send_failed', `proje=${project} neden=${code}`);
        const status = code === 'yasak_dosya' || code === 'proje_yok' || code === 'origin_yok' ? 400 : 500;
        return reply.code(status).send({ error: `git_${code}`, detail: typeof out.detail === 'string' ? out.detail : undefined });
      }
      const bare = join(GIT_ROOT, `${project}.git`);
      if (!existsSync(bare)) {
        if (!originRe || typeof out.origin !== 'string' || !originRe.test(out.origin)) {
          audit(u.username, 'portal.git.send_failed', `proje=${project} neden=origin_yok`);
          return reply.code(400).send({ error: 'git_origin_yok' });
        }
        await git(['init', '-q', '--bare', bare], GIT_ROOT);
        await git(['remote', 'add', 'origin', out.origin], bare);
        await git(['config', 'transfer.fsckObjects', 'true'], bare);
        audit(u.username, 'portal.git.repo_bound', `proje=${project} origin=${out.origin}`);
      }
      const branch = `takim/${u.username}`;
      await git(['fetch', '-q', '--no-tags', bundle, `HEAD:refs/heads/${branch}`], bare).catch((e: Error) => {
        throw Object.assign(new Error(e.message), { code: 'git_ileri_degil' });
      });
      await git(['push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], bare);
      const commit = await git(['rev-parse', '--short', `refs/heads/${branch}`], bare);
      const web = await repoWeb(bare);
      audit(u.username, 'portal.git.send', `proje=${project} dal=${branch} commit=${commit}`);
      return { branch, commit, compareUrl: web ? `${web}/compare/main...${branch}` : null };
    } catch (err) {
      req.log.error({ err }, 'git send');
      const ff = (err as { code?: string }).code === 'git_ileri_degil';
      audit(u.username, 'portal.git.send_failed', `proje=${project} neden=${ff ? 'ileri_degil' : 'push'}`);
      return reply.code(ff ? 409 : 502).send({ error: ff ? 'git_ileri_degil' : 'git_push_failed' });
    } finally {
      busy.delete(u.username);
      rmSync(bundle, { force: true });
    }
  });
}
