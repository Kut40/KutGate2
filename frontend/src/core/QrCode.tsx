import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

const QUIET = 4;

export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const path = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) {
        let c = 0;
        while (c < n) {
          if (!qr.isDark(r, c)) {
            c++;
            continue;
          }
          const start = c;
          while (c < n && qr.isDark(r, c)) c++;
          d += `M${start + QUIET} ${r + QUIET}h${c - start}v1h${start - c}z`;
        }
      }
      return { d, n };
    } catch {
      return null;
    }
  }, [value]);

  if (!path) return null;
  const total = path.n + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label="Kimlik doğrulayıcı karekodu"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ display: 'block', maxWidth: '100%', height: 'auto', aspectRatio: '1 / 1', background: '#ffffff', borderRadius: 6 }}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
