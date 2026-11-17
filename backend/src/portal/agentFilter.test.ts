import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentFilter,
  clampEffort,
  effortWithinLimit,
  isChatEvent,
  isEffortCommand,
  normalizeMaxEffort,
  buildAllow,
  buildAnswer,
  buildDeny,
  castLine,
  LineSplitter,
  setEffortLine,
  setModelLine,
  userMessageLine,
  validateAttachments,
  type AttachmentBlock,
  type ChatEvent,
  type FilterFrame,
  type ToolEvent,
} from './agentFilter.js';

const UUID = '11111111-2222-3333-4444-555555555555';

function events(frames: FilterFrame[]): ChatEvent[] {
  return frames.flatMap((f) => (f.t === 'ev' ? [f.ev] : []));
}

function runTool(name: string, input: unknown, block: Record<string, unknown>, result?: unknown): ToolEvent[] {
  const filter = new AgentFilter();
  const start = filter.push({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  });
  const end = filter.push({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...block }] },
    tool_use_result: result,
  });
  return events([...start.frames, ...end.frames]) as ToolEvent[];
}

test('Read: dosya içeriği hiçbir alanda yok, yalnızca yol ve satır sayısı', () => {
  const evs = runTool(
    'Read',
    { file_path: '/home/a/x.txt', offset: 3 },
    { content: 'ICERIK satırı', is_error: false },
    { type: 'text', file: { filePath: '/home/a/x.txt', content: 'ICERIK satırı', numLines: 120, startLine: 1, totalLines: 120 } },
  );
  assert.equal(JSON.stringify(evs).includes('ICERIK'), false);
  const last = evs[evs.length - 1];
  assert.equal(last.path, '/home/a/x.txt');
  assert.equal(last.summary, '120 satır okundu');
  assert.equal(last.status, 'completed');
  assert.equal(castLine(last).includes('ICERIK'), false);
});

test('Read hatası: tool_result içeriği okunmaz', () => {
  const evs = runTool('Read', { file_path: '/x' }, { content: 'ICERIK', is_error: true }, undefined);
  assert.equal(JSON.stringify(evs).includes('ICERIK'), false);
  assert.equal(evs[evs.length - 1].status, 'failed');
});

test('Grep ve Glob: sonuçlar sızmaz, yalnızca sayı', () => {
  const grep = runTool(
    'Grep',
    { pattern: 'abc', path: '/gizli-yol' },
    { content: 'ICERIK.ts:1:abc', is_error: false },
    { mode: 'content', filenames: ['ICERIK.ts'], content: 'ICERIK', numFiles: 0, numLines: 4 },
  );
  assert.equal(JSON.stringify(grep).includes('ICERIK'), false);
  assert.equal(JSON.stringify(grep).includes('gizli-yol'), false);
  assert.equal(grep[grep.length - 1].pattern, 'abc');
  assert.equal(grep[grep.length - 1].summary, '4 satır bulundu');

  const glob = runTool('Glob', { pattern: '*.ts' }, { content: 'ICERIK.ts', is_error: false }, { filenames: ['ICERIK.ts'], numFiles: 5 });
  assert.equal(JSON.stringify(glob).includes('ICERIK'), false);
  assert.equal(glob[glob.length - 1].summary, '5 dosya bulundu');

  const empty = runTool('Glob', { pattern: '*' }, { content: 'ICERIK', is_error: false }, { filenames: ['ICERIK'] });
  assert.equal(empty[empty.length - 1].summary, undefined);
});

test('thinking: metin sızmaz, yalnızca süre', () => {
  let t = 1000;
  const filter = new AgentFilter({ now: () => t });
  const frames: FilterFrame[] = [];
  const push = (event: unknown): void => {
    frames.push(...filter.push({ type: 'stream_event', parent_tool_use_id: null, event }).frames);
  };
  push({ type: 'message_start', message: { id: 'msg_1' } });
  push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'ICERIK' } });
  push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ICERIK' } });
  t = 3500;
  push({ type: 'content_block_stop', index: 0 });
  frames.push(
    ...filter.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'ICERIK', signature: 's' }] },
    }).frames,
  );
  assert.equal(JSON.stringify(frames).includes('ICERIK'), false);
  const evs = events(frames);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[1], { kind: 'thinking', id: 'msg_1-0', ts: 1000, seconds: 2.5 });
});

test('Bash: en çok 3 satır, satır başına 160 karakter, kalan moreLines', () => {
  const stdout = ['a'.repeat(400), 'b', 'c', 'd', 'e', ''].join('\n');
  const evs = runTool('Bash', { command: 'x'.repeat(900), description: 'd'.repeat(400) }, { content: 'ICERIK', is_error: false }, { stdout, stderr: 'f\n', interrupted: false });
  const last = evs[evs.length - 1];
  assert.equal(last.output, `${'a'.repeat(160)}\nb\nc`);
  assert.equal(last.moreLines, 3);
  assert.equal(last.command?.length, 500);
  assert.equal(last.description?.length, 200);
  assert.equal(JSON.stringify(evs).includes('ICERIK'), false);
});

