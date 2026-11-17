import { isIP } from 'node:net';

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const DEFAULT_PORT = 22;

const HOST_CHARS_RE = /^[A-Za-z0-9.:-]+$/;
const PK_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PK_END = '-----END OPENSSH PRIVATE KEY-----';
const PK_BODY_RE = /^[A-Za-z0-9+/=]+$/;

export function isValidHost(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length === 0 || v.length > 253) return false;
  if (!HOST_CHARS_RE.test(v)) return false;
  if (v.startsWith('.') || v.endsWith('.')) return false;
  if (v.includes(':')) return isIP(v) === 6;
  return true;
}

export function parsePort(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return DEFAULT_PORT;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[0-9]{1,5}$/.test(v)) n = Number(v);
  else return null;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

export function isValidUsername(v: unknown): v is string {
  return typeof v === 'string' && USERNAME_RE.test(v);
}

export function isValidComment(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
}

export function privateKeyLines(pk: unknown): string[] | null {
  if (typeof pk !== 'string') return null;
  const lines = pk.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 3) return null;
  if (lines[0] !== PK_BEGIN || lines[lines.length - 1] !== PK_END) return null;
  for (let i = 1; i < lines.length - 1; i++) {
    if (!PK_BODY_RE.test(lines[i])) return null;
  }
  return lines;
}

interface ScriptInput {
  username: string;
  host: string;
  port: number;
  privateKey: string;
}

function checked(input: ScriptInput): string[] {
  if (!isValidUsername(input.username)) throw new Error('geçersiz kullanıcı adı');
  if (!isValidHost(input.host)) throw new Error('geçersiz host');
  if (!isValidPort(input.port)) throw new Error('geçersiz port');
  const lines = privateKeyLines(input.privateKey);
  if (!lines) throw new Error('geçersiz özel anahtar');
  return lines;
}

export function windowsScript(input: ScriptInput): string {
  const lines = checked(input);
  const { username, host, port } = input;
  const file = `%USERPROFILE%\\.ssh\\gate-${username}`;
  const out = [
    '@echo off',
    'if not exist "%USERPROFILE%\\.ssh" mkdir "%USERPROFILE%\\.ssh"',
    `if exist "${file}" icacls "${file}" /grant:r "%USERNAME%:F" >nul`,
    `if exist "${file}" del /f /q "${file}" >nul`,
    '(',
    ...lines.map((l) => `echo ${l}`),
    `) > "${file}"`,
    `icacls "${file}" /inheritance:r /grant:r "%USERNAME%:R"`,
    `ssh -i "${file}" -o StrictHostKeyChecking=accept-new -p ${port} ${username}@${host}`,
    'pause',
  ];
  return out.join('\r\n') + '\r\n';
}

export function unixScript(input: ScriptInput): string {
  const lines = checked(input);
  const { username, host, port } = input;
  const file = `~/.ssh/gate-${username}`;
  const out = [
    '#!/usr/bin/env bash',
    'set -eu',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    `cat > ${file} <<'GATE_KEY'`,
    ...lines,
    'GATE_KEY',
    `chmod 600 ${file}`,
    `exec ssh -i ${file} -o StrictHostKeyChecking=accept-new -p ${port} ${username}@${host}`,
  ];
  return out.join('\n') + '\n';
}
