import { MAX_DESCRIPTION } from './validate.js';

/** Metnin ilk cümlesi; cümle sonu yoksa ilk boş olmayan satır. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  let s = m ? m[1] : (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  if (s.length > MAX_DESCRIPTION) s = s.slice(0, MAX_DESCRIPTION - 3) + '...';
  return s;
}

/** `source` metninden frontmatter (name, description = ilk cümle) + gövde üretir. */
export function templateSkill(name: string, source: string): string {
  const description = firstSentence(source);
  const body = source.trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}
