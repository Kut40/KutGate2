import { spawn } from 'node:child_process';
import { adminSessionActive, SESSION_CHECK_MS, SESSION_COOKIE } from '../../core/auth.js';
import { LOCK_CLOSE_CODE, LOCK_CLOSE_REASON } from '../../core/screenLock.js';
import type { Core, GateModule } from '../../core/types.js';

const MAX_TERMINALS = 3;
const IDLE_MS = 15 * 60 * 1000;
const PTY_CODE = 'import pty;pty.spawn(["/bin/bash","-l"])';

function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function register(app: Parameters<GateModule['register']>[0], core: Core): void {
  let active = 0;

  app.get('/api/terminal', { websocket: true }, (socket, req) => {
    const admin = req.admin;
    if (!admin) {
      socket.close(1008, 'unauthorized');
      return;
    }
    if (admin.locked || admin.pinRequired) {
      socket.close(LOCK_CLOSE_CODE, LOCK_CLOSE_REASON);
      return;
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      socket.close(1008, 'origin');
      return;
    }
    if (active >= MAX_TERMINALS) {
      socket.close(1013, 'açık terminal sınırı doldu');
      return;
    }
    active++;
    const token = req.cookies[SESSION_COOKIE] ?? '';

    const child = spawn('python3', ['-c', PTY_CODE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const pid = child.pid ?? 0;
    core.audit(admin.username, 'terminal.open', `pid=${pid}`);

    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sessionCheck: ReturnType<typeof setInterval> | undefined;

    const finish = (reason: string, code = 1000): void => {
      if (closed) return;
      closed = true;
      stopLockWatch();
      if (timer) clearTimeout(timer);
      if (sessionCheck) clearInterval(sessionCheck);
      active--;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(code, reason);
      }
      core.audit(admin.username, 'terminal.close', `pid=${pid} reason=${reason}`);
    };

    const stopLockWatch = core.onSessionLocked((locked) => {
      if (locked === token) finish(LOCK_CLOSE_REASON, LOCK_CLOSE_CODE);
    });

    const sessionGone = (): boolean => {
      if (adminSessionActive(core.db, token)) return false;
      finish('unauthorized', 1008);
      return true;
    };

    const resetIdle = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish('idle'), IDLE_MS);
    };

    const forward = (data: string): void => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.stdin.on('error', () => {});
    child.on('exit', () => finish('exit'));
    child.on('error', (err) => {
      forward(`\r\n[hata: ${err.message}]\r\n`);
      finish('error');
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (closed) return;
      if (sessionGone()) return;
      if (core.sessionFrameLocked(token, admin.username)) {
        finish(LOCK_CLOSE_REASON, LOCK_CLOSE_CODE);
        return;
      }
      resetIdle();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      core.touchSessionActivity(token);
      child.stdin.write(buf);
    });
    socket.on('close', () => finish('ws-close'));
    socket.on('error', () => finish('ws-error'));

    sessionCheck = setInterval(sessionGone, SESSION_CHECK_MS);
    resetIdle();
  });
}

const mod: GateModule = { name: 'terminal', register };
export default mod;
