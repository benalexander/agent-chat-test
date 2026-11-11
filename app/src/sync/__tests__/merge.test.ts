import type { SyncMessage, SyncResponse } from '@agent-chat/shared';

import {
  advanceSeenRev,
  buildNotificationContent,
  countUnread,
  delayStats,
  mergeSyncResponse,
  parsePushData,
  selectNotifiable,
  shouldPresent,
  type LocalMessage,
} from '../merge';

const server = (over: Partial<SyncMessage> & Pick<SyncMessage, 'id' | 'rev'>): SyncMessage => ({
  role: 'assistant',
  text: `text ${over.id}`,
  origin: 'reply',
  createdAt: 1_000 * over.rev,
  complete: true,
  ...over,
});

const local = (over: Partial<LocalMessage> & Pick<LocalMessage, 'id'>): LocalMessage => ({
  rev: null,
  role: 'assistant',
  text: `local ${over.id}`,
  origin: 'reply',
  trigger: null,
  createdAt: 0,
  complete: true,
  status: 'sent',
  notified: false,
  ...over,
});

const resp = (messages: SyncMessage[], latestRev: number): SyncResponse => ({ messages, latestRev });
const lookup = (rows: LocalMessage[]) => {
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id);
};

describe('mergeSyncResponse', () => {
  it('turns a pending local user message into sent with server fields', () => {
    const pending = local({ id: 'u1', role: 'user', origin: 'user', status: 'pending', text: 'hi', createdAt: 5 });
    const r = mergeSyncResponse(
      resp([server({ id: 'u1', rev: 3, role: 'user', origin: 'user', text: 'hi', createdAt: 3000 })], 3),
      0,
      lookup([pending]),
    );
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]).toMatchObject({ id: 'u1', rev: 3, status: 'sent', createdAt: 3000 });
    expect(r.updatedIds).toEqual(['u1']);
    expect(r.insertedIds).toEqual([]);
  });

  it('turns a failed local user message into sent (retry confirmed by a later sync)', () => {
    const failed = local({ id: 'u1', role: 'user', origin: 'user', status: 'failed' });
    const r = mergeSyncResponse(resp([server({ id: 'u1', rev: 4, role: 'user', origin: 'user' })], 4), 0, lookup([failed]));
    expect(r.upserts[0].status).toBe('sent');
  });

  it('server wins on text and completeness for an existing row', () => {
    const partial = local({ id: 'a1', rev: 2, complete: false, text: 'Hel' });
    const r = mergeSyncResponse(resp([server({ id: 'a1', rev: 5, text: 'Hello there' })], 5), 2, lookup([partial]));
    expect(r.upserts[0]).toMatchObject({ text: 'Hello there', complete: true, rev: 5 });
  });

  it('dedupes duplicate ids within one response, keeping the highest rev', () => {
    const r = mergeSyncResponse(
      resp([server({ id: 'a1', rev: 2, complete: false, text: 'He' }), server({ id: 'a1', rev: 4, text: 'Hello' })], 4),
      0,
      lookup([]),
    );
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]).toMatchObject({ rev: 4, text: 'Hello', complete: true });
    expect(r.insertedIds).toEqual(['a1']);
  });

  it('ignores server messages we already hold at the same or newer rev', () => {
    const have = local({ id: 'a1', rev: 7, text: 'newer' });
    const r = mergeSyncResponse(resp([server({ id: 'a1', rev: 7 })], 7), 7, lookup([have]));
    expect(r.upserts).toEqual([]);
    const older = mergeSyncResponse(resp([server({ id: 'a1', rev: 5, text: 'older' })], 7), 7, lookup([have]));
    expect(older.upserts).toEqual([]);
  });

  it('preserves the local notified flag when the server updates a message', () => {
    const notified = local({ id: 'a1', rev: 2, notified: true });
    const r = mergeSyncResponse(resp([server({ id: 'a1', rev: 3 })], 3), 2, lookup([notified]));
    expect(r.upserts[0].notified).toBe(true);
  });

  it('new messages start not notified', () => {
    const r = mergeSyncResponse(resp([server({ id: 'a2', rev: 1 })], 1), 0, lookup([]));
    expect(r.upserts[0].notified).toBe(false);
  });

  it('carries proactive origin and trigger', () => {
    const r = mergeSyncResponse(
      resp([server({ id: 'p1', rev: 1, origin: 'proactive', trigger: 'milestone' })], 1),
      0,
      lookup([]),
    );
    expect(r.upserts[0]).toMatchObject({ origin: 'proactive', trigger: 'milestone' });
  });

  describe('lastRev cursor', () => {
    it('advances to latestRev', () => {
      expect(mergeSyncResponse(resp([server({ id: 'a', rev: 3 })], 9), 2, lookup([])).nextRev).toBe(9);
    });
    it('advances to the highest message rev if latestRev lags', () => {
      expect(mergeSyncResponse(resp([server({ id: 'a', rev: 12 })], 10), 2, lookup([])).nextRev).toBe(12);
    });
    it('never goes backwards', () => {
      expect(mergeSyncResponse(resp([], 3), 10, lookup([])).nextRev).toBe(10);
      expect(mergeSyncResponse(resp([server({ id: 'a', rev: 4 })], 4), 10, lookup([])).nextRev).toBe(10);
    });
    it('stays put on an empty response', () => {
      expect(mergeSyncResponse(resp([], 5), 5, lookup([])).nextRev).toBe(5);
    });
  });

  it('orders upserts by rev', () => {
    const r = mergeSyncResponse(resp([server({ id: 'b', rev: 6 }), server({ id: 'a', rev: 4 })], 6), 0, lookup([]));
    expect(r.upserts.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('selectNotifiable', () => {
  const rows = [
    local({ id: 'seen', rev: 3 }),
    local({ id: 'fresh', rev: 6 }),
    local({ id: 'streaming', rev: 7, complete: false }),
    local({ id: 'already', rev: 8, notified: true }),
    local({ id: 'user', rev: 9, role: 'user', origin: 'user' }),
    local({ id: 'pending', rev: null, status: 'pending' }),
    local({ id: 'proactive', rev: 10, origin: 'proactive', trigger: 'checkin' }),
  ];

  it('only complete, unnotified assistant messages above lastSeenRev, ordered by rev', () => {
    expect(selectNotifiable(rows, 5).map((m) => m.id)).toEqual(['fresh', 'proactive']);
  });

  it('respects lastSeenRev exactly (rev must be strictly greater)', () => {
    expect(selectNotifiable(rows, 6).map((m) => m.id)).toEqual(['proactive']);
    expect(selectNotifiable(rows, 10)).toEqual([]);
  });

  it('includes everything unseen when lastSeenRev is 0', () => {
    expect(selectNotifiable(rows, 0).map((m) => m.id)).toEqual(['seen', 'fresh', 'proactive']);
  });
});

describe('countUnread', () => {
  it('counts complete assistant messages above lastSeenRev regardless of notified', () => {
    const rows = [
      local({ id: 'a', rev: 2 }),
      local({ id: 'b', rev: 5, notified: true }),
      local({ id: 'c', rev: 6, complete: false }),
      local({ id: 'u', rev: 7, role: 'user', origin: 'user' }),
    ];
    expect(countUnread(rows, 1)).toBe(2);
    expect(countUnread(rows, 5)).toBe(0);
  });
});

describe('buildNotificationContent', () => {
  it('returns null for nothing', () => {
    expect(buildNotificationContent([])).toBeNull();
  });
  it('previews a single message', () => {
    expect(buildNotificationContent([local({ id: 'a', text: '  Great   work today!\n' })])).toEqual({
      title: 'Your coach',
      body: 'Great work today!',
    });
  });
  it('truncates long previews', () => {
    const body = buildNotificationContent([local({ id: 'a', text: 'x'.repeat(500) })])!.body;
    expect(body.length).toBeLessThanOrEqual(178);
    expect(body.endsWith('…')).toBe(true);
  });
  it('groups several', () => {
    expect(buildNotificationContent([local({ id: 'a' }), local({ id: 'b' }), local({ id: 'c' })])!.body).toBe(
      'Your coach sent 3 messages',
    );
  });
});

describe('advanceSeenRev', () => {
  it('is monotonic', () => {
    expect(advanceSeenRev(5, 3)).toBe(5);
    expect(advanceSeenRev(5, 8)).toBe(8);
  });
});

describe('delayStats', () => {
  it('handles empty input', () => {
    expect(delayStats([])).toEqual({ count: 0, medianMs: null, p90Ms: null, maxMs: null });
  });
  it('computes nearest-rank median / p90 / max', () => {
    const d = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(delayStats(d)).toEqual({ count: 10, medianMs: 5, p90Ms: 9, maxMs: 10 });
  });
});

describe('push', () => {
  const proactive = { url: '/', kind: 'proactive', messageId: 'p1', createdAt: 1000 };

  it('parsePushData accepts only our pushes', () => {
    expect(parsePushData(proactive)).toEqual(proactive);
    expect(parsePushData({ url: '/', kind: 'test' })).toEqual({ url: '/', kind: 'test' });
    expect(parsePushData({ url: '/', messageIds: ['a'] })).toBeNull(); // local notification
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData({ kind: 'proactive', messageId: 7 })).toEqual({ url: '/', kind: 'proactive' });
  });

  it('hides a proactive push only while Coach is on screen in the foreground', () => {
    expect(shouldPresent(proactive, { appActive: true, coachVisible: true })).toBe(false);
    expect(shouldPresent(proactive, { appActive: true, coachVisible: false })).toBe(true);
    expect(shouldPresent(proactive, { appActive: false, coachVisible: true })).toBe(true);
  });

  it('always shows test pushes and local notifications', () => {
    const ctx = { appActive: true, coachVisible: true };
    expect(shouldPresent({ url: '/', kind: 'test' }, ctx)).toBe(true);
    expect(shouldPresent({ url: '/', messageIds: ['a'] }, ctx)).toBe(true);
  });
});
