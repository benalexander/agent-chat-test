/**
 * Background entry points. Imported from /index.ts before expo-router so the
 * task is defined as soon as the bundle evaluates on a background launch.
 *
 * Side effects on import: sets the notification handler and defines the task.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';

import {
  BACKGROUND_SYNC_TIMEOUT_MS,
  BACKGROUND_TASK_INTERVAL_MINUTES,
  BACKGROUND_TASK_NAME,
} from '../config';
import {
  finishBgRun,
  KV,
  kvGetNumber,
  kvSet,
  listAssistantAbove,
  markNotified,
  recordDeliveries,
  startBgRun,
  type RunSource,
} from '../db/repo';
import { errorMessage } from '../lib/format';
import { buildNotificationContent, selectNotifiable, shouldPresent } from './merge';
import { isCoachVisible } from './presence';
import { canNotify, pushActive } from './push';
import { runSync } from './sync';

export { canNotify };

// Notifications arriving while the app is running. A proactive push is hidden when
// Coach is already on screen (the _layout received-listener syncs it into the thread).
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const show = shouldPresent(n.request.content.data, {
      appActive: AppState.currentState === 'active',
      coachVisible: isCoachVisible(),
    });
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
  },
});

TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  try {
    const r = await runBackgroundSync('background_task');
    return r.syncOk ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export interface BackgroundRunResult {
  syncOk: boolean;
  fetched: number;
  notified: number;
  error: string | null;
}

/**
 * What the background task does on each wake. Also called by Debug → "Run
 * background sync now" (source 'manual'), which posts the notification even
 * though the app is open so the whole path can be tested on the simulator.
 *
 * 1. sync (10 s timeout)
 * 2. if not in the foreground: notify complete assistant messages with
 *    rev > lastSeenRev that haven't been handled; one → preview, several → grouped
 * 3. record deliveries (delay = now − server createdAt), mark notified
 * 4. log the run in bg_runs
 *
 * Once the worker has our push token (pushActive), proactive messages arrive as Expo
 * pushes, so a background-task run only syncs and marks due messages handled instead
 * of notifying them a second time. Manual runs still notify (to test this path).
 */
export async function runBackgroundSync(source: RunSource): Promise<BackgroundRunResult> {
  const appState = AppState.currentState ?? 'unknown';
  const runId = await startBgRun(source, appState);
  let fetched = 0;
  let notified = 0;
  let error: string | null = null;
  let syncOk = false;

  try {
    const sync = await runSync({
      reason: source === 'manual' ? 'manual' : 'background_task',
      timeoutMs: BACKGROUND_SYNC_TIMEOUT_MS,
    });
    fetched = sync.fetched;
    syncOk = sync.ok;
    if (!sync.ok) error = `sync: ${sync.error}`;

    // Notify even if the sync failed: earlier runs may have stored unnotified messages.
    const foreground = AppState.currentState === 'active';
    if (source === 'manual' || !foreground) {
      const lastSeenRev = await kvGetNumber(KV.lastSeenRev);
      const due = selectNotifiable(await listAssistantAbove(lastSeenRev), lastSeenRev);
      const content = buildNotificationContent(due);
      if (content && source !== 'manual' && (await pushActive())) {
        await markNotified(due.map((m) => m.id));
      } else if (content) {
        if (await canNotify()) {
          await Notifications.scheduleNotificationAsync({
            content: { ...content, data: { url: '/', messageIds: due.map((m) => m.id) } },
            trigger: null,
          });
          const now = Date.now();
          await recordDeliveries(
            due.map((m) => ({ messageId: m.id, createdAt: m.createdAt })),
            now,
            runId,
          );
          await markNotified(due.map((m) => m.id));
          notified = due.length;
        } else {
          // Left unhandled, so they're notified once permission is granted.
          error = [error, `notifications not permitted (${due.length} due)`].filter(Boolean).join('; ');
        }
      }
    }
  } catch (e) {
    error = [error, errorMessage(e)].filter(Boolean).join('; ');
  }

  await finishBgRun(runId, { fetched, notified, error });
  return { syncOk, fetched, notified, error };
}

/** Idempotent. Called on every foreground launch; the result is shown in Debug. */
export async function registerBackgroundSync(): Promise<void> {
  let note: string;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Available) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_TASK_NAME, {
        minimumInterval: BACKGROUND_TASK_INTERVAL_MINUTES,
      });
      note = `registered (${BACKGROUND_TASK_INTERVAL_MINUTES} min requested)`;
    } else {
      note = `not registered: status ${status === null ? 'null' : BackgroundTask.BackgroundTaskStatus[status]}`;
    }
  } catch (e) {
    note = `error: ${errorMessage(e)}`;
  }
  await kvSet(KV.backgroundSetup, JSON.stringify({ at: Date.now(), note }));
}
