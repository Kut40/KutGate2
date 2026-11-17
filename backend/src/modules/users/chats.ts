import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { deletedDirOf } from '../../portal/chatArchive.js';

function exists(p: string): boolean {
  return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

function isRealDir(p: string): boolean {
  return lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function archiveUserChats(dataDir: string, username: string, now = new Date()): string | null {
  const agentDir = join(dataDir, 'agent');
  if (!isRealDir(agentDir)) return null;
  const sources = [
    { parent: agentDir, from: join(agentDir, `${username}.jsonl`), name: `${username}.jsonl` },
    { parent: join(agentDir, 'archive'), from: join(agentDir, 'archive', username), name: 'archive' },
    { parent: join(agentDir, 'deleted'), from: deletedDirOf(dataDir, username), name: 'deleted' },
  ].filter((s) => isRealDir(s.parent) && exists(s.from));
  if (sources.length === 0) return null;
  const removedDir = join(agentDir, 'removed');
  if (!exists(removedDir)) mkdirSync(removedDir, { mode: 0o700 });
  if (!isRealDir(removedDir)) throw new Error(`dizin değil: ${removedDir}`);
  const target = join(removedDir, `${username}-${stamp(now)}`);
  mkdirSync(target, { mode: 0o700 });
  for (const s of sources) renameSync(s.from, join(target, s.name));
  return target;
}
