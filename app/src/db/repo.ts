/** All SQLite reads and writes. Writes emit change events (lib/events.ts). */
import type { MessageOrigin, ProactiveTrigger } from '@agent-chat/shared';

import { emit } from '../lib/events';
import type { LocalMessage, LocalStatus } from '../sync/merge';
import { getDb } from './db';

// ---------- kv ----------

export const KV = {
  /** Sync cursor: highest server rev applied locally. */
  lastRev: 'sync:last_rev',
  /** Highest rev the user has seen with Coach visible in the foreground. */
  lastSeenRev: 'sync:last_seen_rev',
  /** Set once the first-launch notification permission prompt has been shown. */
  notifPromptShown: 'notif:prompt_shown',
  /** Result of registering the background task (JSON). */
  backgroundSetup: 'bg:setup',
  /** Result of the last push-token registration attempt (JSON PushSetup). */
  pushSetup: 'push:setup',
  /** Expo push token the server has acknowledged (set only after a successful PUT). */
  pushToken: 'push:token',
} as const;
type KvKey = (typeof KV)[keyof typeof KV];

export async function kvGet(key: KvKey): Promise<string | null> {
  const row = await getDb().getFirstAsync<{ value: string | null }>('SELECT value FROM kv WHERE key = ?', key);
  return row?.value ?? null;
}

export async function kvSet(key: KvKey, value: string): Promise<void> {
  await getDb().runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
  emit('kv');
}

export async function kvGetNumber(key: KvKey): Promise<number> {
  const v = Number(await kvGet(key));
  return Number.isFinite(v) ? v : 0;
}

/** Only ever raises the stored number (lastRev / lastSeenRev are monotonic). */
export async function kvRaiseNumber(key: KvKey, value: number): Promise<number> {
  await getDb().runAsync(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
    key,
    String(value),
  );
  emit('kv');
  return kvGetNumber(key);
}

// ---------- messages ----------

interface MessageRow {
  id: string;
  rev: number | null;
  role: string;
  text: string;
  origin: string;
  trigger: string | null;
  created_at: number;
  complete: number;
  status: string;
  notified: number;
}

const toMessage = (r: MessageRow): LocalMessage => ({
  id: r.id,
  rev: r.rev,
  role: r.role as LocalMessage['role'],
  text: r.text,
  origin: r.origin as MessageOrigin,
  trigger: (r.trigger as ProactiveTrigger | null) ?? null,
  createdAt: r.created_at,
  complete: r.complete === 1,
  status: r.status as LocalStatus,
  notified: r.notified === 1,
});

/**
 * Newest first (the chat list is inverted). Synced messages are ordered by rev;
 * unsynced (rev NULL) local messages sort as newest.
 */
export async function listMessages(limit = 500): Promise<LocalMessage[]> {
  const rows = await getDb().getAllAsync<MessageRow>(
    `SELECT * FROM messages
     ORDER BY (rev IS NULL) DESC, rev DESC, created_at DESC
     LIMIT ?`,
    limit,
  );
  return rows.map(toMessage);
}

export async function getMessagesByIds(ids: readonly string[]): Promise<Map<string, LocalMessage>> {
  const out = new Map<string, LocalMessage>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await getDb().getAllAsync<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders})`, ...ids);
  for (const r of rows) out.set(r.id, toMessage(r));
  return out;
}

/** Candidates for notification / unread: complete assistant messages above a rev. */
export async function listAssistantAbove(rev: number): Promise<LocalMessage[]> {
  const rows = await getDb().getAllAsync<MessageRow>(
    `SELECT * FROM messages WHERE role = 'assistant' AND complete = 1 AND rev > ? ORDER BY rev ASC`,
    rev,
  );
  return rows.map(toMessage);
}

export async function countUnreadAbove(rev: number): Promise<number> {
  const row = await getDb().getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND complete = 1 AND rev > ?`,
    rev,
  );
  return row?.n ?? 0;
}

export async function maxRev(): Promise<number> {
  const row = await getDb().getFirstAsync<{ r: number | null }>('SELECT MAX(rev) AS r FROM messages');
  return row?.r ?? 0;
}

