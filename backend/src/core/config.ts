import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './types.js';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PROJECT_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Kuruma özel adlar koda yazılmaz; kurulumda /etc/gate/gate.env ile verilir. Geçersiz değer = açılış durur. */
function hostnameEnv(name: string): string | null {
  const v = env(name)?.toLowerCase();
  if (v === undefined) return null;
  if (!HOSTNAME_RE.test(v)) throw new Error(`${name} geçersiz`);
  return v;
}

function sharedAppsEnv(): Config['sharedApps'] {
  const raw = env('GATE_SHARED_APPS');
  if (raw === undefined) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('GATE_SHARED_APPS geçerli JSON değil');
  }
  if (!Array.isArray(list)) throw new Error('GATE_SHARED_APPS bir dizi olmalı');
  return list.map((a: { project?: unknown; host?: unknown; port?: unknown }) => {
    const host = typeof a?.host === 'string' ? a.host.toLowerCase() : '';
    const port = Number(a?.port);
    if (typeof a?.project !== 'string' || !PROJECT_RE.test(a.project) || !HOSTNAME_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('GATE_SHARED_APPS öğesi geçersiz');
    }
    return { project: a.project, host, port };
  });
}

export function loadConfig(): Config {
  const dryRun = (env('GATE_DRY_RUN') ?? '1') !== '0';
  const dataDir = resolve(env('GATE_DATA_DIR') ?? '/srv/gate/data');
  const port = Number(env('GATE_PORT') ?? '4173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GATE_PORT geçersiz');
  }
  const portalPort = Number(env('GATE_PORTAL_PORT') ?? '4180');
  if (!Number.isInteger(portalPort) || portalPort < 1 || portalPort > 65534) {
    throw new Error('GATE_PORTAL_PORT geçersiz');
  }
  const sandbox = join(dataDir, 'sandbox');
  const modulesRaw = env('GATE_MODULES');
  const modules = modulesRaw
    ? modulesRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;

  return {
    host: env('GATE_HOST') ?? '127.0.0.1',
    port,
    dryRun,
    dataDir,
    scriptsDir: resolve(env('GATE_SCRIPTS_DIR') ?? (dryRun ? '/srv/gate/scripts' : '/usr/local/lib/gate')),
    rulesRoot: resolve(env('GATE_RULES_ROOT') ?? (dryRun ? join(sandbox, 'claude-rules') : '/opt/claude-rules')),
    homeRoot: resolve(env('GATE_HOME_ROOT') ?? (dryRun ? join(sandbox, 'home') : '/home')),
    projectsRoot: resolve(env('GATE_PROJECTS_ROOT') ?? (dryRun ? join(sandbox, 'projects') : '/srv/projects')),
    claudeBin: env('GATE_CLAUDE_BIN') ?? 'claude',
    modules,
    frontendDir: resolve(env('GATE_FRONTEND_DIR') ?? '/srv/gate/frontend/dist'),
    portalHost: env('GATE_PORTAL_HOST') ?? '0.0.0.0',
    portalPort,
    sessionsDir: resolve(env('GATE_SESSIONS_DIR') ?? join(dataDir, 'sessions')),
    boardDir: resolve(env('GATE_BOARD_DIR') ?? (dryRun ? join(sandbox, 'board') : '/var/lib/gate-board')),
    serviceUser: serviceUser(dryRun),
    portalHostname: hostnameEnv('GATE_PORTAL_HOSTNAME'),
    previewDomain: hostnameEnv('GATE_PREVIEW_DOMAIN'),
    githubOrg: githubOrg(),
    sharedApps: sharedAppsEnv(),
    teamName: (env('GATE_TEAM_NAME') ?? 'Takım').slice(0, 60),
    licenseFile: resolve(env('GATE_LICENSE_FILE') ?? '/etc/gate/license.key'),
  };
}

function serviceUser(dryRun: boolean): string {
  const v = env('GATE_SERVICE_USER');
  if (v === undefined) {
    if (dryRun) return 'gate';
    throw new Error('GATE_SERVICE_USER verilmedi');
  }
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(v)) throw new Error('GATE_SERVICE_USER geçersiz');
  return v;
}

function githubOrg(): string | null {
  const v = env('GATE_GITHUB_ORG');
  if (v === undefined) return null;
  if (!ORG_RE.test(v)) throw new Error('GATE_GITHUB_ORG geçersiz');
  return v;
}

export function ensureSessionsDir(cfg: Config): void {
  mkdirSync(cfg.sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(cfg.sessionsDir, 0o700);
}

/** Dry-run başlangıcında sandbox dizinlerini oluşturur. */
export function ensureSandbox(cfg: Config): void {
  if (!cfg.dryRun) return;
  const dirs = [
    join(cfg.rulesRoot, 'global', 'rules'),
    join(cfg.rulesRoot, 'global', 'references'),
    join(cfg.rulesRoot, 'users', '_template', 'rules'),
    join(cfg.rulesRoot, 'users', '_template', 'references'),
    join(cfg.rulesRoot, 'scripts'),
    cfg.homeRoot,
    cfg.projectsRoot,
    join(cfg.boardDir, 'public'),
    join(cfg.boardDir, 'users'),
    join(cfg.boardDir, 'inbox'),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
