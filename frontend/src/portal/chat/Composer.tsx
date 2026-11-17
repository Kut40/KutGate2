import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, LoaderCircle, Paperclip, Plus, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MAX_SEND_CHARS, type AgentState, type ModelInfo } from './protocol';
import { ACCEPT_FILES, ACCEPT_IMAGES, fmtSize, type AttachItem } from './attachments';
import { SelectMenu, useDismiss, type SelectOption } from './SelectMenu';

const MODE_OPTIONS: SelectOption[] = [
  { value: 'auto', label: 'Otomatik', description: 'Ajan kendisi karar verir, yalnız riskli işlemlerde sorar' },
  { value: 'acceptEdits', label: 'Düzenlemeleri kabul et', description: 'Dosya değişikliklerini sormadan yapar, komutlarda sorar' },
  { value: 'plan', label: 'Plan', description: 'Önce plan çıkarır, değişiklik yapmaz' },
  { value: 'default', label: 'Her adımda sor', description: 'Her değişiklik ve komut için onay ister' },
];

const EFFORT_LABELS: Record<string, string> = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
  xhigh: 'Çok yüksek',
  max: 'En yüksek',
};

function modelLabel(m: ModelInfo): string {
  return m.value === 'default' ? 'Varsayılan' : m.label;
}