/** Apply merge results and the new cursor in one transaction. */
export async function applyMerge(upserts: readonly LocalMessage[], nextRev: number): Promise<void> {
  const db = getDb();
  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const m of upserts) {
      await tx.runAsync(
        `INSERT OR REPLACE INTO messages
         (id, rev, role, text, origin, trigger, created_at, complete, status, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id,
        m.rev,
        m.role,
        m.text,
        m.origin,
        m.trigger,
        m.createdAt,
        m.complete ? 1 : 0,
        m.status,
        m.notified ? 1 : 0,
      );
    }
    await tx.runAsync(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
      KV.lastRev,
      String(nextRev),
    );
  });
  emit('messages', 'kv');
}

/** A user message written locally before the server confirms it. */
export async function insertPendingUserMessage(id: string, text: string): Promise<void> {
  await getDb().runAsync(
    `INSERT OR IGNORE INTO messages (id, rev, role, text, origin, trigger, created_at, complete, status, notified)
     VALUES (?, NULL, 'user', ?, 'user', NULL, ?, 1, 'pending', 1)`,
    id,
    text,
    Date.now(),
  );
  emit('messages');
}

/** pending <-> failed for unconfirmed user messages. A synced (sent) row is never downgraded. */
export async function setLocalStatus(id: string, status: 'pending' | 'failed'): Promise<void> {
  await getDb().runAsync(`UPDATE messages SET status = ? WHERE id = ? AND status != 'sent'`, status, id);
  emit('messages');
}

export async function getMessage(id: string): Promise<LocalMessage | null> {
  const row = await getDb().getFirstAsync<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  return row ? toMessage(row) : null;
}

export async function markNotified(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await getDb().runAsync(`UPDATE messages SET notified = 1 WHERE id IN (${placeholders})`, ...ids);
  emit('messages');
}

/** Everything up to `rev` has been seen in the foreground: never notify it later. */
export async function markHandledUpTo(rev: number): Promise<void> {
  await getDb().runAsync(`UPDATE messages SET notified = 1 WHERE notified = 0 AND rev <= ?`, rev);
}

// ---------- bg_runs ----------

export type RunSource = 'background_task' | 'manual';

export interface BgRun {
  id: number;
  wokeAt: number;
  finishedAt: number | null;
  source: RunSource;
  appState: string | null;
  fetched: number;
  notified: number;
  error: string | null;
}

export async function startBgRun(source: RunSource, appState: string): Promise<number> {
  const res = await getDb().runAsync(
    'INSERT INTO bg_runs (woke_at, source, app_state) VALUES (?, ?, ?)',
    Date.now(),
    source,
    appState,
  );
  emit('bg_runs');
  return res.lastInsertRowId;
}

export async function finishBgRun(
  id: number,
  r: { fetched: number; notified: number; error: string | null },
): Promise<void> {
  await getDb().runAsync(
    'UPDATE bg_runs SET finished_at = ?, fetched = ?, notified = ?, error = ? WHERE id = ?',
    Date.now(),
    r.fetched,
    r.notified,
    r.error,
    id,
  );
  emit('bg_runs');
}

export async function listBgRuns(limit = 200): Promise<BgRun[]> {
  const rows = await getDb().getAllAsync<{
    id: number;
    woke_at: number;
    finished_at: number | null;
    source: string;
    app_state: string | null;
    fetched: number;
    notified: number;
    error: string | null;
  }>('SELECT * FROM bg_runs ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id,
    wokeAt: r.woke_at,
    finishedAt: r.finished_at,
    source: r.source as RunSource,
    appState: r.app_state,
    fetched: r.fetched,
    notified: r.notified,
    error: r.error,
  }));
}

// ---------- notification_deliveries ----------

export type DeliverySource = 'local' | 'push';

export interface Delivery {
  id: number;
  source: DeliverySource;
  messageId: string;
  createdAt: number;
  notifiedAt: number;
  delayMs: number;
  grouped: boolean;
  bgRunId: number | null;
}

export async function recordDeliveries(
  items: readonly { messageId: string; createdAt: number }[],
  notifiedAt: number,
  bgRunId: number | null,
): Promise<void> {
  const db = getDb();
  const grouped = items.length > 1 ? 1 : 0;
  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const it of items) {
      await tx.runAsync(
        `INSERT INTO notification_deliveries (message_id, created_at, notified_at, delay_ms, grouped, bg_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        it.messageId,
        it.createdAt,
        notifiedAt,
        Math.max(0, notifiedAt - it.createdAt),
        grouped,
        bgRunId,
      );
    }
  });
  emit('deliveries');
}

/**
 * A push notification iOS delivered at `deliveredAt` (notification.date). Idempotent per
 * message: the same push is seen several ways (received in foreground, tapped,
 * still in Notification Centre), and only the first sighting is stored.
 */
export async function recordPushDelivery(messageId: string, createdAt: number, deliveredAt: number): Promise<boolean> {
  const res = await getDb().runAsync(
    `INSERT OR IGNORE INTO notification_deliveries (message_id, created_at, notified_at, delay_ms, grouped, bg_run_id, source)
     VALUES (?, ?, ?, ?, 0, NULL, 'push')`,
    messageId,
    createdAt,
    deliveredAt,
    Math.max(0, deliveredAt - createdAt),
  );
  if (res.changes > 0) emit('deliveries');
  return res.changes > 0;
}

export async function listDeliveries(limit = 500): Promise<Delivery[]> {
  const rows = await getDb().getAllAsync<{
    id: number;
    message_id: string;
    created_at: number;
    notified_at: number;
    delay_ms: number;
    grouped: number;
    bg_run_id: number | null;
    source: string;
  }>('SELECT * FROM notification_deliveries ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id,
    source: r.source as DeliverySource,
    messageId: r.message_id,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    delayMs: r.delay_ms,
    grouped: r.grouped === 1,
    bgRunId: r.bg_run_id,
  }));
}