test('Bash hatası tek satır ve en çok 300 karakter', () => {
  const evs = runTool('Bash', { command: 'x' }, { content: 'y', is_error: true }, `${'h'.repeat(500)}\nikinci`);
  const last = evs[evs.length - 1];
  assert.equal(last.status, 'failed');
  assert.equal(last.error, 'h'.repeat(300));
});

test('fark: toplam 80 satır, sayılar gerçek toplam, satır numaraları ardışık', () => {
  const lines = (n: number, p: string): string => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n');
  const edit = runTool('Edit', { file_path: '/a', old_string: lines(50, 'o'), new_string: lines(60, 'n') }, { content: 'ICERIK', is_error: false }, { originalFile: 'ICERIK' });
  const diff = edit[edit.length - 1].diff;
  assert.ok(diff);
  assert.equal(diff.file, '/a');
  assert.equal(diff.del, 50);
  assert.equal(diff.add, 60);
  assert.equal(diff.rows.length, 80);
  assert.deepEqual(diff.rows[0], { old: 1, cur: null, type: 'del', text: 'o0' });
  assert.deepEqual(diff.rows[50], { old: null, cur: 1, type: 'add', text: 'n0' });
  assert.equal(JSON.stringify(edit).includes('ICERIK'), false);

  const write = runTool('Write', { file_path: '/b', content: `${lines(100, 'w')}\n` }, { content: 'k', is_error: false });
  assert.equal(write[0].diff?.add, 100);
  assert.equal(write[0].diff?.del, 0);
  assert.equal(write[0].diff?.rows.length, 80);

  const multi = runTool('MultiEdit', { file_path: '/c', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, { content: 'k', is_error: false });
  assert.deepEqual(multi[0].diff?.rows.map((r) => [r.old, r.cur]), [[1, null], [null, 1], [2, null], [null, 2]]);
});

test('MCP ve bilinmeyen araç: girdi, sonuç ve hata iletilmez', () => {
  const ok = runTool('mcp__srv__do', { file_path: '/ICERIK', command: 'ICERIK', secret: 'ICERIK' }, { content: 'ICERIK', is_error: false }, { stdout: 'ICERIK' });
  assert.equal(JSON.stringify(ok).includes('ICERIK'), false);
  assert.equal(ok[0].tool, 'other');
  assert.equal(ok[0].name, 'mcp__srv__do');

  const bad = runTool('Bilinmeyen', { x: 'ICERIK' }, { content: 'ICERIK', is_error: true }, 'ICERIK');
  assert.equal(JSON.stringify(bad).includes('ICERIK'), false);

  const filter = new AgentFilter();
  const perm = filter.push({
    type: 'control_request',
    request_id: 'req-1',
    request: { subtype: 'can_use_tool', tool_name: 'mcp__srv__do', display_name: 'ICERIK', description: 'ICERIK', input: { x: 'ICERIK' }, permission_suggestions: [], tool_use_id: 'toolu_1' },
  });
  assert.equal(JSON.stringify(perm.frames).includes('ICERIK'), false);
  assert.equal(perm.pending[0].kind, 'permission');
});

test('ad eşleme: nesne önkümesi adları other sayılır', () => {
  for (const name of ['constructor', '__proto__', 'toString']) {
    assert.equal(runTool(name, {}, { content: '', is_error: false })[0].tool, 'other');
  }
  const kinds: [string, string][] = [
    ['Read', 'read'], ['Write', 'write'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'], ['Bash', 'exec'],
    ['Grep', 'search'], ['Glob', 'glob'], ['WebFetch', 'fetch'], ['WebSearch', 'web'], ['TodoWrite', 'todo'], ['Task', 'agent'], ['Agent', 'agent'],
  ];
  for (const [name, kind] of kinds) assert.equal(runTool(name, {}, { content: '', is_error: false })[0].tool, kind);
});

test('izinli araçlarda fazla girdi alanı iletilmez', () => {
  const fetch = runTool('WebFetch', { url: 'https://x.test', prompt: 'ICERIK' }, { content: 'ICERIK', is_error: false }, { result: 'ICERIK' });
  assert.equal(JSON.stringify(fetch).includes('ICERIK'), false);
  const todo = runTool('TodoWrite', { todos: [{ content: 'ICERIK' }] }, { content: 'ICERIK', is_error: false });
  assert.equal(JSON.stringify(todo).includes('ICERIK'), false);
  const task = runTool('Task', { description: 'kısa', prompt: 'ICERIK' }, { content: 'ICERIK', is_error: false });
  assert.equal(JSON.stringify(task).includes('ICERIK'), false);
  assert.equal(task[0].description, 'kısa');
});

test('ANSI ve kontrol karakterleri temizlenir', () => {
  const evs = runTool('Bash', { command: '\x1b[31mls\x1b[0m\x07' }, { content: '', is_error: false }, { stdout: '\x1b[1;32mtamam\x1b[0m\x00\r\n\x1b]0;baslik\x07iki\n' });
  const last = evs[evs.length - 1];
  assert.equal(last.command, 'ls');
  assert.equal(last.output, 'tamam\niki');

  const filter = new AgentFilter();
  const r = filter.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'a\x1b[31mb\x1b[0m\x01c' }] } });
  assert.equal((events(r.frames)[0] as { text: string }).text, 'abc');
});

