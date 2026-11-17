import { join } from 'node:path';

export const USER_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const ALL_USERS = '*';

export type TargetKind = 'home' | 'rules' | 'global';
const KINDS = new Set<string>(['home', 'rules', 'global']);

export interface Target {
  kind: TargetKind;
  user: string;
}

interface Roots {
  homeRoot: string;
  rulesRoot: string;
}

interface TargetFile {
  user: string | null;
  path: string;
}

export function resolveTarget(kindRaw: unknown, userRaw: unknown): Target | string {
  if (typeof kindRaw !== 'string' || !KINDS.has(kindRaw)) return "hedef türü 'home', 'rules' veya 'global' olmalı";
  const kind = kindRaw as TargetKind;
  if (kind === 'global') {
    if (userRaw !== undefined && userRaw !== null && userRaw !== '') return 'global hedefte kullanıcı olmaz';
    return { kind, user: '' };
  }
  if (userRaw === ALL_USERS) {
    return kind === 'rules' ? { kind: 'global', user: '' } : { kind: 'home', user: ALL_USERS };
  }
  if (typeof userRaw !== 'string' || !USER_RE.test(userRaw)) return 'geçersiz hedef kullanıcı';
  return { kind, user: userRaw };
}

export function isFanOut(t: Target): boolean {
  return t.kind === 'home' && t.user === ALL_USERS;
}

/** Yayılımda hiçbir kullanıcıya yazılamadıysa kayıt eklenmez; kullanıcı yoksa hata sayılmaz. */
export function fanOutCreateFailed(w: { written: number; failed: string[] }): boolean {
  return w.written === 0 && w.failed.length > 0;
}

/** Yayılımda silinemeyen kullanıcı varsa kayıt yeniden denenebilsin diye korunur. */
export function fanOutDeleteFailed(failed: string[]): boolean {
  return failed.length > 0;
}

export function skillPath(roots: Roots, kind: TargetKind, user: string, name: string): string {
  switch (kind) {
    case 'home':
      return join(roots.homeRoot, user, '.claude', 'skills', name, 'SKILL.md');
    case 'rules':
      return join(roots.rulesRoot, 'users', user, 'skills', name, 'SKILL.md');
    case 'global':
      return join(roots.rulesRoot, 'global', 'skills', name, 'SKILL.md');
  }
}

export function targetFiles(roots: Roots, t: Target, name: string, allUsers: string[]): TargetFile[] {
  if (isFanOut(t)) {
    return allUsers.filter((u) => USER_RE.test(u)).map((u) => ({ user: u, path: skillPath(roots, 'home', u, name) }));
  }
  return [{ user: t.kind === 'global' ? null : t.user, path: skillPath(roots, t.kind, t.user, name) }];
}

export function describeTarget(kind: TargetKind, user: string, name: string): string {
  return kind === 'global' ? `global/${name}` : `${kind}:${user}/${name}`;
}
