import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

export function useDismiss(open: boolean, close: () => void, rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close, rootRef]);
}

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean; hint?: string };

export function SelectMenu({
  ariaLabel,
  buttonLabel,
  options,
  value,
  onChange,
  disabled,
  className,
  menuClassName,
}: {
  ariaLabel: string;
  buttonLabel: ReactNode;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const openMenu = () => {
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  };

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btnRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onBtnKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = options.length;
    const step = (from: number, dir: 1 | -1) => {
      for (let k = 1; k <= n; k++) {
        const j = (from + dir * k + n * k) % n;
        if (!options[j]?.disabled) return j;
      }
      return from;
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => step(a, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => step(a, -1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(options[0]?.disabled ? step(0, 1) : 0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options[n - 1]?.disabled ? step(n - 1, -1) : n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onBtnKey}
        className="inline-flex h-11 max-w-full min-w-0 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:h-8"
      >
        <span className="min-w-0 truncate">{buttonLabel}</span>
        <ChevronDown className="size-3.5 flex-none" strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${uid}-${active}`}
          onKeyDown={onListKey}
          className={cn(
            'absolute bottom-full left-0 z-30 mb-2 max-h-64 w-max max-w-[calc(100vw-32px)] min-w-44 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none',
            menuClassName,
          )}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${uid}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled ? 'true' : undefined}
              title={o.disabled ? o.hint : undefined}
              onPointerEnter={() => { if (!o.disabled) setActive(i); }}
              onClick={() => choose(i)}
              className={cn(
                'flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-1.5 sm:min-h-9',
                o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                i === active && !o.disabled && 'bg-muted',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] leading-5 font-medium">{o.label}</span>
                {o.description ? <span className="text-[12px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">{o.description}</span> : null}
                {o.disabled && o.hint ? <span className="text-[11px] leading-4 text-muted-foreground/80">{o.hint}</span> : null}
              </span>
              {o.disabled ? (
                <Lock className="size-3.5 flex-none" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Check className={cn('size-4 flex-none', o.value === value ? 'opacity-100' : 'opacity-0')} strokeWidth={1.75} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
