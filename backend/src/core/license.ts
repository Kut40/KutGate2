import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * KutGate lisans denetimi.
 * Lisans dosyası: base64url(JSON yük) + "." + base64url(Ed25519 imza). Yalnız AÇIK anahtar burada durur;
 * imzalayan özel anahtar ve lisans üretme aracı ürünün dışında, lisans verende kalır.
 */
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5VlZAbHZWPwdAIzgy5rFn3vKEiCAsCkY8iaMYr+E+d8=
-----END PUBLIC KEY-----
`;

export const LICENSE_EXIT_CODE = 78;

export type License = { v: 1; urun: 'kutgate'; lisansNo: string; kurum: string; bitis: string };

export type LicenseResult = { ok: true; license: License } | { ok: false; reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function verifyLicense(text: string, now: Date, publicKey: KeyObject = createPublicKey(PUBLIC_KEY_PEM)): LicenseResult {
  const parts = text.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'biçim bozuk' };
  const [body, sig] = parts;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(body, 'utf8'), publicKey, Buffer.from(sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'imza geçersiz' };
  let lic: Partial<License>;
  try {
    lic = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'içerik okunamadı' };
  }
  if (lic.v !== 1 || lic.urun !== 'kutgate') return { ok: false, reason: 'ürün ya da sürüm uyuşmuyor' };
  if (typeof lic.kurum !== 'string' || !lic.kurum.trim()) return { ok: false, reason: 'kurum adı yok' };
  if (typeof lic.lisansNo !== 'string' || !lic.lisansNo.trim()) return { ok: false, reason: 'lisans no yok' };
  if (typeof lic.bitis !== 'string' || !DATE_RE.test(lic.bitis)) return { ok: false, reason: 'bitiş tarihi bozuk' };
  // Bitiş günü dahil geçerlidir (UTC gün sonu).
  if (now.getTime() > Date.parse(`${lic.bitis}T23:59:59.999Z`)) return { ok: false, reason: `süresi doldu (${lic.bitis})` };
  return { ok: true, license: lic as License };
}

/** Açılışta çağrılır. Geçerli lisans yoksa süreç her modda (dry-run dahil) DURUR. */
export function requireLicense(cfg: { licenseFile: string }): License {
  let text: string;
  try {
    text = readFileSync(cfg.licenseFile, 'utf8');
  } catch {
    return fail(`lisans dosyası okunamadı: ${cfg.licenseFile}`);
  }
  const r = verifyLicense(text, new Date());
  if (!r.ok) return fail(`lisans geçersiz: ${r.reason}`);
  console.log(`KutGate lisansı: ${r.license.kurum} · no ${r.license.lisansNo} · bitiş ${r.license.bitis}`);
  return r.license;
}

/**
 * Çalışan servis de lisansı saatte bir yeniden doğrular: süre dolar ya da dosya değişip bozulursa süreç durur.
 * (Yalnız açılışta bakılsaydı, yeniden başlatılmayan kurulum süresi dolduktan sonra da çalışırdı.)
 */
export function watchLicense(cfg: { licenseFile: string }, everyMs = 60 * 60 * 1000): NodeJS.Timeout {
  const t = setInterval(() => requireLicense(cfg), everyMs);
  t.unref();
  return t;
}

function fail(msg: string): never {
  console.error(`HATA: ${msg}. KutGate lisanssız çalışmaz.`);
  // 78 = yapılandırma hatası; systemd birimi bu kodda yeniden denemez (RestartPreventExitStatus=78).
  process.exit(LICENSE_EXIT_CODE);
}
