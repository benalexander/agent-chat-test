import { getAgentByName } from 'agents';
import { handleAdmin, isAdminApiPath } from './admin';
import { CoachAgent } from './agent';
import { isAuthorized } from './auth';
import { Registry } from './registry';
import { touchRegistry } from './touch';

export { CoachAgent, Registry, isAuthorized };

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-timezone',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// /api/:userId/<route>; userId = device-generated UUID (letters, digits, - and _).
const API_PATH = /^\/api\/([A-Za-z0-9_-]{1,128})\/(.+)$/;

// Static assets (the admin UI under /admin/) are served by the assets layer before
// this handler runs; only /api/*, /admin/api/* and non-asset paths reach here.
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Admin API: same-origin with the admin UI, own secret, no CORS.
    if (isAdminApiPath(url.pathname)) return handleAdmin(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true }, 200);

    if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);

    const match = API_PATH.exec(url.pathname);
    if (!match) return json({ error: 'not_found' }, 404);
    const userId = match[1];

    // Register / refresh the user for the admin panel without adding latency.
    const touched = touchRegistry(env, userId, request.headers.get('X-Timezone'));
    if (touched) ctx.waitUntil(touched);

    const stub = await getAgentByName(env.CoachAgent, userId);
    const response = await stub.fetch(request);
    // Re-wrap so we can add CORS headers (the DO response's headers are immutable).
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
