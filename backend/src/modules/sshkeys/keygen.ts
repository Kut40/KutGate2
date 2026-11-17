import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TIMEOUT_MS = 30 * 1000;

interface GeneratedKey {
  publicKey: string;
  privateKey: string;
}

function runKeygen(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh-keygen',
      args,
      { timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const msg = (stderr || '').trim() || (err.killed ? 'ssh-keygen zaman aşımı' : 'ssh-keygen başarısız');
        reject(new Error(msg));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

export async function generateEd25519(dataDir: string, comment: string): Promise<GeneratedKey> {
  const base = join(dataDir, 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = join(base, randomBytes(16).toString('hex'));
  await mkdir(dir, { mode: 0o700 });
  const keyPath = join(dir, 'key');
  try {
    await runKeygen(['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath]);
    const privateKey = await readFile(keyPath, 'utf8');
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
    return { publicKey, privateKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
