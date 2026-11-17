import type { SyntheticEvent } from 'react';

export const DEFAULT_MAX_MINUTES = 240;
export const KB_THRESHOLD = 120;

export function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const COPY_ALLOWED = 'textarea, input, .kg-copyable, .modal .form-error';

export function blockCopy(e: SyntheticEvent): void {
  const t = e.target;
  if (t instanceof Element && t.closest(COPY_ALLOWED) !== null) return;
  e.preventDefault();
}
