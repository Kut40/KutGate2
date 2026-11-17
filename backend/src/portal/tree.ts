/** Proje ağacı: yol doğrulama ve betik çıktısının izin listesiyle süzülmesi. Dosya içeriği taşımaz. */

const MAX_PATH = 1024;
const MAX_NAME = 255;
const MAX_ENTRIES = 500;

type TreeEntry = { name: string; type: 'dir' | 'file' | 'link'; size?: number };
type TreeListing = { entries: TreeEntry[]; truncated: boolean };

export function isTreePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p === '') return true;
  if (p.length > MAX_PATH || p.startsWith('/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export function parseTreeOutput(stdout: string): TreeListing | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  const o = v as { ok?: unknown; entries?: unknown; truncated?: unknown };
  if (o.ok !== true || !Array.isArray(o.entries)) return null;
  const entries: TreeEntry[] = [];
  for (const raw of o.entries.slice(0, MAX_ENTRIES)) {
    if (raw === null || typeof raw !== 'object') continue;
    const e = raw as { n?: unknown; t?: unknown; s?: unknown };
    if (typeof e.n !== 'string' || e.n === '' || e.n.length > MAX_NAME || e.n.includes('/')) continue;
    if (e.t === 'd') entries.push({ name: e.n, type: 'dir' });
    else if (e.t === 'l') entries.push({ name: e.n, type: 'link' });
    else if (e.t === 'f') {
      entries.push(typeof e.s === 'number' && e.s >= 0 ? { name: e.n, type: 'file', size: e.s } : { name: e.n, type: 'file' });
    }
  }
  return { entries, truncated: o.truncated === true };
}
