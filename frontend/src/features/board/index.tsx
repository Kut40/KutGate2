import type { Feature } from '../../core/registry';
import { AdminNotesPage } from './AdminNotesPage';
import { BoardPage } from './BoardPage';
import { DevlogPage } from './DevlogPage';

export const devlogFeature: Feature = { id: 'devlog', title: 'Geliştirme Notları', icon: 'note', Page: DevlogPage, module: 'board' };
export const boardFeature: Feature = { id: 'board', title: 'Takım Panosu', icon: 'board', Page: BoardPage, module: 'board' };
export const adminNotesFeature: Feature = { id: 'admin-notes', title: 'Yönetici Notları', icon: 'megaphone', Page: AdminNotesPage, module: 'board' };
