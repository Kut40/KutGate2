const W = 600;
const H = 800;
const MAX_LEN = 790_000;

export async function fileToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Lütfen bir resim dosyası seçin.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('Resim okunamadı. JPG, PNG ya da WEBP deneyin.');
  }
  const scale = Math.max(W / bmp.width, H / bmp.height);
  const sw = W / scale;
  const sh = H / scale;
  const sx = (bmp.width - sw) / 2;
  const sy = Math.max(0, (bmp.height - sh) * 0.3);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Resim işlenemedi.');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, W, H);
  bmp.close();
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_LEN) return url;
  }
  throw new Error('Resim çok büyük.');
}
