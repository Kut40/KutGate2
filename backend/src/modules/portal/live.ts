/** `/internal/live` yanıtını oturum kimliği -> bağlı mı eşlemesine çevirir; biçim geçersizse null. */
export function parseLiveList(v: unknown): Map<string, boolean> | null {
  if (!Array.isArray(v)) return null;
  const out = new Map<string, boolean>();
  for (const item of v) {
    if (typeof item === 'string') {
      out.set(item, true);
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id === 'string') out.set(o.id, typeof o.attached === 'boolean' ? o.attached : true);
  }
  return out;
}