test('alt ajan olayları atılır', () => {
  const filter = new AgentFilter();
  const parent = { parent_tool_use_id: 'toolu_9' };
  for (const msg of [
    { type: 'stream_event', ...parent, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ICERIK' } } },
    { type: 'assistant', ...parent, message: { id: 'm', content: [{ type: 'text', text: 'ICERIK' }] } },
    { type: 'user', ...parent, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ICERIK' }] } },
    { type: 'result', ...parent, is_error: false, result: 'ICERIK', session_id: UUID },
  ]) {
    const r = filter.push(msg);
    assert.deepEqual(r.frames, []);
    assert.equal(r.turnEnded, undefined);
    assert.equal(r.sessionId, undefined);
  }
});

test('metin tekrar eklenmez: deltadan sonra gelen assistant yok sayılır', () => {
  const filter = new AgentFilter();
  const frames: FilterFrame[] = [];
  const stream = (event: unknown): void => {
    frames.push(...filter.push({ type: 'stream_event', parent_tool_use_id: null, event }).frames);
  };
  stream({ type: 'message_start', message: { id: 'msg_1' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Mer' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'haba' } });
  const assistant = { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'text', text: 'Merhaba' }] } };
  frames.push(...filter.push(assistant).frames);
  stream({ type: 'content_block_stop', index: 0 });
  frames.push(...filter.push(assistant).frames);

  assert.deepEqual(frames.filter((f) => f.t === 'delta').map((f) => (f as { text: string }).text), ['Mer', 'haba']);
  const evs = events(frames);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { kind: 'text', id: 'msg_1-0', ts: (evs[0] as { ts: number }).ts, text: '', done: false });
  assert.equal((evs[1] as { text: string; done: boolean }).text, 'Merhaba');
  assert.equal((evs[1] as { text: string; done: boolean }).done, true);
});

test('delta görülmeyen assistant metni bir kez eklenir', () => {
  const filter = new AgentFilter();
  const assistant = { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_2', content: [{ type: 'text', text: 'Tek' }] } };
  const first = events(filter.push(assistant).frames);
  assert.equal(first.length, 1);
  assert.equal((first[0] as { done: boolean }).done, true);
  assert.deepEqual(filter.push(assistant).frames, []);
});

test('araç akış başlangıcı ve assistant aynı olayı günceller', () => {
  const filter = new AgentFilter();
  filter.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm' } } });
  const start = filter.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } });
  const full = filter.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }] } });
  const a = events(start.frames)[0] as ToolEvent;
  const b = events(full.frames)[0] as ToolEvent;
  assert.equal(a.id, b.id);
  assert.equal(a.path, undefined);
  assert.equal(b.path, '/a');
  assert.equal(b.ts, a.ts);
});

test('result: sonuç, durdurma, hata ve oturum kimliği', () => {
  const end = (msg: Record<string, unknown>, interrupt = false) => {
    const filter = new AgentFilter();
    if (interrupt) filter.markInterrupted();
    const r = filter.push({ type: 'result', parent_tool_use_id: null, session_id: UUID, ...msg });
    return { r, ev: events(r.frames).at(-1) as Extract<ChatEvent, { kind: 'turn_end' }> };
  };
  const ok = end({ subtype: 'success', is_error: false, result: 'ICERIK', terminal_reason: 'completed' });
  assert.equal(ok.ev.outcome, 'ok');
  assert.equal(ok.r.turnEnded, true);
  assert.equal(ok.r.sessionId, UUID);
  assert.equal(JSON.stringify(ok.r.frames).includes('ICERIK'), false);

  assert.equal(end({ is_error: false, terminal_reason: 'aborted_streaming' }).ev.outcome, 'stopped');
  assert.equal(end({ is_error: true, subtype: 'error_during_execution' }, true).ev.outcome, 'stopped');

  const failed = end({ is_error: true, subtype: 'error_during_execution', result: 'ICERIK' });
  assert.equal(failed.ev.outcome, 'error');
  assert.ok((failed.ev.message ?? '').length <= 300);
  assert.equal(JSON.stringify(failed.r.frames).includes('ICERIK'), false);

  assert.equal(end({ session_id: 'gecersiz', is_error: false }).r.sessionId, undefined);
});

