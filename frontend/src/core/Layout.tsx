import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useLock } from './lock/context';
import type { Feature } from './registry';
import { useSession } from './session';
import { Button, ChromeCtx, Icon, lockScroll, unlockScroll, type ChromeApi } from './ui';

const DRAWER_MQ = '(max-width: 900px)';
const NAV_FOCUSABLE = 'a[href],button:not([disabled])';

const NAV_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Kullanıcılar', ids: ['users', 'portal', 'gates'] },
  { title: 'Çalışma', ids: ['folders', 'rules', 'skills', 'terminal'] },
  { title: 'İzleme', ids: ['sessions', 'devlog', 'board', 'admin-notes', 'audit'] },
  { title: 'Sistem', ids: ['settings'] },
];

function groupFeatures(features: Feature[]): { title: string; items: Feature[] }[] {
  const used = new Set<string>();
  const out = NAV_GROUPS.map((g) => ({
    title: g.title,
    items: g.ids.flatMap((id) => {
      const f = features.find((x) => x.id === id);
      if (!f) return [];
      used.add(id);
      return [f];
    }),
  }));
  const rest = features.filter((f) => !used.has(f.id));
  if (rest.length > 0) out.push({ title: 'Diğer', items: rest });
  return out.filter((g) => g.items.length > 0);
}

export function Layout({ features, current, children }: { features: Feature[]; current: string; children: ReactNode }) {
  const { status, meta, logout } = useSession();
  const lockApi = useLock();
  const [open, setOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const active = features.find((f) => f.id === current);
  const groups = useMemo(() => groupFeatures(features), [features]);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const chrome = useMemo<ChromeApi>(() => ({ slot, setTitle: setPageTitle }), [slot]);
  const heading = pageTitle ?? active?.title ?? 'Gate';

  useEffect(() => {
    document.title = heading === 'Gate' ? 'Gate' : `${heading} · Gate`;
    return () => {
      document.title = 'Gate';
    };
  }, [heading]);

  useEffect(() => {
    if (!open) return;
    const aside = asideRef.current;
    if (!aside) return;
    const items = () => Array.from(aside.querySelectorAll<HTMLElement>(NAV_FOCUSABLE));
    (aside.querySelector<HTMLElement>('[aria-current="page"]') ?? items()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      const act = document.activeElement;
      if (!(act instanceof Node) || !aside.contains(act)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && act === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && act === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !aside.contains(e.target)) items()[0]?.focus();
    };
    const mq = window.matchMedia(DRAWER_MQ);
    const onMq = () => {
      if (!mq.matches) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    mq.addEventListener('change', onMq);
    lockScroll();
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      mq.removeEventListener('change', onMq);
      menuRef.current?.focus();
    };
  }, [open]);

  return (
    <div className="app">
      <a className="skip" href="#main">
        İçeriğe geç
      </a>
      <aside
        ref={asideRef}
        className={`sidebar ${open ? 'open' : ''}`}
        aria-label="Ana menü"
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
      >
        <div className="sidebar-head">
          <div className="brand">Gate</div>
          <button type="button" className="icon-btn sidebar-close" aria-label="Menüyü kapat" onClick={() => setOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="Sayfalar">
          {groups.map((g, gi) => (
            <div key={g.title} className="nav-group" role="group" aria-labelledby={`nav-g-${gi}`}>
              <div className="nav-group-title" id={`nav-g-${gi}`}>
                {g.title}
              </div>
              <ul>
                {g.items.map((f) => (
                  <li key={f.id}>
                    <a
                      href={`#/${f.id}`}
                      className={f.id === current ? 'nav-link active' : 'nav-link'}
                      aria-current={f.id === current ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                    >
                      <span className="nav-icon" aria-hidden="true">
                        <Icon name={f.icon} />
                      </span>
                      {f.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      {open ? <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            ref={menuRef}
            className="icon-btn menu-btn"
            aria-label="Menüyü aç/kapat"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="menu" />
          </button>
          <h1 className="topbar-title">{heading}</h1>
          <div className="topbar-actions" ref={setSlot} />
          <span className="who">{status?.username}</span>
          <button type="button" className="icon-btn kg-lock-topbtn" aria-label="Ekranı kilitle" title="Ekranı kilitle" onClick={lockApi.lockNow}>
            <Lock size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <Button small onClick={() => void logout()}>
            Çıkış
          </Button>
        </header>
        {meta?.dryRun ? (
          <div className="dry-banner" role="status">
            <strong>DRY-RUN modu:</strong> sistem script'leri çalıştırılmaz, dosyalar yalnızca sandbox'a yazılır.
          </div>
        ) : null}
        <main id="main" className="content" tabIndex={-1}>
          <ChromeCtx.Provider value={chrome}>{children}</ChromeCtx.Provider>
        </main>
      </div>
    </div>
  );
}
