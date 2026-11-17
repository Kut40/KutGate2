import { useEffect, useState } from 'react';
import { Check, CircleHelp, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileDiff } from './trace';
import type { PermissionEvent, PermissionStatus, QuestionEvent } from './protocol';

const STATUS_TEXT: Record<Exclude<PermissionStatus, 'pending'>, string> = {
  allowed: 'Onaylandı',
  allowed_always: 'Bu oturumda hep izin verildi',
  denied: 'Reddedildi',
  expired: 'Süresi doldu',
};

const BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium transition-[transform,background-color,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 sm:min-h-9';

export function PermissionCard({
  event,
  open,
  onRespond,
}: {
  event: PermissionEvent;
  open: boolean;
  onRespond: (id: string, allow: boolean, always?: boolean) => boolean;
}) {
  const [sent, setSent] = useState(false);
  const pending = event.status === 'pending';
  useEffect(() => {
    if (open) setSent(false);
  }, [open]);
  const respond = (allow: boolean, always?: boolean) => {
    if (onRespond(event.id, allow, always)) setSent(true);
  };
  return (
    <section
      aria-label={`İzin isteği: ${event.name}`}
      className="flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3 text-[13px] text-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">İzin isteniyor</span>
        <span className="min-w-0 truncate rounded-[5px] bg-muted/70 px-1.5 font-mono text-[11.5px] text-foreground/85">
          {event.name}
        </span>
      </div>
      {event.description ? (
        <p className="text-[13px] leading-5 text-foreground/90 [overflow-wrap:anywhere]">{event.description}</p>
      ) : null}
      {event.command ? (
        <div className="max-h-40 overflow-auto rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
          {event.command}
        </div>
      ) : null}
      {event.path && !event.diff ? (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 font-mono text-[12px] leading-[18px] text-foreground/90 [overflow-wrap:anywhere]">
          {event.path}
        </div>
      ) : null}
      {event.diff ? <FileDiff file={event.diff.file} rows={event.diff.rows} /> : null}
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={sent} onClick={() => respond(true)} className={cn(BTN, 'bg-primary text-primary-foreground hover:opacity-90')}>
            Onayla
          </button>
          {event.canAlways ? (
            <button
              type="button"
              disabled={sent}
              onClick={() => respond(true, true)}
              className={cn(BTN, 'border border-border bg-muted text-foreground hover:bg-muted/70')}
            >
              Bu oturumda hep izin ver
            </button>
          ) : null}
          <button
            type="button"
            disabled={sent}
            onClick={() => respond(false)}
            className={cn(BTN, 'border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground')}
          >
            Reddet
          </button>
        </div>
      ) : (
        <p className={cn('flex items-center gap-1.5 text-[12px]', event.status === 'denied' ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
          {event.status === 'allowed' || event.status === 'allowed_always' ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {event.status === 'pending' ? null : STATUS_TEXT[event.status]}
        </p>
      )}
    </section>
  );
}

export function QuestionCard({
  event,
  open,
  onAnswer,
}: {
  event: QuestionEvent;
  open: boolean;
  onAnswer: (id: string, answers: Record<string, string>) => boolean;
}) {
  const [picked, setPicked] = useState<string[][]>(() => event.questions.map(() => []));
  const [sent, setSent] = useState(false);
  const pending = event.status === 'pending';
  useEffect(() => {
    if (open) setSent(false);
  }, [open]);
  const complete = picked.length === event.questions.length && picked.every((p) => p.length > 0);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) =>
      prev.map((sel, i) => {
        if (i !== qi) return sel;
        if (!multi) return [label];
        return sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label];
      }),
    );
  };

  const submit = () => {
    if (!complete || sent) return;
    const answers: Record<string, string> = {};
    event.questions.forEach((q, i) => {
      answers[q.question] = picked[i].join(', ');
    });
    if (onAnswer(event.id, answers)) setSent(true);
  };

  return (
    <section
      aria-label="Ajan soruyor"
      className="flex w-full min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3 text-[13px] text-foreground"
    >
      {event.questions.map((q, qi) => (
        <div key={qi} className="flex min-w-0 flex-col gap-2" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
          <div className="flex min-w-0 items-start gap-2">
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              {q.header ? (
                <span className="mb-1 inline-block rounded-[5px] bg-muted/70 px-1.5 text-[11.5px] text-muted-foreground">{q.header}</span>
              ) : null}
              <p className="text-[14px] leading-[22px] font-medium text-foreground [overflow-wrap:anywhere]">{q.question}</p>
              {pending && q.multiSelect ? <p className="text-[12px] text-muted-foreground">Birden fazla seçebilirsiniz.</p> : null}
            </div>
          </div>
          {pending ? (
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = picked[qi]?.includes(o.label) === true;
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    disabled={sent}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                    className={cn(
                      'flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors duration-150 disabled:opacity-60 sm:min-h-9',
                      on ? 'border-foreground/60 bg-muted' : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                        q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        on ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/60',
                      )}
                    >
                      {on ? <Check className="size-3" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-foreground [overflow-wrap:anywhere]">{o.label}</span>
                      {o.description ? (
                        <span className="block text-[12px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">{o.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
      {pending ? (
        <div>
          <button type="button" disabled={!complete || sent} onClick={submit} className={cn(BTN, 'bg-primary text-primary-foreground hover:opacity-90')}>
            Yanıtla
          </button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {event.status === 'answered' ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {event.status === 'answered' ? 'Yanıtlandı' : 'Süresi doldu'}
        </p>
      )}
    </section>
  );
}
