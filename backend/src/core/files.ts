import { mkdir, readdir, rm, rmdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Config } from './types.js';
import { isAllowedFilePath, type RunFn } from './exec.js';

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

export interface Files {
  writeFile(absPath: string, content: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
}

export function makeFiles(cfg: Config, run: RunFn): Files {
  async function writeFile(absPath: string, content: string): Promise<void> {
    if (!isAllowedFilePath(cfg, absPath)) throw httpError(400, 'izin verilmeyen yol');
    if (typeof content !== 'string') throw httpError(400, 'içerik metin olmalı');
    if (cfg.dryRun) {
      await mkdir(dirname(absPath), { recursive: true });
      await fsWriteFile(absPath, content, 'utf8');
      return;
    }
    const r = await run('file-write', [absPath], content);
    if (!r.ok) throw httpError(500, r.stderr || 'dosya yazılamadı');
  }

  async function deleteFile(absPath: string): Promise<void> {
    if (!isAllowedFilePath(cfg, absPath)) throw httpError(400, 'izin verilmeyen yol');
    if (cfg.dryRun) {
      await rm(absPath, { force: true });
      if (basename(absPath) === 'SKILL.md') {
        const dir = dirname(absPath);
        try {
          if ((await readdir(dir)).length === 0) await rmdir(dir);
        } catch {
          /* klasör yoksa veya boş değilse bırak */
        }
      }
      return;
    }
    const r = await run('file-delete', [absPath]);
    if (!r.ok) throw httpError(500, r.stderr || 'dosya silinemedi');
  }

  return { writeFile, deleteFile };
}
