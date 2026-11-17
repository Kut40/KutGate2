import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidComment,
  isValidHost,
  isValidUsername,
  parsePort,
  privateKeyLines,
  unixScript,
  windowsScript,
} from './scripts.js';

const PK = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACDh0Yj1d2ZzVQ5r4kq3W8m3n1F2j0x9k6vY1O8n4Z1b2wAAAJi7vYxwu72M',
  'AAAAC3NzaC1lZDI1NTE5AAAAIOHRiPV3ZnNVDmviSrdbybefUXaPTH2Tq9jU7yfhnVvb==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n') + '\n';

const INPUT = { username: 'ali', host: 'srv.example.com', port: 2222, privateKey: PK };

test('geçerli host değerleri kabul edilir', () => {
  for (const h of ['example.com', 'srv-1.example.com', 'localhost', '192.168.1.10', '::1', '2001:db8::1', 'a'.repeat(253)]) {
    assert.equal(isValidHost(h), true, h);
  }
});

test('geçersiz host ve enjeksiyon denemeleri reddedilir', () => {
  const bad: unknown[] = [
    '',
    '.example.com',
    'example.com.',
    'a;b',
    'a b',
    ' example.com',
    'example.com ',
    '"host"',
    "'host'",
    'a"b',
    "a'b",
    '$(id)',
    'a$(id)b',
    '`id`',
    'a&b',
    'a|b',
    'a>b',
    'a%b',
    'a\nb',
    'a\r\nb',
    'a\tb',
    'a\0b',
    'a/b',
    'a\\b',
    'user@host',
    'a:b',
    ':::',
    'fe80::1%eth0',
    'a'.repeat(254),
    123,
    null,
    undefined,
    {},
  ];
  for (const h of bad) assert.equal(isValidHost(h), false, JSON.stringify(h));
});

test('port: varsayılan 22 ve geçerli aralık', () => {
  assert.equal(parsePort(undefined), 22);
  assert.equal(parsePort(null), 22);
  assert.equal(parsePort(''), 22);
  assert.equal(parsePort(1), 1);
  assert.equal(parsePort(22), 22);
  assert.equal(parsePort(65535), 65535);
  assert.equal(parsePort('2222'), 2222);
});

test('port: geçersiz değerler ve enjeksiyon reddedilir', () => {
  const bad: unknown[] = [0, -1, 65536, 1.5, NaN, Infinity, '0', '65536', '22;', 'a;b', ' 22', '22 ', '2 2', '$(id)', '"22"', '1e3', '0x16', '-22', 'abc', {}, []];
  for (const p of bad) assert.equal(parsePort(p), null, String(p));
});

test('kullanıcı adı doğrulaması', () => {
  for (const u of ['ali', 'user_1', 'dev-ops']) assert.equal(isValidUsername(u), true, u);
  for (const u of ['a', 'Ali', '1ali', 'a;b', 'a b', '"ali"', "'ali'", '$(id)', 'ali\n', 'a'.repeat(33), 5]) {
    assert.equal(isValidUsername(u), false, String(u));
  }
});

test('comment doğrulaması', () => {
  assert.equal(isValidComment('gate-ali'), true);
  assert.equal(isValidComment('ali laptop'), true);
  for (const c of ['', '   ', 'a\nb', 'a\rb', 'a\0b', 'a\tb', 7]) assert.equal(isValidComment(c), false, String(c));
});

test('özel anahtar satırları doğrulanır', () => {
  assert.equal(privateKeyLines(PK)?.length, 5);
  assert.equal(privateKeyLines(PK.replace(/\n/g, '\r\n'))?.length, 5);
  assert.equal(privateKeyLines('not a key'), null);
  assert.equal(privateKeyLines(PK.replace('BEGIN OPENSSH', 'BEGIN RSA')), null);
  assert.equal(privateKeyLines(PK.replace('-----END OPENSSH PRIVATE KEY-----', '')), null);
  for (const inj of ['GATE_KEY', 'abc & calc', 'abc;id', '$(id)', '`id`', '%PATH%', 'abc def', 'a"b']) {
    const lines = PK.split('\n');
    lines.splice(2, 0, inj);
    assert.equal(privateKeyLines(lines.join('\n')), null, inj);
  }
  assert.equal(privateKeyLines(42), null);
});

