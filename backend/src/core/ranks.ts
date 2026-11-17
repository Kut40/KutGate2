export const RANKS = [
  'Takım Lideri',
  'Vibe Code Uzmanı',
  'Backend Uzmanı',
  'Frontend Uzmanı',
  'Araştırmacı',
  'Analist',
  'Veri Uzmanı',
] as const;

export function parseRanks(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? RANKS.filter((r) => v.includes(r)) : [];
  } catch {
    return [];
  }
}
