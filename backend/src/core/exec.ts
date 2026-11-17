import { isTreePath } from '../portal/tree.js';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { Config, RunResult, ScriptName } from './types.js';
import type { AuditFn } from './audit.js';

export const USER_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const MODULE_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const SESSION_ID_RE = /^[a-f0-9]{24}$/;
export const AGENT_RESUME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UNIT_RE = /^gate-portal-[a-z][a-z0-9_-]{1,31}-[a-f0-9]{24}$/;
export const APIKEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
export const AGENTLOG_NAME_RE = /^[A-Za-z0-9._-]{1,200}\.jsonl$/;
export const AGENTLOG_SUBDIR_NAME_RE = /^[A-Za-z0-9._-]{1,200}\/[A-Za-z0-9._-]{1,200}\.jsonl$/;
export const AGENTLOG_MAX_BYTES = 5 * 1024 * 1024;
export const EPOCH_RE = /^[0-9]{1,12}$/;
const TIMEOUT_MS = 30 * 1000;

export function isAgentLogName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (!AGENTLOG_NAME_RE.test(s) && !AGENTLOG_SUBDIR_NAME_RE.test(s)) return false;
  return s.split('/').every((part) => part !== '.' && part !== '..');
}

export function isApiKeyLine(stdin: string | undefined): boolean {
  if (typeof stdin !== 'string') return false;
  const line = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin;
  return APIKEY_RE.test(line);
}

export function isIpOrCidr(s: string): boolean {
  if (s.includes('%')) return false;
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return false;
  const v = isIP(m[1]);
  if (v === 0) return false;
  if (m[2] === undefined) return true;
  const p = Number(m[2]);
  return p <= (v === 4 ? 32 : 128);
}

/** Dosya yolu yalnızca izinli köklerin altında olabilir ve `..` içeremez. */
export function isAllowedFilePath(cfg: Config, p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!isAbsolute(p) || p.includes('..') || p.includes('\0') || /[\r\n]/.test(p)) return false;
  if (normalize(p) !== p) return false;
  const rules = cfg.rulesRoot + sep;
  if (p.startsWith(rules)) return true;
  const home = cfg.homeRoot + sep;
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split(sep);
    return rest.length >= 4 && USER_RE.test(rest[0]) && rest[1] === '.claude' && rest[2] === 'skills';
  }
  return false;
}

function isUser(s: string | undefined): boolean {
  return typeof s === 'string' && USER_RE.test(s);
}
function isModule(s: string | undefined): boolean {
  return typeof s === 'string' && MODULE_RE.test(s);
}
function isKeyLine(stdin: string | undefined): boolean {
  if (typeof stdin !== 'string') return false;
  const line = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin;
  return line.trim().length > 0 && !/[\r\n\0]/.test(line);
}

type Validator = (args: string[], stdin: string | undefined, cfg: Config) => boolean;

