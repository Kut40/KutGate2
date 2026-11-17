import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originMatchesHost, parseResize, passwordError, resizeControl } from './validate.js';
import {
  APIKEY_RE,
  isAgentLogName,
  isApiKeyLine,
  SESSION_ID_RE,
  UNIT_RE,
  USER_RE,
} from '../core/exec.js';

test('parola: en az 12 karakter', () => {
  assert.notEqual(passwordError('ali', 'kisaparola1'), null);
  assert.equal(passwordError('ali', 'uzunbirparola'), null);
  assert.notEqual(passwordError('ali', 123456789012), null);
  assert.notEqual(passwordError('ali', undefined), null);
});

test('parola: kullanıcı adını içeremez (büyük/küçük harf duyarsız)', () => {
  assert.notEqual(passwordError('ayse', 'benimadimAYSE123'), null);
  assert.notEqual(passwordError('ayse', 'ayse1234567890'), null);
  assert.equal(passwordError('ayse', 'tamamenbaskabir'), null);
});

test('resize mesajı: geçerli', () => {
  assert.deepEqual(parseResize('{"t":"resize","cols":120,"rows":40}'), { cols: 120, rows: 40 });
  assert.deepEqual(parseResize('{"t":"resize","cols":1,"rows":500}'), { cols: 1, rows: 500 });
});

test('resize mesajı: geçersiz', () => {
  assert.equal(parseResize('{"t":"resize","cols":0,"rows":40}'), null);
  assert.equal(parseResize('{"t":"resize","cols":501,"rows":40}'), null);
  assert.equal(parseResize('{"t":"resize","cols":80.5,"rows":40}'), null);
  assert.equal(parseResize('{"t":"resize","cols":"80","rows":40}'), null);
  assert.equal(parseResize('{"t":"other","cols":80,"rows":40}'), null);
  assert.equal(parseResize('{"t":"resize","cols":80}'), null);
  assert.equal(parseResize('[1,2]'), null);
  assert.equal(parseResize('ls -la\r'), null);
  assert.equal(parseResize('{bozuk'), null);
  assert.equal(parseResize('null'), null);
});

test('resize kontrol satırı', () => {
  assert.equal(resizeControl(120, 40), '\x00RESIZE 120 40\n');
});

test('API anahtarı regex', () => {
  assert.match('sk-ant-' + 'a'.repeat(20), APIKEY_RE);
  assert.match('sk-ant-api03-AbC_dEf-123456789012345', APIKEY_RE);
  assert.doesNotMatch('sk-ant-' + 'a'.repeat(19), APIKEY_RE);
  assert.doesNotMatch('sk-ant-' + 'a'.repeat(201), APIKEY_RE);
  assert.doesNotMatch('sk-xyz-' + 'a'.repeat(30), APIKEY_RE);
  assert.doesNotMatch('sk-ant-' + 'a'.repeat(20) + ' x', APIKEY_RE);
  assert.doesNotMatch('sk-ant-' + 'a'.repeat(20) + '\n', APIKEY_RE);
  assert.equal(isApiKeyLine('sk-ant-' + 'a'.repeat(20) + '\n'), true);
  assert.equal(isApiKeyLine('sk-ant-' + 'a'.repeat(20) + '\n\n'), false);
  assert.equal(isApiKeyLine(undefined), false);
});

test('ajan kaydı adı', () => {
  assert.equal(isAgentLogName('abc-123.jsonl'), true);
  assert.equal(isAgentLogName('-srv-projects-x/3f2a.jsonl'), true);
  assert.equal(isAgentLogName('abc.json'), false);
  assert.equal(isAgentLogName('a/b/c.jsonl'), false);
  assert.equal(isAgentLogName('../x.jsonl'), false);
  assert.equal(isAgentLogName('./x.jsonl'), false);
  assert.equal(isAgentLogName('/etc/x.jsonl'), false);
  assert.equal(isAgentLogName('a b.jsonl'), false);
  assert.equal(isAgentLogName('.jsonl'), false);
  assert.equal(isAgentLogName('a'.repeat(201) + '.jsonl'), false);
  assert.equal(isAgentLogName(42), false);
});

test('oturum id regex', () => {
  assert.match('0123456789abcdef01234567', SESSION_ID_RE);
  assert.doesNotMatch('0123456789abcdef0123456', SESSION_ID_RE);
  assert.doesNotMatch('0123456789ABCDEF01234567', SESSION_ID_RE);
  assert.doesNotMatch('0123456789abcdef0123456g', SESSION_ID_RE);
});

test('unit regex', () => {
  assert.match('gate-portal-ali-0123456789abcdef01234567', UNIT_RE);
  assert.match('gate-portal-a_b-c-0123456789abcdef01234567', UNIT_RE);
  assert.doesNotMatch('gate-portal-a-0123456789abcdef01234567', UNIT_RE);
  assert.doesNotMatch('gate-portal-Ali-0123456789abcdef01234567', UNIT_RE);
  assert.doesNotMatch('gate-portal-ali-0123456789abcdef0123456', UNIT_RE);
  assert.doesNotMatch('gate-portal-ali-0123456789abcdef01234567.service', UNIT_RE);
  assert.doesNotMatch('x-gate-portal-ali-0123456789abcdef01234567', UNIT_RE);
});

test('kullanıcı adı regex', () => {
  assert.match('ali', USER_RE);
  assert.doesNotMatch('a', USER_RE);
  assert.doesNotMatch('1ali', USER_RE);
});

test('origin eşleşmesi', () => {
  assert.equal(originMatchesHost('http://srv:4180', 'srv:4180'), true);
  assert.equal(originMatchesHost('http://evil:4180', 'srv:4180'), false);
  assert.equal(originMatchesHost(undefined, 'srv:4180'), false);
  assert.equal(originMatchesHost('bozuk', 'srv:4180'), false);
});
