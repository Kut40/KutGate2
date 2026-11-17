import { useCallback, useRef, useState } from 'react';
import type { AttachmentKind, AttachmentPayload } from './protocol';

const MAX_FILES = 5;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'rb', 'sh', 'bash', 'sql', 'css', 'scss', 'html', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'vue', 'svelte', 'swift', 'lua',
];

export const ACCEPT_FILES = ['text/*', 'application/pdf', ...IMAGE_MIMES, ...TEXT_EXT.map((e) => `.${e}`)].join(',');
export const ACCEPT_IMAGES = 'image/*';

export type AttachItem = {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mime: string;
  dataUrl: string | null;
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function classify(f: File): { kind: AttachmentKind; mime: string } | null {
  const t = f.type.toLowerCase();
  if (IMAGE_MIMES.includes(t)) return { kind: 'image', mime: t };
  if (t === 'application/pdf' || extOf(f.name) === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (t.startsWith('text/') || TEXT_EXT.includes(extOf(f.name))) return { kind: 'text', mime: t.startsWith('text/') ? t : 'text/plain' };
  return null;
}

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read')));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(f);
  });
}

export function toPayload(a: AttachItem): AttachmentPayload {
  const url = a.dataUrl ?? '';
  return { name: a.name, mime: a.mime, data: url.slice(url.indexOf(',') + 1) };
}

export function useAttachments() {
  const [items, setItems] = useState<AttachItem[]>([]);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(0);
  const itemsRef = useRef<AttachItem[]>([]);
  const seq = useRef(0);

  const commit = (next: AttachItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const add = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setError('');
    let list = itemsRef.current;
    let total = list.reduce((s, a) => s + a.size, 0);
    const accepted: { file: File; kind: AttachmentKind; mime: string }[] = [];
    let err = '';
    for (const f of files) {
      if (list.length + accepted.length >= MAX_FILES) {
        err = `En fazla ${MAX_FILES} dosya eklenebilir.`;
        break;
      }
      const c = classify(f);
      if (!c) {
        err = `"${f.name}" desteklenmeyen bir dosya türü.`;
        continue;
      }
      const limit = c.kind === 'image' ? MAX_IMAGE : c.kind === 'pdf' ? MAX_PDF : MAX_TEXT;
      if (f.size > limit) {
        err = `"${f.name}" çok büyük: ${c.kind === 'image' ? 'resim' : c.kind === 'pdf' ? 'PDF' : 'metin dosyası'} en çok ${fmtSize(limit)} olabilir.`;
        continue;
      }
      if (f.size === 0) {
        err = `"${f.name}" boş bir dosya.`;
        continue;
      }
      if (total + f.size > MAX_TOTAL) {
        err = `Toplam ek boyutu ${fmtSize(MAX_TOTAL)} sınırını aşamaz.`;
        continue;
      }
      total += f.size;
      accepted.push({ file: f, ...c });
    }
    if (err) setError(err);
    if (accepted.length === 0) return;
    setReading((n) => n + accepted.length);
    for (const a of accepted) {
      try {
        const dataUrl = await readDataUrl(a.file);
        seq.current += 1;
        list = [...itemsRef.current, { id: `a${seq.current}`, name: a.file.name || 'dosya', size: a.file.size, kind: a.kind, mime: a.mime, dataUrl }];
        commit(list);
      } catch {
        setError(`"${a.file.name}" okunamadı.`);
      } finally {
        setReading((n) => n - 1);
      }
    }
  }, []);

  const remove = useCallback((id: string) => {
    commit(itemsRef.current.filter((a) => a.id !== id));
    setError('');
  }, []);

  const clear = useCallback(() => {
    commit([]);
    setError('');
  }, []);

  return { items, error, reading, add, remove, clear };
}
