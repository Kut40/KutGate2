import { execFile } from 'node:child_process';

const ID_TIMEOUT_MS = 5 * 1000;

export function uidOf(username: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'id',
        ['-u', '--', username],
        { timeout: ID_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout) => {
          const s = stdout.trim();
          resolve(!err && /^[0-9]+$/.test(s) ? Number(s) : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}