const VALIDATORS: Record<ScriptName, Validator> = {
  'user-add': (a, s) => a.length === 1 && isUser(a[0]) && s === undefined,
  'user-del': (a, s) => a.length === 1 && isUser(a[0]) && s === undefined,
  'user-lock': (a, s) => a.length === 2 && isUser(a[0]) && (a[1] === 'lock' || a[1] === 'unlock') && s === undefined,
  'key-add': (a, s) => a.length === 1 && isUser(a[0]) && isKeyLine(s),
  'key-del': (a, s) => a.length === 1 && isUser(a[0]) && isKeyLine(s),
  'module-add': (a, s) => a.length === 1 && isModule(a[0]) && s === undefined,
  'module-del': (a, s) => a.length === 1 && isModule(a[0]) && s === undefined,
  grant: (a, s) => a.length === 3 && isUser(a[0]) && isModule(a[1]) && (a[2] === 'r' || a[2] === 'rw') && s === undefined,
  revoke: (a, s) => a.length === 2 && isUser(a[0]) && isModule(a[1]) && s === undefined,
  'egress-profile': (a, s) => {
    if (s !== undefined) return false;
    if (a.length !== 4 && a.length !== 5) return false;
    if (!isUser(a[0])) return false;
    if (a[1] !== '0' && a[1] !== '1') return false;
    if (a[2] !== '0' && a[2] !== '1') return false;
    if (a[3] !== 'none' && a[3] !== 'allowlist' && a[3] !== 'open') return false;
    if (a.length === 5) {
      const items = a[4].split(',');
      if (items.length === 0 || !items.every((x) => isIpOrCidr(x))) return false;
    }
    return true;
  },
  'rules-init': (a, s) => a.length === 1 && isUser(a[0]) && s === undefined,
  'file-write': (a, s, cfg) => a.length === 1 && isAllowedFilePath(cfg, a[0]) && typeof s === 'string',
  'file-delete': (a, s, cfg) => a.length === 1 && isAllowedFilePath(cfg, a[0]) && s === undefined,
  'portal-shell': (a, s) => {
    if (s !== undefined || a.length < 2 || a.length > 4) return false;
    if (!isUser(a[0]) || !SESSION_ID_RE.test(a[1])) return false;
    if (a.length >= 3 && a[2] !== 'agent') return false;
    return a.length !== 4 || AGENT_RESUME_UUID_RE.test(a[3]);
  },
  'session-kill': (a, s) => a.length === 1 && UNIT_RE.test(a[0]) && s === undefined,
  'portal-mode': (a, s) =>
    a.length === 2 && isUser(a[0]) && (a[1] === 'on' || a[1] === 'off' || a[1] === 'status') && s === undefined,
  'apikey-set': (a, s) => {
    if (a.length === 1) return isUser(a[0]) && isApiKeyLine(s);
    return a.length === 2 && isUser(a[0]) && a[1] === '--delete' && s === undefined;
  },
  'agent-logs': (a, s) => {
    if (s !== undefined || !isUser(a[0])) return false;
    if (a.length === 2) return a[1] === 'list';
    return a.length === 3 && a[1] === 'read' && isAgentLogName(a[2]);
  },
  'dev-changes': (a, s) => a.length === 2 && isUser(a[0]) && EPOCH_RE.test(a[1]) && s === undefined,
  'git-proje': (a, s) => {
    if (a.length !== 3 || !isUser(a[0]) || !isModule(a[1])) return false;
    if (a[2] === 'clone' || a[2] === 'sync') return s === undefined;
    if (a[2] !== 'send' && a[2] !== 'env') return false;
    return typeof s === 'string' && s.trim().length > 0 && s.length <= (a[2] === 'send' ? 2000 : 20000) && !s.includes('\0');
  },
  'project-list': (a, s) =>
    (a.length === 2 || a.length === 3) &&
    isUser(a[0]) &&
    /^[a-z][a-z0-9-]{1,31}$/.test(a[1]) &&
    (a.length === 2 || isTreePath(a[2])) &&
    s === undefined,
};

export function isValidScriptCall(cfg: Config, script: ScriptName, args: string[], stdin?: string): boolean {
  const validator = Object.hasOwn(VALIDATORS, script) ? VALIDATORS[script] : undefined;
  return !!validator && Array.isArray(args) && args.every((x) => typeof x === 'string') && validator(args, stdin, cfg);
}

export function scriptPath(cfg: Config, script: ScriptName): string {
  return join(cfg.scriptsDir, `${script}.sh`);
}

export type RunFn = (script: ScriptName, args: string[], stdin?: string) => Promise<RunResult>;

export function makeRunner(cfg: Config, audit: AuditFn): RunFn {
  return async function run(script, args, stdin) {
    if (!isValidScriptCall(cfg, script, args, stdin)) {
      return { ok: false, dryRun: cfg.dryRun, code: -1, stdout: '', stderr: `geçersiz argüman: ${String(script)}` };
    }
    if (cfg.dryRun) {
      audit('system', `exec.${script}`, `DRY ${args.join(' ')}`.trim());
      return { ok: true, dryRun: true, code: 0, stdout: '', stderr: '' };
    }
    const path = scriptPath(cfg, script);
    const timeout = script === 'git-proje' ? 180 * 1000 : TIMEOUT_MS;
    const maxBuffer = script === 'agent-logs' ? AGENTLOG_MAX_BYTES + 1024 * 1024 : 1024 * 1024;
    return new Promise<RunResult>((resolve) => {
      const child = execFile(
        'sudo',
        ['-n', '--', path, ...args],
        { timeout, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ ok: true, dryRun: false, code: 0, stdout, stderr });
            return;
          }
          const code = typeof err.code === 'number' ? err.code : -1;
          let msg = stderr;
          if (err.killed) msg = `${msg}${msg ? '\n' : ''}zaman aşımı (${timeout / 1000} sn)`;
          if (!msg) msg = err.message;
          resolve({ ok: false, dryRun: false, code, stdout, stderr: msg.trim() });
        },
      );
      child.stdin?.on('error', () => {});
      if (stdin !== undefined) child.stdin?.end(stdin);
      else child.stdin?.end();
    });
  };
}
