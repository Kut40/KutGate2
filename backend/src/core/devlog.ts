import type { DatabaseSync } from 'node:sqlite';
import { claudeRun } from './claudeRun.js';
import type { Config } from './types.js';
import type { AuditFn } from './audit.js';
import { AGENTLOG_MAX_BYTES, isAgentLogName, MODULE_RE, USER_RE, type RunFn } from './exec.js';
import { readDevlogSettings } from './settings.js';
import { GENERAL_PROJECT, truncateChars, writeDevlogFile } from './board.js';

export const AGENT_TEXT_MAX = 12000;
export const SUMMARY_MAX = 400;
export const DEVLOG_FILES_MAX = 50;
export const BASIC_FILES = 5;
export const SUMMARY_TIMEOUT_MS = 90 * 1000;
export const AGENT_ONLY_SUMMARY = 'Ajanla çalışıldı, dosya değişikliği yok.';
export const SUMMARY_PROMPT =
  'Aşağıdaki geliştirme oturumunu takım arkadaşları için Türkçe, en fazla 2 cümle, kısa ve net özetle. Ne yapıldığını ve hangi bölümde yapıldığını söyle. Kesinlikle kod, dosya içeriği, komut, gizli bilgi yazma. Yalnızca özeti yaz.';

export interface ProjectChanges {
  name: string;
  count: number;
  files: string[];
}

export interface AgentLogEntry {
  file: string;
  size: number;
  mtime: number;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseDevChanges(stdout: string): ProjectChanges[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const o = obj(v);
  if (o.ok !== true || !Array.isArray(o.projects)) return null;
  const out: ProjectChanges[] = [];
  for (const item of o.projects) {
    const p = obj(item);
    if (typeof p.name !== 'string' || !MODULE_RE.test(p.name)) return null;
    if (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 0) return null;
    if (!Array.isArray(p.files) || !p.files.every((f) => typeof f === 'string')) return null;
    out.push({ name: p.name, count: p.count, files: (p.files as string[]).slice(0, DEVLOG_FILES_MAX) });
  }
  return out;
}

export function parseAgentLogList(stdout: string): AgentLogEntry[] | null {
  const text = stdout.trim();
  if (text === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: AgentLogEntry[] = [];
  for (const item of v) {
    const o = obj(item);
    if (typeof o.file !== 'string' || typeof o.size !== 'number' || typeof o.mtime !== 'number') return null;
    out.push({ file: o.file, size: o.size, mtime: o.mtime });
  }
  return out;
}

export function changedLogs(list: AgentLogEntry[], sinceMs: number): AgentLogEntry[] {
  const sinceSec = Math.floor(sinceMs / 1000);
  return list
    .filter((e) => e.mtime >= sinceSec && e.size <= AGENTLOG_MAX_BYTES && isAgentLogName(e.file))
    .sort((a, b) => a.mtime - b.mtime);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const o = obj(item);
    if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
  }
  return parts.join('\n');
}

export function extractAgentText(jsonl: string, sinceMs: number): string {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const o = obj(v);
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!(ts >= sinceMs)) continue;
    const text = contentText(obj(o.message).content).trim();
    if (text === '') continue;
    out.push(`${o.type === 'user' ? 'Kullanıcı' : 'Asistan'}: ${text}`);
  }
  return out.join('\n');
}

export function clipText(s: string, max = AGENT_TEXT_MAX): string {
  return truncateChars(s, max);
}

export function validateSummary(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.includes('```')) return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return truncateChars(s, SUMMARY_MAX);
}

export function basicSummary(count: number, files: string[]): string {
  return `${count} dosyada değişiklik: ${files.slice(0, BASIC_FILES).join(', ')}`;
}

export function buildSummaryPrompt(username: string, projects: ProjectChanges[], chat: string): string {
  const lines = [SUMMARY_PROMPT, '', `Kullanıcı: ${username}`, '', 'Değişen dosyalar:'];
  const changed = projects.filter((p) => p.count > 0);
  if (changed.length === 0) lines.push('(yok)');
  for (const p of changed) {
    lines.push(`${p.name} (${p.count}): ${p.files.join(', ')}`);
  }
  lines.push('', 'Sohbet:', chat === '' ? '(yok)' : chat);
  return lines.join('\n');
}

export function runSummary(cfg: Config, prompt: string): Promise<string | null> {
  return claudeRun(cfg.claudeBin, cfg.dataDir, prompt, SUMMARY_TIMEOUT_MS);
}

export interface TickDeps {
  db: DatabaseSync;
  cfg: Config;
  run: RunFn;
  audit: AuditFn;
}

export interface TickResult {
  written: number;
  renderError: unknown;
}

async function collectAgentText(run: RunFn, username: string, sinceMs: number): Promise<string> {
  const list = await run('agent-logs', [username, 'list']);
  if (!list.ok) throw new Error(`agent-logs list: ${list.stderr}`);
  const entries = parseAgentLogList(list.stdout);
  if (!entries) throw new Error('agent-logs çıktısı geçersiz');
  const parts: string[] = [];
  let total = 0;
  for (const e of changedLogs(entries, sinceMs)) {
    if (total >= AGENT_TEXT_MAX) break;
    const r = await run('agent-logs', [username, 'read', e.file]);
    if (!r.ok) throw new Error(`agent-logs read: ${r.stderr}`);
    const text = extractAgentText(r.stdout, sinceMs);
    if (text === '') continue;
    parts.push(text);
    total += text.length + 1;
  }
  return clipText(parts.join('\n'));
}

export async function devlogTick(
  deps: TickDeps,
  username: string,
  sinceMs: number,
  nowMs: number,
  sessionId: string | null,
): Promise<TickResult> {
  const { db, cfg, run, audit } = deps;
  if (!USER_RE.test(username)) throw new Error('geçersiz kullanıcı adı');
  const changes = await run('dev-changes', [username, String(Math.floor(sinceMs / 1000))]);
  if (!changes.ok) throw new Error(`dev-changes: ${changes.stderr}`);
  const projects = changes.dryRun && changes.stdout.trim() === '' ? [] : parseDevChanges(changes.stdout);
  if (!projects) throw new Error('dev-changes çıktısı geçersiz');
  const chat = await collectAgentText(run, username, sinceMs);
  const changed = projects.filter((p) => p.count > 0);
  if (changed.length === 0 && chat === '') return { written: 0, renderError: null };

  let summary: string | null = null;
  if (readDevlogSettings(db).summarize) {
    summary = validateSummary(await runSummary(cfg, buildSummaryPrompt(username, changed, chat)));
  }
  const mode: 'claude' | 'basic' = summary !== null ? 'claude' : 'basic';
  const ts = new Date(nowMs).toISOString();
  const rows =
    changed.length > 0
      ? changed.map((p) => ({
          project: p.name,
          summary: summary ?? basicSummary(p.count, p.files),
          files: p.files,
          count: p.count,
        }))
      : [{ project: GENERAL_PROJECT, summary: summary ?? AGENT_ONLY_SUMMARY, files: [] as string[], count: 0 }];

  const stmt = db.prepare(
    'INSERT INTO dev_log(ts, username, project, summary, files, file_count, session_id, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(ts, username, r.project, r.summary, JSON.stringify(r.files), r.count, sessionId, mode);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(
    'system',
    'devlog.write',
    `${username} rows=${rows.length} mode=${mode} projects=${rows.map((r) => r.project).join(',')}`,
  );
  let renderError: unknown = null;
  try {
    await writeDevlogFile(db, cfg);
  } catch (e) {
    renderError = e;
  }
  return { written: rows.length, renderError };
}
