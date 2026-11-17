import { closeSync, createWriteStream, existsSync, fstatSync, openSync, readSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';
import { SESSION_ID_RE } from './exec.js';

export const CAST_TAIL_BYTES = 1024 * 1024;

export type EndReason = 'idle' | 'max' | 'closed' | 'admin' | 'exit' | 'error' | 'detached_timeout' | 'logout';
export type CastKind = 'o' | 'i';

export function castPath(cfg: Config, id: string): string | null {
  if (!SESSION_ID_RE.test(id)) return null;
  return join(cfg.sessionsDir, `${id}.cast`);
}

export function castHeader(width: number, height: number, timestampSec: number, title: string): string {
  return JSON.stringify({
    version: 2,
    width,
    height,
    timestamp: timestampSec,
    env: { TERM: 'xterm-256color' },
    title,
  });
}

export function castEvent(seconds: number, kind: CastKind, data: string): string {
  const t = Math.max(0, Math.round(seconds * 1e6) / 1e6);
  return JSON.stringify([t, kind, data]);
}

export function castOutput(text: string): string {
  const lines = text.split('\n');
  let out = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    try {
      const ev = JSON.parse(line) as unknown;
      if (Array.isArray(ev) && ev.length === 3 && ev[1] === 'o' && typeof ev[2] === 'string') out += ev[2];
    } catch {
      continue;
    }
  }
  return out;
}

export function readCastOutput(file: string, tailBytes: number = CAST_TAIL_BYTES): string {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = size > tailBytes ? size - tailBytes - 1 : 0;
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return castOutput(buf.subarray(0, read).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export class CastRecorder {
  private stream: WriteStream | null;
  private headerWritten = false;
  private width = 80;
  private height = 24;
  private readonly startMs: number;

  constructor(
    private readonly file: string,
    private readonly title: string,
    private readonly now: () => number = Date.now,
  ) {
    const fd = openSync(file, 'wx', 0o600);
    const stream = createWriteStream(file, { fd });
    stream.on('error', () => {
      if (this.stream === stream) this.stream = null;
    });
    this.stream = stream;
    this.startMs = this.now();
  }

  resize(cols: number, rows: number): void {
    if (this.headerWritten) return;
    this.width = cols;
    this.height = rows;
  }

  output(data: string): void {
    this.event('o', data);
  }

  input(data: string): void {
    this.event('i', data);
  }

  close(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return Promise.resolve();
    this.ensureHeader();
    this.stream = null;
    return new Promise((resolve) => {
      stream.once('close', () => resolve());
      stream.end();
    });
  }

  private ensureHeader(): void {
    if (this.headerWritten || this.stream === null) return;
    this.headerWritten = true;
    this.stream.write(castHeader(this.width, this.height, Math.floor(this.startMs / 1000), this.title) + '\n');
  }

  private event(kind: CastKind, data: string): void {
    if (this.stream === null || data === '') return;
    this.ensureHeader();
    this.stream.write(castEvent((this.now() - this.startMs) / 1000, kind, data) + '\n');
  }
}

export interface LiveListener {
  data(chunk: string): void;
  end(): void;
}

export class LiveHub {
  private readonly map = new Map<string, Set<LiveListener>>();

  open(id: string): void {
    if (!this.map.has(id)) this.map.set(id, new Set());
  }

  isLive(id: string): boolean {
    return this.map.has(id);
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  subscribe(id: string, listener: LiveListener): (() => void) | null {
    const set = this.map.get(id);
    if (!set) return null;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  publish(id: string, chunk: string): void {
    const set = this.map.get(id);
    if (!set) return;
    for (const l of set) l.data(chunk);
  }

  close(id: string): void {
    const set = this.map.get(id);
    if (!set) return;
    this.map.delete(id);
    for (const l of set) l.end();
  }
}

export interface Deadline {
  at: number;
  reason: 'idle' | 'max';
}

export function sessionDeadline(startedMs: number, lastActivityMs: number, idleMs: number, maxMs: number): Deadline {
  const idleAt = lastActivityMs + idleMs;
  const maxAt = startedMs + maxMs;
  return maxAt <= idleAt ? { at: maxAt, reason: 'max' } : { at: idleAt, reason: 'idle' };
}

export function expiredReason(
  nowMs: number,
  startedMs: number,
  lastActivityMs: number,
  idleMs: number,
  maxMs: number,
): 'idle' | 'max' | null {
  if (nowMs >= startedMs + maxMs) return 'max';
  if (nowMs >= lastActivityMs + idleMs) return 'idle';
  return null;
}