test('init oturum kimliğini verir; diğer system alt türleri yok sayılır', () => {
  const filter = new AgentFilter();
  assert.equal(filter.push({ type: 'system', subtype: 'init', session_id: UUID }).sessionId, UUID);
  const other = filter.push({ type: 'system', subtype: 'status', session_id: UUID, text: 'ICERIK' });
  assert.equal(other.sessionId, undefined);
  assert.deepEqual(other.frames, []);
});

test('authentication_failed: metin basılmaz, sinyal verilir', () => {
  const filter = new AgentFilter();
  const a = filter.push({
    type: 'assistant',
    parent_tool_use_id: null,
    error: 'authentication_failed',
    message: { id: 'm', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
  });
  assert.equal(a.authRequired, true);
  assert.deepEqual(a.frames, []);
  const r = filter.push({ type: 'result', parent_tool_use_id: null, is_error: true, result: 'Not logged in · Please run /login', session_id: UUID });
  assert.equal(r.authRequired, true);
  assert.equal(JSON.stringify(r.frames).includes('logged'), false);
  assert.equal((events(r.frames)[0] as { message?: string }).message, undefined);
});

test('sonuç metni Not logged in: authRequired', () => {
  const r = new AgentFilter().push({ type: 'result', parent_tool_use_id: null, is_error: true, result: 'Not logged in' });
  assert.equal(r.authRequired, true);
});

test('initialize yanıtı: giriş durumu', () => {
  const resp = (account: unknown) => new AgentFilter().push({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { account } } });
  assert.equal(resp({ tokenSource: 'none' }).authRequired, true);
  assert.equal(resp({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' }).authRequired, false);
  assert.equal(resp({ tokenSource: 'claude.ai' }).authRequired, false);
  assert.equal(new AgentFilter().push({ type: 'control_response', response: { subtype: 'success', request_id: 'r' } }).authRequired, undefined);
});

test('izin isteği: özgün girdi sunucuda kalır, çerçeve süzülür', () => {
  const filter = new AgentFilter();
  const r = filter.push({
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'ls', description: 'listele', dangerouslyDisableSandbox: 'ICERIK' },
      description: 'ICERIK',
      permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      tool_use_id: 'toolu_1',
    },
  });
  const ev = events(r.frames)[0];
  assert.equal(JSON.stringify(r.frames).includes('ICERIK'), false);
  assert.equal(ev.kind, 'permission');
  assert.equal((ev as { canAlways: boolean }).canAlways, false);
  assert.equal((ev as { command?: string }).command, 'ls');
  assert.equal(r.pending[0].id, 'req-1');
  assert.equal(r.pending[0].input.dangerouslyDisableSandbox, 'ICERIK');
});

test('izin isteği: kabul edilen öneri varsa canAlways', () => {
  const r = new AgentFilter().push({
    type: 'control_request',
    request_id: 'req-1',
    request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/a' }, permission_suggestions: [{ type: 'addDirectories', directories: ['/a'], destination: 'projectSettings' }] },
  });
  assert.equal((events(r.frames)[0] as { canAlways: boolean }).canAlways, true);
});

test('AskUserQuestion: soru olayı yalnızca izinli alanları taşır', () => {
  const r = new AgentFilter().push({
    type: 'control_request',
    request_id: 'req-2',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        metadata: 'ICERIK',
        questions: [{ question: 'q'.repeat(900), header: 'Başlık', multiSelect: true, extra: 'ICERIK', options: [{ label: 'Evet', description: 'açıklama', preview: 'ICERIK' }] }],
      },
    },
  });
  assert.equal(JSON.stringify(r.frames).includes('ICERIK'), false);
  const ev = events(r.frames)[0];
  assert.equal(ev.kind, 'question');
  if (ev.kind !== 'question') return;
  assert.equal(ev.questions[0].question.length, 500);
  assert.deepEqual(ev.questions[0].options, [{ label: 'Evet', description: 'açıklama' }]);
  assert.equal(r.pending[0].kind, 'question');
});

