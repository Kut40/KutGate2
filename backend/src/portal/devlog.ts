import type { FastifyBaseLogger } from 'fastify';
import { devlogTick, type TickDeps } from '../core/devlog.js';
import { readDevlogSettings } from '../core/settings.js';

interface DevlogScheduler {
  sessionStarted(username: string, id: string, startMs: number): void;
  sessionEnded(username: string, id: string): void;
  stop(): void;
}

interface UserState {
  sessions: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function makeDevlogScheduler(deps: TickDeps & { log: FastifyBaseLogger }): DevlogScheduler {
  const { log } = deps;
  const users = new Map<string, UserState>();
  const since = new Map<string, number>();
  const lastSession = new Map<string, string>();
  const queued = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  function intervalMs(): number {
    return readDevlogSettings(deps.db).intervalMinutes * 60 * 1000;
  }

  function schedule(username: string): void {
    const st = users.get(username);
    if (!st || stopped) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      enqueue(username);
      schedule(username);
    }, intervalMs());
  }

  function enqueue(username: string): void {
    if (stopped || queued.has(username)) return;
    queued.add(username);
    chain = chain.then(async () => {
      queued.delete(username);
      const from = since.get(username);
      if (from === undefined) return;
      const now = Date.now();
      try {
        const r = await devlogTick(deps, username, from, now, lastSession.get(username) ?? null);
        since.set(username, now);
        if (r.renderError) log.error({ err: r.renderError }, 'Geliştirme_notu.md yazılamadı');
        if (!users.has(username)) {
          since.delete(username);
          lastSession.delete(username);
        }
      } catch (err) {
        log.warn({ err, username }, 'geliştirme günlüğü tick başarısız');
      }
    });
  }

  function sessionStarted(username: string, id: string, startMs: number): void {
    let st = users.get(username);
    if (!st) {
      st = { sessions: new Set(), timer: undefined };
      users.set(username, st);
      if (!since.has(username)) since.set(username, startMs);
      st.sessions.add(id);
      lastSession.set(username, id);
      schedule(username);
      return;
    }
    st.sessions.add(id);
    lastSession.set(username, id);
  }

  function sessionEnded(username: string, id: string): void {
    const st = users.get(username);
    if (!st) return;
    st.sessions.delete(id);
    if (st.sessions.size > 0) return;
    if (st.timer) clearTimeout(st.timer);
    users.delete(username);
    enqueue(username);
  }

  function stop(): void {
    stopped = true;
    for (const st of users.values()) if (st.timer) clearTimeout(st.timer);
  }

  return { sessionStarted, sessionEnded, stop };
}
