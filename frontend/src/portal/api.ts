import { errorText } from '../core/errors';
import { EVT_LOCKED, EVT_RECHECK, type LockInfo } from '../core/lock/types';

export class PortalError extends Error {
  status: number;
  /** Özgün hata kodu (message Türkçe metindir). */
  code: string;
  detail?: string;
  constructor(code: string, status: number, detail?: string) {
    super(errorText(code));
    this.name = 'PortalError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const NETWORK_TEXT = 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip yeniden deneyin.';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function papi<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-gate-csrf'] = '1';
  const init: RequestInit = { method, credentials: 'same-origin', headers, signal };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  let text: string;
  try {
    res = await fetch(`/papi${path}`, init);
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw err;
    const netErr = new PortalError('network', 0);
    netErr.message = NETWORK_TEXT;
    throw netErr;
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText || `HTTP ${res.status}`;
    // Kilitli oturum (423 locked) ya da eksik kurulum (403 setup_incomplete): durum yeniden okunur.
    if (res.status === 423 && msg === 'locked') window.dispatchEvent(new Event(EVT_LOCKED));
    else if (res.status === 403 && msg === 'setup_incomplete') window.dispatchEvent(new Event(EVT_RECHECK));
    const detail =
      data && typeof data === 'object' && typeof (data as { detail?: unknown }).detail === 'string'
        ? (data as { detail: string }).detail
        : undefined;
    throw new PortalError(msg, res.status, detail);
  }
  return data as T;
}

export type Stage = 'change_password' | 'setup_totp' | 'setup_pin' | 'locked' | 'ready';

export interface PortalStatus {
  loggedIn: boolean;
  username?: string;
  stage?: Stage;
  maxMinutes?: number;
  unreadAdminNotes?: number;
  lock?: LockInfo;
}

const STAGES: readonly string[] = ['change_password', 'setup_totp', 'setup_pin', 'locked', 'ready'];

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toLockInfo(v: unknown): LockInfo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const l = v as Record<string, unknown>;
  if (!isNum(l.minutes) || !isNum(l.maxMinutes) || !isNum(l.warningSeconds) || !Array.isArray(l.options)) return undefined;
  return { minutes: l.minutes, maxMinutes: l.maxMinutes, warningSeconds: l.warningSeconds, options: l.options.filter(isNum) };
}

export function toPortalStatus(v: unknown): PortalStatus {
  const s = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return {
    loggedIn: s.loggedIn === true,
    username: typeof s.username === 'string' ? s.username : undefined,
    stage: typeof s.stage === 'string' && STAGES.includes(s.stage) ? (s.stage as Stage) : undefined,
    maxMinutes: isNum(s.maxMinutes) ? s.maxMinutes : undefined,
    unreadAdminNotes: isNum(s.unreadAdminNotes) ? s.unreadAdminNotes : undefined,
    lock: toLockInfo(s.lock),
  };
}

export async function getStatus(signal?: AbortSignal): Promise<PortalStatus> {
  return toPortalStatus(await papi<unknown>('GET', '/status', undefined, signal));
}