test('buildAllow: bypassPermissions alınmaz, destination hep session', () => {
  const input = { command: 'ls' };
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*', x: 1 }], behavior: 'allow', destination: 'userSettings' },
    { type: 'addDirectories', directories: ['/a', 3], destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'setMode', mode: 'plan', destination: 'session' },
    { type: 'removeRules', rules: [], behavior: 'deny', destination: 'session' },
  ];
  const r = buildAllow(input, suggestions, true);
  assert.equal(JSON.stringify(r).includes('bypassPermissions'), false);
  assert.equal(r.updatedInput, input);
  assert.deepEqual(r.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' },
    { type: 'addDirectories', directories: ['/a'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  for (const p of r.updatedPermissions ?? []) assert.equal(p.destination, 'session');

  assert.equal(buildAllow(input, suggestions, false).updatedPermissions, undefined);
  assert.equal(buildAllow(input, [{ type: 'setMode', mode: 'bypassPermissions' }], true).updatedPermissions, undefined);
});

test('buildDeny ve buildAnswer', () => {
  const deny = buildDeny();
  assert.equal(deny.behavior, 'deny');
  assert.ok(deny.message.length > 0);

  const long = 'L'.repeat(600);
  const input = {
    keep: 1,
    questions: [
      { question: 'Hangisi?', options: [{ label: 'A' }, { label: 'B' }] },
      { question: long, multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
    ],
  };
  const r = buildAnswer(input, { 'Hangisi?': 'A', ['L'.repeat(500)]: 'x, y', 'Olmayan soru': 'z', 'Hepsi': 5 });
  assert.equal(r.behavior, 'allow');
  assert.equal(r.updatedInput.keep, 1);
  assert.deepEqual(r.updatedInput.answers, { 'Hangisi?': 'A', [long]: 'x, y' });
});

test('castLine: dosya içeriği yok, satır sonu CRLF', () => {
  const evs = runTool('Write', { file_path: '/a.txt', content: 'ICERIK\nICERIK' }, { content: 'ICERIK', is_error: false });
  const last = evs[evs.length - 1];
  const line = castLine(last);
  assert.equal(line, '[araç] Write /a.txt\r\n');

  const perm = new AgentFilter().push({
    type: 'control_request',
    request_id: 'r',
    request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/a.txt', content: 'ICERIK' } },
  });
  const permEv = events(perm.frames)[0];
  assert.equal(JSON.stringify(permEv).includes('ICERIK'), true);
  assert.equal(castLine(permEv).includes('ICERIK'), false);
  assert.ok(castLine(permEv).startsWith('[izin] Write /a.txt'));

  assert.equal(castLine({ kind: 'user', id: 'u', ts: 1, text: 'selam\nikinci' }), '[kullanıcı] selam\r\nikinci\r\n');
  assert.equal(castLine({ kind: 'text', id: 't', ts: 1, text: 'cevap', done: true }), '[ajan] cevap\r\n');
  assert.equal(castLine({ kind: 'thinking', id: 'd', ts: 1, seconds: 2 }), '');
});

test('flush: açık blok biter, çalışan araç failed olur', () => {
  const filter = new AgentFilter();
  filter.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm' } } });
  filter.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  filter.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'yarım' } } });
  filter.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'x' } }] } });
  const evs = events(filter.flush().frames);
  assert.equal((evs.find((e) => e.kind === 'text') as { text: string; done: boolean }).done, true);
  assert.equal((evs.find((e) => e.kind === 'tool') as ToolEvent).status, 'failed');
  assert.deepEqual(filter.flush().frames, []);
});

test('LineSplitter: parçalı satır, çok baytlı karakter, sınırı aşan satır', () => {
  const s = new LineSplitter(10);
  assert.deepEqual(s.push(Buffer.from('ab')), []);
  assert.deepEqual(s.push(Buffer.from('c\nde\n')), ['abc', 'de']);
  const ş = Buffer.from('ş\n');
  assert.deepEqual(s.push(ş.subarray(0, 1)), []);
  assert.deepEqual(s.push(ş.subarray(1)), ['ş']);
  assert.deepEqual(s.push(Buffer.from('x'.repeat(20))), []);
  assert.deepEqual(s.push(Buffer.from('y'.repeat(5))), []);
  assert.deepEqual(s.push(Buffer.from('z\nson\n')), ['son']);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function attachment(name: string, mime: string, content: Buffer | string): { name: string; mime: string; data: string } {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return { name, mime, data: buf.toString('base64') };
}

test('model listesi: yalnızca izinli alanlar geçer', () => {
  const r = new AgentFilter().push({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'init',
      response: {
        account: { tokenSource: 'claude.ai' },
        models: [
          { value: 'default', resolvedModel: 'ICERIK-gizli', displayName: 'Varsayılan\x1b[31m', description: 'açıklama', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'ICERIK'], extra: 'ICERIK' },
          { value: 'sonnet[1m]', resolvedModel: 'ICERIK', displayName: 'Sonnet', supportsEffort: false, supportedEffortLevels: ['low'] },
          { value: 'gecersiz deger', displayName: 'ICERIK' },
          'ICERIK',
        ],
      },
    },
  });
  assert.equal(r.authRequired, false);
  assert.equal(JSON.stringify(r.models).includes('ICERIK'), false);
  assert.deepEqual(r.models, [
    { value: 'default', label: 'Varsayılan', description: 'açıklama', efforts: ['low', 'high'] },
    { value: 'sonnet[1m]', label: 'Sonnet', efforts: [] },
  ]);
});

