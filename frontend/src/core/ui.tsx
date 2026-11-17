import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

const ICON_PATHS: Record<string, string> = {
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  gate: 'M4 21V8l8-5 8 5v13 M9 21v-7h6v7',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
  spark: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2-3 2 M12 15h5',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M18 6L6 18',
  portal: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 12h18 M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3',
  sessions: 'M5 4l14 8-14 8z',
  note: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M8 8h8 M8 12h8 M8 16h5',
  board: 'M3 4h18v12H8l-5 4z M8 9h8 M8 12h5',
  megaphone: 'M3 10v4h4l8 5V5l-8 5z M18 9a4 4 0 0 1 0 6',
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name] ?? ''} />
    </svg>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  busy?: boolean;
}

export function Button({ variant = 'secondary', small, busy, className, children, disabled, type, ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, small ? 'btn-sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type ?? 'button'} className={cls} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {title || actions ? (
        <header className="card-head">
          <h2 className="card-title">{title}</h2>
          <div className="card-actions">{actions}</div>
        </header>
      ) : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const t = tableRef.current;
    if (!t) return;
    t.querySelectorAll('tbody > tr').forEach((tr) => {
      Array.from(tr.children).forEach((cell, i) => {
        if (!(cell instanceof HTMLTableCellElement) || cell.tagName !== 'TD') return;
        const label = head[i];
        if (label && cell.colSpan <= 1) cell.setAttribute('data-label', label);
        else cell.removeAttribute('data-label');
      });
    });
  });
  return (
    <div className="table-wrap">
      <table className="table" ref={tableRef}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p className="form-error">{message}</p>
      {onRetry ? <Button onClick={onRetry}>Yeniden dene</Button> : null}
    </div>
  );
}

export function Spinner({ label = 'Yükleniyor' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}…
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const TR_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

/** ISO / "YYYY-MM-DD HH:MM" zamanını kısa yerel biçime çevirir (ör. "9 Kas 11:53"); çözülemezse değeri aynen döndürür. */
export function fmtDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  let d: Date;
  if (typeof value === 'number') {
    d = new Date(value > 1e12 ? value : value * 1000);
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
    if (!m) return value;
    if (m[6]) d = new Date(value.trim().replace(' ', 'T'));
    else d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${TR_MONTHS[d.getMonth()] ?? ''}${year} ${hh}:${mm}`;
}

/** Kısa zaman metni; tam değer title içinde. */
export function Time({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return <>-</>;
  const full = typeof value === 'number' ? new Date(value > 1e12 ? value : value * 1000).toLocaleString('tr-TR') : value;
  return (
    <span className="nowrap" title={full}>
      {fmtDateTime(value)}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {hint ? (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

let scrollLocks = 0;
let scrollPrev = '';
export function lockScroll() {
  if (scrollLocks === 0) {
    scrollPrev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}
export function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = scrollPrev;
}

const modalStack: object[] = [];

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    const entry = {};
    modalStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== entry) return;
      if (ref.current?.closest('[inert]')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0] as HTMLElement;
      const lastEl = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    lockScroll();
    return () => {
      const at = modalStack.indexOf(entry);
      if (at >= 0) modalStack.splice(at, 1);
      unlockScroll();
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Onayla',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} data-autofocus>
            Vazgeç
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

interface ToastItem {
  id: number;
  kind: 'ok' | 'error' | 'warn';
  text: string;
}
interface ToastApi {
  success: (text: string) => void;
  error: (text: string) => void;
  warn: (text: string) => void;
}
const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: 'ok' | 'error' | 'warn', text: string) => {
    const id = ++seq.current;
    setItems((l) => [...l, { id, kind, text }]);
    window.setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'ok' ? 4000 : 8000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (t) => push('ok', t), error: (t) => push('error', t), warn: (t) => push('warn', t) }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <strong>{t.kind === 'ok' ? 'Tamam: ' : t.kind === 'warn' ? 'Uyarı: ' : 'Hata: '}</strong>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('ToastProvider eksik');
  return v;
}

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Satır işlemleri için küçük "⋯" menüsü (menu düğmesi deseni: klavye, Escape, dışarı tıklama, odak dönüşü). */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusFirst = useRef<'first' | 'last' | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) btnRef.current?.focus();
  }, []);

  const openMenu = (where: 'first' | 'last' | null) => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    focusFirst.current = where;
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    const r = btnRef.current?.getBoundingClientRect();
    const h = menu.offsetHeight;
    if (r && r.bottom + 4 + h > window.innerHeight - 8) {
      const top = Math.max(8, r.top - h - 4);
      menu.style.top = `${top}px`;
      setPos((p) => (p ? { ...p, top } : p));
    }
    const nodes = menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const target = focusFirst.current === 'last' ? nodes[nodes.length - 1] : focusFirst.current === 'first' ? nodes[0] : null;
    (target ?? menuRef.current).focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false);
    };
    const onAway = () => close(false);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('scroll', onAway, true);
    };
  }, [open, close]);

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      nodes[(n + nodes.length) % nodes.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? nodes.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(nodes.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') close(true);
  };

  const select = (it: RowMenuItem) => {
    close(true);
    it.onSelect();
  };

  const host = btnRef.current?.closest('.admin-app') ?? document.body;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn row-menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu(null))}
        onKeyDown={onButtonKey}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              className="row-menu"
              style={{ top: pos.top, right: pos.right }}
              onKeyDown={onMenuKey}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`row-menu-item${it.danger ? ' row-menu-danger' : ''}`}
                  onClick={() => select(it)}
                >
                  {it.label}
                </button>
              ))}
            </div>,
            host,
          )
        : null}
    </>
  );
}

export interface ChromeApi {
  slot: HTMLElement | null;
  setTitle: (t: string | null) => void;
}
export const ChromeCtx = createContext<ChromeApi | null>(null);

/** Yönetici kabuğunda başlık ve eylemler üst şeride taşınır; kabuk yoksa eski yerleşimle çizilir. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const chrome = useContext(ChromeCtx);
  const setTitle = chrome?.setTitle;
  useEffect(() => {
    if (!setTitle) return;
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
  if (chrome) return chrome.slot && children ? createPortal(children, chrome.slot) : null;
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="page-head-actions">{children}</div>
    </div>
  );
}
