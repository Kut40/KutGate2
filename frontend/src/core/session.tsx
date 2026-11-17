import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, get, post } from './api';
import { EVT_LOCKED, EVT_RECHECK, type LockInfo } from './lock/types';

export interface AuthStatus {
  needsSetup: boolean;
  loggedIn: boolean;
  username?: string;
  totpEnabled?: boolean;
  viaProxy?: boolean;
  /** Ekran kilitli (sunucu oturumu kilitledi). */
  locked?: boolean;
  /** PIN henüz belirlenmedi: panel yerine PIN belirleme ekranı. */
  pinRequired?: boolean;
  lock?: LockInfo;
}

export interface Meta {
  dryRun: boolean;
  rulesRoot: string;
  homeRoot: string;
  projectsRoot: string;
  modules: string[];
}

interface SessionValue {
  loading: boolean;
  status: AuthStatus | null;
  meta: Meta | null;
  unreachable: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string, totp?: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    inFlight.current = true;
    try {
      const s = await get<AuthStatus>('/api/auth/status');
      if (s.viaProxy === true && !s.loggedIn) {
        window.location.assign('/');
        return;
      }
      setStatus(s);
      setUnreachable(false);
      if (!s.loggedIn) {
        setMeta(null);
      } else if (!s.locked && !s.pinRequired) {
        try {
          setMeta(await get<Meta>('/api/meta'));
        } catch (err) {
          // 423 / 428: oturum düşmüş sayılmaz; kilit ya da PIN kurulumu durumuna geçilir.
          if (err instanceof ApiError && err.status === 423) setStatus({ ...s, locked: true });
          else if (err instanceof ApiError && err.status === 428) setStatus({ ...s, pinRequired: true });
          else throw err;
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setStatus({ needsSetup: false, loggedIn: false });
        setMeta(null);
        setUnreachable(false);
      } else {
        setUnreachable(true);
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Okuma sürerken gelen olay (meta çağrısının 423'ü gibi) ikinci okuma başlatmaz.
    const onUnauth = () => {
      if (!inFlight.current) void refresh();
    };
    window.addEventListener('gate:unauthorized', onUnauth);
    window.addEventListener(EVT_LOCKED, onUnauth);
    window.addEventListener(EVT_RECHECK, onUnauth);
    return () => {
      window.removeEventListener('gate:unauthorized', onUnauth);
      window.removeEventListener(EVT_LOCKED, onUnauth);
      window.removeEventListener(EVT_RECHECK, onUnauth);
    };
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string, totp?: string) => {
      const body: { username: string; password: string; totp?: string } = { username, password };
      if (totp) body.totp = totp;
      await post('/api/auth/login', body);
      await refresh();
    },
    [refresh],
  );

  const setup = useCallback(
    async (username: string, password: string) => {
      await post('/api/auth/setup', { username, password });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      if (status?.viaProxy === true) {
        window.location.assign('/');
      } else {
        await refresh();
      }
    }
  }, [refresh, status]);

  const value = useMemo(
    () => ({ loading, status, meta, unreachable, refresh, login, setup, logout }),
    [loading, status, meta, unreachable, refresh, login, setup, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider eksik');
  return v;
}