test('model listesi: en çok 30 model, metinler kısaltılır', () => {
  const models = Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, displayName: 'd'.repeat(500), description: 'a'.repeat(900) }));
  const r = new AgentFilter().push({ type: 'control_response', response: { subtype: 'success', response: { models } } });
  assert.equal(r.models?.length, 30);
  assert.equal(r.models?.[0].label.length, 100);
  assert.equal(r.models?.[0].description?.length, 300);
});

test('set_model ve efor satırları', () => {
  assert.deepEqual(JSON.parse(setModelLine('r1', 'opus')), { type: 'control_request', request_id: 'r1', request: { subtype: 'set_model', model: 'opus' } });
  assert.deepEqual(JSON.parse(setEffortLine('r2', 'low')), {
    type: 'control_request',
    request_id: 'r2',
    request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
  });
});

test('api_retry: iletilmez, retry sinyali verir ve ilk akışla biter', () => {
  const filter = new AgentFilter();
  const r = filter.push({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 503, error: 'ICERIK', session_id: UUID });
  assert.deepEqual(r.frames, []);
  assert.deepEqual(r.retry, { attempt: 2, max: 10 });
  assert.equal(r.sessionId, undefined);
  assert.equal(JSON.stringify(r).includes('ICERIK'), false);

  const stream = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm' } } };
  assert.equal(filter.push(stream).retry, null);
  assert.equal(filter.push(stream).retry, undefined);

  for (const end of [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [] } },
    { type: 'result', parent_tool_use_id: null, is_error: false },
  ]) {
    const f = new AgentFilter();
    f.push({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3 });
    assert.equal(f.push(end).retry, null);
  }
});

test('API hatası: ham metin hiçbir çerçevede geçmez, genel ileti seçilir', () => {
  const run = (error: unknown, status: unknown): { frames: FilterFrame[]; message?: string; outcome?: string } => {
    const filter = new AgentFilter();
    const raw = 'API Error: 500 ICERIK api.gizli-sunucu.test';
    const a = filter.push({ type: 'assistant', parent_tool_use_id: null, error, message: { id: 'm', content: [{ type: 'text', text: raw }] } });
    assert.deepEqual(a.frames, []);
    const r = filter.push({ type: 'result', parent_tool_use_id: null, is_error: true, result: raw, api_error_status: status, session_id: UUID });
    const frames = [...a.frames, ...r.frames];
    const end = events(frames).at(-1) as Extract<ChatEvent, { kind: 'turn_end' }>;
    return { frames, message: end.message, outcome: end.outcome };
  };
  for (const [error, status, message] of [
    ['rate_limit', 429, 'Kullanım sınırına ulaşıldı. Bir süre sonra yeniden deneyin.'],
    ['server_error', 500, 'Modele ulaşılamadı. Bağlantı sürüyorsa yöneticinize başvurun.'],
    ['server_error', null, 'Modele ulaşılamadı. Bağlantı sürüyorsa yöneticinize başvurun.'],
    ['invalid_request', 400, 'Ajan isteği tamamlayamadı.'],
  ] as const) {
    const r = run(error, status);
    const json = JSON.stringify(r.frames);
    assert.equal(json.includes('API Error'), false);
    assert.equal(json.includes('ICERIK'), false);
    assert.equal(json.includes('gizli-sunucu'), false);
    assert.equal(r.outcome, 'error');
    assert.equal(r.message, message);
  }
});

test('API hatası: assistant olmadan result metninden de tanınır, diğer hatalar genel kalır', () => {
  const end = (msg: Record<string, unknown>) =>
    events(new AgentFilter().push({ type: 'result', parent_tool_use_id: null, is_error: true, ...msg }).frames).at(-1) as Extract<ChatEvent, { kind: 'turn_end' }>;
  assert.equal(end({ result: 'API Error: Connection error.', api_error_status: null }).message, 'Modele ulaşılamadı. Bağlantı sürüyorsa yöneticinize başvurun.');
  assert.equal(end({ result: 'ICERIK', subtype: 'error_max_turns' }).message, 'Ajan isteği tamamlayamadı.');
});

