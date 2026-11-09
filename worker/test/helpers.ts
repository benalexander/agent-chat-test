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
