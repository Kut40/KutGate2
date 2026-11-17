import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { startWsHeartbeat, WS_PING_MS } from './wsHeartbeat.js';

test('kalp atışı 100 sn sınırının çok altında', () => {
  assert.ok(WS_PING_MS < 100_000 / 2);
});

test('kalp atışı açık sokete ping gönderir, uygulama mesajı üretmez', async () => {
  const app = Fastify();
  await app.register(websocket);
  let serverMessages = 0;
  let clientMessages = 0;
  app.get('/s', { websocket: true }, (socket) => {
    socket.on('message', () => {
      serverMessages += 1;
    });
  });
  startWsHeartbeat(app, 20);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${port}/s`);
  client.on('message', () => {
    clientMessages += 1;
  });
  const pings = await new Promise<number>((resolve, reject) => {
    let n = 0;
    client.on('ping', () => {
      n += 1;
      if (n === 3) resolve(n);
    });
    client.on('error', reject);
  });
  assert.equal(pings, 3);
  assert.equal(serverMessages, 0);
  assert.equal(clientMessages, 0);
  client.close();
  await app.close();
});

test('kalp atışı ping yanıtı vermeyen soketi kapatır, yanıt vereni açık tutar', async () => {
  const app = Fastify();
  await app.register(websocket);
  app.get('/s', { websocket: true }, () => {});
  startWsHeartbeat(app, 20);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const silent = new WebSocket(`ws://127.0.0.1:${port}/s`, { autoPong: false });
  const healthy = new WebSocket(`ws://127.0.0.1:${port}/s`);
  await Promise.all([silent, healthy].map((c) => new Promise((r) => c.once('open', r))));
  const closed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 1000);
    silent.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  assert.equal(closed, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(healthy.readyState, WebSocket.OPEN);
  healthy.close();
  await app.close();
});
