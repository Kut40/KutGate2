import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { INTERNAL_HEADER, internalTokenMatches } from './internal.js';

export interface RequestLike {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined };
}

const TRUSTED_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isTrustedPeer(peer: string | undefined): boolean {
  return peer !== undefined && TRUSTED_PEERS.has(peer);
}

export type ProxyTrust = (req: RequestLike) => boolean;

export const trustLoopbackPeer: ProxyTrust = (req) => isTrustedPeer(req.socket.remoteAddress);

export function trustInternalProxy(token: string): ProxyTrust {
  return (req) =>
    isTrustedPeer(req.socket.remoteAddress) && internalTokenMatches(req.headers[INTERNAL_HEADER], token);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function validIp(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.trim();
  return s !== '' && isIP(s) !== 0 ? s : null;
}

export function resolveClientIp(
  peer: string | undefined,
  headers: IncomingHttpHeaders,
  trusted: boolean = isTrustedPeer(peer),
): string {
  if (trusted) {
    const cf = validIp(headerValue(headers['cf-connecting-ip']));
    if (cf) return cf;
    const xff = headerValue(headers['x-forwarded-for']);
    const first = validIp(xff === undefined ? undefined : xff.split(',')[0]);
    if (first) return first;
  }
  return peer ?? '';
}

export function resolveForwardedProto(
  peer: string | undefined,
  headers: IncomingHttpHeaders,
  trusted: boolean = isTrustedPeer(peer),
): 'http' | 'https' {
  if (!trusted) return 'http';
  const xfp = headerValue(headers['x-forwarded-proto']);
  if (xfp !== undefined && xfp.split(',')[0].trim().toLowerCase() === 'https') return 'https';
  const visitor = headerValue(headers['cf-visitor']);
  if (visitor !== undefined) {
    try {
      const v = JSON.parse(visitor) as unknown;
      if (v !== null && typeof v === 'object' && (v as Record<string, unknown>).scheme === 'https') return 'https';
    } catch {
      return 'http';
    }
  }
  return 'http';
}

export function clientIp(req: RequestLike, trust: ProxyTrust = trustLoopbackPeer): string {
  return resolveClientIp(req.socket.remoteAddress, req.headers, trust(req));
}

export function isHttps(req: RequestLike, trust: ProxyTrust = trustLoopbackPeer): boolean {
  return resolveForwardedProto(req.socket.remoteAddress, req.headers, trust(req)) === 'https';
}

export function isProxied(req: RequestLike): boolean {
  return req.headers['x-gate-proxied'] !== undefined;
}
