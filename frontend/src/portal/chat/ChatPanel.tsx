import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, CircleAlert, FileText, Image as ImageIcon, LoaderCircle, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown, ThinkingState } from './trace';
import type { AgentState, AttachmentPayload, ChatEvent, ModelInfo } from './protocol';
import { BrandMark } from './BrandMark';
import { toPayload, useAttachments } from './attachments';
import { Composer } from './Composer';
import type { ConnState } from './useAgent';
import { toTrace } from './toTrace';
import { PermissionCard, QuestionCard } from './PermissionCard';

const EXAMPLES = ['Bu projenin yapısını özetle', 'Açık görevleri ve eksikleri listele'];
const STICK_PX = 80;

const BAND_BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium transition-[transform,background-color,opacity] duration-150 active:scale-[0.98] disabled:opacity-50 sm:min-h-9';

export function ChatPanel({
  events,
  agent,
  conn,
  closeNote,
  models,
  onSetModel,
  onSetEffort,
  onSetMode,
  onSend,
  onStop,
  onRestart,
  onReconnect,
  onOpenTerminal,
  onPermission,
  onAnswer,
  insertRef,
}: {
  events: ChatEvent[];
  agent: AgentState;
  conn: ConnState;
  closeNote: string;
  models: ModelInfo[] | null;
  onSetModel: (m: string) => void;
  onSetEffort: (e: string) => void;
  onSetMode: (m: string) => void;
  onSend: (text: string, attachments?: AttachmentPayload[]) => boolean;
  onStop: () => void;
  onRestart: () => void;
  onReconnect: () => void;
  onOpenTerminal: () => void;
  onPermission: (id: string, allow: boolean, always?: boolean) => boolean;
  onAnswer: (id: string, answers: Record<string, string>) => boolean;
  insertRef?: { current: ((text: string) => void) | null };
}) {
  const items = useMemo(() => toTrace(events), [events]);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const [restarting, setRestarting] = useState(false);

  const busy = agent.busy;
  const open = conn === 'open';
  const blocked = agent.authRequired || !agent.alive;
  const canType = open && !blocked;
  const last = items[items.length - 1];

  useEffect(() => {
    if (agent.alive && !agent.authRequired) setRestarting(false);
  }, [agent.alive, agent.authRequired]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stickRef.current = near;
    setShowJump(!near);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, busy, blocked]);

  // İçerik yüksekliği değişince (katlanma, düşünme satırları) alta yapışıklığı koru.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const box = composerRef.current;
    if (!root || !box) return;
    const ro = new ResizeObserver(() => {
      root.style.setProperty('--kg-composer-h', `${box.offsetHeight}px`);
    });
    ro.observe(box, { box: 'border-box' });
    return () => ro.disconnect();
  }, []);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  const att = useAttachments();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const submit = useCallback(() => {
    const text = value.trim();
    if ((!text && att.items.length === 0) || busy || !canType || att.reading > 0) return;
    const payloads = att.items.map(toPayload);
    if (onSend(text, payloads)) {
      setValue('');
      att.clear();
      stickRef.current = true;
    }
  }, [value, busy, canType, onSend, att]);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!canType || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!canType || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (canType) void att.add(Array.from(e.dataTransfer.files));
  };

  const restart = () => {
    setRestarting(true);
    onRestart();
  };

  const lastLive = last?.kind === 'group' && busy;
  const showWorking = busy && (last?.kind === 'user' || (last?.kind === 'text' && last.event.done));

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {!open ? 'Bağlantı yok' : busy ? 'Ajan çalışıyor' : 'Ajan hazır'}
      </div>

      {agent.authRequired && open ? (
        <div className="mx-auto mt-3 flex w-[calc(100%-32px)] max-w-3xl flex-none flex-col gap-2.5 rounded-xl border border-border bg-card p-3 text-[13px]" role="alert">
          <p className="leading-5 text-foreground">
            Claude hesabınız bu sunucuya bağlı değil. Terminali açın, <code className="rounded-sm bg-muted px-1 py-px font-mono text-[12px]">claude</code> yazın ve girişi tamamlayın.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onOpenTerminal} className={cn(BAND_BTN, 'bg-primary text-primary-foreground hover:opacity-90')}>
              Terminali aç
            </button>
            <button type="button" disabled={restarting} onClick={restart} className={cn(BAND_BTN, 'border border-border bg-muted text-foreground hover:bg-muted/70')}>
              Yeniden dene
            </button>
          </div>
        </div>
      ) : !agent.alive && open ? (
        <div className="mx-auto mt-3 flex w-[calc(100%-32px)] max-w-3xl flex-none flex-wrap items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-[13px]" role="alert">
          <p className="min-w-0 flex-1 text-foreground">Oturum sona erdi.</p>
          <button type="button" disabled={restarting} onClick={restart} className={cn(BAND_BTN, 'bg-primary text-primary-foreground hover:opacity-90')}>
            Devam et
          </button>
        </div>
      ) : null}

      {conn === 'closed' ? (
        <div className="mx-auto mt-3 flex w-[calc(100%-32px)] max-w-3xl flex-none flex-wrap items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-[13px]" role="alert">
          <p className="min-w-0 flex-1 text-foreground">{closeNote || 'Bağlantı kapandı.'}</p>
          <button type="button" onClick={onReconnect} className={cn(BAND_BTN, 'bg-primary text-primary-foreground hover:opacity-90')}>
            Yeniden bağlan
          </button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center gap-2 overflow-hidden px-6 text-center text-foreground opacity-30 select-none"
      >
        <BrandMark size={72} className="size-[clamp(40px,8vw,72px)]" />
        <span className="max-w-full text-[clamp(24px,5.5vw,56px)] leading-[1.1] font-extrabold tracking-[0.04em] [overflow-wrap:anywhere]">KutGate AI Ajanı</span>
        <span className="max-w-full text-[clamp(13px,2vw,20px)] leading-tight font-semibold tracking-[0.08em]">Takım Çalışma Paneli</span>
      </div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-ring bg-background/80 text-[14px] font-medium text-foreground">
          <Upload className="size-4" strokeWidth={1.75} aria-hidden="true" />
          Dosyaları buraya bırakın
        </div>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Sohbet"
        aria-live="off"
        className="relative z-10 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
          {items.length === 0 && !busy ? (
            <div className="flex flex-col items-start gap-3 py-8">
              <p className="text-[18px] leading-[26px] font-semibold text-foreground">Merhaba, size nasıl yardımcı olabilirim?</p>
              <p className="text-[14px] leading-[22px] text-muted-foreground">
                Ajana bir görev yazın; yaptığı adımları burada canlı izleyebilirsiniz.
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    disabled={!canType}
                    onClick={() => {
                      setValue(ex);
                      taRef.current?.focus();
                    }}
                    className="min-h-11 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5 text-left text-[12.5px] font-medium text-muted-foreground transition-all duration-150 hover:border-border hover:text-foreground active:scale-[0.97] disabled:opacity-50 sm:min-h-9"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {items.map((it, i) => {
            switch (it.kind) {
              case 'user':
                return (
                  <div key={it.id} className="flex justify-end">
                    <div className="flex max-w-[80%] flex-col gap-2 rounded-2xl bg-muted px-4 py-2.5 text-[14px] leading-relaxed text-foreground text-balance shadow-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {it.event.text ? <span>{it.event.text}</span> : null}
                      {it.event.attachments && it.event.attachments.length > 0 ? (
                        <span className="flex flex-wrap gap-1.5 whitespace-normal">
                          {it.event.attachments.map((a, k) => (
                            <span key={`${a.name}-${k}`} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 text-[12px] text-muted-foreground">
                              {a.kind === 'image' ? (
                                <ImageIcon className="size-3.5 flex-none" strokeWidth={1.75} aria-hidden="true" />
                              ) : (
                                <FileText className="size-3.5 flex-none" strokeWidth={1.75} aria-hidden="true" />
                              )}
                              <span className="max-w-[160px] truncate" title={a.name}>
                                {a.name}
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              case 'group':
                return (
                  <div key={it.id} className="flex min-w-0 flex-col">
                    <ThinkingState nodes={it.nodes} live={lastLive && i === items.length - 1} />
                  </div>
                );
              case 'text':
                return it.event.text ? (
                  <div key={it.id} className="min-w-0 [overflow-wrap:anywhere]">
                    <Markdown text={it.event.text} />
                  </div>
                ) : null;
              case 'permission':
                return <PermissionCard key={it.id} event={it.event} open={open} onRespond={onPermission} />;
              case 'question':
                return <QuestionCard key={it.id} event={it.event} open={open} onAnswer={onAnswer} />;
              case 'turn_end':
                if (it.event.outcome === 'ok') return null;
                if (it.event.outcome === 'stopped') {
                  return (
                    <p key={it.id} className="text-[12px] leading-[18px] text-muted-foreground">
                      Durduruldu
                    </p>
                  );
                }
                return (
                  <p key={it.id} className="flex items-start gap-1.5 text-[13px] leading-5 text-rose-600 [overflow-wrap:anywhere] dark:text-rose-400" role="alert">
                    <CircleAlert className="mt-0.5 size-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
                    <span className="min-w-0">{it.event.message || 'Bir hata oluştu.'}</span>
                  </p>
                );
              case 'notice':
                return (
                  <p
                    key={it.id}
                    className={cn(
                      'text-[12px] leading-[18px] [overflow-wrap:anywhere]',
                      it.event.level === 'error'
                        ? 'text-rose-600 dark:text-rose-400'
                        : it.event.level === 'warn'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground',
                    )}
                  >
                    {it.event.text}
                  </p>
                );
            }
          })}

          {showWorking ? (
            <div className="flex min-w-0 flex-col">
              <ThinkingState nodes={[]} live />
            </div>
          ) : null}

          {agent.retry ? (
            <p className="flex items-start gap-1.5 text-[13px] leading-5 text-amber-600 [overflow-wrap:anywhere] dark:text-amber-400" role="status">
              <LoaderCircle className="mt-0.5 size-4 flex-none animate-spin" strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0">
                Modele ulaşılamıyor, yeniden deneniyor ({agent.retry.attempt}/{agent.retry.max})…
              </span>
            </p>
          ) : null}
        </div>
      </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={jump}
          aria-label="En alta in"
          className="absolute right-4 bottom-[calc(var(--kg-composer-h,96px)+8px)] z-10 flex size-10 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-xs backdrop-blur-sm transition-all duration-150 hover:text-foreground active:scale-[0.97]"
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </button>
      ) : null}

      <Composer
        value={value}
        setValue={setValue}
        taRef={taRef}
        boxRef={composerRef}
        insertRef={insertRef}
        agent={agent}
        canType={canType}
        open={open}
        models={models}
        attachments={att.items}
        attachError={att.error}
        reading={att.reading}
        onAddFiles={(files) => void att.add(files)}
        onRemoveAttachment={att.remove}
        onSubmit={submit}
        onStop={onStop}
        onSetModel={onSetModel}
        onSetEffort={onSetEffort}
        onSetMode={onSetMode}
      />
    </div>
  );
}