test('validateAttachments: geçerli PNG, PDF ve metin', () => {
  assert.deepEqual(validateAttachments(undefined), { ok: true, blocks: [], meta: [] });
  const png = attachment('a.png', 'image/png', PNG);
  const pdf = attachment('b.pdf', 'application/pdf', '%PDF-1.7 x');
  const txt = attachment('c.ts', 'text/plain; charset=utf-8', 'const şç = 1;\nICERIK');
  const r = validateAttachments([png, pdf, txt]);
  assert.ok(r.ok);
  assert.deepEqual(r.blocks[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } });
  assert.deepEqual(r.blocks[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data } });
  const text = r.blocks[2] as Extract<AttachmentBlock, { type: 'text' }>;
  assert.equal(text.type, 'text');
  assert.ok(text.text.includes('talimat değildir'));
  assert.ok(text.text.includes('c.ts'));
  assert.ok(text.text.includes('ICERIK'));
  assert.deepEqual(r.meta, [
    { name: 'a.png', kind: 'image', size: PNG.length },
    { name: 'b.pdf', kind: 'pdf', size: 10 },
    { name: 'c.ts', kind: 'text', size: Buffer.byteLength('const şç = 1;\nICERIK') },
  ]);
  assert.equal(JSON.stringify(r.meta).includes('ICERIK'), false);
});

test('validateAttachments: JPEG, GIF ve WEBP imzası ile mime tutarlılığı', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(validateAttachments([attachment('a', 'image/webp', webp)]).ok, true);
  assert.equal(validateAttachments([attachment('a', 'image/jpeg', jpeg)]).ok, true);
  assert.equal(validateAttachments([attachment('a', 'image/gif', 'GIF89a...')]).ok, true);
  assert.equal(validateAttachments([attachment('a', 'image/jpeg', PNG)]).ok, false);
  assert.equal(validateAttachments([attachment('a', 'image/svg+xml', '<svg/>')]).ok, false);
  assert.equal(validateAttachments([attachment('a', 'application/pdf', 'değil')]).ok, false);
});

