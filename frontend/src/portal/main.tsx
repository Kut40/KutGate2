import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp } from './App';
import '../core/styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PortalApp />
  </StrictMode>,
);
