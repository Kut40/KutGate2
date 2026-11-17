import { randomBytes } from 'node:crypto';

export type Os = 'windows' | 'unix';

export const TOKEN_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_USER = 3;
export const TOKEN_RE = /^[0-9a-f]{64}$/;

interface PendingKey {
  userId: number;
  username: string;
  privateKey: string;
  host: string;
  port: number;
  expires: number;
  used: { windows: boolean; unix: boolean };
}

interface Entry {
  userId: number;
  username: string;
  ready: boolean;
  privateKey: string;
  host: string;
  port: number;
  expires: number;
  used: { windows: boolean; unix: boolean };
}

type TakeResult =
  | { status: 200; key: Readonly<PendingKey> }
  | { status: 404 }
  | { status: 410 };

interface TokenStoreOptions {
  ttlMs?: number;
  maxPerUser?: number;
  now?: () => number;
}

export function isOs(v: unknown): v is Os {
  return v === 'windows' || v === 'unix';
}

export class TokenStore {
  private readonly map = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxPerUser: number;
  private readonly now: () => number;

  constructor(opts: TokenStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? TOKEN_TTL_MS;
    this.maxPerUser = opts.maxPerUser ?? MAX_PENDING_PER_USER;
    this.now = opts.now ?? Date.now;
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  get size(): number {
    this.sweep();
    return this.map.size;
  }

  sweep(): void {
    const now = this.now();
    for (const [token, e] of this.map) {
      if (e.expires <= now) this.map.delete(token);
    }
  }

  pendingCount(userId: number): number {
    this.sweep();
    let n = 0;
    for (const e of this.map.values()) if (e.userId === userId) n++;
    return n;
  }

  reserve(userId: number, username: string): string | null {
    if (this.pendingCount(userId) >= this.maxPerUser) return null;
    let token = randomBytes(32).toString('hex');
    while (this.map.has(token)) token = randomBytes(32).toString('hex');
    this.map.set(token, {
      userId,
      username,
      ready: false,
      privateKey: '',
      host: '',
      port: 0,
      expires: this.now() + this.ttlMs,
      used: { windows: false, unix: false },
    });
    return token;
  }

  activate(token: string, data: { privateKey: string; host: string; port: number }): boolean {
    const e = this.map.get(token);
    if (!e || e.ready || e.expires <= this.now()) {
      this.map.delete(token);
      return false;
    }
    e.privateKey = data.privateKey;
    e.host = data.host;
    e.port = data.port;
    e.expires = this.now() + this.ttlMs;
    e.ready = true;
    return true;
  }

  release(token: string): void {
    this.map.delete(token);
  }

  take(token: string, os: Os): TakeResult {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { status: 404 };
    const e = this.map.get(token);
    if (!e) return { status: 404 };
    if (e.expires <= this.now()) {
      this.map.delete(token);
      return { status: 404 };
    }
    if (!e.ready) return { status: 404 };
    if (e.used[os]) return { status: 410 };
    e.used[os] = true;
    const key: PendingKey = {
      userId: e.userId,
      username: e.username,
      privateKey: e.privateKey,
      host: e.host,
      port: e.port,
      expires: e.expires,
      used: { windows: e.used.windows, unix: e.used.unix },
    };
    if (e.used.windows && e.used.unix) this.map.delete(token);
    return { status: 200, key };
  }
}
