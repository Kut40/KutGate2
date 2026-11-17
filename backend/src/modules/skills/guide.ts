import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resmi skill-creator'ın SKILL.md yazım rehberi (Skill Stüdyosu üretim komutuna eklenir). */
export const CREATOR_PATH =
  process.env.GATE_SKILL_CREATOR ?? join(homedir(), '.claude', 'skills', 'skill-creator', 'SKILL.md');

const START = '### Write the SKILL.md';
const END = '### Test Cases';
const MAX_GUIDE = 16 * 1024;

/** "Write the SKILL.md" … "Test Cases" arasını döndürür; bulunamazsa null. */
export function extractGuide(md: string): string | null {
  const s = md.indexOf(START);
  if (s < 0) return null;
  const e = md.indexOf(END, s + START.length);
  const part = (e < 0 ? md.slice(s) : md.slice(s, e)).trim();
  if (part.length < 200) return null;
  return part.length > MAX_GUIDE ? part.slice(0, MAX_GUIDE) : part;
}

export async function loadCreatorGuide(path: string = CREATOR_PATH): Promise<string | null> {
  try {
    return extractGuide(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
