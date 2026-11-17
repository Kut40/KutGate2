import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLicense } from './license.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const NOW = new Date('2026-06-15T12:00:00Z');

function make(payload: object, key = privateKey): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`;
}
const good = { v: 1, urun: 'kutgate', lisansNo: 'L-1', kurum: 'Örnek Kurum', bitis: '2026-12-31' };

test('geçerli lisans kabul edilir', () => {
  const r = verifyLicense(make(good), NOW, publicKey);
  assert.equal(r.ok, true);
});

test('bitiş günü dahil, ertesi gün reddedilir', () => {
  assert.equal(verifyLicense(make({ ...good, bitis: '2026-06-15' }), NOW, publicKey).ok, true);
  const r = verifyLicense(make({ ...good, bitis: '2026-06-14' }), NOW, publicKey);
  assert.equal(r.ok, false);
});

test('başka anahtarla imzalanan reddedilir', () => {
  assert.equal(verifyLicense(make(good, other.privateKey), NOW, publicKey).ok, false);
});

test('içeriği değiştirilen (imza aynı) reddedilir', () => {
  const [, sig] = make(good).split('.');
  const forged = Buffer.from(JSON.stringify({ ...good, bitis: '2099-12-31' })).toString('base64url');
  assert.equal(verifyLicense(`${forged}.${sig}`, NOW, publicKey).ok, false);
});

test('boş, bozuk ve eksik alanlı lisans reddedilir', () => {
  assert.equal(verifyLicense('', NOW, publicKey).ok, false);
  assert.equal(verifyLicense('abc', NOW, publicKey).ok, false);
  assert.equal(verifyLicense(make({ ...good, kurum: '' }), NOW, publicKey).ok, false);
  assert.equal(verifyLicense(make({ ...good, urun: 'baska' }), NOW, publicKey).ok, false);
});
