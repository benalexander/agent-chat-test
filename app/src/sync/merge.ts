/**
 * Pure sync logic: no IO, no React Native imports, so it can be unit tested in
 * plain Jest. sync.ts does the fetching and writing; this decides what to write.
 */
import type { MessageOrigin, ProactiveTrigger, PushData, SyncMessage, SyncResponse } from '@agent-chat/shared';

export type LocalStatus = 'pending' | 'sent' | 'failed';

/** A row of the local `messages` table. */
export interface LocalMessage {
  id: string;
  /** Server rev; null for a local user message the server hasn't confirmed yet. */
  rev: number | null;
  role: 'user' | 'assistant';
  text: string;
  origin: MessageOrigin;
  trigger: ProactiveTrigger | null;
  /** ms since epoch. Server createdAt once synced; local clock while pending. */
  createdAt: number;
  complete: boolean;
  status: LocalStatus;
  /**
   * True once the message has been "handled" for notification purposes: either a
   * local notification was posted for it, or it was on screen in the Coach tab
   * (rev <= lastSeenRev), so it must never produce a late notification.
   */
  notified: boolean;
}

export interface MergeResult {
  /** Rows to insert or replace. Fields not owned by the server (notified) are carried over. */
  upserts: LocalMessage[];
  /** Ids of rows that were new locally. */
  insertedIds: string[];
  /** Ids of existing rows that changed (incl. pending -> sent). */
  updatedIds: string[];
  /** The cursor to store. Never lower than the current one. */
  nextRev: number;
}

/**
 * Merge a sync response into local state.
 *
 * - Server wins: a server message replaces the local row with the same id.
 *   A pending/failed local user message with that id (clientMessageId) becomes `sent`.
 * - Dedupe: duplicate ids in one response collapse to the highest rev; server
 *   messages whose rev is not newer than what we already hold are ignored.
 * - The cursor (lastRev) is monotonic: max(current, latestRev, highest rev seen).
 *
 * @param getLocal lookup of the current local row by id (from SQLite, or a Map in tests)
 */
export function mergeSyncResponse(
  response: SyncResponse,
  currentLastRev: number,
  getLocal: (id: string) => LocalMessage | undefined,
): MergeResult {
  // Collapse duplicates, keeping the highest rev per id.
  const latestById = new Map<string, SyncMessage>();
  for (const m of response.messages) {
    const prev = latestById.get(m.id);
    if (!prev || m.rev > prev.rev) latestById.set(m.id, m);
  }

  const upserts: LocalMessage[] = [];
  const insertedIds: string[] = [];
  const updatedIds: string[] = [];
  let maxRev = currentLastRev;

  const ordered = [...latestById.values()].sort((a, b) => a.rev - b.rev);
  for (const server of ordered) {
    maxRev = Math.max(maxRev, server.rev);
    const local = getLocal(server.id);
    if (local && local.rev !== null && local.rev >= server.rev && local.status === 'sent') {
      continue; // already have this version (or newer)
    }
    upserts.push(fromServer(server, local));
    if (local) updatedIds.push(server.id);
    else insertedIds.push(server.id);
  }

  const latest = Number.isFinite(response.latestRev) ? response.latestRev : 0;
  return { upserts, insertedIds, updatedIds, nextRev: Math.max(maxRev, latest, currentLastRev) };
}

/** Server fields + local-only fields (notified) carried over from the existing row. */
export function fromServer(server: SyncMessage, local?: LocalMessage): LocalMessage {
  return {
    id: server.id,
    rev: server.rev,
    role: server.role,
    text: server.text,
    origin: server.origin,
    trigger: server.trigger ?? null,
    createdAt: server.createdAt,
    complete: server.complete,
    status: 'sent',
    notified: local?.notified ?? false,
  };
}

/**
 * Messages that should produce a local notification: complete assistant
 * messages newer than what the user has seen in the Coach tab, not yet handled.
 * Ordered by rev.
 */
export function selectNotifiable(messages: readonly LocalMessage[], lastSeenRev: number): LocalMessage[] {
  return messages
    .filter(
      (m) =>
        m.role === 'assistant' &&
        m.complete &&
        m.status === 'sent' &&
        m.rev !== null &&
        m.rev > lastSeenRev &&
        !m.notified,
    )
    .sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0));
}

/** Unread = complete assistant messages with rev > lastSeenRev (independent of notified). */
export function countUnread(messages: readonly LocalMessage[], lastSeenRev: number): number {
  return messages.filter((m) => m.role === 'assistant' && m.complete && m.rev !== null && m.rev > lastSeenRev)
    .length;
}

export const NOTIFICATION_TITLE = 'Your coach';
const PREVIEW_MAX = 178;

/** One message: text preview. Several: grouped count. */
export function buildNotificationContent(messages: readonly LocalMessage[]): { title: string; body: string } | null {
  if (messages.length === 0) return null;
  if (messages.length === 1) {
    const text = messages[0].text.trim().replace(/\s+/g, ' ');
    const body = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text;
    return { title: NOTIFICATION_TITLE, body: body || 'New message' };
  }
  return { title: NOTIFICATION_TITLE, body: `Your coach sent ${messages.length} messages` };
}

/** lastSeenRev only moves forward. */
export function advanceSeenRev(current: number, candidate: number): number {
  return Math.max(current, candidate);
}

export interface DelayStats {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

/** Nearest-rank percentiles over notification delays. */
export function delayStats(delaysMs: readonly number[]): DelayStats {
  if (delaysMs.length === 0) return { count: 0, medianMs: null, p90Ms: null, maxMs: null };
  const sorted = [...delaysMs].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { count: sorted.length, medianMs: pick(0.5), p90Ms: pick(0.9), maxMs: sorted[sorted.length - 1] };
}

// ---------- push ----------

/** The `data` of an Expo push from our worker (see PushData), or null for anything else. */
export function parsePushData(data: unknown): PushData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'proactive' && d.kind !== 'test') return null;
  return {
    url: '/',
    kind: d.kind,
    ...(typeof d.messageId === 'string' ? { messageId: d.messageId } : {}),
    ...(typeof d.createdAt === 'number' ? { createdAt: d.createdAt } : {}),
  };
}

/**
 * Whether to show a notification that arrives while the app is running. A proactive
 * push is hidden only when the user is already looking at Coach (the message appears
 * in the thread via the sync it triggers). Test pushes and local notifications always show.
 */
export function shouldPresent(data: unknown, ctx: { appActive: boolean; coachVisible: boolean }): boolean {
  const push = parsePushData(data);
  if (push?.kind !== 'proactive') return true;
  return !(ctx.appActive && ctx.coachVisible);
}
