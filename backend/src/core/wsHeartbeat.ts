import type { FastifyInstance } from 'fastify';

export const WS_PING_MS = 30 * 1000;

/**
 * Açık soketlere düzenli ping gönderir; arada bir vekil boşta kalan bağlantıyı kesmesin.
 * Ping uygulama karesi değildir: kilit sayacını ertelemez, sohbet ve terminal akışına karışmaz.
 */
export function startWsHeartbeat(app: FastifyInstance, intervalMs: number = WS_PING_MS): void {
  const seen = new WeakSet<object>();
  const alive = new WeakSet<object>();
  const timer = setInterval(() => {
    for (const client of app.websocketServer.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (!seen.has(client)) {
        seen.add(client);
        alive.add(client);
        client.on('pong', () => alive.add(client));
      }
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, intervalMs);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
