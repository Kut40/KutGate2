import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg, get, getText } from '../../core/api';
import { Badge, Button, Card, Empty, ErrorState, Field, Spinner, Table, Time } from '../../core/ui';
import { fmtBytes } from './util';

interface UserRow {
  id: number;
  username: string;
}
interface LogFile {
  file: string;
  size: number;
  mtime: string | number;
}
interface Entry {
  role: string;
  tool: string;
  text: string;
}

const PAGE = 300;
const MAX_TEXT = 400;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

function summarize(v: unknown): string {
  if (typeof v === 'string') return clip(v);
  if (Array.isArray(v)) return clip(v.map((x) => summarize(x)).filter(Boolean).join(' '));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return clip(o.text);
    if (o.content !== undefined) return summarize(o.content);
    return clip(JSON.stringify(v));
  }
  return '';
}

function parseLine(line: string): Entry {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { role: '?', tool: '', text: '(satır çözümlenemedi)' };
  }
  if (!o || typeof o !== 'object') return { role: '?', tool: '', text: clip(String(o)) };
  const rec = o as Record<string, unknown>;
  const msg = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : null;
  const role = String((msg && msg.role) ?? rec.role ?? rec.type ?? '?');
  const content = msg ? msg.content : rec.content;
  const tools: string[] = [];
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (p.type === 'tool_use' && typeof p.name === 'string') {
          tools.push(p.name);
          if (p.input !== undefined) texts.push(summarize(p.input));
        } else if (p.type === 'tool_result') {
          texts.push(summarize(p.content));
        } else {
          texts.push(summarize(p));
        }
      } else {
        texts.push(summarize(part));
      }
    }
  } else if (content !== undefined) {
    texts.push(summarize(content));
  }
  return { role, tool: tools.join(', '), text: texts.filter(Boolean).join(' ') || '(metin yok)' };
}

export function AgentLogs() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [usersError, setUsersError] = useState('');
  const [userId, setUserId] = useState('');
  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [filesError, setFilesError] = useState('');
  const [opened, setOpened] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [shown, setShown] = useState(PAGE);
  const filesReq = useRef(0);
  const fileReq = useRef(0);

  const loadUsers = useCallback(async () => {
    setUsersError('');
    try {
      setUsers(await get<UserRow[]>('/api/users'));
    } catch (e) {
      setUsersError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const loadFiles = useCallback(async (uid: string) => {
    const req = ++filesReq.current;
    fileReq.current++;
    setFilesError('');
    setFiles(null);
    setOpened('');
    setEntries(null);
    setFileLoading(false);
    if (!uid) return;
    try {
      const list = await get<LogFile[]>(`/api/agentlogs/${encodeURIComponent(uid)}`);
      if (req === filesReq.current) setFiles(list);
    } catch (e) {
      if (req === filesReq.current) setFilesError(errMsg(e));
    }
  }, []);

  const openFile = async (name: string) => {
    const req = ++fileReq.current;
    setOpened(name);
    setEntries(null);
    setFileError('');
    setFileLoading(true);
    setShown(PAGE);
    try {
      const text = await getText(`/api/agentlogs/${encodeURIComponent(userId)}/file?name=${encodeURIComponent(name)}`);
      if (req === fileReq.current) setEntries(text.split('\n').filter((l) => l.trim() !== '').map(parseLine));
    } catch (e) {
      if (req === fileReq.current) setFileError(errMsg(e));
    } finally {
      if (req === fileReq.current) setFileLoading(false);
    }
  };

  return (
    <>
      <Card title="Ajan kayıtları">
        {usersError ? (
          <ErrorState message={usersError} onRetry={() => void loadUsers()} />
        ) : users === null ? (
          <Spinner />
        ) : (
          <div className="form-row">
            <Field label="Kullanıcı">
              {(id) => (
                <select
                  id={id}
                  value={userId}
                  onChange={(e) => {
                    setUserId(e.target.value);
                    void loadFiles(e.target.value);
                  }}
                >
                  <option value="">Seçin…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
        {userId ? (
          filesError ? (
            <ErrorState message={filesError} onRetry={() => void loadFiles(userId)} />
          ) : files === null ? (
            <Spinner />
          ) : (
            <Table
              head={['Dosya', 'Boyut', 'Değişiklik', '']}
              empty={files.length === 0 ? <Empty>Kayıt dosyası yok.</Empty> : undefined}
            >
              {files.map((f) => (
                <tr key={f.file}>
                  <td className="mono clip" title={f.file}>
                    {f.file}
                  </td>
                  <td>{fmtBytes(f.size)}</td>
                  <td>
                    <Time value={f.mtime} />
                  </td>
                  <td className="actions">
                    <Button small onClick={() => void openFile(f.file)} aria-pressed={opened === f.file}>
                      Aç
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )
        ) : null}
      </Card>
      {opened ? (
        <Card title={<span className="mono">{opened}</span>}>
          {fileLoading ? (
            <Spinner />
          ) : fileError ? (
            <ErrorState message={fileError} onRetry={() => void openFile(opened)} />
          ) : entries === null ? null : entries.length === 0 ? (
            <Empty>Dosya boş.</Empty>
          ) : (
            <>
              <ol className="log-list">
                {entries.slice(0, shown).map((en, i) => (
                  <li key={i} className="log-item">
                    <div className="log-meta">
                      <Badge tone={en.role === 'assistant' ? 'info' : en.role === 'user' ? 'ok' : 'neutral'}>{en.role}</Badge>
                      {en.tool ? <Badge tone="warn">Araç: {en.tool}</Badge> : null}
                      <span className="muted">#{i + 1}</span>
                    </div>
                    <p className="log-text">{en.text}</p>
                  </li>
                ))}
              </ol>
              {shown < entries.length ? (
                <div className="form-actions">
                  <Button small onClick={() => setShown((n) => n + PAGE)}>
                    Daha fazla göster ({entries.length - shown} satır kaldı)
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      ) : null}
    </>
  );
}
