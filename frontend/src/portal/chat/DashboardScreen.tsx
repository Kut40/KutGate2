import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Camera, Eye, GitBranch, Ellipsis, KeyRound, Lock, LogOut, MessageSquare, NotebookPen, SquarePen, Terminal as TerminalIcon } from 'lucide-react';
import { useLock } from '../../core/lock/context';
import { PinSetupScreen } from '../../core/lock/PinSetupScreen';
import { minuteLabel, type LockInfo } from '../../core/lock/types';
import { ConfirmDialog, Modal, useToast } from '../../core/ui';
import { errMsg, getStatus, papi, PortalError } from '../api';
import { AdminNotesModal, DevlogModal } from '../Notes';
import { blockCopy, DEFAULT_MAX_MINUTES, fmt, KB_THRESHOLD } from '../panel';
import { TerminalScreen } from '../Terminal';
import '../portal.css';
import '../chat.css';
import { BrandMark } from './BrandMark';
import { ChatList } from './ChatList';
import { ChatPanel } from './ChatPanel';
import { SelectMenu } from './SelectMenu';
import { ProjectTree } from './ProjectTree';
import type { ChatInfo, Project } from './protocol';
import { useAgent } from './useAgent';
import { PhotoPanel } from './PhotoPanel';
import { SendPanel } from './SendPanel';
import { PreviewPanel } from './PreviewPanel';

