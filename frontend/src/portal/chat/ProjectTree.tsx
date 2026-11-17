import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, CornerDownLeft, File as FileIcon, FileSymlink, Folder, FolderOpen, RotateCw } from 'lucide-react';
import { papi, PortalError } from '../api';
import { fmtSize } from './attachments';
import type { Project } from './protocol';

type Entry = { name: string; type: 'dir' | 'file' | 'link'; size?: number };
type TreeResp = { entries?: Entry[]; truncated?: boolean };
type NodeData = { status: 'loading' | 'ok' | 'error'; entries: Entry[]; truncated: boolean };

const STORE_KEY = 'kg_tree_open';
const ROOT = '/srv/projects';

const keyOf = (proj: string, rel: string) => `${proj}/${rel}`;
const projOf = (key: string) => key.slice(0, key.indexOf('/'));
const relOf = (key: string) => key.slice(key.indexOf('/') + 1);
const childRel = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);
const parentKey = (key: string) => {
  const rel = relOf(key);
  if (!rel) return '';
  const i = rel.lastIndexOf('/');
  return keyOf(projOf(key), i < 0 ? '' : rel.slice(0, i));
};
const fullPath = (key: string) => {
  const rel = relOf(key);
  return rel ? `${ROOT}/${projOf(key)}/${rel}` : `${ROOT}/${projOf(key)}`;
};

function readOpen(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeOpen(s: Set<string>) {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(s)));
  } catch {
    /* depolama yok */
  }
}

type RowProps = {
  nodeKey: string;
  pKey: string;
  name: string;
  kind: 'proj' | 'dir' | 'file' | 'link';
  level: number;
  open: boolean;
  focusable: boolean;
  size?: number;
  perm?: 'r' | 'rw';
  onActivate: (key: string, kind: RowProps['kind']) => void;
  onInsert: (key: string) => void;
  onFocusKey: (key: string) => void;
  onKeyNav: (e: KeyboardEvent<HTMLDivElement>) => void;
};

