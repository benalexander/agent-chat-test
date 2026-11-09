/**
 * Sync engine (IO side). Fetches GET /messages?since=lastRev, merges with
 * merge.ts, writes SQLite. Runs are serialised: never two at once, whether
 * triggered by the Coach poll, app foreground, chat send or the background task.
 */
import { AppState } from 'react-native';

import { getMessages } from '../api/client';
import { FOREGROUND_SYNC_TIMEOUT_MS } from '../config';
import { applyMerge, getMessagesByIds, KV, kvGetNumber, kvRaiseNumber, markHandledUpTo } from '../db/repo';
import { errorMessage } from '../lib/format';
import { mergeSyncResponse } from './merge';
import { isCoachVisible } from './presence';

export type SyncReason = 'poll' | 'foreground' | 'pull' | 'chat' | 'background_task' | 'manual';

export interface SyncOptions {
  reason: SyncReason;
  timeoutMs?: number;
}

export interface SyncResult {
  ok: boolean;
  /** Messages returned by the server (after de-dupe), including ones already held. */
  fetched: number;
  inserted: number;
  updated: number;
  lastRev: number;
  error?: string;
}

/** Called when the user has seen everything up to `rev` (Coach visible + app active). */
export async function markSeenUpTo(rev: number): Promise<void> {
  const seen = await kvRaiseNumber(KV.lastSeenRev, rev);
  await markHandledUpTo(seen);
}

async function doSync(opts: SyncOptions): Promise<SyncResult> {
  const since = await kvGetNumber(KV.lastRev);
  try {
    const res = await getMessages(since, { timeoutMs: opts.timeoutMs ?? FOREGROUND_SYNC_TIMEOUT_MS });
    const local = await getMessagesByIds(res.messages.map((m) => m.id));
    const merged = mergeSyncResponse(res, since, (id) => local.get(id));
    await applyMerge(merged.upserts, merged.nextRev);

    // Seen while Coach is on screen in the foreground: never notify these later.
    // ("manual" = Debug → Run background sync now, which exercises the notify path.)
    if (AppState.currentState === 'active' && isCoachVisible() && opts.reason !== 'manual') {
      await markSeenUpTo(merged.nextRev);
    }

    return {
      ok: true,
      fetched: res.messages.length,
      inserted: merged.insertedIds.length,
      updated: merged.updatedIds.length,
      lastRev: merged.nextRev,
    };
  } catch (e) {
    return { ok: false, fetched: 0, inserted: 0, updated: 0, lastRev: since, error: errorMessage(e) };
  }
}

// ---------- serial queue ----------

/** Tail of the run chain; each run starts after the previous one settles. */
let tail: Promise<unknown> = Promise.resolve();
/** Runs queued but not started, by reason: a second request for the same reason shares it. */
const queuedByReason = new Map<SyncReason, Promise<SyncResult>>();
let pending = 0;
const listeners = new Set<(syncing: boolean) => void>();

export function isSyncing(): boolean {
  return pending > 0;
}

export function onSyncingChange(cb: (syncing: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Runs a sync, never overlapping another: runs execute one at a time in
 * arrival order. A request whose reason already has a run waiting in the queue
 * shares that run instead of adding another (e.g. a poll tick during a slow sync).
 */
export function runSync(opts: SyncOptions): Promise<SyncResult> {
  const waiting = queuedByReason.get(opts.reason);
  if (waiting) return waiting;

  pending++;
  if (pending === 1) listeners.forEach((l) => l(true));
  const run = tail
    .then(() => {
      queuedByReason.delete(opts.reason);
      return doSync(opts);
    })
    .finally(() => {
      pending--;
      if (pending === 0) listeners.forEach((l) => l(false));
    });
  queuedByReason.set(opts.reason, run);
  tail = run.catch(() => undefined);
  return run;
}
