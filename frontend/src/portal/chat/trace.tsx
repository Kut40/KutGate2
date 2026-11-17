// KutGate sohbet akışı bileşenleri (KUT40'ın kendi kodu): ajan adımları, Markdown ve dosya farkı.
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  ListTodo,
  LoaderCircle,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DiffRow } from './protocol';

export type { DiffRow };

export type TraceStatus = 'pending' | 'running' | 'completed' | 'failed';
export type DetailLine = { text: string; tone?: 'muted' | 'error' };

/** Sohbetteki tek bir ajan adımı (toTrace.ts üretir). */
export type TraceNode = {
  id?: string;
  type: 'reasoning' | 'tool' | 'terminal';
  status?: TraceStatus;
  toolName?: string;
  args?: Record<string, string | undefined>;
  primary?: string;
  secondary?: string;
  sentences?: string[];
  durationSeconds?: number;
  command?: string;
  output?: string;
  exitCode?: number;
  moreLines?: number;
  add?: number;
  del?: number;
  diffFile?: string;
  diffRows?: DiffRow[];
  details?: DetailLine[];
};

/* ───────────────────────── Adım satırları ───────────────────────── */

type Describe = { icon: typeof Wrench; verb: string; target?: string; mono?: boolean };

function describe(n: TraceNode): Describe {
  const a = n.args ?? {};
  if (n.type === 'reasoning') {
    const s = n.durationSeconds;
    return { icon: Brain, verb: s ? `Düşündü (${s} sn)` : 'Düşündü' };
  }
  if (n.type === 'terminal') return { icon: SquareTerminal, verb: 'Komut', target: n.command, mono: true };
  switch (n.toolName) {
    case 'read_file':
      return { icon: FileText, verb: 'Okudu', target: a.path, mono: true };
    case 'edit_file':
      return { icon: FilePen, verb: 'Düzenledi', target: a.path, mono: true };
    case 'write_file':
      return { icon: FilePlus, verb: 'Yazdı', target: a.path, mono: true };
    case 'search':
      return { icon: Search, verb: 'Aradı', target: [a.pattern, a.path].filter(Boolean).join(' · '), mono: true };
    case 'glob':
      return { icon: FileSearch, verb: 'Dosya aradı', target: [a.pattern, a.path].filter(Boolean).join(' · '), mono: true };
    case 'fetch':
      return { icon: Globe, verb: 'Sayfa aldı', target: a.url, mono: true };
    case 'web':
      return { icon: Globe, verb: "Web'de aradı", target: a.query };
    case 'agent':
      return { icon: Bot, verb: 'Alt görev', target: a.description };
    case 'todo':
      return { icon: ListTodo, verb: n.primary || 'Yapılacaklar', target: n.secondary };
    default:
      return { icon: Wrench, verb: n.primary || 'Araç', target: n.secondary };
  }
}

function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={cn('size-3.5 shrink-0 animate-spin motion-reduce:animate-none', className)} />;
}

function hasBody(n: TraceNode): boolean {
  return Boolean(
    (n.sentences && n.sentences.length) ||
      (n.type === 'terminal' && n.output) ||
      (n.diffRows && n.diffRows.length) ||
      (n.details && n.details.length),
  );
}

function StepBody({ n }: { n: TraceNode }) {
  return (
    <div className="mt-1.5 ml-6 flex min-w-0 flex-col gap-1.5">
      {n.sentences?.length ? <p className="text-[13px] leading-5 text-muted-foreground">{n.sentences.join(' ')}</p> : null}
      {n.type === 'terminal' && n.output ? (
        <pre className="max-h-56 overflow-auto rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
          {n.output}
          {n.moreLines ? `\n… ${n.moreLines} satır daha` : ''}
        </pre>
      ) : null}
      {n.diffRows?.length ? <FileDiff file={n.diffFile ?? n.args?.path ?? ''} rows={n.diffRows} /> : null}
      {n.details?.map((d, i) => (
        <p key={i} className={cn('text-[12px] leading-[18px] [overflow-wrap:anywhere]', d.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {d.text}
        </p>
      ))}
    </div>
  );
}

function StepRow({ n, active }: { n: TraceNode; active: boolean }) {
  const [open, setOpen] = useState(false);
  const d = describe(n);
  const Icon = d.icon;
  const failed = n.status === 'failed' || (n.type === 'terminal' && typeof n.exitCode === 'number' && n.exitCode !== 0);
  const running = active || n.status === 'running' || n.status === 'pending';
  const expandable = hasBody(n);
  const head = (
    <>
      {running ? <Spinner className="text-muted-foreground" /> : <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')} />}
      <span className="shrink-0 font-medium text-foreground/90">{d.verb}</span>
      {d.target ? <span className={cn('min-w-0 truncate text-muted-foreground', d.mono && 'font-mono text-[12px]')}>{d.target}</span> : null}
      {typeof n.add === 'number' || typeof n.del === 'number' ? (
        <span className="shrink-0 font-mono text-[12px]">
          {n.add ? <span className="text-emerald-500">+{n.add}</span> : null} {n.del ? <span className="text-rose-500">−{n.del}</span> : null}
        </span>
      ) : null}
      {failed ? <CircleAlert aria-label="başarısız" className="size-3.5 shrink-0 text-destructive" /> : null}
      {expandable ? <ChevronRight aria-hidden="true" className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} /> : null}
    </>
  );
  return (
    <li className="min-w-0">
      {expandable ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] hover:bg-muted/40">
          {head}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-[13px]">{head}</div>
      )}
      {expandable && open ? <StepBody n={n} /> : null}
    </li>
  );
}

