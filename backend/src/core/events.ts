import type { GateEventListener, GateEventMap, GateEvents } from './types.js';

export function makeEvents(onError?: (event: string, err: unknown) => void): GateEvents {
  const listeners = new Map<keyof GateEventMap, GateEventListener<keyof GateEventMap>[]>();

  function on<K extends keyof GateEventMap>(event: K, listener: GateEventListener<K>): void {
    const list = listeners.get(event) ?? [];
    list.push(listener as GateEventListener<keyof GateEventMap>);
    listeners.set(event, list);
  }

  async function emit<K extends keyof GateEventMap>(event: K, payload: GateEventMap[K]): Promise<void> {
    const list = listeners.get(event) ?? [];
    for (const l of list) {
      try {
        await l(payload);
      } catch (err) {
        onError?.(event, err);
      }
    }
  }

  return { on, emit };
}
