import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export const INTERNAL_HEADER = 'x-gate-internal';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const INTERNAL_TIMEOUT_MS = 3000;

export function internalPort(cfg: Config): number {
  return cfg.portalPort + 1;
}

export function internalHttpBase(cfg: Config): string {
  return `http://127.0.0.1:${internalPort(cfg)}`;
}

export function internalWsBase(cfg: Config): string {
  return `ws://127.0.0.1:${internalPort(cfg)}`;
}

export async function internalFetch(
  cfg: Config,
  token: string,
  path: string,
  method: 'GET' | 'POST',
): Promise<Response | null> {
  try {
    return await fetch(`${internalHttpBase(cfg)}${path}`, {
      method,
      headers: { [INTERNAL_HEADER]: token },
      signal: AbortSignal.timeout(INTERNAL_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export function loadInternalToken(cfg: Config): string {
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const file = join(cfg.dataDir, 'internal.token');
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  chmodSync(file, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  if (!TOKEN_RE.test(token)) throw new Error('internal.token geçersiz');
  return token;
}

export function internalTokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || !TOKEN_RE.test(given)) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}
