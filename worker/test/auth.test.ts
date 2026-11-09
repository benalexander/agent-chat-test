import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('auth', () => {
  it('401 without Authorization', async () => {
    const res = await api('auth-user', 'messages?since=0', { auth: null });
    expect(res.status).toBe(401);
  });

  it('401 with the wrong secret', async () => {
    const res = await api('auth-user', 'messages?since=0', { auth: 'wrong' });
    expect(res.status).toBe(401);
    const res2 = await api('auth-user', 'debug/reset', { method: 'POST', auth: 'test-secret-but-longer' });
    expect(res2.status).toBe(401);
  });

  it('200 with the right secret', async () => {
    const res = await api('auth-user', 'messages?since=0');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], latestRev: 0 });
  });
});
