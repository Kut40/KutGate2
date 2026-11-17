import { createContext, useContext } from 'react';

export interface LockApi {
  /** Ekran şu an kilitli mi. */
  locked: boolean;
  /** Elle kilitle ("Ekranı kilitle"). */
  lockNow: () => void;
  /** Sunucudan 423 ya da soketten 4001 geldi: kilit ekranına geç. */
  reportLocked: () => void;
}

const NOOP: LockApi = { locked: false, lockNow: () => undefined, reportLocked: () => undefined };

export const LockCtx = createContext<LockApi>(NOOP);

export function useLock(): LockApi {
  return useContext(LockCtx);
}
