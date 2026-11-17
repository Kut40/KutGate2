export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_CONTENT_BYTES = 200 * 1024;
export const MAX_DESCRIPTION = 1024;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* düz kırp */
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Basit YAML frontmatter ayrıştırıcısı (anahtar: değer, girintili devam satırları, `>`/`|` blokları). */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  let current: string | null = null;
  const parts = new Map<string, { literal: boolean; lines: string[] }>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (m) {
      current = m[1];
      const raw = (m[2] ?? '').trim();
      if (/^[>|][+-]?$/.test(raw)) {
        parts.set(current, { literal: raw[0] === '|', lines: [] });
      } else {
        parts.set(current, { literal: false, lines: raw === '' ? [] : [raw] });
      }
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) {
      parts.get(current)?.lines.push(line.trim());
    }
  }
  for (const [k, p] of parts) {
    fields[k] = unquote(p.lines.join(p.literal ? '\n' : ' ').trim());
  }
  return fields;
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateSkill(name: string, content: string): ValidationResult {
  const errors: string[] = [];
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    errors.push('skill adı geçersiz (^[a-z][a-z0-9-]{1,63}$)');
  }
  if (typeof content !== 'string') {
    return { ok: false, errors: [...errors, 'içerik metin olmalı'] };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    errors.push('içerik 200 KB sınırını aşıyor');
  }
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('frontmatter bulunamadı (--- ile başlayıp --- ile kapanmalı)');
    return { ok: false, errors };
  }
  const fmName = fm.name ?? '';
  if (fmName !== name) {
    errors.push(`frontmatter name alanı klasör adıyla aynı olmalı (${name})`);
  }
  const desc = (fm.description ?? '').trim();
  if (desc === '') {
    errors.push('description boş olamaz');
  } else if (desc.toUpperCase() === 'TODO') {
    errors.push('description TODO olamaz');
  } else if (desc.length > MAX_DESCRIPTION) {
    errors.push(`description en fazla ${MAX_DESCRIPTION} karakter olabilir`);
  }
  return { ok: errors.length === 0, errors };
}
