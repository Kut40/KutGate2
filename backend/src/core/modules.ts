import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Core, GateModule } from './types.js';

const MODULES_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** `src/modules/<ad>/index.ts` dosyalarını dinamik import ile yükler; yüklenen modül adlarını döner. */
export async function loadModules(app: FastifyInstance, core: Core): Promise<string[]> {
  const entries = await readdir(MODULES_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const loaded: string[] = [];
  for (const dir of dirs) {
    if (core.cfg.modules && !core.cfg.modules.includes(dir)) continue;
    const candidates = [join(MODULES_DIR, dir, 'index.ts'), join(MODULES_DIR, dir, 'index.js')];
    const file = candidates.find((f) => existsSync(f));
    if (!file) continue;
    const imported = (await import(pathToFileURL(file).href)) as { default?: GateModule };
    const mod = imported.default;
    if (!mod || typeof mod.name !== 'string' || typeof mod.register !== 'function') {
      throw new Error(`modül geçersiz: ${dir}`);
    }
    await mod.register(app, core);
    loaded.push(mod.name);
  }
  if (core.cfg.modules) {
    for (const name of core.cfg.modules) {
      if (!loaded.includes(name)) app.log.warn(`GATE_MODULES içindeki modül bulunamadı: ${name}`);
    }
  }
  return loaded;
}
