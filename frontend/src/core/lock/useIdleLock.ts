import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../errors';
import type { LockPhase, LockReason, UnlockResult } from './types';

/** Hareket olayları; en çok 1 sn'de bir işlenir. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
const THROTTLE_MS = 1000;
const PING_MS = 30000;
const TICK_MS = 1000;
/** Bu öznitelikli öğenin içindeki hareket sayacı sıfırlamaz (geri sayım kartı). */
export const IGNORE_ATTR = 'data-kg-lock-ignore';

export interface IdleLockOptions {
  /** Uç adresi öneki: `/papi` ya da `/api/auth`. */
  base: string;
  /** Oturum açık ve kilit bilgisi var: sayaç çalışır. */
  enabled: boolean;
  minutes: number;
  warningSeconds: number;
  /** Sunucu durumu kilitli diyor (stage:'locked' ya da locked:true). */
  serverLocked: boolean;
  /** Kilit durumu değişti: durum yeniden okunmalı. */
  onStateChange?: () => void;
}

export interface IdleLock {
  phase: LockPhase;
  /** Uyarı aşamasında kalan saniye. */
  secondsLeft: number;
  lockNow: (reason?: LockReason) => void;
  continue: () => void;
  unlock: (pin: string) => Promise<UnlockResult>;
  /** Sunucu (423 / 4001) kilitli dedi. */
  markLocked: () => void;
}

