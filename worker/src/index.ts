import { getAgentByName } from 'agents';
import { CoachAgent } from './agent';

export { CoachAgent };

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-timezone',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

/** Constant-time-ish string compare (lengths leak, which is fine for this POC). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorized(request: Request, env: Cloudflare.Env): boolean {
  const secret = env.APP_SHARED_SECRET;
  if (!secret) return false; // fail closed if the secret isn't configured
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return !!match && safeEqual(match[1].trim(), secret);
}

// /api/:userId/<route>; userId = device-generated UUID (letters, digits, - and _).
const API_PATH = /^\/api\/([A-Za-z0-9_-]{1,128})\/(.+)$/;

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true }, 200);

    if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);

    const match = API_PATH.exec(url.pathname);
    if (!match) return json({ error: 'not_found' }, 404);

    const stub = await getAgentByName(env.CoachAgent, match[1]);
    const response = await stub.fetch(request);
    // Re-wrap so we can add CORS headers (the DO response's headers are immutable).
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
