import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('geçersiz base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Uint8Array, counter: number, digits: number = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretB32: string, timeMs: number = Date.now(), digits: number = DIGITS): string {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretB32), counter, digits);
}

export function matchTotp(
  secretB32: string,
  code: string,
  timeMs: number = Date.now(),
  lastCounter: number | null = null,
): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  let key: Buffer;
  try {
    key = base32Decode(secretB32);
  } catch {
    return null;
  }
  if (key.length === 0) return null;
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  let matched: number | null = null;
  for (const w of [-1, 0, 1]) {
    const expected = hotp(key, counter + w, DIGITS);
    const fresh = lastCounter === null || counter + w > lastCounter;
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code)) && fresh) matched = counter + w;
  }
  return matched;
}

/** ±1 pencere (30 sn) toleransıyla 6 haneli kodu doğrular. */
export function verifyTotp(secretB32: string, code: string, timeMs: number = Date.now()): boolean {
  return matchTotp(secretB32, code, timeMs) !== null;
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
