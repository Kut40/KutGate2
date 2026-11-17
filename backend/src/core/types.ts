import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type ScriptName =
  | 'user-add'
  | 'user-del'
  | 'user-lock'
  | 'key-add'
  | 'key-del'
  | 'module-add'
  | 'module-del'
  | 'grant'
  | 'revoke'
  | 'egress-profile'
  | 'rules-init'
  | 'file-write'
  | 'git-proje'
  | 'file-delete'
  | 'portal-shell'
  | 'session-kill'
  | 'portal-mode'
  | 'apikey-set'
  | 'agent-logs'
  | 'dev-changes'
  | 'project-list';

export interface Config {
  host: string;
  port: number;
  dryRun: boolean;
  dataDir: string;
  scriptsDir: string;
  rulesRoot: string;
  homeRoot: string;
  projectsRoot: string;
  claudeBin: string;
  /** null = tüm modüller açık */
  modules: string[] | null;
  frontendDir: string;
  portalHost: string;
  portalPort: number;
  sessionsDir: string;
  boardDir: string;
  serviceUser: string;
  /** Portalın kendi adı (ör. gate.ornek.com). null = host denetimi yapılmaz. */
  portalHostname: string | null;
  /** Önizleme alt alan adlarının kökü (ör. ornek.com → onizle-<kullanıcı>.ornek.com). null = önizleme KAPALI. */
  previewDomain: string | null;
  /** Git gönderiminde izin verilen GitHub hesabı/kuruluşu. null = git gönderimi KAPALI. */
  githubOrg: string | null;
  /** Portalın arkasından yayınlanan ortak uygulamalar (host → yerel port). */
  sharedApps: { project: string; host: string; port: number }[];
  /** Takım sayfasında görünen takım adı. */
  teamName: string;
  /** İmzalı lisans dosyası. */
  licenseFile: string;
}

export interface RunResult {
  ok: boolean;
  dryRun: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface AdminInfo {
  id: number;
  username: string;
  locked: boolean;
  pinRequired: boolean;
}


export interface GateEventMap {
  'user.created': { username: string };
}

export type GateEventListener<K extends keyof GateEventMap> = (payload: GateEventMap[K]) => void | Promise<void>;

export interface GateEvents {
  on<K extends keyof GateEventMap>(event: K, listener: GateEventListener<K>): void;
  emit<K extends keyof GateEventMap>(event: K, payload: GateEventMap[K]): Promise<void>;
}

export interface Core {
  db: DatabaseSync;
  events: GateEvents;
  cfg: Config;
  audit(actor: string, action: string, detail?: string): void;
  run(script: ScriptName, args: string[], stdin?: string): Promise<RunResult>;
  writeFile(absPath: string, content: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
  /** Yönetici oturumu kilitlenince çağrılır; dönen işlev aboneliği kaldırır. */
  onSessionLocked(fn: (token: string) => void): () => void;
  sessionFrameLocked(token: string, username: string): boolean;
  touchSessionActivity(token: string): void;
}

export interface GateModule {
  name: string;
  register(app: FastifyInstance, core: Core): void | Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminInfo;
  }
}
