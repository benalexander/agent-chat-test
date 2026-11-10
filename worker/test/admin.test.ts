import { env, exports } from 'cloudflare:workers';
import { listDurableObjectIds } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  AdminActionResponse,
  AdminUserDetail,
  AdminUsersResponse,
  RegistryEntry,
  UpdateCampaignResponse,
} from '@agent-chat/shared';
import { ADMIN_SECRET, adminApi, api, SECRET, waitFor } from './helpers';

async function listUsers(): Promise<RegistryEntry[]> {
  const res = await adminApi('/users');
  expect(res.status).toBe(200);
  return (await res.json<AdminUsersResponse>()).users;
}

async function registered(userId: string): Promise<RegistryEntry> {
  return waitFor(async () => (await listUsers()).find((u) => u.userId === userId));
}

async function detail(userId: string): Promise<AdminUserDetail> {
  const res = await adminApi(`/users/${userId}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function chat(userId: string, clientMessageId: string, text: string) {
  const res = await api(userId, 'chat', { method: 'POST', body: JSON.stringify({ clientMessageId, text }) });
  await res.text();
  expect(res.status).toBe(200);
}

describe('admin auth', () => {
  it('401 without a token or with the app secret; 200 with the admin secret', async () => {
    expect((await adminApi('/users', { auth: null })).status).toBe(401);
    expect((await adminApi('/users', { auth: SECRET })).status).toBe(401);
    expect((await adminApi('/users/anyone', { auth: SECRET })).status).toBe(401);
    const ok = await adminApi('/users');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('admin secret is rejected on the app API', async () => {
    expect((await api('admin-auth-user', 'messages?since=0', { auth: ADMIN_SECRET })).status).toBe(401);
  });
});

describe('registry', () => {
  it('an app request registers the user with its timezone', async () => {
    const user = 'reg-tz';
    await api(user, 'messages?since=0', { headers: { 'X-Timezone': 'Europe/London' } });
    const entry = await registered(user);
    expect(entry.timezone).toBe('Europe/London');
    expect(entry.firstSeen).toBeGreaterThan(0);
    expect(entry.lastSeen).toBeGreaterThanOrEqual(entry.firstSeen);
  });

  it('lists users by lastSeen, newest first', async () => {
    await api('reg-sort-z', 'messages?since=0');
    await registered('reg-sort-z');
    await new Promise((r) => setTimeout(r, 20));
    await api('reg-sort-a', 'messages?since=0');
    await registered('reg-sort-a');
    const users = await listUsers();
    const ids = users.map((u) => u.userId);
    expect(ids.indexOf('reg-sort-a')).toBeLessThan(ids.indexOf('reg-sort-z'));
    for (let i = 1; i < users.length; i++) expect(users[i - 1].lastSeen).toBeGreaterThanOrEqual(users[i].lastSeen);
  });

  it('the agent pushes its summary after a chat', async () => {
    const user = 'reg-summary';
    await chat(user, 'm-1', 'hello');
    const entry = await waitFor(async () => {
      const e = (await listUsers()).find((u) => u.userId === user);
      return e?.summary?.messageCount === 2 ? e : null;
    });
    expect(entry.summary).toMatchObject({ messageCount: 2, raised: 120, target: 500, currency: 'AUD' });
    expect(entry.summary!.lastMessageAt).toBeGreaterThan(0);
  });

  it('unknown user → 404 and no agent is created', async () => {
    const user = 'never-seen-typo';
    for (const [path, init] of [
      [`/users/${user}`, {}],
      [`/users/${user}/proactive`, { method: 'POST', body: '{}' }],
      [`/users/${user}/campaign`, { method: 'PATCH', body: '{"raised":1}' }],
      [`/users/${user}`, { method: 'DELETE' }],
    ] as const) {
      const res = await adminApi(path, init);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown_user' });
    }
    const target = env.CoachAgent.idFromName(user);
    const ids = await listDurableObjectIds(env.CoachAgent);
    expect(ids.some((id) => id.equals(target))).toBe(false);
  });
});

describe('admin actions', () => {
  it('forced proactive shows up in detail; admin calls are not device activity', async () => {
    const user = 'admin-proactive';
    await chat(user, 'm-1', 'hi coach');
    const before = await registered(user);
    expect(before.timezone).toBe('Australia/Melbourne');

    const res = await adminApi(`/users/${user}/proactive`, {
      method: 'POST',
      body: JSON.stringify({ trigger: 'manual' }),
      headers: { 'X-Timezone': 'Asia/Tokyo' },
    });
    expect(res.status).toBe(200);
    const body = await res.json<AdminActionResponse>();
    expect(body).toMatchObject({ ok: true, outcome: 'sent' });

    const d = await detail(user);
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const last = d.messages[2];
    expect(last.metadata).toMatchObject({ origin: 'proactive', trigger: 'manual' });
    expect(last.text).toBe(body.message);
    expect(last.parts[0]).toMatchObject({ type: 'text' });
    expect(d.messages.map((m) => m.rev)).toEqual([1, 2, 3]);
    expect(d.state.timezone).toBe('Australia/Melbourne');
    expect(d.tokenTotals.chat.calls).toBe(1);
    expect(d.tokenTotals.proactive.calls).toBe(1);
    expect(d.tokenTotals.proactive.outputTokens).toBeGreaterThan(0);
    expect(d.user.lastSeen).toBe(before.lastSeen);
    expect(d.user.timezone).toBe('Australia/Melbourne');
    expect(d.user.summary?.messageCount).toBe(3);
  });

  it('PATCH campaign recomputes milestonesHit and sends nothing', async () => {
    const user = 'admin-patch';
    await api(user, 'messages?since=0');
    await registered(user);

    const bad = await adminApi(`/users/${user}/campaign`, { method: 'PATCH', body: JSON.stringify({ target: 0 }) });
    expect(bad.status).toBe(400);

    const res = await adminApi(`/users/${user}/campaign`, {
      method: 'PATCH',
      body: JSON.stringify({ raised: 300, donorCount: 9 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<UpdateCampaignResponse>();
    expect(body.ok).toBe(true);
    expect(body.campaign).toMatchObject({ raised: 300, target: 500, donorCount: 9, milestonesHit: [25, 50] });

    // Lowering raised un-hits thresholds.
    const lower = await adminApi(`/users/${user}/campaign`, { method: 'PATCH', body: JSON.stringify({ raised: 130 }) });
    expect((await lower.json<UpdateCampaignResponse>()).campaign.milestonesHit).toEqual([25]);

    const d = await detail(user);
    expect(d.messages).toEqual([]);
    expect(d.state.proactiveLog).toEqual([]);
    expect(d.state.llmLog).toEqual([]);
    expect(d.user.summary).toMatchObject({ raised: 130, target: 500, messageCount: 0 });
  });

  it('reset keeps the user registered', async () => {
    const user = 'admin-reset';
    await chat(user, 'm-1', 'hello');
    await registered(user);
    const res = await adminApi(`/users/${user}/reset`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const d = await detail(user);
    expect(d.messages).toEqual([]);
    expect(d.user.summary).toMatchObject({ messageCount: 0, raised: 120 });
  });

  it('DELETE wipes the agent and unregisters the user', async () => {
    const user = 'admin-delete';
    await chat(user, 'm-1', 'hello');
    await registered(user);

    const res = await adminApi(`/users/${user}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    expect((await listUsers()).some((u) => u.userId === user)).toBe(false);
    const gone = await adminApi(`/users/${user}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'unknown_user' });
    // Give any stray push a chance to (wrongly) re-create the entry.
    await new Promise((r) => setTimeout(r, 100));
    expect((await listUsers()).some((u) => u.userId === user)).toBe(false);

    // The device coming back gets a fresh agent (messages and rev counter wiped)...
    const sync = await api(user, 'messages?since=0');
    expect(await sync.json()).toEqual({ messages: [], latestRev: 0 });
    // ...and re-registers.
    await registered(user);
  });
});

describe('static assets', () => {
  // exports.default.fetch calls the Worker directly (the assets router isn't in front of
  // it in vitest-pool-workers), so check the ASSETS binding for the admin UI itself.
  it('/admin/ serves the admin UI; / and /health are still the worker', async () => {
    const res = await env.ASSETS.fetch(new Request('https://worker.test/admin/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<html');
    // "/admin" (no slash) redirects to "/admin/" (default html_handling).
    const bare = await env.ASSETS.fetch(new Request('https://worker.test/admin'), { redirect: 'manual' } as RequestInit);
    expect([200, 307, 308]).toContain(bare.status);
    // No root index.html: "/" is not an asset, so it falls through to the Worker.
    expect((await env.ASSETS.fetch(new Request('https://worker.test/'))).status).toBe(404);

    for (const path of ['/', '/health']) {
      const r = await exports.default.fetch(new Request(`https://worker.test${path}`));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
  });
});