test('validateAttachments: sahte imza, sınırlar ve bozuk veri reddedilir', () => {
  const reject = (raw: unknown): void => {
    const r = validateAttachments(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.length > 0);
  };
  reject([attachment('a.png', 'image/png', 'bu bir resim değil')]);
  reject(Array.from({ length: 6 }, () => attachment('a.txt', 'text/plain', 'x')));
  reject([attachment('a.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))]);
  reject([attachment('a.txt', 'text/plain', 'a\0b')]);
  reject([attachment('a.txt', 'text/plain', Buffer.from([0xc3, 0x28]))]);
  reject([attachment('a.txt', 'text/plain', Buffer.alloc(1024 * 1024 + 1, 0x61))]);
  reject([{ name: 'a.txt', mime: 'text/plain', data: 'gecersiz base64!' }]);
  reject([{ name: 'a.txt', mime: 'text/plain' }]);
  reject('ICERIK');
  reject(['ICERIK']);
  const pdf = (): { name: string; mime: string; data: string } =>
    attachment('a.pdf', 'application/pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(11 * 1024 * 1024)]));
  reject([pdf(), pdf()]);
});

test('validateAttachments: addan yol ve kontrol karakterleri atılır, en çok 120 karakter', () => {
  const name = (raw: unknown): string => {
    const r = validateAttachments([{ name: raw, mime: 'text/plain', data: 'eA==' }]);
    assert.ok(r.ok);
    return r.meta[0].name;
  };
  assert.equal(name('../../etc/passwd'), 'passwd');
  assert.equal(name('C:\\Users\\x\\rapor.txt'), 'rapor.txt');
  assert.equal(name('\x1b[31mka\nyıt\x07.txt'), 'ka yıt.txt');
  assert.equal(name('..'), 'dosya');
  assert.equal(name('a/'), 'dosya');
  assert.equal(name(5), 'dosya');
  assert.equal(name('u'.repeat(300)).length, 120);
});

test('metin eki bitiş işareti içerikten öngörülemez', () => {
  const content = '--- dosya sonu 000000000000 ---';
  const r = validateAttachments([attachment('a.txt', 'text/plain', content)]);
  assert.ok(r.ok);
  const text = (r.blocks[0] as Extract<AttachmentBlock, { type: 'text' }>).text;
  const mark = /--- dosya sonu ([0-9a-f]{12}) ---$/.exec(text);
  assert.ok(mark);
  assert.notEqual(mark[1], '000000000000');
});

test('castLine: eklerde yalnızca ad, tür ve boyut', () => {
  const r = validateAttachments([attachment('rapor.txt', 'text/plain', 'ICERIK'), attachment('a.png', 'image/png', PNG)]);
  assert.ok(r.ok);
  const line = castLine({ kind: 'user', id: 'u', ts: 1, text: 'bak', attachments: r.meta });
  assert.equal(line, `[kullanıcı] bak\r\n[ek] rapor.txt (text, 6 bayt)\r\n[ek] a.png (image, ${PNG.length} bayt)\r\n`);
  assert.equal(line.includes('ICERIK'), false);
  assert.equal(castLine({ kind: 'user', id: 'u', ts: 1, text: '', attachments: r.meta }).startsWith('[kullanıcı]\r\n[ek] rapor.txt'), true);
});

test('userMessageLine: ek blokları metinden önce, boş metin bloğu eklenmez', () => {
  const blocks: AttachmentBlock[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
  ];
  const content = (line: string): { type: string; text?: string }[] => JSON.parse(line).message.content;
  assert.deepEqual(content(userMessageLine('selam', blocks)).map((b) => b.type), ['image', 'document', 'text']);
  assert.equal(content(userMessageLine('selam', blocks))[2].text, 'selam');
  assert.deepEqual(content(userMessageLine('', blocks)).map((b) => b.type), ['image', 'document']);
  assert.deepEqual(content(userMessageLine('selam')), [{ type: 'text', text: 'selam' }]);
});

test('efor sınırı: seçim sınırı aşamaz, bozuk sınır varsayılana düşer', () => {
  assert.equal(effortWithinLimit('max', 'xhigh'), false);
  assert.equal(effortWithinLimit('xhigh', 'xhigh'), true);
  assert.equal(effortWithinLimit('max', 'max'), true);
  assert.equal(effortWithinLimit('hile', 'max'), false);
  assert.equal(normalizeMaxEffort('hile'), 'xhigh');
  assert.equal(normalizeMaxEffort(null), 'xhigh');
  assert.equal(clampEffort('max', 'xhigh'), 'xhigh');
  assert.equal(clampEffort('high', 'low'), 'low');
  assert.equal(clampEffort('low', 'high'), 'low');
  assert.equal(clampEffort(null, 'xhigh'), null);
  assert.equal(clampEffort(null, 'max'), null);
  assert.equal(clampEffort(null, 'medium'), 'medium');
});

test('efor komutu sohbetten kabul edilmez', () => {
  for (const t of ['/effort max', '  /EFFORT max', '/effort']) assert.equal(isEffortCommand(t), true, t);
  for (const t of ['/effortless', 'efor nedir', '/model sonnet', 'lütfen /effort yazma']) assert.equal(isEffortCommand(t), false, t);
});

test('isChatEvent: sunucunun yazdığı olaylar kabul edilir', () => {
  const ok: unknown[] = [
    { kind: 'user', id: 'u1', ts: 1, text: 'merhaba', attachments: [{ name: 'a.png', kind: 'image', size: 3 }] },
    { kind: 'text', id: 't1', ts: 1, text: 'yanıt', done: true },
    { kind: 'text', id: 't2', ts: 1, text: 'yarım', done: false },
    { kind: 'thinking', id: 'th1', ts: 1, seconds: null },
    { kind: 'tool', id: 'to1', ts: 1, tool: 'read', name: 'Read', status: 'completed' },
    { kind: 'permission', id: 'p1', ts: 1, tool: 'exec', name: 'Bash', canAlways: false, status: 'pending' },
    { kind: 'question', id: 'q1', ts: 1, questions: [], status: 'answered' },
    { kind: 'turn_end', id: 'e1', ts: 1, outcome: 'ok' },
    { kind: 'notice', id: 'n1', ts: 1, level: 'warn', text: 'uyarı' },
  ];
  for (const v of ok) assert.equal(isChatEvent(v), true, JSON.stringify(v));
});

test('isChatEvent: türüne uymayan satır reddedilir', () => {
  const bad: unknown[] = [
    null,
    [],
    'metin',
    { kind: 'user', id: 'u1', text: 'zaman yok' },
    { kind: 'user', id: 1, ts: 1, text: 'sayı kimlik' },
    { kind: 'user', id: 'u1', ts: 1, text: 5 },
    { kind: 'text', id: 't1', ts: 1, text: 'x', done: 'evet' },
    { kind: 'notice', id: 'n1', ts: 1, level: 'info' },
    { kind: 'tool', id: 'to1', ts: 1, status: 'bilinmiyor' },
    { kind: 'permission', id: 'p1', ts: 1 },
    { kind: 'question', id: 'q1', ts: 1, status: 'pending', questions: 'yok' },
    { kind: 'meta', id: 'm1', ts: 1 },
    { kind: 'başka', id: 'x1', ts: 1 },
  ];
  for (const v of bad) assert.equal(isChatEvent(v), false, JSON.stringify(v));
});
