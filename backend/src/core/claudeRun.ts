import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeKeyEnv, readClaudeKey } from './claudeKey.js';

export const CLAUDE_MAX_BUFFER = 1024 * 1024;

export interface ClaudeInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function claudeInvocation(prompt: string, baseEnv: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  return {
    args: ['-p', prompt, '--setting-sources', '', '--tools', '', '--no-session-persistence'],
    env: {
      ...baseEnv,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}

function execClaude(bin: string, inv: ClaudeInvocation, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        bin,
        inv.args,
        {
          cwd,
          env: inv.env,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: CLAUDE_MAX_BUFFER,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

export async function claudeRun(bin: string, dataDir: string, prompt: string, timeoutMs: number): Promise<string | null> {
  const base = join(dataDir, 'tmp');
  let dir: string | null = null;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const candidate = join(base, `claude-${randomBytes(16).toString('hex')}`);
    await mkdir(candidate, { mode: 0o700 });
    dir = candidate;
    // Ayarlar'dan kaydedilen anahtar varsa her çağrıda okunur; yoksa servis kullanıcısının kendi girişi kullanılır.
    const env = { ...process.env, ...claudeKeyEnv(readClaudeKey(dataDir)) };
    return await execClaude(bin, claudeInvocation(prompt, env), dir, timeoutMs);
  } catch {
    return null;
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
