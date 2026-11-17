import type { ComponentType } from 'react';
import users from '../features/users';
import folders from '../features/folders';
import gates from '../features/gates';
import rules from '../features/rules';
import skills from '../features/skills';
import terminal from '../features/terminal';
import portal from '../features/portal';
import sessions from '../features/sessions';
import audit from '../features/audit';
import settings from '../features/settings';
import { devlogFeature, boardFeature, adminNotesFeature } from '../features/board';

export interface Feature {
  id: string;
  title: string;
  icon: string;
  Page: ComponentType;
  module?: string;
}

export const allFeatures: Feature[] = [users, folders, gates, rules, skills, terminal, portal, sessions, devlogFeature, boardFeature, adminNotesFeature, audit, settings];

export function visibleFeatures(modules: string[]): Feature[] {
  return allFeatures.filter((f) => f.id === 'settings' || modules.includes(f.module ?? f.id) || (f.id === 'sessions' && modules.includes('portal')));
}
