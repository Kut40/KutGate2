// Sözleşme: /srv/gate/docs/AGENT_CHAT_SOZLESME.md

export type DiffRow = { old: number | null; cur: number | null; type: 'add' | 'del' | 'ctx' | 'hunk'; text: string };
export type ToolKind = 'read' | 'write' | 'edit' | 'exec' | 'search' | 'glob' | 'fetch' | 'web' | 'todo' | 'agent' | 'other';
export type DiffInfo = { file: string; add: number; del: number; rows: DiffRow[] };

export type AttachmentKind = 'image' | 'pdf' | 'text';
export type AttachmentInfo = { name: string; kind: AttachmentKind; size: number };
export type UserEvent = { kind: 'user'; id: string; ts: number; text: string; attachments?: AttachmentInfo[] };
export type TextEvent = { kind: 'text'; id: string; ts: number; text: string; done: boolean };
export type ThinkingEvent = { kind: 'thinking'; id: string; ts: number; seconds: number | null };
export type ToolEvent = {
  kind: 'tool';
  id: string;
  ts: number;
  tool: ToolKind;
  name: string;
  path?: string;
  command?: string;
  pattern?: string;
  url?: string;
  description?: string;
  diff?: DiffInfo;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  output?: string;
  moreLines?: number;
  error?: string;
};
export type PermissionStatus = 'pending' | 'allowed' | 'allowed_always' | 'denied' | 'expired';
export type PermissionEvent = {
  kind: 'permission';
  id: string;
  ts: number;
  tool: ToolKind;
  name: string;
  description?: string;
  path?: string;
  command?: string;
  diff?: DiffInfo;
  canAlways: boolean;
  status: PermissionStatus;
};
export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
};
export type QuestionEvent = {
  kind: 'question';
  id: string;
  ts: number;
  questions: QuestionItem[];
  status: 'pending' | 'answered' | 'expired';
};
export type TurnEndEvent = {
  kind: 'turn_end';
  id: string;
  ts: number;
  outcome: 'ok' | 'error' | 'stopped';
  message?: string;
};
export type NoticeEvent = { kind: 'notice'; id: string; ts: number; level: 'info' | 'warn' | 'error'; text: string };

export type ChatEvent =
  | UserEvent
  | TextEvent
  | ThinkingEvent
  | ToolEvent
  | PermissionEvent
  | QuestionEvent
  | TurnEndEvent
  | NoticeEvent;

export type AgentState = {
  id: string | null;
  started: string | null;
  alive: boolean;
  busy: boolean;
  authRequired: boolean;
  model: string | null;
  effort: string | null;
  mode: string;
  maxEffort: string;
  retry: RetryState | null;
};
export type RetryState = { attempt: number; max: number };
export type ModelInfo = { value: string; label: string; description?: string; efforts: string[] };
export type AttachmentPayload = { name: string; mime: string; data: string };

export type ChatInfo = { id: string; title: string; updated: number; active: boolean };

export type ServerFrame =
  | ({ t: 'hello'; events: ChatEvent[] } & AgentState)
  | ({ t: 'state' } & AgentState)
  | { t: 'ev'; ev: ChatEvent }
  | { t: 'delta'; id: string; text: string }
  | { t: 'models'; models: ModelInfo[] }
  | { t: 'reset' }
  | { t: 'chats'; chats: ChatInfo[] };

export type ClientFrame =
  | { t: 'send'; text: string; attachments?: AttachmentPayload[] }
  | { t: 'set_model'; model: string }
  | { t: 'set_effort'; effort: string }
  | { t: 'set_mode'; mode: string }
  | { t: 'perm'; id: string; allow: boolean; always?: boolean }
  | { t: 'answer'; id: string; answers: Record<string, string> }
  | { t: 'stop' }
  | { t: 'restart' }
  | { t: 'new' }
  | { t: 'open_chat'; id: string }
  | { t: 'delete_chat'; id: string };

export const MAX_SEND_CHARS = 100000;

export type Project = { name: string; perm: 'r' | 'rw' };
