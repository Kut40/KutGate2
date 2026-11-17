import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RunResult, ScriptName } from './types.js';

export function scriptErrorLine(script: ScriptName, stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const prefix = `${script}: `;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(prefix)) return lines[i];
  }
  return lines.length > 0 ? lines[lines.length - 1] : `${script}: başarısız`;
}

export function sendScriptFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  script: ScriptName,
  r: Pick<RunResult, 'code' | 'stderr'>,
): FastifyReply {
  req.log.error({ script, code: r.code, stderr: r.stderr }, 'betik başarısız');
  return reply.code(500).send({ error: scriptErrorLine(script, r.stderr) });
}
