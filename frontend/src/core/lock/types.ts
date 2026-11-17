/** Sunucunun durum yanıtındaki `lock` alanı. */
export interface LockInfo {
  minutes: number;
  maxMinutes: number;
  options: number[];
  warningSeconds: number;
}

/** Kilit açma denemesinin sonucu. */
export type UnlockResult =
  | { ok: true }
  | { ok: false; kind: 'invalid'; remaining: number }
  | { ok: false; kind: 'locked'; seconds: number }
  | { ok: false; kind: 'error'; message: string };

export type LockReason = 'bosta' | 'elle';
export type LockPhase = 'unlocked' | 'warning' | 'locked';

/** Sunucudan 423 ya da soketten 4001 gelince panel kilit ekranına geçer. */
export const EVT_LOCKED = 'gate:locked';
/** 403 setup_incomplete / 428 gelince durum yeniden okunur. */
export const EVT_RECHECK = 'gate:recheck';

/** 60 dk için "1 saat", diğerleri "N dk". */
export function minuteLabel(m: number): string {
  return m === 60 ? '1 saat' : `${m} dk`;
}

/** PIN hane sayısı; sunucudaki PIN_RE ile aynı olmalı. */
export const PIN_LENGTH = 4;

export function isStrongPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH || !/^\d+$/.test(pin)) return false;
  const d = pin.split('').map(Number);
  if (d.every((x) => x === d[0])) return false;
  const diffs = d.slice(1).map((x, i) => x - (d[i] as number));
  if (diffs.every((x) => x === 1) || diffs.every((x) => x === -1)) return false;
  return true;
}
