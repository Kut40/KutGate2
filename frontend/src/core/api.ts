import { errorText } from './errors';
import { EVT_LOCKED, EVT_RECHECK } from './lock/types';

export class ApiError extends Error {
  status: number;
  /** Özgün hata kodu (message Türkçe metindir). */
  code: string;
  /** Yanıt gövdesi (varsa). */
  data: unknown;
  constructor(code: string, status: number, data?: unknown) {
    super(errorText(code));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function failure(res: Response, path: string): Promise<ApiError> {
  const data = parseJson(await res.text());
  const msg =
    data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
      ? (data as { error: string }).error
      : res.statusText || `HTTP ${res.status}`;
  if (res.status === 401 && msg !== 'totp_required' && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('gate:unauthorized'));
  }
  // Kilitli oturum (423 locked) ya da PIN yok (428 setup_pin): durum yeniden okunur.
  if (res.status === 423 && msg === 'locked') window.dispatchEvent(new Event(EVT_LOCKED));
  else if (res.status === 428 || (res.status === 403 && msg === 'setup_incomplete')) window.dispatchEvent(new Event(EVT_RECHECK));
  return new ApiError(msg, res.status, data);
}

export async function apiResponse(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-gate-csrf'] = '1';
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw await failure(res, path);
  return res;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiResponse(method, path, body);
  return parseJson(await res.text()) as T;
}

export async function getText(path: string): Promise<string> {
  const res = await apiResponse('GET', path);
  return res.text();
}

export const get = <T = unknown>(path: string) => api<T>('GET', path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = unknown>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const del = <T = unknown>(path: string) => api<T>('DELETE', path);
