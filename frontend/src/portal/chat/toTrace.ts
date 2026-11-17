import type { TraceNode } from './trace';
import type {
  ChatEvent,
  NoticeEvent,
  PermissionEvent,
  QuestionEvent,
  TextEvent,
  ThinkingEvent,
  ToolEvent,
  TurnEndEvent,
  UserEvent,
} from './protocol';

export type ChatItem =
  | { kind: 'user'; id: string; event: UserEvent }
  | { kind: 'group'; id: string; nodes: TraceNode[] }
  | { kind: 'text'; id: string; event: TextEvent }
  | { kind: 'permission'; id: string; event: PermissionEvent }
  | { kind: 'question'; id: string; event: QuestionEvent }
  | { kind: 'turn_end'; id: string; event: TurnEndEvent }
  | { kind: 'notice'; id: string; event: NoticeEvent };

function thinkingNode(ev: ThinkingEvent): TraceNode {
  return {
    id: ev.id,
    type: 'reasoning',
    sentences: [],
    durationSeconds: ev.seconds ?? undefined,
  };
}

function toolNode(ev: ToolEvent): TraceNode {
  const base: TraceNode = { id: ev.id, type: 'tool', status: ev.status };
  const details: NonNullable<TraceNode['details']> = [];
  if (ev.summary) details.push({ text: ev.summary, tone: 'muted' });
  if (ev.error) details.push({ text: ev.error, tone: 'error' });
  const withDetails = (n: TraceNode): TraceNode => (details.length ? { ...n, details } : n);

  switch (ev.tool) {
    case 'exec': {
      const failed = ev.status === 'failed';
      const output = [ev.output, ev.error].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n');
      return {
        ...base,
        type: 'terminal',
        command: ev.command ?? '',
        output: output || undefined,
        exitCode: failed ? 1 : 0,
        moreLines: ev.moreLines,
      };
    }
    case 'edit':
    case 'write': {
      const path = ev.diff?.file ?? ev.path;
      const n: TraceNode = {
        ...base,
        toolName: ev.tool === 'edit' ? 'edit_file' : 'write_file',
        args: { path },
      };
      if (ev.diff) {
        n.add = ev.diff.add;
        n.del = ev.diff.del;
        n.diffFile = ev.diff.file;
        n.diffRows = ev.diff.rows;
      }
      if (ev.error) n.details = [{ text: ev.error, tone: 'error' }];
      return n;
    }
    case 'read':
      return withDetails({ ...base, toolName: 'read_file', args: { path: ev.path } });
    case 'search':
      return withDetails({ ...base, toolName: 'search', args: { pattern: ev.pattern, path: ev.path } });
    case 'glob':
      return withDetails({ ...base, toolName: 'glob', args: { pattern: ev.pattern, path: ev.path } });
    case 'fetch':
      return withDetails({ ...base, toolName: 'fetch', args: { url: ev.url } });
    case 'web':
      return withDetails({ ...base, toolName: 'web', args: { query: ev.pattern ?? ev.url } });
    case 'agent':
      return withDetails({ ...base, toolName: 'agent', args: { description: ev.description } });
    case 'todo':
      return withDetails({ ...base, toolName: 'todo', primary: ev.name, secondary: ev.description });
    default:
      return withDetails({ ...base, toolName: 'other', primary: ev.name, secondary: ev.description });
  }
}

/** Olayları sırayla öğelere böler: kullanıcı balonları arasında ardışık düşünme/araç olayları tek grup olur. */
export function toTrace(events: ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let group: { kind: 'group'; id: string; nodes: TraceNode[] } | null = null;
  for (const ev of events) {
    if (ev.kind === 'thinking' || ev.kind === 'tool') {
      if (!group) {
        group = { kind: 'group', id: `g-${ev.id}`, nodes: [] };
        items.push(group);
      }
      group.nodes.push(ev.kind === 'thinking' ? thinkingNode(ev) : toolNode(ev));
      continue;
    }
    group = null;
    switch (ev.kind) {
      case 'user':
        items.push({ kind: 'user', id: ev.id, event: ev });
        break;
      case 'text':
        items.push({ kind: 'text', id: ev.id, event: ev });
        break;
      case 'permission':
        items.push({ kind: 'permission', id: ev.id, event: ev });
        break;
      case 'question':
        items.push({ kind: 'question', id: ev.id, event: ev });
        break;
      case 'turn_end':
        items.push({ kind: 'turn_end', id: ev.id, event: ev });
        break;
      case 'notice':
        items.push({ kind: 'notice', id: ev.id, event: ev });
        break;
    }
  }
  return items;
}
