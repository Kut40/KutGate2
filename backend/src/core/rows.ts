export type ColumnType = 'number' | 'string' | 'number?' | 'string?';

type ColumnFor<V> = null extends V
  ? NonNullable<V> extends number
    ? 'number?'
    : NonNullable<V> extends string
      ? 'string?'
      : never
  : V extends number
    ? 'number'
    : V extends string
      ? 'string'
      : never;

export type RowSpec<T> = { readonly [K in keyof T]-?: ColumnFor<T[K]> };

function fits(value: unknown, type: ColumnType): boolean {
  if (value === null) return type === 'number?' || type === 'string?';
  return typeof value === (type === 'number' || type === 'number?' ? 'number' : 'string');
}

export function readRow<T>(spec: RowSpec<T>, row: unknown): T {
  if (row === null || typeof row !== 'object') throw new Error('veritabanı satırı okunamadı');
  const record = row as Record<string, unknown>;
  const columns = spec as Record<string, ColumnType>;
  for (const key of Object.keys(columns)) {
    if (!fits(record[key], columns[key])) throw new Error(`veritabanı sütunu beklenen türde değil: ${key}`);
  }
  return row as T;
}

export function readOptionalRow<T>(spec: RowSpec<T>, row: unknown): T | undefined {
  return row === undefined ? undefined : readRow(spec, row);
}

export function readRows<T>(spec: RowSpec<T>, rows: unknown[]): T[] {
  return rows.map((row) => readRow(spec, row));
}
