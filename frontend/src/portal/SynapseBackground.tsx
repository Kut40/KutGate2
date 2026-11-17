import { useEffect, useRef } from 'react';

type Node = { x: number; y: number; vx: number; vy: number; r: number; act: number };
type Pulse = { a: Node; b: Node; t: number };

const LINK_DIST = 170;
const NODE_RGB = '0, 215, 232';
const LINE_RGB = '0, 165, 236';
const PULSE_RGB = '70, 251, 251';

export function SynapseBackground({ paused = false }: { paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const startRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) startRef.current?.();
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0;
    let h = 0;
    let nodes: Node[] = [];
    let pulses: Pulse[] = [];
    const pointer = { x: -9999, y: -9999 };
    let raf = 0;

    const makeNodes = () => {
      const count = Math.round(Math.min(70, Math.max(24, (w * h) / 26000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.4 + 1.2,
        act: 0,
      }));
      pulses = [];
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const prevW = w;
      const prevH = h;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const areaChange = prevW && prevH ? Math.abs(w * h - prevW * prevH) / (prevW * prevH) : 0;
      if (!nodes.length || areaChange > 0.25) {
        makeNodes();
      } else if (prevW && prevH) {
        for (const n of nodes) {
          n.x = (n.x / prevW) * w;
          n.y = (n.y / prevH) * h;
        }
      }
    };

    const step = () => {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > w) {
          n.vx *= -1;
          n.x = Math.min(Math.max(n.x, 0), w);
        }
        if (n.y < 0 || n.y > h) {
          n.vy *= -1;
          n.y = Math.min(Math.max(n.y, 0), h);
        }
        const d = Math.hypot(n.x - pointer.x, n.y - pointer.y);
        const target = Math.max(0, 1 - d / (LINK_DIST * 0.9));
        n.act += (target - n.act) * 0.08;
      }

      for (const n of nodes) {
        if (n.act > 0.5 && Math.random() > 0.985) {
          const near = nodes.filter((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y) < LINK_DIST);
          if (near.length) pulses.push({ a: n, b: near[Math.floor(Math.random() * near.length)], t: 0 });
        }
      }
      for (const p of pulses) p.t += 0.025;
      pulses = pulses.filter((p) => p.t < 1).slice(-60);
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d >= LINK_DIST) continue;
          const fade = 1 - d / LINK_DIST;
          const alpha = fade * (0.07 + Math.max(a.act, b.act) * 0.22);
          ctx.strokeStyle = `rgba(${LINE_RGB}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (const n of nodes) {
        ctx.fillStyle = `rgba(${NODE_RGB}, ${(0.22 + n.act * 0.6).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const p of pulses) {
        const x = p.a.x + (p.b.x - p.a.x) * p.t;
        const y = p.a.y + (p.b.y - p.a.y) * p.t;
        ctx.fillStyle = `rgba(${PULSE_RGB}, ${(0.85 * (1 - p.t * 0.5)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      step();
      draw();
      raf = pausedRef.current ? 0 : requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduce.matches) {
        draw();
      } else {
        raf = requestAnimationFrame(loop);
      }
    };

    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };
    const onResize = () => {
      resize();
      if (reduce.matches) draw();
    };

    resize();
    startRef.current = start;
    start();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    window.addEventListener('resize', onResize);
    reduce.addEventListener('change', start);

    return () => {
      startRef.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onResize);
      reduce.removeEventListener('change', start);
    };
  }, []);

  return <canvas ref={canvasRef} className="kg-synapse" aria-hidden="true" />;
}