test('Windows betiği: CRLF ve beklenen içerik', () => {
  const s = windowsScript(INPUT);
  assert.ok(s.endsWith('\r\n'));
  assert.equal(/(?<!\r)\n/.test(s), false);
  const lines = s.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.equal(lines[lines.length - 1], '');
  assert.equal(lines[lines.length - 2], 'pause');
  assert.ok(lines.includes('if not exist "%USERPROFILE%\\.ssh" mkdir "%USERPROFILE%\\.ssh"'));
  assert.ok(lines.includes('echo -----BEGIN OPENSSH PRIVATE KEY-----'));
  assert.ok(lines.includes('echo -----END OPENSSH PRIVATE KEY-----'));
  assert.ok(lines.includes(') > "%USERPROFILE%\\.ssh\\gate-ali"'));
  assert.ok(lines.includes('icacls "%USERPROFILE%\\.ssh\\gate-ali" /inheritance:r /grant:r "%USERNAME%:R"'));
  assert.ok(
    lines.includes('ssh -i "%USERPROFILE%\\.ssh\\gate-ali" -o StrictHostKeyChecking=accept-new -p 2222 ali@srv.example.com'),
  );
  assert.equal(/[&|;`$^<]/.test(s), false);
});

test('Windows betiği: mevcut anahtar dosyası yazmadan önce yazılabilir yapılıp silinir', () => {
  const lines = windowsScript(INPUT).split('\r\n');
  const grant = lines.indexOf('if exist "%USERPROFILE%\\.ssh\\gate-ali" icacls "%USERPROFILE%\\.ssh\\gate-ali" /grant:r "%USERNAME%:F" >nul');
  const del = lines.indexOf('if exist "%USERPROFILE%\\.ssh\\gate-ali" del /f /q "%USERPROFILE%\\.ssh\\gate-ali" >nul');
  const write = lines.indexOf('(');
  assert.ok(grant !== -1);
  assert.ok(del !== -1);
  assert.ok(write !== -1);
  assert.ok(grant < del);
  assert.ok(del < write);
});

test('Unix betiği: LF ve beklenen içerik', () => {
  const s = unixScript(INPUT);
  assert.equal(s.includes('\r'), false);
  assert.ok(s.endsWith('\n'));
  const lines = s.split('\n');
  assert.equal(lines[0], '#!/usr/bin/env bash');
  assert.equal(lines[1], 'set -eu');
  assert.ok(lines.includes("cat > ~/.ssh/gate-ali <<'GATE_KEY'"));
  assert.ok(lines.includes('GATE_KEY'));
  assert.ok(lines.includes('chmod 600 ~/.ssh/gate-ali'));
  assert.ok(lines.includes('chmod 700 ~/.ssh'));
  assert.ok(lines.includes('exec ssh -i ~/.ssh/gate-ali -o StrictHostKeyChecking=accept-new -p 2222 ali@srv.example.com'));
  const start = lines.indexOf("cat > ~/.ssh/gate-ali <<'GATE_KEY'");
  const end = lines.indexOf('GATE_KEY');
  assert.deepEqual(lines.slice(start + 1, end), PK.trimEnd().split('\n'));
  assert.equal(/[&|;`$]/.test(s), false);
});

test('Windows betiği anahtarı satır sonunda CRLF ile yazar (LF girdi)', () => {
  const s = windowsScript({ ...INPUT, privateKey: PK.replace(/\n/g, '\r\n') });
  assert.equal(/(?<!\r)\n/.test(s), false);
  assert.equal(s.includes('\r\r'), false);
});

test('IPv6 host gömülür', () => {
  assert.ok(unixScript({ ...INPUT, host: '2001:db8::1', port: 22 }).includes('-p 22 ali@2001:db8::1\n'));
});

test('doğrulanmamış değerler betiğe gömülmez (hata fırlatılır)', () => {
  const builders = [windowsScript, unixScript];
  for (const build of builders) {
    for (const host of ['a;b', 'a b', '"x"', '$(id)', '`id`', '.x', 'x.', '']) {
      assert.throws(() => build({ ...INPUT, host }), /host/, host);
    }
    for (const port of [0, 65536, 1.5, NaN, Number('22;')]) {
      assert.throws(() => build({ ...INPUT, port }), /port/, String(port));
    }
    for (const username of ['a;b', 'a b', '$(id)', '"ali"', 'Ali']) {
      assert.throws(() => build({ ...INPUT, username }), /kullanıcı/, username);
    }
    assert.throws(() => build({ ...INPUT, privateKey: PK.replace('b3Bl', 'b3Bl & calc ') }), /anahtar/);
    assert.throws(() => build({ ...INPUT, privateKey: '' }), /anahtar/);
  }
});
