import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { LockCtx, type LockApi } from './context';
import { IdleWarning } from './IdleWarning';
import { LockScreen } from './LockScreen';
import { EVT_LOCKED, type LockInfo } from './types';
import { clearSharedLockState, useIdleLock } from './useIdleLock';
import './lock.css';

const DEFAULT_MINUTES = 5;
const DEFAULT_WARNING = 30;

/**
 * Uygulama ağacını sarar. Kilitliyken ağaç unmount edilmez; `display:none` + `inert` ile gizlenir
 * (taslak, açık form ve terminal içeriği korunur) ve opak kilit ekranı gösterilir.
 * Sayfa kilitli açılırsa ağaç hiç mount edilmez; ilk açılıştan sonra mount edilir.
 */
export function LockGate({
  base,
  username,
  lock,
  serverLocked,
  enabled = true,
  onStateChange,
  onLogout,
  children,
}: {
  /** Uç adresi öneki: `/papi` ya da `/api/auth`. */
  base: string;
  username: string;
  lock: LockInfo | undefined;
  serverLocked: boolean;
  enabled?: boolean;
  /** Kilit durumu değişti (kilitlendi, açıldı, sunucu 423 verdi): durum yeniden okunur. */
  onStateChange: () => void;
  /** Çıkış yapar ve giriş ekranına döner (ağ hatasında da). */
  onLogout: () => Promise<void> | void;
  children: ReactNode;
}) {
  const il = useIdleLock({
    base,
    enabled: enabled && lock !== undefined,
    minutes: lock?.minutes ?? DEFAULT_MINUTES,
    warningSeconds: lock?.warningSeconds ?? DEFAULT_WARNING,
    serverLocked,
    onStateChange,
  });
  const locked = il.phase === 'locked';
  const treeRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const everOpenRef = useRef(!locked);
  if (!locked) everOpenRef.current = true;

  const { lockNow, markLocked, unlock } = il;

  // 423 ya da soket 4001: anında kilit ekranı.
  useEffect(() => {
    const on = () => {
      markLocked();
      onStateChange();
    };
    window.addEventListener(EVT_LOCKED, on);
    return () => window.removeEventListener(EVT_LOCKED, on);
  }, [markLocked, onStateChange]);

  // Kilit açılınca odak eski yerine döner, terminal yeniden ölçülür.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (!locked && t instanceof HTMLElement && treeRef.current?.contains(t)) lastFocusRef.current = t;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [locked]);

  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) {
      const el = lastFocusRef.current;
      const id = window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        if (el && el.isConnected) el.focus({ preventScroll: true });
      });
      wasLocked.current = locked;
      return () => window.cancelAnimationFrame(id);
    }
    wasLocked.current = locked;
    return undefined;
  }, [locked]);

  const handleLogout = useCallback(async () => {
    clearSharedLockState(base);
    await onLogout();
  }, [base, onLogout]);

  const api = useMemo<LockApi>(() => ({ locked, lockNow: () => lockNow('elle'), reportLocked: markLocked }), [locked, lockNow, markLocked]);

  return (
    <LockCtx.Provider value={api}>
      <div className="kg-lock-tree" ref={treeRef} style={{ display: locked ? 'none' : 'contents' }} inert={locked} aria-hidden={locked ? true : undefined}>
        {everOpenRef.current ? children : null}
      </div>
      {il.phase === 'warning' ? <IdleWarning seconds={il.secondsLeft} onContinue={il.continue} onLockNow={() => lockNow('elle')} /> : null}
      {locked ? <LockScreen username={username} onUnlock={unlock} onLogout={handleLogout} /> : null}
    </LockCtx.Provider>
  );
}
