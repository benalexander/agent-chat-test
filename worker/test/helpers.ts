import { exports } from 'cloudflare:workers';

export const SECRET = 'test-secret';

export function api(userId: string, path: string, init: RequestInit & { auth?: string | null } = {}) {
  const headers = new Headers(init.headers);
  const auth = init.auth === undefined ? SECRET : init.auth;
  if (auth !== null) headers.set('Authorization', `Bearer ${auth}`);
  if (!headers.has('X-Timezone')) headers.set('X-Timezone', 'Australia/Melbourne');
  if (init.body) headers.set('content-type', 'application/json');
  return exports.default.fetch(new Request(`https://worker.test/api/${userId}/${path}`, { ...init, headers }));
}

export const ADMIN_SECRET = 'test-admin';

export function adminApi(path: string, init: RequestInit & { auth?: string | null } = {}) {
  const headers = new Headers(init.headers);
  const auth = init.auth === undefined ? ADMIN_SECRET : init.auth;
  if (auth !== null) headers.set('Authorization', `Bearer ${auth}`);
  if (init.body) headers.set('content-type', 'application/json');
  return exports.default.fetch(new Request(`https://worker.test/admin/api${path}`, { ...init, headers }));
}

/** Poll until `fn` returns a truthy value (registry writes happen in waitUntil). */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
