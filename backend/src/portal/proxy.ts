import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { isTrustedPeer, resolveClientIp, resolveForwardedProto, type RequestLike } from '../core/clientip.js';
import { INTERNAL_HEADER } from '../core/internal.js';

const UPSTREAM_HOST = '127.0.0.1';
/** Skill üretiminin 120 sn'lik Claude süresinden uzun olmalı (modules/skills `CLAUDE_TIMEOUT_MS`). */
export const HTTP_TIMEOUT_MS = 130 * 1000;
const UNAVAILABLE_BODY = JSON.stringify({ error: 'admin_unavailable' });
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0];
}

export function isProxyPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/');
}

export function isWsProxyPath(path: string): boolean {
  return path.startsWith('/api/');
}

export function stripHopByHop(headers: IncomingHttpHeaders, websocket = false): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    if (HOP_BY_HOP.has(name) || name.startsWith('proxy-')) continue;
    out[name] = v;
  }
  if (websocket && headers.upgrade !== undefined) {
    out.connection = 'Upgrade';
    out.upgrade = headers.upgrade;
  }
  return out;
}

export function forwardHeaders(
  req: RequestLike,
  websocket: boolean,
  internalToken: string | null = null,
): OutgoingHttpHeaders {
  const peer = req.socket.remoteAddress;
  const out = stripHopByHop(req.headers, websocket);
  if (!isTrustedPeer(peer)) {
    delete out['cf-connecting-ip'];
    delete out['cf-visitor'];
  }
  delete out[INTERNAL_HEADER];
  out['x-forwarded-for'] = resolveClientIp(peer, req.headers);
  out['x-forwarded-proto'] = resolveForwardedProto(peer, req.headers);
  out['x-gate-proxied'] = '1';
  if (internalToken !== null) out[INTERNAL_HEADER] = internalToken;
  return out;
}

function headerBlock(headers: OutgoingHttpHeaders): string {
  let text = '';
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [String(v)]) text += `${k}: ${item}\r\n`;
  }
  return text;
}

export interface AdminProxy {
  forward(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function makeAdminProxy(
  port: number,
  unavailableBody = UNAVAILABLE_BODY,
  internalToken: string | null = null,
): AdminProxy {
  function forward(req: IncomingMessage, res: ServerResponse): void {
    let failed = false;
    const upstream = httpRequest({
      host: UPSTREAM_HOST,
      port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, false, internalToken),
      timeout: HTTP_TIMEOUT_MS,
    });

    const fail = (): void => {
      if (failed) return;
      failed = true;
      upstream.destroy();
      if (!res.headersSent) {
        res.writeHead(502, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(unavailableBody),
          'cache-control': 'no-store',
        });
        res.end(unavailableBody);
      } else {
        res.destroy();
      }
    };

    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
      up.on('error', () => res.destroy());
      up.pipe(res);
    });
    upstream.on('timeout', fail);
    upstream.on('error', fail);
    req.on('error', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let connected = false;
    const upstream = connect(port, UPSTREAM_HOST);

    const destroyBoth = (): void => {
      socket.destroy();
      upstream.destroy();
    };

    upstream.on('connect', () => {
      connected = true;
      upstream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headerBlock(forwardHeaders(req, true, internalToken))}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!connected && socket.writable) {
        socket.end(
          `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(
            unavailableBody,
          )}\r\nconnection: close\r\n\r\n${unavailableBody}`,
        );
        upstream.destroy();
        return;
      }
      destroyBoth();
    });
    upstream.on('close', () => {
      if (connected) socket.destroy();
    });
    socket.on('error', destroyBoth);
    socket.on('close', () => upstream.destroy());
  }

  return { forward, upgrade };
}

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export function attachUpgradeProxy(server: Server, proxy: AdminProxy): void {
  const previous = server.listeners('upgrade') as UpgradeListener[];
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (isWsProxyPath(pathOf(req.url))) {
      proxy.upgrade(req, socket, head);
      return;
    }
    for (const fn of previous) fn.call(server, req, socket, head);
  });
}
