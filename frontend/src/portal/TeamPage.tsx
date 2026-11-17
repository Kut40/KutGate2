import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { GlassWindow, type GlassWindowHandle } from './GlassWindow';
import { SynapseBackground } from './SynapseBackground';
import './vendor/team-section/team-section.css';
import { papi } from './api';
import { accountMember, type TeamMember } from './teamMembers';
import defaultAvatar from './team-photos/default-avatar.svg';

const MAX_PROJECTS = 3;

function blockEmptyHref(e: MouseEvent<HTMLAnchorElement>) {
  if (e.currentTarget.getAttribute('href') === '#') e.preventDefault();
}

/* Font Awesome Free 6.5.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0) Copyright 2024 Fonticons, Inc. */
function XTwitterIcon() {
  return (
    <svg viewBox="0 0 512 512" width="1em" aria-hidden="true" focusable="false">
      <path d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z" />
    </svg>
  );
}

/* Font Awesome Free 6.5.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0) Copyright 2024 Fonticons, Inc. */
function LinkedInIcon() {
  return (
    <svg viewBox="0 0 448 512" width="0.875em" aria-hidden="true" focusable="false">
      <path d="M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 111.28 61.9 111.28 142.3V448z" />
    </svg>
  );
}

function MemberCard({ m, featured = false, onOpen }: { m: TeamMember; featured?: boolean; onOpen: (m: TeamMember, el: HTMLElement) => void }) {
  const projectsId = useId();
  const visible = m.projects.slice(0, MAX_PROJECTS);
  const hidden = m.projects.slice(MAX_PROJECTS);

  return (
    <div className={featured ? 'card card--featured' : 'card'}>
      <img src={m.photo ?? defaultAvatar} alt="" className={m.photo ? undefined : 'is-default'} />
      {featured ? <div className="card-accent" aria-hidden="true" /> : null}
      <button
        type="button"
        className="card-hit"
        aria-label={`${m.alt}, ${m.role} — giriş yap`}
        aria-haspopup="dialog"
        onClick={(e) => onOpen(m, e.currentTarget)}
      />
      <div className="card-content">
        <h3>{m.name}</h3>
        <p>{m.role}</p>
        {m.projects.length > 0 ? (
          <div className="card-projects">
            <div className="card-projects-title" id={projectsId}>
              Projeler
            </div>
            <ul aria-labelledby={projectsId}>
              {visible.map((p) => (
                <li key={p}>{p}</li>
              ))}
              {hidden.length > 0 ? (
                <li className="is-more" title={hidden.join(', ')}>
                  <span aria-hidden="true">+{hidden.length}</span>
                  <span className="kg-sr">{hidden.join(', ')}</span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        {m.links.x || m.links.linkedin ? (
          <ul className="card-social">
            {m.links.x ? (
              <li>
                <a href={m.links.x} aria-label={`${m.alt} — X`} onClick={blockEmptyHref}>
                  <XTwitterIcon />
                </a>
              </li>
            ) : null}
            {m.links.linkedin ? (
              <li>
                <a href={m.links.linkedin} aria-label={`${m.alt} — LinkedIn`} onClick={blockEmptyHref}>
                  <LinkedInIcon />
                </a>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default function TeamPage() {
  const loginRef = useRef<GlassWindowHandle>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Takım adı kurulumda verilir (GATE_TEAM_NAME); koda kurum adı yazılmaz.
  const [teamName, setTeamName] = useState('Takım');
  const openLogin = (_m: TeamMember, el: HTMLElement) => loginRef.current?.open(el);

  useEffect(() => {
    const ctrl = new AbortController();
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    papi<{ members?: { name?: unknown; ranks?: unknown; projects?: unknown; avatar?: unknown }[] }>('GET', '/team', undefined, ctrl.signal)
      .then((r) => {
        setMembers(
          (r?.members ?? [])
            .filter((x) => typeof x.name === 'string' && x.name.trim())
            .map((x) =>
              accountMember(
                (x.name as string).trim(),
                strings(x.ranks),
                strings(x.projects),
                typeof x.avatar === 'string' && x.avatar.startsWith('/papi/avatar/') ? x.avatar : undefined,
              ),
            ),
        );
        setListState('ready');
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setListState('error');
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    papi<{ teamName?: unknown }>('GET', '/meta', undefined, ctrl.signal)
      .then((r) => {
        if (typeof r?.teamName === 'string' && r.teamName.trim()) setTeamName(r.teamName.trim());
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const prev = document.title;
    document.title = teamName;
    return () => {
      document.title = prev;
    };
  }, [teamName]);

  return (
    <div className="kg-team">
      <SynapseBackground paused={modalOpen} />
      <section>
        <div className="intro">
          <span>KutGate</span>
          <h1>{teamName}</h1>
          <p>Projelerimizi fikirden canlıya kadar birlikte geliştiren ekip.</p>
          {/* Üye kartı olmasa da (yeni kurulum) giriş her zaman açılabilmeli. */}
          <button type="button" className="kg-team-login" onClick={(e) => loginRef.current?.open(e.currentTarget)}>
            Giriş yap
          </button>
          <span className="bg-watermark" aria-hidden="true">
            takım
          </span>
          <h2 className="kg-sr" style={{ position: 'absolute' }}>
            Takım üyeleri
          </h2>
        </div>
        <div className="cards">
          {members.map((m, i) => (
            <MemberCard m={m} key={`${i}-${m.name}`} onOpen={openLogin} />
          ))}
          {listState === 'error' || (listState === 'ready' && members.length === 0) ? (
            <p role="status" style={{ gridColumn: '1 / -1' }}>
              {listState === 'error' ? 'Takım listesi yüklenemedi.' : 'Henüz takım üyesi eklenmedi.'}
            </p>
          ) : null}
        </div>
      </section>
      <GlassWindow ref={loginRef} onOpenChange={setModalOpen} />
    </div>
  );
}
