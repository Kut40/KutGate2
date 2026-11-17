import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { makePreview } from './preview.js';

type Preview = ReturnType<typeof makePreview>;

function login(preview: Preview, link: string, owner: string): number {
  const u = new URL(link);
  let status = 0;
  const res = {
    writeHead(code: number): void {
      status = code;
    },
    end(): void {},
  };
  preview.handle({ url: `${u.pathname}${u.search}`, headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse, owner);
  return status;
}

test('önizleme bağlantısı: kullanıcı başına en çok 50 bağlantı tutulur, en eskisi düşer, başka kullanıcı etkilenmez', () => {
  const preview = makePreview({} as DatabaseSync, () => {}, 'example.com', 'gate.example.com');
  const other = preview.issue('ayse');
  const links = Array.from({ length: 51 }, () => preview.issue('veli'));
  assert.equal(login(preview, links[0], 'veli'), 403);
  assert.equal(login(preview, links[1], 'veli'), 302);
  assert.equal(login(preview, links[50], 'veli'), 302);
  assert.equal(login(preview, other, 'ayse'), 302);
});

test('önizleme bağlantısı: sınırın altında hiçbir bağlantı düşmez', () => {
  const preview = makePreview({} as DatabaseSync, () => {}, 'example.com', 'gate.example.com');
  const links = Array.from({ length: 30 }, () => preview.issue('veli'));
  for (const link of links) assert.equal(login(preview, link, 'veli'), 302);
});

test('önizleme alan adı verilmezse hiçbir host önizleme sayılmaz (özellik kapalı)', () => {
  const off = makePreview({} as DatabaseSync, () => {}, null, null);
  const on = makePreview({} as DatabaseSync, () => {}, 'example.com', 'gate.example.com');
  const req = (host: string) => ({ headers: { host } }) as unknown as Parameters<typeof on.owner>[0];
  assert.equal(off.owner(req('onizle-veli.example.com')), null);
  assert.equal(on.owner(req('onizle-veli.example.com')), 'veli');
  assert.equal(on.owner(req('onizle-veli.baska.com')), null);
  assert.equal(on.owner(req('gate.example.com')), null);
});