const Row = memo(function Row(p: RowProps) {
  const isDir = p.kind === 'proj' || p.kind === 'dir';
  const title =
    p.kind === 'file'
      ? `${p.name}${p.size !== undefined ? ` (${fmtSize(p.size)})` : ''}. Tıkla: yolu mesaja ekle`
      : p.kind === 'link'
        ? `${p.name} (sembolik bağ)`
        : `${p.name}. Tıkla: aç/kapat`;
  const Icon = p.kind === 'file' ? FileIcon : p.kind === 'link' ? FileSymlink : p.open ? FolderOpen : Folder;
  return (
    <div
      className="kg-tr-row"
      role="treeitem"
      aria-level={p.level}
      aria-expanded={isDir ? p.open : undefined}
      tabIndex={p.focusable ? 0 : -1}
      title={title}
      data-key={p.nodeKey}
      data-pkey={p.pKey}
      data-kind={p.kind}
      onClick={() => p.onActivate(p.nodeKey, p.kind)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) p.onFocusKey(p.nodeKey);
      }}
      onKeyDown={p.onKeyNav}
    >
      {isDir ? (
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="kg-tr-chev" data-open={p.open} />
      ) : (
        <span className="kg-tr-chev" aria-hidden="true" />
      )}
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="kg-proj-ico" />
      <span className="kg-proj-name">{p.name}</span>
      {p.perm ? <span className="kg-proj-perm">{p.perm === 'rw' ? 'Oku/Yaz' : 'Oku'}</span> : null}
      {isDir ? (
        <button
          type="button"
          tabIndex={-1}
          className="kg-tr-ins"
          aria-label="Klasör yolunu mesaja ekle"
          title="Klasör yolunu mesaja ekle"
          onClick={(e) => {
            e.stopPropagation();
            p.onInsert(p.nodeKey);
          }}
        >
          <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});

export function ProjectTree({
  projects,
  projError,
  busy,
  onReloadProjects,
  onUnauthorized,
  onInsertPath,
}: {
  projects: Project[] | null;
  projError: string;
  busy: boolean;
  onReloadProjects: () => void;
  onUnauthorized: () => void;
  onInsertPath: (path: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [nodes, setNodes] = useState<Record<string, NodeData>>({});
  const [focusKey, setFocusKey] = useState('');
  const inflight = useRef(new Set<string>());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;
  const treeRef = useRef<HTMLUListElement>(null);

  const setOpenAndStore = useCallback((fn: (prev: Set<string>) => Set<string>) => {
    setOpen((prev) => {
      const next = fn(prev);
      if (next !== prev) writeOpen(next);
      return next;
    });
  }, []);

  const load = useCallback(
    (key: string, silent: boolean) => {
      if (inflight.current.has(key)) return;
      inflight.current.add(key);
      const had = nodesRef.current[key]?.status === 'ok';
      if (!silent || !had) {
        setNodes((prev) => ({ ...prev, [key]: { status: 'loading', entries: prev[key]?.entries ?? [], truncated: false } }));
      }
      papi<TreeResp>('GET', `/projects/${encodeURIComponent(projOf(key))}/tree?path=${encodeURIComponent(relOf(key))}`)
        .then((r) => {
          const entries = Array.isArray(r?.entries) ? r.entries : [];
          setNodes((prev) => ({ ...prev, [key]: { status: 'ok', entries, truncated: r?.truncated === true } }));
        })
        .catch((err: unknown) => {
          if (err instanceof PortalError && err.status === 401) {
            unauthRef.current();
            return;
          }
          if (silent && had) {
            if (err instanceof PortalError && err.status === 404 && relOf(key) !== '') {
              setOpenAndStore((prev) => {
                if (!prev.has(key)) return prev;
                const n = new Set(prev);
                n.delete(key);
                return n;
              });
            }
            return;
          }
          setNodes((prev) => ({ ...prev, [key]: { status: 'error', entries: prev[key]?.entries ?? [], truncated: false } }));
        })
        .finally(() => {
          inflight.current.delete(key);
        });
    },
    [setOpenAndStore],
  );

  // Açık düğümleri ilk açılışta yükle.
  useEffect(() => {
    if (!projects) return;
    const names = new Set(projects.map((p) => p.name));
    open.forEach((key) => {
      if (!names.has(projOf(key))) return;
      if (!nodes[key]) load(key, false);
    });
  }, [open, nodes, projects, load]);

  // Var olmayan projelerin ve kaybolan klasörlerin açık durumunu temizle.
  useEffect(() => {
    if (!projects) return;
    const names = new Set(projects.map((p) => p.name));
    const dead = new Set<string>();
    const keys = Array.from(open).sort((a, b) => relOf(a).split('/').length - relOf(b).split('/').length);
    for (const key of keys) {
      if (!names.has(projOf(key))) {
        dead.add(key);
        continue;
      }
      const rel = relOf(key);
      if (!rel) continue;
      const pk = parentKey(key);
      if (dead.has(pk)) {
        dead.add(key);
        continue;
      }
      const pn = nodes[pk];
      if (pn && pn.status === 'ok') {
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        if (!pn.entries.some((e) => e.type === 'dir' && e.name === name)) dead.add(key);
      }
    }
    if (dead.size === 0) return;
    setOpenAndStore((prev) => {
      const n = new Set(prev);
      dead.forEach((k) => n.delete(k));
      return n;
    });
    setNodes((prev) => {
      const n = { ...prev };
      dead.forEach((k) => delete n[k]);
      return n;
    });
  }, [open, nodes, projects, setOpenAndStore]);

  const refreshOpen = useCallback(() => {
    open.forEach((key) => {
      if (nodesRef.current[key]) load(key, true);
    });
  }, [open, load]);

  const openRef = useRef(refreshOpen);
  openRef.current = refreshOpen;
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) openRef.current();
    prevBusy.current = busy;
  }, [busy]);

  const manualRefresh = () => {
    onReloadProjects();
    refreshOpen();
  };

  const activate = useCallback(
    (key: string, kind: RowProps['kind']) => {
      if (kind === 'link') return;
      if (kind === 'file') {
        onInsertPath(fullPath(key));
        return;
      }
      setOpenAndStore((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
    },
    [onInsertPath, setOpenAndStore],
  );

  const insert = useCallback((key: string) => onInsertPath(fullPath(key)), [onInsertPath]);

  const items = () => Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
  const focusEl = (el: HTMLElement | undefined) => {
    if (!el) return;
    setFocusKey(el.dataset.key ?? '');
    el.focus();
  };

  const onKeyNav = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      const el = e.currentTarget;
      const key = el.dataset.key ?? '';
      const kind = el.dataset.kind as RowProps['kind'];
      const isDir = kind === 'proj' || kind === 'dir';
      const isOpen = open.has(key);
      const list = items();
      const i = list.indexOf(el);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusEl(list[i + 1]);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusEl(list[i - 1]);
          break;
        case 'Home':
          e.preventDefault();
          focusEl(list[0]);
          break;
        case 'End':
          e.preventDefault();
          focusEl(list[list.length - 1]);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (isDir && !isOpen) activate(key, kind);
          else if (isDir && list[i + 1]?.dataset.pkey === key) focusEl(list[i + 1]);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (isDir && isOpen) activate(key, kind);
          else if (el.dataset.pkey) focusEl(list.find((x) => x.dataset.key === el.dataset.pkey));
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (e.key === 'Enter' && e.shiftKey && isDir) insert(key);
          else activate(key, kind);
          break;
        default:
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, activate, insert],
  );

  const firstKey = projects && projects.length > 0 ? keyOf(projects[0].name, '') : '';

  const isShown = (key: string): boolean => {
    if (!projects?.some((p) => p.name === projOf(key))) return false;
    let k = key;
    let first = true;
    while (relOf(k) !== '') {
      const pk = parentKey(k);
      const rel = relOf(k);
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (!open.has(pk) || !nodes[pk]?.entries.some((e) => e.name === name && (first || e.type === 'dir'))) return false;
      k = pk;
      first = false;
    }
    return true;
  };
  const tabKey = focusKey && isShown(focusKey) ? focusKey : firstKey;

  const rows = (key: string, level: number): ReactNode => {
    const n = nodes[key];
    if (!n || (n.status === 'loading' && n.entries.length === 0)) {
      return (
        <li role="none" key="__s">
          <div className="kg-tr-status" role="status" aria-busy="true">
            Yükleniyor…
          </div>
        </li>
      );
    }
    const out: ReactNode[] = [];
    if (n.status === 'error' && n.entries.length === 0) {
      out.push(
        <li role="none" key="__s">
          <div className="kg-tr-status" role="status">
            <span>Klasör okunamadı</span>
            <button type="button" className="kg-link" onClick={() => load(key, false)}>
              Yeniden dene
            </button>
          </div>
        </li>,
      );
      return out;
    }
    if (n.entries.length === 0) {
      out.push(
        <li role="none" key="__s">
          <div className="kg-tr-status">Boş</div>
        </li>,
      );
      return out;
    }
    const rel = relOf(key);
    for (const en of n.entries) {
      const ck = keyOf(projOf(key), childRel(rel, en.name));
      out.push(node(ck, key, en.name, en.type, level, en.size));
    }
    if (n.truncated) {
      out.push(
        <li role="none" key="__t">
          <div className="kg-tr-status">İlk 500 kayıt gösteriliyor</div>
        </li>,
      );
    }
    return out;
  };

  const node = (key: string, pKey: string, name: string, kind: RowProps['kind'], level: number, size?: number, perm?: 'r' | 'rw'): ReactNode => {
    const isOpen = (kind === 'proj' || kind === 'dir') && open.has(key);
    return (
      <li role="none" key={key}>
        <Row
          nodeKey={key}
          pKey={pKey}
          name={name}
          kind={kind}
          level={level}
          open={isOpen}
          focusable={key === tabKey}
          size={size}
          perm={perm}
          onActivate={activate}
          onInsert={insert}
          onFocusKey={setFocusKey}
          onKeyNav={onKeyNav}
        />
        {isOpen ? (
          <ul role="group" className="kg-tr-group" aria-busy={nodes[key]?.status === 'loading'}>
            {rows(key, level + 1)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <section className="kg-projects" aria-label="Projeler">
      <h2 className="kg-h">
        <span>Projeler</span>
        <span className="kg-h-right">
          {projects ? <span className="kg-h-count">{projects.length}</span> : null}
          <button type="button" className="kg-tr-refresh" aria-label="Ağacı yenile" title="Ağacı yenile" onClick={manualRefresh}>
            <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
      </h2>
      {projError ? (
        <div className="kg-note">
          <span>Projeler alınamadı.</span>
          <button type="button" className="kg-link" onClick={onReloadProjects}>
            Yeniden dene
          </button>
        </div>
      ) : projects === null ? (
        <p className="kg-note">Yükleniyor…</p>
      ) : projects.length === 0 ? (
        <p className="kg-note">Size açılmış proje yok</p>
      ) : (
        <ul className="kg-tree" role="tree" aria-label="Proje dosyaları" ref={treeRef}>
          {projects.map((p) => node(keyOf(p.name, ''), '', p.name, 'proj', 1, undefined, p.perm))}
        </ul>
      )}
    </section>
  );
}
