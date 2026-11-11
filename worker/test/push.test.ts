import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { DebugActionResponse, DebugState } from '@agent-chat/shared';
import { EXPO_PUSH_RECEIPTS_URL, EXPO_PUSH_SEND_URL } from '../src/push';
import { adminApi, api, waitFor } from './helpers';

const TOKEN = 'ExponentPushToken[abc123xyz456def]';

interface Call {
  url: string;
  headers: Headers;
  body: any;
}

/** Installs a fake Expo push service on the user's agent and returns the recorded calls. */
async function stubExpo(
  user: string,
  respond: (call: Call) => { status?: number; body: unknown } = () => ({
    body: { data: [{ status: 'ok', id: 'ticket-1' }] },
  }),
) {
  const calls: Call[] = [];
  const stub = await getAgentByName(env.CoachAgent, user);
  await runInDurableObject(stub, async (agent) => {
    agent.pushFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      calls.push(call);
      const r = respond(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch;
  });
  return { calls, stub };
}

const registerToken = (user: string, token = TOKEN) =>
  api(user, 'push-token', { method: 'PUT', body: JSON.stringify({ token }) });

const state = async (user: string) => (await api(user, 'debug/state')).json<DebugState>();

const force = async (user: string) =>
  (await api(user, 'debug/proactive', { method: 'POST', body: JSON.stringify({ trigger: 'manual' }) })).json<DebugActionResponse>();

describe('push token route', () => {
  it('requires the app secret and an Expo token', async () => {
    const user = 'push-token-route';
    expect((await api(user, 'push-token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }), auth: null })).status).toBe(401);
    expect((await registerToken(user, 'not-a-token')).status).toBe(400);
    expect((await state(user)).push.tokenTail).toBeNull();

    expect((await registerToken(user)).status).toBe(200);
    const s = await state(user);
    expect(s.push.tokenTail).toBe(TOKEN.slice(-12));
    expect(s.push.tokenUpdatedAt).toBeTypeOf('number');
  });

  it('allows PUT in CORS preflight', async () => {
    const res = await api('push-cors', 'push-token', { method: 'OPTIONS' });
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
  });
});

describe('push on proactive send', () => {
  it('logs no_token when the device has not registered', async () => {
    const user = 'push-none';
    const { calls } = await stubExpo(user);
    expect(await force(user)).toMatchObject({ outcome: 'sent' });
    expect(calls).toHaveLength(0);
    expect((await state(user)).push.log[0]).toMatchObject({ kind: 'proactive', ticket: 'no_token' });
  });

  it('sends the message preview to Expo and schedules a receipt check', async () => {
    const user = 'push-send';
    await registerToken(user);
    const { calls } = await stubExpo(user);
    const r = await force(user);
    expect(r.outcome).toBe('sent');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(EXPO_PUSH_SEND_URL);
    const [msg] = calls[0].body;
    const s = await state(user);
    const last = s.push.log[0];
    expect(msg).toMatchObject({ to: TOKEN, title: 'Your coach', body: r.message, sound: 'default' });
    expect(msg.data).toMatchObject({ url: '/', kind: 'proactive', messageId: last.messageId });
    expect(msg.data.createdAt).toBeTypeOf('number');
    expect(last).toMatchObject({ kind: 'proactive', ticket: 'ok', ticketId: 'ticket-1' });
    expect(s.schedules.some((x) => x.callback === 'checkPushReceipts')).toBe(true);
  });

  it('sends EXPO_ACCESS_TOKEN only when configured', async () => {
    const user = 'push-auth-header';
    await registerToken(user);
    const { calls } = await stubExpo(user);
    await force(user);
    expect(calls[0].headers.get('authorization')).toBeNull(); // not set in tests
  });

  it('a failed push still sends the message, and DeviceNotRegistered drops the token', async () => {
    const user = 'push-dead';
    await registerToken(user);
    await stubExpo(user, () => ({
      body: { data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] },
    }));
    expect(await force(user)).toMatchObject({ ok: true, outcome: 'sent' });
    const s = await state(user);
    expect(s.push.log[0]).toMatchObject({ ticket: 'error', error: 'DeviceNotRegistered' });
    expect(s.push.tokenTail).toBeNull();
    const msgs = await (await api(user, 'messages?since=0')).json<any>();
    expect(msgs.messages.at(-1)).toMatchObject({ origin: 'proactive' });
  });

  it('a transport error is logged without dropping the token', async () => {
    const user = 'push-500';
    await registerToken(user);
    await stubExpo(user, () => ({ status: 500, body: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } }));
    expect(await force(user)).toMatchObject({ outcome: 'sent' });
    const s = await state(user);
    expect(s.push.log[0]).toMatchObject({ ticket: 'error', error: 'INTERNAL_SERVER_ERROR' });
    expect(s.push.tokenTail).not.toBeNull();
  });

  it('reset keeps the push token', async () => {
    const user = 'push-reset';
    await registerToken(user);
    await api(user, 'debug/reset', { method: 'POST' });
    expect((await state(user)).push.tokenTail).toBe(TOKEN.slice(-12));
  });
});

describe('push receipts', () => {
  it('records receipts and drops the token on DeviceNotRegistered', async () => {
    const user = 'push-receipts';
    await registerToken(user);
    const { calls, stub } = await stubExpo(user, (call) =>
      call.url === EXPO_PUSH_SEND_URL
        ? { body: { data: [{ status: 'ok', id: 'ticket-r' }] } }
        : { body: { data: { 'ticket-r': { status: 'error', details: { error: 'DeviceNotRegistered' } } } } },
    );
    await force(user);
    await runInDurableObject(stub, (agent) => agent.checkPushReceipts({ ticketIds: ['ticket-r'] }));
    expect(calls[1]).toMatchObject({ url: EXPO_PUSH_RECEIPTS_URL, body: { ids: ['ticket-r'] } });
    const s = await state(user);
    expect(s.push.log[0]).toMatchObject({ ticketId: 'ticket-r', receipt: 'error', error: 'DeviceNotRegistered' });
    expect(s.push.tokenTail).toBeNull();
  });
});

describe('test push', () => {
  it('app debug route and admin route send a test push', async () => {
    const user = 'push-test';
    await registerToken(user);
    const { calls } = await stubExpo(user);
    const r = await (await api(user, 'debug/push-test', { method: 'POST' })).json<DebugActionResponse>();
    expect(r).toMatchObject({ ok: true });
    expect(calls[0].body[0].data).toMatchObject({ kind: 'test' });

    // Admin route: the registry is written in waitUntil, so wait for the user to appear.
    await waitFor(async () => (await adminApi(`/users/${user}`)).status === 200);
    const a = await (await adminApi(`/users/${user}/push`, { method: 'POST' })).json<DebugActionResponse>();
    expect(a.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
