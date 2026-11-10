/**
 * /admin/api/* — the admin panel's API. Contract: shared/src/admin.ts.
 *
 * Same-origin with the admin UI (served from static assets at /admin/), so no CORS.
 * Every per-user route checks the Registry first and 404s unknown userIds before
 * touching the agent, so a typo never creates a Durable Object. Agents are called via
 * DO RPC (never their onRequest), so admin calls don't update the device timezone or
 * any activity markers.
 */
import { getAgentByName } from 'agents';
import type {
  AdminActionResponse,
  AdminErrorResponse,
  AdminUserDetail,
  AdminUsersResponse,
  UpdateCampaignResponse,
} from '@agent-chat/shared';
import { ADMIN_API_PREFIX } from '@agent-chat/shared';
import { isAdminAuthorized } from './auth';
import { registryStub } from './registry';
import { DonationSchema, ForceSchema, MilestoneSchema, readJson, UpdateCampaignSchema } from './schemas';
import { forgetTouch } from './touch';

const USER_PATH = /^\/users\/([A-Za-z0-9_-]{1,128})(?:\/([a-z]+))?\/?$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function error(status: number, code: string, message?: string): Response {
  const body: AdminErrorResponse = { error: code, ...(message ? { message } : {}) };
  return json(body, status);
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseBody<T>(
  request: Request,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
): Promise<Parsed<T>> {
  const body = await readJson(request);
  if (body === undefined) return { ok: false, response: error(400, 'invalid_json') };
  const p = schema.safeParse(body);
  if (!p.success) return { ok: false, response: error(400, 'invalid_body', p.error.message) };
  return { ok: true, data: p.data };
}

export function isAdminApiPath(pathname: string): boolean {
  return pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`);
}

export async function handleAdmin(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) return error(401, 'unauthorized');
  try {
    return await route(request, env);
  } catch (e) {
    console.error('[admin] request failed', request.method, new URL(request.url).pathname, e);
    return error(500, 'internal', e instanceof Error ? e.message : String(e));
  }
}

async function route(request: Request, env: Cloudflare.Env): Promise<Response> {
  const path = new URL(request.url).pathname.slice(ADMIN_API_PREFIX.length);
  const method = request.method.toUpperCase();
  const registry = registryStub(env);

  if (path === '/users' || path === '/users/') {
    if (method !== 'GET') return error(405, 'method_not_allowed');
    const body: AdminUsersResponse = { users: await registry.list() };
    return json(body);
  }

  const m = USER_PATH.exec(path);
  if (!m) return error(404, 'not_found');
  const [, userId, action] = m;

  const allowed: Record<string, string> = {
    '': 'GET DELETE',
    donation: 'POST',
    milestone: 'POST',
    inactivity: 'POST',
    proactive: 'POST',
    reset: 'POST',
    campaign: 'PATCH',
  };
  const methods = allowed[action ?? ''];
  if (!methods) return error(404, 'not_found');
  if (!methods.split(' ').includes(method)) return error(405, 'method_not_allowed');

  // Registry gate: unknown users never reach (or create) an agent.
  const user = await registry.get(userId);
  if (!user) return error(404, 'unknown_user');

  if (action === undefined && method === 'GET') {
    const agent = await getAgentByName(env.CoachAgent, userId);
    // Cast: the RPC stub's type collapses `unknown`-valued fields (message parts) to
    // never, but the value is structured-cloned unchanged.
    const detail = (await agent.adminDetail()) as unknown as Omit<AdminUserDetail, 'user'>;
    // Re-read: the agent may have just pushed a fresher summary.
    const body: AdminUserDetail = { user: (await registry.get(userId)) ?? user, ...detail };
    return json(body);
  }

  if (action === undefined && method === 'DELETE') {
    const agent = await getAgentByName(env.CoachAgent, userId);
    try {
      await agent.adminDestroy();
    } catch (e) {
      // Agent.destroy() aborts the DO isolate right after wiping storage; depending on
      // timing the RPC caller sees that abort as an error even though the wipe is done.
      if (!/destroyed|abort/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    await registry.remove(userId);
    forgetTouch(userId);
    const body: AdminActionResponse = { ok: true, message: `deleted ${userId}` };
    return json(body);
  }

  switch (action) {
    case 'donation': {
      const p = await parseBody(request, DonationSchema);
      if (!p.ok) return p.response;
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.injectDonation(p.data)) satisfies AdminActionResponse);
    }
    case 'milestone': {
      const p = await parseBody(request, MilestoneSchema);
      if (!p.ok) return p.response;
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.injectMilestone(p.data.percent)) satisfies AdminActionResponse);
    }
    case 'inactivity': {
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.injectInactivity()) satisfies AdminActionResponse);
    }
    case 'proactive': {
      const p = await parseBody(request, ForceSchema);
      if (!p.ok) return p.response;
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.forceProactive(p.data.trigger)) satisfies AdminActionResponse);
    }
    case 'reset': {
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.resetAgent()) satisfies AdminActionResponse);
    }
    case 'campaign': {
      const p = await parseBody(request, UpdateCampaignSchema);
      if (!p.ok) return p.response;
      const agent = await getAgentByName(env.CoachAgent, userId);
      return json((await agent.adminUpdateCampaign(p.data)) satisfies UpdateCampaignResponse);
    }
  }
  return error(404, 'not_found');
}