export function Composer({
  value,
  setValue,
  taRef,
  boxRef,
  insertRef,
  agent,
  canType,
  open,
  models,
  attachments,
  attachError,
  reading,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
  onStop,
  onSetModel,
  onSetEffort,
  onSetMode,
}: {
  value: string;
  setValue: (v: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  boxRef?: RefObject<HTMLDivElement | null>;
  insertRef?: { current: ((text: string) => void) | null };
  agent: AgentState;
  canType: boolean;
  open: boolean;
  models: ModelInfo[] | null;
  attachments: AttachItem[];
  attachError: string;
  reading: number;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onSetModel: (m: string) => void;
  onSetEffort: (e: string) => void;
  onSetMode: (m: string) => void;
}) {
  const busy = agent.busy;
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const closePlus = useCallback(() => setPlusOpen(false), []);
  useDismiss(plusOpen, closePlus, plusRef);

  useEffect(() => {
    if (plusOpen) plusRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [plusOpen]);

  const selectedModel = agent.model ?? 'default';
  const modelOptions: SelectOption[] = useMemo(
    () => (models ?? []).map((m) => ({ value: m.value, label: modelLabel(m), description: m.description })),
    [models],
  );
  const current = models?.find((m) => m.value === selectedModel);
  const modelBtn = current ? modelLabel(current) : selectedModel === 'default' ? 'Varsayılan' : selectedModel;

  const efforts = current?.efforts ?? [];
  const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
  const capIdx = EFFORT_ORDER.indexOf(agent.maxEffort);
  const effortOptions: SelectOption[] = efforts.map((e) => {
    const locked = capIdx >= 0 && EFFORT_ORDER.indexOf(e) > capIdx;
    return { value: e, label: EFFORT_LABELS[e] ?? e, ...(locked ? { disabled: true, hint: 'Yönetici izni gerekir' } : {}) };
  });
  const effortSel = agent.effort && efforts.includes(agent.effort) ? agent.effort : null;

  const valueRef = useRef(value);
  valueRef.current = value;
  const caretRef = useRef<number | null>(null);

  const insertText = useCallback(
    (text: string) => {
      const ta = taRef.current;
      const v = valueRef.current;
      const s = Math.min(ta?.selectionStart ?? v.length, v.length);
      const e = Math.min(Math.max(ta?.selectionEnd ?? s, s), v.length);
      const before = v.slice(0, s);
      const after = v.slice(e);
      const ins = `${before !== '' && !/\s$/.test(before) ? ' ' : ''}${text}${/^\s/.test(after) ? '' : ' '}`;
      if (v.length - (e - s) + ins.length > MAX_SEND_CHARS) return;
      const next = before + ins + after;
      valueRef.current = next;
      caretRef.current = before.length + ins.length;
      setValue(next);
      ta?.focus();
    },
    [setValue, taRef],
  );

  useEffect(() => {
    if (!insertRef) return;
    insertRef.current = insertText;
    return () => {
      insertRef.current = null;
    };
  }, [insertRef, insertText]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || caretRef.current === null) return;
    const c = caretRef.current;
    caretRef.current = null;
    ta.focus();
    ta.setSelectionRange(c, c);
  }, [value, taRef]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value, taRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      onAddFiles(files);
    }
  };

  const onPick = (input: HTMLInputElement) => {
    onAddFiles(Array.from(input.files ?? []));
    input.value = '';
  };

  const onPlusKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPlusOpen(false);
      plusBtnRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(plusRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const i = items.indexOf(document.activeElement as HTMLElement);
      const n = items.length;
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
    }
    if (e.key === 'Tab') setPlusOpen(false);
  };

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const sendDisabled = !canType || !hasContent || reading > 0;

  return (
    <div ref={boxRef} className="flex-none px-4 pt-2 pb-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col rounded-2xl border border-border bg-card focus-within:border-ring">
        {attachments.length > 0 || reading > 0 ? (
          <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Ekler">
            {attachments.map((a) => (
              <li key={a.id} className="flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-muted pr-1 pl-1.5 text-[12px]">
                {a.kind === 'image' && a.dataUrl ? (
                  <img src={a.dataUrl} alt="" className="size-5 flex-none rounded-sm object-cover" />
                ) : (
                  <FileText className="size-4 flex-none text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                )}
                <span className="max-w-[140px] min-w-0 truncate text-foreground" title={a.name}>
                  {a.name}
                </span>
                <span className="flex-none text-muted-foreground tabular-nums">{fmtSize(a.size)}</span>
                <button
                  type="button"
                  aria-label={`${a.name} ekini kaldır`}
                  title="Kaldır"
                  onClick={() => onRemoveAttachment(a.id)}
                  className="relative inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground after:absolute after:-inset-2.5 after:content-[''] sm:after:-inset-0"
                >
                  <X className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
            {reading > 0 ? (
              <li className="flex h-8 items-center gap-1.5 px-2 text-[12px] text-muted-foreground" role="status">
                <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                Yükleniyor…
              </li>
            ) : null}
          </ul>
        ) : null}
        {attachError ? (
          <p className="px-3 pt-1.5 text-[12px] leading-4 text-rose-600 [overflow-wrap:anywhere] dark:text-rose-400" role="alert">
            {attachError}
          </p>
        ) : null}

        <div className="px-4 pt-3 pb-1">
          <textarea
            ref={taRef}
            className="kg-input"
            rows={1}
            value={value}
            maxLength={MAX_SEND_CHARS}
            disabled={!canType}
            aria-label="Ajana mesaj"
            placeholder={canType ? 'Ajana bir görev yazın…' : open ? 'Sohbet şu an kullanılamıyor' : 'Bağlantı bekleniyor…'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            enterKeyHint="send"
          />
        </div>

        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <div ref={plusRef} className="relative flex-none" onKeyDown={onPlusKey}>
            <button
              ref={plusBtnRef}
              type="button"
              disabled={!canType}
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              aria-label="Ekle"
              title="Ekle"
              onClick={() => setPlusOpen((v) => !v)}
              className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:size-8"
            >
              <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
            {plusOpen ? (
              <div
                role="menu"
                aria-label="Ekle"
                className="absolute bottom-full left-0 z-30 mb-2 w-max min-w-56 max-w-[calc(100vw-32px)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    fileRef.current?.click();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-muted focus-visible:bg-muted sm:min-h-9"
                >
                  <Paperclip className="size-4 flex-none text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                  Dosya ekle
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    photoRef.current?.click();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-muted focus-visible:bg-muted sm:min-h-9"
                >
                  <ImageIcon className="size-4 flex-none text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                  Fotoğraf ya da görüntü ekle
                </button>
              </div>
            ) : null}
            <input ref={fileRef} type="file" multiple accept={ACCEPT_FILES} className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.currentTarget)} />
            <input ref={photoRef} type="file" multiple accept={ACCEPT_IMAGES} className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.currentTarget)} />
          </div>

          <SelectMenu
            ariaLabel="Model"
            buttonLabel={modelBtn}
            options={modelOptions}
            value={selectedModel}
            onChange={onSetModel}
            disabled={!models || models.length === 0 || busy || !open}
            className="max-w-[38%] sm:max-w-[220px]"
          />
          {models && efforts.length > 0 ? (
            <SelectMenu
              ariaLabel="Efor"
              buttonLabel={
                <>
                  <span className="hidden sm:inline">Efor: </span>
                  {effortSel ? EFFORT_LABELS[effortSel] ?? effortSel : 'Varsayılan'}
                </>
              }
              options={effortOptions}
              value={effortSel}
              onChange={onSetEffort}
              disabled={busy || !open}
              className="max-w-[34%] sm:max-w-[200px]"
              menuClassName="min-w-40"
            />
          ) : null}
          <SelectMenu
            ariaLabel="İzin modu"
            buttonLabel={
              <>
                <span className="hidden sm:inline">Mod: </span>
                {MODE_OPTIONS.find((m) => m.value === agent.mode)?.label ?? 'Otomatik'}
              </>
            }
            options={MODE_OPTIONS}
            value={agent.mode}
            onChange={onSetMode}
            disabled={!open}
            className="max-w-[34%] sm:max-w-[220px]"
            menuClassName="min-w-56"
          />

          <div className="ml-auto flex-none pl-1">
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Durdur"
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-muted px-3.5 text-[13px] font-medium text-foreground transition-[transform,background-color] duration-150 hover:bg-muted/70 active:scale-[0.98] sm:h-8"
              >
                <Square className="size-3.5 fill-current" aria-hidden="true" />
                Durdur
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={sendDisabled}
                aria-busy={reading > 0}
                aria-label={reading > 0 ? 'Ekler yükleniyor' : 'Gönder'}
                className={cn(
                  'inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-30 sm:size-8',
                  reading > 0 && 'disabled:opacity-60',
                )}
              >
                {reading > 0 ? (
                  <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <ArrowUp className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
