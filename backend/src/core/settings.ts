import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LOCK_MAX_MINUTES, isLockOption } from './screenLock.js';

export interface PortalSettings {
  idleMinutes: number;
  maxMinutes: number;
  maxConcurrent: number;
  detachMinutes: number;
}

const KEYS: Record<keyof PortalSettings, string> = {
  idleMinutes: 'portal.idle_minutes',
  maxMinutes: 'portal.max_minutes',
  maxConcurrent: 'portal.max_concurrent',
  detachMinutes: 'portal.detach_minutes',
};

export const PORTAL_SETTING_LIMITS: Record<keyof PortalSettings, [number, number]> = {
  idleMinutes: [1, 240],
  maxMinutes: [5, 1440],
  maxConcurrent: [1, 5],
  detachMinutes: [1, 120],
};

export const PORTAL_SETTING_DEFAULTS: PortalSettings = {
  idleMinutes: 15,
  maxMinutes: 240,
  maxConcurrent: 1,
  detachMinutes: 15,
};

function inRange(key: keyof PortalSettings, v: unknown): v is number {
  const [min, max] = PORTAL_SETTING_LIMITS[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function validatePortalSettings(v: unknown): PortalSettings | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!inRange('idleMinutes', o.idleMinutes)) return null;
  if (!inRange('maxMinutes', o.maxMinutes)) return null;
  if (!inRange('maxConcurrent', o.maxConcurrent)) return null;
  if (!inRange('detachMinutes', o.detachMinutes)) return null;
  return {
    idleMinutes: o.idleMinutes,
    maxMinutes: o.maxMinutes,
    maxConcurrent: o.maxConcurrent,
    detachMinutes: o.detachMinutes,
  };
}

export function readPortalSettings(db: DatabaseSync): PortalSettings {
  const out: PortalSettings = { ...PORTAL_SETTING_DEFAULTS };
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  for (const k of Object.keys(KEYS) as (keyof PortalSettings)[]) {
    const row = stmt.get(KEYS[k]) as unknown as { value: string | null } | undefined;
    const n = row?.value != null ? Number(row.value) : NaN;
    if (inRange(k, n)) out[k] = n;
  }
  return out;
}

export interface DevlogSettings {
  intervalMinutes: number;
  summarize: boolean;
}

export const DEVLOG_INTERVAL_LIMITS: [number, number] = [1, 120];
export const DEVLOG_SETTING_DEFAULTS: DevlogSettings = { intervalMinutes: 10, summarize: true };

function isInterval(v: unknown): v is number {
  const [min, max] = DEVLOG_INTERVAL_LIMITS;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function validateDevlogSettings(v: unknown): DevlogSettings | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isInterval(o.intervalMinutes)) return null;
  if (typeof o.summarize !== 'boolean') return null;
  return { intervalMinutes: o.intervalMinutes, summarize: o.summarize };
}

export function readDevlogSettings(db: DatabaseSync): DevlogSettings {
  const out: DevlogSettings = { ...DEVLOG_SETTING_DEFAULTS };
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const interval = stmt.get('devlog.interval_minutes') as unknown as { value: string | null } | undefined;
  const n = interval?.value != null ? Number(interval.value) : NaN;
  if (isInterval(n)) out.intervalMinutes = n;
  const summarize = stmt.get('devlog.summarize') as unknown as { value: string | null } | undefined;
  if (summarize?.value === '0') out.summarize = false;
  else if (summarize?.value === '1') out.summarize = true;
  return out;
}

export function writeDevlogSettings(db: DatabaseSync, s: DevlogSettings): void {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.exec('BEGIN');
  try {
    stmt.run('devlog.interval_minutes', String(s.intervalMinutes));
    stmt.run('devlog.summarize', s.summarize ? '1' : '0');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function writePortalSettings(db: DatabaseSync, s: PortalSettings): void {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.exec('BEGIN');
  try {
    for (const k of Object.keys(KEYS) as (keyof PortalSettings)[]) stmt.run(KEYS[k], String(s[k]));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const LOCK_MAX_KEY = 'lock.maxMinutes';

export function readLockMaxMinutes(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LOCK_MAX_KEY) as unknown as
    | { value: string | null }
    | undefined;
  const n = row?.value != null ? Number(row.value) : NaN;
  return isLockOption(n) ? n : DEFAULT_LOCK_MAX_MINUTES;
}

export function writeLockMaxMinutes(db: DatabaseSync, minutes: number): void {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(LOCK_MAX_KEY, String(minutes));
}
