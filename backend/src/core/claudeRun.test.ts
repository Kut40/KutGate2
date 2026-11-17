import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeInvocation } from './claudeRun.js';

test('argümanlar yalıtım bayraklarını içerir', () => {
  const { args } = claudeInvocation('merhaba', {});
  assert.deepEqual(args, ['-p', 'merhaba', '--setting-sources', '', '--tools', '', '--no-session-persistence']);
  const i = args.indexOf('--setting-sources');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], '');
});

test('ortam CLAUDE.md ve gereksiz trafiği kapatır, mevcut ortamı korur', () => {
  const { env } = claudeInvocation('x', { PATH: '/usr/bin', HOME: '/home/a' });
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/a');
});

test('ortamdaki eski değer ezilir ve temel ortam değişmez', () => {
  const base = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' };
  const { env } = claudeInvocation('x', base);
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(base.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '0');
});
