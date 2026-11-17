import { useEffect } from 'react';

const sources = new Set<object>();

export function hasUnsavedChanges(): boolean {
  return sources.size > 0;
}

export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const token = {};
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    sources.add(token);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      sources.delete(token);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}
