/**
 * wrangler.jsonc serves the admin UI from ../admin/dist (a gitignored Vite build).
 * If it hasn't been built, write a placeholder so the assets directory exists for the
 * test runtime (and `wrangler dev`) and /admin/ still serves HTML. A real build
 * replaces it (Vite empties its outDir).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const index = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist/admin/index.html');
  if (existsSync(index)) return;
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(
    index,
    '<!doctype html><html><head><title>Admin (placeholder)</title></head>' +
      '<body><p>Admin UI not built. Run <code>npm run admin:build</code>.</p></body></html>\n',
  );
}