/**
 * Ardışık ajan adımları. live=true iken grup açık durur ve son adım "çalışıyor" görünür;
 * iş bitince grup kendiliğinden katlanır, kullanıcı başlığa basarak açabilir.
 */
export function ThinkingState({ nodes, live }: { nodes: TraceNode[]; live?: boolean }) {
  const [open, setOpen] = useState(Boolean(live));
  useEffect(() => {
    setOpen(Boolean(live));
  }, [live]);

  if (!nodes.length) {
    return live ? (
      <div role="status" className="flex items-center gap-2 px-1 py-1 text-[13px] text-muted-foreground">
        <Spinner />
        <span>Çalışıyor…</span>
      </div>
    ) : null;
  }

  const seconds = nodes.reduce((t, n) => t + (n.durationSeconds ?? 0), 0);
  const failed = nodes.some((n) => n.status === 'failed');
  const title = live ? 'Çalışıyor…' : `${nodes.length} adım${seconds ? ` · ${seconds} sn düşünme` : ''}`;

  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px] text-muted-foreground hover:text-foreground">
        {live ? <Spinner /> : <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />}
        <span>{title}</span>
        {failed && !live ? <CircleAlert aria-label="hatalı adım var" className="size-3.5 text-destructive" /> : null}
      </button>
      {open ? (
        <ul role={live ? 'status' : undefined} className="mt-0.5 ml-1.5 flex min-w-0 flex-col border-l border-border/70 pl-2.5">
          {nodes.map((n, i) => (
            <StepRow key={n.id ?? i} n={n} active={Boolean(live) && i === nodes.length - 1 && n.status !== 'completed' && n.status !== 'failed'} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ───────────────────────── Dosya farkı ───────────────────────── */

export function FileDiff({ file, rows }: { file: string; rows: DiffRow[] }) {
  const add = rows.filter((r) => r.type === 'add').length;
  const del = rows.filter((r) => r.type === 'del').length;
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border/70">
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-2.5 py-1 text-[12px]">
        <span className="min-w-0 truncate font-mono text-foreground/90">{file}</span>
        <span className="ml-auto shrink-0 font-mono">
          <span className="text-emerald-500">+{add}</span> <span className="text-rose-500">−{del}</span>
        </span>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[18px]">
          <tbody>
            {rows.map((r, i) =>
              r.type === 'hunk' ? (
                <tr key={i} className="bg-muted/30 text-muted-foreground">
                  <td colSpan={4} className="px-2.5 py-0.5">
                    {r.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={r.type === 'add' ? 'bg-emerald-500/10' : r.type === 'del' ? 'bg-rose-500/10' : undefined}>
                  <td className="w-10 px-1.5 text-right text-muted-foreground/70 select-none">{r.old ?? ''}</td>
                  <td className="w-10 px-1.5 text-right text-muted-foreground/70 select-none">{r.cur ?? ''}</td>
                  <td className={cn('w-4 select-none', r.type === 'add' ? 'text-emerald-500' : r.type === 'del' ? 'text-rose-500' : 'text-muted-foreground/50')}>
                    {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}
                  </td>
                  <td className="pr-2.5 whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">{r.text}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────────────────── Markdown ───────────────────────── */
// HTML üretmez: metin React öğelerine çevrilir, ham HTML yazı olarak görünür. Bağlantılar yalnız http(s).

function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const id = `${key}-${k++}`;
    if (m[1]) {
      out.push(
        <code key={id} className="rounded bg-muted/50 px-1 py-px font-mono text-[0.9em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(<strong key={id}>{inline(tok.slice(2, -2), id)}</strong>);
    } else if (m[3]) {
      out.push(<em key={id}>{inline(tok.slice(1, -1), id)}</em>);
    } else {
      const label = tok.slice(1, tok.indexOf(']('));
      const href = safeUrl(tok.slice(tok.indexOf('](') + 2, -1));
      out.push(
        href ? (
          <a key={id} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {inline(label, id)}
          </a>
        ) : (
          <Fragment key={id}>{label}</Fragment>
        ),
      );
    }
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(
        <p key={b++} className="my-2 first:mt-0 last:mb-0">
          {inline(para.join(' '), `p${b}`)}
        </p>,
      );
      para.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={b++} className="my-2 overflow-auto rounded-md border border-border/70 bg-muted/30 px-3 py-2 font-mono text-[12px] leading-[18px]">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const size = ['text-lg', 'text-base', 'text-[15px]', 'text-sm'][h[1].length - 1];
      blocks.push(
        <p key={b++} role="heading" aria-level={h[1].length + 1} className={cn('mt-3 mb-1.5 font-semibold first:mt-0', size)}>
          {inline(h[2], `h${b}`)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={b++} className="my-3 border-border/70" />);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));
      blocks.push(
        <div key={b++} className="my-2 overflow-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className="border border-border/70 bg-muted/40 px-2 py-1 text-left font-semibold">
                    {inline(c, `th${b}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} className="border border-border/70 px-2 py-1 align-top">
                      {inline(r[j] ?? '', `td${b}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
        else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim();
        else break;
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={b++} className={cn('my-2 flex flex-col gap-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `l${b}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={b++} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
          {inline(quote.join(' '), `q${b}`)}
        </blockquote>,
      );
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i++;
  }
  flush();
  return <div className="min-w-0 text-[14px] leading-6 [overflow-wrap:anywhere]">{blocks}</div>;
}