export function DashboardScreen({
  username,
  maxMinutes,
  unreadAdminNotes,
  lock,
  onLockChanged,
  onLogout,
  onUnauthorized,
}: {
  username: string;
  maxMinutes?: number;
  unreadAdminNotes: number;
  lock?: LockInfo;
  onLockChanged: () => void;
  onLogout: () => void;
  onUnauthorized: () => void;
}) {
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;
  const agentApi = useAgent(onUnauthorized);
  const lockApi = useLock();
  const toast = useToast();
  const [pinOpen, setPinOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [display, setDisplay] = useState<string | null>(null);

  useEffect(() => {
    papi<{ avatar: string | null; display: string | null }>('GET', '/me/profile')
      .then((r) => {
        setAvatar(r.avatar);
        setDisplay(r.display);
      })
      .catch(() => undefined);
  }, []);
  const { events, agent, conn, closeNote } = agentApi;

  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [termMounted, setTermMounted] = useState(false);
  const [unread, setUnread] = useState(unreadAdminNotes);
  const [devlogOpen, setDevlogOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [pending, setPending] = useState<{ kind: 'new' } | { kind: 'open'; id: string } | null>(null);
  const [delChat, setDelChat] = useState<ChatInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projError, setProjError] = useState('');
  const [remaining, setRemaining] = useState(0);
  const appRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const firstOpenRef = useRef(0);
  const insertRef = useRef<((text: string) => void) | null>(null);

  const totalSec = (maxMinutes ?? DEFAULT_MAX_MINUTES) * 60;
  const startedMs = agent.started ? Date.parse(agent.started) : NaN;
  const baseMs = Number.isFinite(startedMs) ? startedMs : firstOpenRef.current;
  const endAt = baseMs > 0 ? baseMs + totalSec * 1000 : 0;

  useEffect(() => {
    if (conn === 'open' && firstOpenRef.current === 0) firstOpenRef.current = Date.now();
  }, [conn]);

  useEffect(() => {
    if (conn !== 'open' || !endAt) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [conn, endAt]);

  useEffect(() => {
    setUnread(unreadAdminNotes);
  }, [unreadAdminNotes]);

  useEffect(() => {
    const t = window.setInterval(() => {
      getStatus()
        .then((s) => {
          if (!s.loggedIn) unauthRef.current();
          else setUnread(s.unreadAdminNotes ?? 0);
        })
        .catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(t);
  }, []);

  const loadProjects = useCallback(() => {
    setProjError('');
    papi<Project[]>('GET', '/projects')
      .then((rows) => setProjects(Array.isArray(rows) ? rows : []))
      .catch((err: unknown) => {
        if (err instanceof PortalError && err.status === 401) unauthRef.current();
        setProjError(errMsg(err));
      });
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (sideRef.current && !sideRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        moreRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    const syncViewport = () => {
      const vv = window.visualViewport;
      const app = appRef.current;
      if (vv && app) {
        app.style.setProperty('--portal-vh', `${vv.height}px`);
        app.style.setProperty('--portal-top', `${vv.offsetTop}px`);
        app.dataset.kbOpen = String(window.innerHeight - vv.height > KB_THRESHOLD);
      }
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    const vvp = window.visualViewport;
    if (vvp) {
      vvp.addEventListener('resize', syncViewport);
      vvp.addEventListener('scroll', syncViewport);
    }
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      if (vvp) {
        vvp.removeEventListener('resize', syncViewport);
        vvp.removeEventListener('scroll', syncViewport);
      }
    };
  }, []);

  const insertPath = useCallback((path: string) => {
    insertRef.current?.(path);
    setMenuOpen(false);
  }, []);

  const openTerminal = useCallback(() => {
    setMenuOpen(false);
    setTermMounted(true);
    setView('terminal');
  }, []);

  const backToChat = useCallback(() => {
    setView('chat');
  }, []);

  useEffect(() => {
    if (view !== 'terminal') return;
    // Terminal görünür olunca boyutunu yeniden ölçsün.
    const t = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => window.clearTimeout(t);
  }, [view]);

  const logout = () => {
    agentApi.disconnect();
    onLogout();
  };

  const runPending = (a: { kind: 'new' } | { kind: 'open'; id: string }) => {
    setPending(null);
    if (a.kind === 'new') agentApi.newConversation();
    else agentApi.openChat(a.id);
  };

  const request = (a: { kind: 'new' } | { kind: 'open'; id: string }) => {
    setMenuOpen(false);
    if (a.kind === 'open' && agentApi.chats.some((c) => c.id === a.id && c.active)) return;
    if (conn !== 'open') {
      if (a.kind === 'new') agentApi.reconnect();
      return;
    }
    if (agent.busy) setPending(a);
    else runPending(a);
  };

  const lockScreen = () => {
    setMenuOpen(false);
    lockApi.lockNow();
  };

  const changeMinutes = (value: string) => {
    const minutes = Number(value);
    papi('PUT', '/lock/minutes', { minutes })
      .then(() => {
        toast.success(`Kilit süresi ${minuteLabel(minutes)} olarak ayarlandı.`);
        onLockChanged();
      })
      .catch((err: unknown) => toast.error(errMsg(err)));
  };

  const agentLabel = agent.authRequired ? 'Giriş gerekli' : !agent.alive ? 'Durdu' : agent.busy ? 'Çalışıyor' : 'Hazır';

  return (
    <>
      <div
        className="portal-app kg-dash select-none"
        ref={appRef}
        style={view === 'chat' ? undefined : { display: 'none' }}
        onCopy={blockCopy}
        onCut={blockCopy}
        onDragStart={blockCopy}
        onContextMenu={blockCopy}
      >
        <aside className="kg-side" ref={sideRef}>
          <div className="kg-id">
            <div className="kg-brandrow">
              <BrandMark className="kg-mark" />
              <div className="kg-brandtxt">
                <h1 className="kg-brand">KutGate</h1>
                <span className="kg-brandsub">Takım Çalışma Paneli</span>
              </div>
            </div>
            <span className="kg-strip-status" aria-hidden="true">
              <span className="kg-dot" data-state={conn} />
              <span className="kg-strip-time">{conn === 'open' && endAt ? fmt(remaining) : '--:--:--'}</span>
            </span>
            <button
              type="button"
              ref={moreRef}
              className="kg-more"
              aria-label={unread > 0 ? `Menü, ${unread} okunmamış yönetici notu` : 'Menü'}
              aria-expanded={menuOpen}
              aria-controls="kg-menu"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Ellipsis size={20} strokeWidth={1.75} aria-hidden="true" />
              {unread > 0 ? <span className="kg-more-dot" aria-hidden="true" /> : null}
            </button>
          </div>
          <div className="kg-menu" id="kg-menu" data-open={menuOpen}>
            <button
              type="button"
              className="kg-new"
              onClick={() => request({ kind: 'new' })}
            >
              <SquarePen size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Yeni sohbet</span>
            </button>
            <nav className="kg-nav" aria-label="Gezinme">
              <button type="button" className="kg-navitem" aria-current="page" onClick={() => setMenuOpen(false)}>
                <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="kg-navlabel">Sohbet</span>
              </button>
              <button type="button" className="kg-navitem" onClick={openTerminal}>
                <TerminalIcon size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="kg-navlabel">Terminal</span>
              </button>
              <button type="button" className="kg-navitem" onClick={lockScreen}>
                <Lock size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="kg-navlabel">Ekranı kilitle</span>
              </button>
              <button
                type="button"
                className="kg-navitem"
                onClick={() => {
                  setMenuOpen(false);
                  setDevlogOpen(true);
                }}
              >
                <BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="kg-navlabel">Geliştirme günlüğü</span>
              </button>
              <button
                type="button"
                className="kg-navitem"
                onClick={() => {
                  setMenuOpen(false);
                  setNotesOpen(true);
                }}
              >
                <NotebookPen size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="kg-navlabel">Yönetici notu</span>
                {unread > 0 ? (
                  <span className="kg-count" aria-label={`${unread} okunmamış`}>
                    {unread}
                  </span>
                ) : null}
              </button>
            </nav>
            <ChatList chats={agentApi.chats} onOpen={(id) => request({ kind: 'open', id })} onDelete={(c) => setDelChat(c)} />
            <ProjectTree
              projects={projects}
              projError={projError}
              busy={agent.busy}
              onReloadProjects={loadProjects}
              onUnauthorized={onUnauthorized}
              onInsertPath={insertPath}
            />
            <section className="kg-session" aria-label="Oturum">
              <div className="kg-session-top">
                <span className="kg-h-plain">Oturum</span>
                <span className="kg-conn" role="status">
                  <span className="kg-dot" data-state={conn} aria-hidden="true" />
                  {conn === 'open' ? 'Bağlı' : conn === 'connecting' ? 'Bağlanıyor' : conn === 'reconnecting' ? 'Yeniden bağlanıyor' : 'Bağlı değil'}
                </span>
              </div>
              <div className="kg-session-row">
                <span className="kg-session-key">Kalan süre</span>
                <span className="kg-time">{conn === 'open' && endAt ? fmt(remaining) : '--:--:--'}</span>
              </div>
              <div className="kg-bar" aria-hidden="true">
                <span style={{ width: `${conn === 'open' && endAt ? Math.min(100, Math.max(0, (remaining / totalSec) * 100)) : 0}%` }} />
              </div>
              <div className="kg-session-row">
                <span className="kg-session-key">Ajan</span>
                <span className="kg-session-val">{agentLabel}</span>
              </div>
              {lock ? (
                <div className="kg-session-row">
                  <span className="kg-session-key">Kilit süresi</span>
                  <SelectMenu
                    ariaLabel="Kilit süresi"
                    buttonLabel={minuteLabel(lock.minutes)}
                    className="kg-lock-select"
                    menuClassName="right-0 left-auto min-w-36"
                    value={String(lock.minutes)}
                    onChange={changeMinutes}
                    options={lock.options.map((m) => ({ value: String(m), label: minuteLabel(m), disabled: m > lock.maxMinutes, hint: 'Yönetici sınırı' }))}
                  />
                </div>
              ) : null}
              <div className="kg-session-acts">
                <button
                  type="button"
                  className="kg-session-act"
                  onClick={() => {
                    setMenuOpen(false);
                    setPinOpen(true);
                  }}
                >
                  <KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>PIN değiştir</span>
                </button>
                <button
                  type="button"
                  className="kg-session-act"
                  onClick={() => {
                    setMenuOpen(false);
                    setPhotoOpen(true);
                  }}
                >
                  <Camera size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Fotoğrafım</span>
                </button>
                <button
                  type="button"
                  className="kg-session-act"
                  onClick={() => {
                    setMenuOpen(false);
                    setSendOpen(true);
                  }}
                >
                  <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Kodu gönder</span>
                </button>
                <button
                  type="button"
                  className="kg-session-act"
                  onClick={() => {
                    setMenuOpen(false);
                    setPreviewOpen(true);
                  }}
                >
                  <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Önizleme</span>
                </button>
              </div>
            </section>
            <p className="kg-rec">Bu oturum kaydedilmektedir.</p>
            <div className="kg-user">
              <span className="kg-avatar" aria-hidden="true">
                {avatar ? <img className="kg-avatar-img" src={avatar} alt="" /> : (display ?? username).trim().charAt(0).toLocaleUpperCase('tr-TR') || '?'}
              </span>
              <span className="kg-who" title={display ? `${display} (${username})` : username}>
                {display ?? username}
              </span>
              <button
                type="button"
                className="kg-iconbtn"
                aria-label="Çıkış"
                title="Çıkış"
                onClick={() => {
                  setMenuOpen(false);
                  logout();
                }}
              >
                <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
        </aside>
        <main className="kg-main">
          <div className="kg-chat">
            <ChatPanel
              events={events}
              agent={agent}
              conn={conn}
              closeNote={closeNote}
              models={agentApi.models}
              onSetModel={agentApi.setModel}
              onSetEffort={agentApi.setEffort}
              onSetMode={agentApi.setMode}
              onSend={agentApi.send}
              onStop={agentApi.stop}
              onRestart={agentApi.restart}
              onReconnect={agentApi.reconnect}
              onOpenTerminal={openTerminal}
              onPermission={agentApi.respondPermission}
              onAnswer={agentApi.answer}
              insertRef={insertRef}
            />
          </div>
        </main>
        <Modal open={pinOpen} title="PIN değiştir" onClose={() => setPinOpen(false)}>
          <PinSetupScreen
            submitLabel="PIN&#8217;i değiştir"
            onCancel={() => setPinOpen(false)}
            onSubmit={async (password, pin) => {
              await papi('POST', '/pin', { password, pin });
              toast.success('PIN değiştirildi.');
              setPinOpen(false);
            }}
          />
        </Modal>
        <Modal open={photoOpen} title="Fotoğrafım" onClose={() => setPhotoOpen(false)}>
          <PhotoPanel avatar={avatar} onChange={setAvatar} />
        </Modal>
        <Modal open={sendOpen} title="Kodu gönder" onClose={() => setSendOpen(false)}>
          {sendOpen ? <SendPanel onDone={() => setSendOpen(false)} /> : null}
        </Modal>
        <Modal open={previewOpen} title="Önizleme" onClose={() => setPreviewOpen(false)}>
          {previewOpen ? <PreviewPanel /> : null}
        </Modal>
        {devlogOpen ? <DevlogModal onClose={() => setDevlogOpen(false)} /> : null}
        {notesOpen ? <AdminNotesModal onClose={() => setNotesOpen(false)} onUnread={setUnread} /> : null}
        <ConfirmDialog
          open={pending !== null}
          title="Sohbet değiştirilsin mi?"
          message="Ajan çalışıyor. Devam ederseniz çalışan iş durur, sohbet ise silinmez."
          confirmLabel="Devam et"
          danger
          onConfirm={() => {
            if (pending) runPending(pending);
          }}
          onCancel={() => setPending(null)}
        />
        <ConfirmDialog
          open={delChat !== null}
          title="Sohbet silinsin mi?"
          message="Bu sohbet listenizden kaldırılır. Yönetici kayıtlarında saklanmaya devam eder."
          confirmLabel="Sohbeti sil"
          danger
          onConfirm={() => {
            if (delChat) agentApi.deleteChat(delChat.id);
            setDelChat(null);
          }}
          onCancel={() => setDelChat(null)}
        />
      </div>
      {termMounted ? (
        <div style={{ display: view === 'terminal' ? 'block' : 'none' }}>
          <TerminalScreen
            username={username}
            maxMinutes={maxMinutes}
            unreadAdminNotes={unread}
            onLogout={logout}
            onUnauthorized={onUnauthorized}
            onBack={backToChat}
          />
        </div>
      ) : null}
    </>
  );
}