function scopeOf(base: string): string {
  return base.replace(/[^a-z]/gi, '').toLowerCase() || 'gate';
}
const keyLast = (scope: string) => `kg_lock_${scope}_last`;
const keyState = (scope: string) => `kg_lock_${scope}_state`;

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}
function removeStore(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

/** Çıkışta ortak sayaç durumunu temizler (başka oturumun kilidi bu yüzden açık kalmasın). */
export function clearSharedLockState(base: string): void {
  const s = scopeOf(base);
  removeStore(keyLast(s));
  removeStore(keyState(s));
}

async function lockPost(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-gate-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let data: Record<string, unknown> | null = null;
  const text = await res.text();
  if (text) {
    try {
      const v: unknown = JSON.parse(text);
      data = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

export function useIdleLock(opts: IdleLockOptions): IdleLock {
  const { base, enabled, serverLocked } = opts;
  const scope = scopeOf(base);
  const kLast = keyLast(scope);
  const kState = keyState(scope);

  const [locked, setLocked] = useState(serverLocked);
  const [warnLeft, setWarnLeft] = useState<number | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lockedRef = useRef(locked);
  const lastRef = useRef(Date.now());
  const lastPingRef = useRef(0);
  const lastHandledRef = useRef(0);

  const applyLocked = useCallback(
    (broadcast: boolean) => {
      lockedRef.current = true;
      setLocked(true);
      setWarnLeft(null);
      if (broadcast) writeStore(kState, `locked:${Date.now()}`);
    },
    [kState],
  );

  const applyUnlocked = useCallback(
    (broadcast: boolean) => {
      const now = Date.now();
      lockedRef.current = false;
      lastRef.current = now;
      lastHandledRef.current = now;
      lastPingRef.current = now;
      setLocked(false);
      setWarnLeft(null);
      writeStore(kLast, String(now));
      if (broadcast) writeStore(kState, `open:${now}`);
    },
    [kLast, kState],
  );

  const notify = useCallback(() => {
    optsRef.current.onStateChange?.();
  }, []);

  const ping = useCallback(() => {
    lastPingRef.current = Date.now();
    lockPost(`${optsRef.current.base}/lock/activity`, {})
      .then((r) => {
        if (r.status === 423 || (r.data && r.data.locked === true)) {
          if (!lockedRef.current) {
            applyLocked(true);
            notify();
          }
        }
      })
      .catch(() => undefined);
  }, [applyLocked, notify]);

  const lockNow = useCallback(
    (reason: LockReason = 'elle') => {
      if (lockedRef.current) return;
      applyLocked(true);
      lockPost(`${optsRef.current.base}/lock/now`, { reason })
        .catch(() => undefined)
        .finally(notify);
    },
    [applyLocked, notify],
  );

  const markLocked = useCallback(() => {
    if (lockedRef.current) return;
    applyLocked(true);
  }, [applyLocked]);

  const touch = useCallback(
    (now: number, forcePing: boolean) => {
      lastRef.current = now;
      writeStore(kLast, String(now));
      setWarnLeft((p) => (p === null ? p : null));
      if (forcePing || now - lastPingRef.current >= PING_MS) ping();
    },
    [kLast, ping],
  );

  const continueSession = useCallback(() => {
    if (lockedRef.current) return;
    touch(Date.now(), true);
  }, [touch]);

  const unlock = useCallback(
    async (pin: string): Promise<UnlockResult> => {
      let r: { status: number; data: Record<string, unknown> | null };
      try {
        r = await lockPost(`${optsRef.current.base}/lock/unlock`, { pin });
      } catch {
        return { ok: false, kind: 'error', message: 'Sunucuya ulaşılamadı. Yeniden deneyin.' };
      }
      if (r.status >= 200 && r.status < 300) {
        applyUnlocked(true);
        notify();
        return { ok: true };
      }
      const code = r.data && typeof r.data.error === 'string' ? r.data.error : '';
      if (r.status === 403 && code === 'pin_invalid') {
        const rem = Number(r.data?.remaining);
        return { ok: false, kind: 'invalid', remaining: Number.isFinite(rem) && rem > 0 ? Math.floor(rem) : 0 };
      }
      if (r.status === 423 && code === 'pin_locked') {
        const sec = Number(r.data?.seconds);
        return { ok: false, kind: 'locked', seconds: Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 600 };
      }
      if (r.status === 401) {
        notify();
        return { ok: false, kind: 'error', message: errorText('unauthorized') };
      }
      return { ok: false, kind: 'error', message: code ? errorText(code) : 'İşlem tamamlanamadı. Yeniden deneyin.' };
    },
    [applyUnlocked, notify],
  );

  // Sunucu kilitli dedi: kilit ekranına geç.
  useEffect(() => {
    if (serverLocked && !lockedRef.current) applyLocked(true);
  }, [serverLocked, applyLocked]);

  // Sayaç: zaman damgasıyla ölçülür, uykudan dönüşte fark geçmişse hemen kilitler.
  useEffect(() => {
    if (!enabled) return;
    const limitMs = () => optsRef.current.minutes * 60000;

    const stored = Number(readStore(kLast));
    const now0 = Date.now();
    if (!lockedRef.current) {
      lastRef.current = Number.isFinite(stored) && stored > 0 && now0 - stored < limitMs() ? stored : now0;
    }

    const sharedLast = () => {
      const s = Number(readStore(kLast));
      return Number.isFinite(s) && s > lastRef.current ? s : lastRef.current;
    };

    const expire = () => {
      applyLocked(true);
      lockPost(`${optsRef.current.base}/lock/now`, { reason: 'bosta' })
        .catch(() => undefined)
        .finally(notify);
    };

    const check = () => {
      if (lockedRef.current) return;
      const idle = Date.now() - sharedLast();
      const lim = limitMs();
      const warn = optsRef.current.warningSeconds * 1000;
      if (idle >= lim) {
        expire();
      } else if (idle >= lim - warn) {
        setWarnLeft(Math.max(1, Math.ceil((lim - idle) / 1000)));
      } else {
        setWarnLeft((p) => (p === null ? p : null));
      }
    };

    const onActivity = (e: Event) => {
      if (lockedRef.current) return;
      const t = e.target;
      if (t instanceof Element && t.closest(`[${IGNORE_ATTR}]`)) return;
      const now = Date.now();
      if (now - lastHandledRef.current < THROTTLE_MS) return;
      lastHandledRef.current = now;
      // Süre zaten dolmuşsa (uyku, gizli sekme) hareket onu kurtarmaz.
      if (now - sharedLast() >= limitMs()) {
        expire();
        return;
      }
      touch(now, false);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== kState || e.newValue === null) return;
      if (e.newValue.startsWith('locked') && !lockedRef.current) {
        applyLocked(false);
      } else if (e.newValue.startsWith('open') && lockedRef.current) {
        applyUnlocked(false);
        notify();
      }
    };

    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('storage', onStorage);
    const timer = window.setInterval(check, TICK_MS);
    check();

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(timer);
    };
  }, [enabled, kLast, kState, applyLocked, applyUnlocked, notify, touch]);

  const phase: LockPhase = locked ? 'locked' : warnLeft !== null ? 'warning' : 'unlocked';
  return { phase, secondsLeft: warnLeft ?? 0, lockNow, continue: continueSession, unlock, markLocked };
}
