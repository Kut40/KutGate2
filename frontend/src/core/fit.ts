import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const NARROW = '(max-width: 700px)';
const DEBOUNCE_MS = 100;

export function termFontSize(desktop: number): number {
  return window.matchMedia(NARROW).matches ? 12 : desktop;
}

export function attachFit(term: Terminal, fit: FitAddon, box: HTMLElement, desktopFont: number): () => void {
  let timer = 0;
  const run = () => {
    const size = termFontSize(desktopFont);
    if (term.options.fontSize !== size) term.options.fontSize = size;
    if (box.clientWidth === 0 || box.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      return;
    }
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, DEBOUNCE_MS);
  };
  run();
  const ro = new ResizeObserver(schedule);
  ro.observe(box);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  return () => {
    window.clearTimeout(timer);
    ro.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    vv?.removeEventListener('resize', schedule);
  };
}
