import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hotp, matchTotp, totp, verifyTotp, generateSecret } from './totp.js';

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 kodlama/çözme RFC anahtarı ile tutarlı', () => {
  assert.equal(base32Encode(Buffer.from(RFC_SECRET_ASCII)), RFC_SECRET_B32);
  assert.equal(base32Decode(RFC_SECRET_B32).toString(), RFC_SECRET_ASCII);
});

test('base32 gidiş-dönüş', () => {
  const s = generateSecret();
  assert.equal(base32Encode(base32Decode(s)), s);
});

test('base32 geçersiz karakter reddedilir', () => {
  assert.throws(() => base32Decode('ABC1'));
});

test('RFC 4226 HOTP vektörleri', () => {
  const key = Buffer.from(RFC_SECRET_ASCII);
  assert.equal(hotp(key, 0), '755224');
  assert.equal(hotp(key, 1), '287082');
  assert.equal(hotp(key, 9), '520489');
});

test('RFC 6238 SHA1 vektörleri (8 hane)', () => {
  assert.equal(totp(RFC_SECRET_B32, 59 * 1000, 8), '94287082');
  assert.equal(totp(RFC_SECRET_B32, 1111111109 * 1000, 8), '07081804');
  assert.equal(totp(RFC_SECRET_B32, 1111111111 * 1000, 8), '14050471');
  assert.equal(totp(RFC_SECRET_B32, 1234567890 * 1000, 8), '89005924');
  assert.equal(totp(RFC_SECRET_B32, 2000000000 * 1000, 8), '69279037');
});

test('6 haneli TOTP', () => {
  assert.equal(totp(RFC_SECRET_B32, 59 * 1000), '287082');
  assert.equal(totp(RFC_SECRET_B32, 1234567890 * 1000), '005924');
});

test('±1 pencere doğrulama', () => {
  const t = 1234567890 * 1000;
  const code = totp(RFC_SECRET_B32, t);
  assert.equal(verifyTotp(RFC_SECRET_B32, code, t), true);
  assert.equal(verifyTotp(RFC_SECRET_B32, code, t + 30 * 1000), true);
  assert.equal(verifyTotp(RFC_SECRET_B32, code, t - 30 * 1000), true);
  assert.equal(verifyTotp(RFC_SECRET_B32, code, t + 90 * 1000), false);
});

test('biçimsiz kod reddedilir', () => {
  assert.equal(verifyTotp(RFC_SECRET_B32, '12345'), false);
  assert.equal(verifyTotp(RFC_SECRET_B32, 'abcdef'), false);
  assert.equal(verifyTotp(RFC_SECRET_B32, '1234567'), false);
});

test('eşleşen sayaç döner, aynı ya da daha eski sayaç reddedilir', () => {
  const t = 1234567890 * 1000;
  const counter = Math.floor(t / 1000 / 30);
  const code = totp(RFC_SECRET_B32, t);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t), counter);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t + 30 * 1000), counter);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t, counter - 1), counter);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t, counter), null);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t, counter + 1), null);
  assert.equal(matchTotp(RFC_SECRET_B32, code, t + 90 * 1000), null);
  assert.equal(matchTotp(RFC_SECRET_B32, '12345', t), null);
  assert.equal(matchTotp('', code, t), null);
});
