import { SESSION_ID_RE } from '../core/exec.js';

export interface SessionView {
  id: string;
  userId: number;
  startedMs: number;
  attached: boolean;
  ended: boolean;
}

type TerminalDecision =
  | { kind: 'resume'; id: string }
  | { kind: 'new' }
  | { kind: 'reject' };

export function decideTerminal(opts: {
  resume: unknown;
  userId: number;
  sessions: Iterable<SessionView>;
  maxConcurrent: number;
}): TerminalDecision {
  const own: SessionView[] = [];
  for (const s of opts.sessions) if (s.userId === opts.userId && !s.ended) own.push(s);

  if (typeof opts.resume === 'string' && SESSION_ID_RE.test(opts.resume)) {
    const target = own.find((s) => s.id === opts.resume);
    if (target) return { kind: 'resume', id: target.id };
  }

  if (own.length < opts.maxConcurrent) return { kind: 'new' };

  let oldest: SessionView | null = null;
  for (const s of own) {
    if (s.attached) continue;
    if (!oldest || s.startedMs < oldest.startedMs) oldest = s;
  }
  if (oldest) return { kind: 'resume', id: oldest.id };
  return { kind: 'reject' };
}
