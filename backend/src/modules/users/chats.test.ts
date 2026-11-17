import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveUserChats } from './chats.js';

const NOW = new Date(2026, 10, 14, 9, 5, 7);

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gate-chats-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('kullanıcı silme: etkin, arşiv ve silinmiş sohbetler removed altına taşınır', () => {
  withDir((dir) => {
    const agent = join(dir, 'agent');
    mkdirSync(join(agent, 'archive', 'ali'), { recursive: true });
    mkdirSync(join(agent, 'deleted', 'ali'), { recursive: true });
    mkdirSync(join(agent, 'archive', 'veli'), { recursive: true });
    writeFileSync(join(agent, 'ali.jsonl'), 'a\n');
    writeFileSync(join(agent, 'veli.jsonl'), 'v\n');
    writeFileSync(join(agent, 'archive', 'ali', 'c1.jsonl'), 'c1\n');
    writeFileSync(join(agent, 'deleted', 'ali', 'c2.jsonl'), 'c2\n');

    const target = archiveUserChats(dir, 'ali', NOW);

    assert.equal(target, join(agent, 'removed', 'ali-20261114090507'));
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(target, 'ali.jsonl'), 'utf8'), 'a\n');
    assert.equal(readFileSync(join(target, 'archive', 'c1.jsonl'), 'utf8'), 'c1\n');
    assert.equal(readFileSync(join(target, 'deleted', 'c2.jsonl'), 'utf8'), 'c2\n');
    assert.equal(existsSync(join(agent, 'ali.jsonl')), false);
    assert.equal(existsSync(join(agent, 'archive', 'ali')), false);
    assert.equal(existsSync(join(agent, 'deleted', 'ali')), false);
    assert.equal(readFileSync(join(agent, 'veli.jsonl'), 'utf8'), 'v\n');
    assert.equal(existsSync(join(agent, 'archive', 'veli')), true);
  });
});

test('kullanıcı silme: yalnız var olan sohbet yolları taşınır', () => {
  withDir((dir) => {
    const agent = join(dir, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'ali.jsonl'), 'a\n');

    const target = archiveUserChats(dir, 'ali', NOW);

    assert.ok(target);
    assert.equal(readFileSync(join(target, 'ali.jsonl'), 'utf8'), 'a\n');
    assert.equal(existsSync(join(target, 'archive')), false);
    assert.equal(existsSync(join(target, 'deleted')), false);
  });
});

test('kullanıcı silme: sohbeti olmayan kullanıcıda removed dizini açılmaz', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'agent'), { recursive: true });

    assert.equal(archiveUserChats(dir, 'ali', NOW), null);
    assert.equal(existsSync(join(dir, 'agent', 'removed')), false);
  });
  withDir((dir) => {
    assert.equal(archiveUserChats(dir, 'ali', NOW), null);
  });
});

test('kullanıcı silme: symlink izlenmez, bağlantının kendisi taşınır', () => {
  withDir((dir) => {
    const agent = join(dir, 'agent');
    const outside = join(dir, 'outside');
    mkdirSync(join(agent, 'archive'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.jsonl'), 'x\n');
    symlinkSync(outside, join(agent, 'archive', 'ali'));

    const target = archiveUserChats(dir, 'ali', NOW);

    assert.ok(target);
    assert.equal(lstatSync(join(target, 'archive')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(outside, 'x.jsonl'), 'utf8'), 'x\n');
  });
});
