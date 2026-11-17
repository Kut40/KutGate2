import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeKeyEnv, claudeKeyHint, claudeKeyPath, deleteClaudeKey, readClaudeKey, writeClaudeKey } from './claudeKey.js';

const KEY = `sk-ant-api03-${'a'.repeat(40)}wxyz`;

test('anahtar yazılır, 0600 olur, okunur ve silinir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-key-'));
  try {
    assert.equal(readClaudeKey(dir), null);
    await writeClaudeKey(dir, KEY);
    assert.equal(readClaudeKey(dir), KEY);
    assert.equal((await stat(claudeKeyPath(dir))).mode & 0o777, 0o600);
    await writeClaudeKey(dir, KEY.replace('wxyz', 'abcd'));
    assert.equal(readClaudeKey(dir)?.slice(-4), 'abcd');
    await deleteClaudeKey(dir);
    assert.equal(readClaudeKey(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('geçersiz anahtar reddedilir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-key-'));
  try {
    await assert.rejects(writeClaudeKey(dir, 'abc'));
    assert.equal(readClaudeKey(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ipucu yalnızca son 4 karakteri gösterir', () => {
  assert.equal(claudeKeyHint(KEY), 'sk-ant-…wxyz');
});

test('ortam: API anahtarı ve OAuth token ayrımı', () => {
  assert.deepEqual(claudeKeyEnv(null), {});
  assert.deepEqual(claudeKeyEnv(KEY), { ANTHROPIC_API_KEY: KEY });
  const oat = `sk-ant-oat01-${'b'.repeat(40)}`;
  assert.deepEqual(claudeKeyEnv(oat), { CLAUDE_CODE_OAUTH_TOKEN: oat });
});
