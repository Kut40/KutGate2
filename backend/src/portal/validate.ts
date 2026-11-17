const MIN_PORTAL_PASSWORD = 12;
const MAX_TERM_SIZE = 500;

export function passwordError(username: string, password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PORTAL_PASSWORD) {
    return `parola en az ${MIN_PORTAL_PASSWORD} karakter olmalı`;
  }
  if (username !== '' && password.toLowerCase().includes(username.toLowerCase())) {
    return 'parola kullanıcı adını içeremez';
  }
  return null;
}

function isSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERM_SIZE;
}

export function parseResize(text: string): { cols: number; rows: number } | null {
  if (!text.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.t !== 'resize' || !isSize(o.cols) || !isSize(o.rows)) return null;
  return { cols: o.cols, rows: o.rows };
}

export function isEndControl(text: string): boolean {
  if (!text.startsWith('{')) return false;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return (v as Record<string, unknown>).t === 'end';
}

export function resizeControl(cols: number, rows: number): string {
  return `\x00RESIZE ${cols} ${rows}\n`;
}

export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
