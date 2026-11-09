import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { SyncResponse } from '@agent-chat/shared';
import { api } from './helpers';

async function sync(userId: string, since: number): Promise<SyncResponse> {
  const res = await api(userId, `messages?since=${since}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function chat(userId: string, clientMessageId: string, text: string) {
  const res = await api(userId, 'chat', { method: 'POST', body: JSON.stringify({ clientMessageId, text }) });
  const body = await res.text(); // drain the SSE stream
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

describe('rev cursor', () => {
  it('insert bumps rev; since returns rows in rev order', async () => {
    const user = 'rev-insert';
    const r = await chat(user, 'msg-1', 'hello');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    expect(r.body).toContain('"type":"text-delta"');

    const all = await sync(user, 0);
    expect(all.messages.map((m) => [m.id, m.role, m.origin])).toEqual([
      ['msg-1', 'user', 'user'],
      [expect.stringMatching(/^reply_/), 'assistant', 'reply'],
    ]);
    expect(all.messages.map((m) => m.rev)).toEqual([1, 2]);
    expect(all.latestRev).toBe(2);
    expect(all.messages[1].text.length).toBeGreaterThan(10);
    expect(all.messages.every((m) => m.complete && m.createdAt > 0)).toBe(true);

    await chat(user, 'msg-2', 'any ideas for a post?');
    const delta = await sync(user, 2);
    expect(delta.messages.map((m) => m.rev)).toEqual([3, 4]);
    expect(delta.messages[0].id).toBe('msg-2');
    expect(delta.latestRev).toBe(4);

    const none = await sync(user, 4);
    expect(none).toEqual({ messages: [], latestRev: 4 });
  });

  it('update bumps rev and moves the message past the cursor; unchanged rewrite does not', async () => {
    const user = 'rev-update';
    await chat(user, 'msg-1', 'hello');
    const before = await sync(user, 0);
    expect(before.latestRev).toBe(2);
    const replyId = before.messages[1].id;

    const stub = await getAgentByName(env.CoachAgent, user);
    await runInDurableObject(stub, async (agent) => {
      // Rewrite identical content: no bump.
      await agent.persistMessages([...agent.messages]);
      // Update the reply's text: bump.
      const updated = agent.messages.map((m) =>
        m.id === replyId ? { ...m, parts: [{ type: 'text' as const, text: 'edited reply' }] } : m,
      );
      await agent.persistMessages(updated);
    });

    const after = await sync(user, 2);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]).toMatchObject({ id: replyId, rev: 3, text: 'edited reply', origin: 'reply' });
    expect(after.latestRev).toBe(3);

    // Full sync shows each message once at its latest rev, ordered by rev.
    const full = await sync(user, 0);
    expect(full.messages.map((m) => [m.id, m.rev])).toEqual([
      ['msg-1', 1],
      [replyId, 3],
    ]);
  });

  it('chat is idempotent on clientMessageId (409 once replied)', async () => {
    const user = 'rev-idem';
    expect((await chat(user, 'dup-1', 'hello')).status).toBe(200);
    const again = await chat(user, 'dup-1', 'hello');
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body)).toMatchObject({ error: 'duplicate', replied: true });
    const all = await sync(user, 0);
    expect(all.messages.filter((m) => m.id === 'dup-1')).toHaveLength(1);
    expect(all.messages).toHaveLength(2);
  });
});

describe('proactive via debug endpoints', () => {
  it('donation crossing a milestone produces a proactive message; reset restores the seed', async () => {
    const user = 'proactive-1';
    // Use a timezone where it is currently daytime so quiet hours don't interfere.
    const tz = ['Etc/GMT+12', 'Etc/GMT+9', 'Etc/GMT+6', 'Etc/GMT+3', 'UTC', 'Etc/GMT-3', 'Etc/GMT-6', 'Etc/GMT-9', 'Etc/GMT-12'].find(
      (z) => {
        const h = Number(new Intl.DateTimeFormat('en-AU', { timeZone: z, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
        return h >= 9 && h < 20;
      },
    )!;
    const res = await api(user, 'debug/donation', {
      method: 'POST',
      headers: { 'X-Timezone': tz },
      body: JSON.stringify({ amount: 20, donorName: 'Sam' }), // 120 → 140 = 28% crosses 25%
    });
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'sent' });
    const s = await sync(user, 0);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: 'assistant', origin: 'proactive', trigger: 'milestone' });

    const state = await (await api(user, 'debug/state', { headers: { 'X-Timezone': tz } })).json<any>();
    expect(state.campaign.milestonesHit).toEqual([25]);
    expect(state.proactiveSentToday).toBe(1);
    expect(state.timezone).toBe(tz);
    expect(state.schedules.filter((x: any) => x.callback === 'proactiveTick')).toHaveLength(1);

    const reset = await api(user, 'debug/reset', { method: 'POST' });
    expect(await reset.json()).toMatchObject({ ok: true });
    const afterReset = await sync(user, 0);
    expect(afterReset.messages).toEqual([]);
    const state2 = await (await api(user, 'debug/state')).json<any>();
    expect(state2.campaign.raised).toBe(120);
    expect(state2.proactiveLog).toEqual([]);
    expect(state2.schedules.filter((x: any) => x.callback === 'proactiveTick')).toHaveLength(1);
  });
});
