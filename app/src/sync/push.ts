/**
 * Expo push: register this device's push token with the worker, and measure
 * delivery delay of the pushes that arrive.
 *
 * The worker pushes every proactive message (worker/src/push.ts). Tokens can
 * change (reinstall, restore) and the worker drops a token APNs rejects, so we PUT
 * the current token on every launch (idempotent on the server).
 */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';

import { putPushToken } from '../api/client';
import { KV, kvGet, kvSet, recordPushDelivery } from '../db/repo';
import { errorMessage } from '../lib/format';
import { parsePushData } from './merge';

export interface PushSetup {
  at: number;
  /** Shown in Debug. */
  note: string;
  ok: boolean;
}

/** True if the app may post alerts (granted or iOS provisional). */
export async function canNotify(): Promise<boolean> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted || p.ios?.status === IosAuthorizationStatus.PROVISIONAL;
}

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** True once the server has acknowledged a token, so the worker will push to us. */
export async function pushActive(): Promise<boolean> {
  return (await kvGet(KV.pushToken)) !== null;
}

/**
 * Idempotent. Call on launch and after notification permission is granted. Records
 * the outcome under KV.pushSetup (Debug → Push).
 */
export async function registerPushToken(): Promise<PushSetup> {
  let setup: PushSetup;
  try {
    if (!(await canNotify())) {
      setup = { at: Date.now(), ok: false, note: 'not registered: notifications not permitted' };
    } else {
      const id = projectId();
      if (!id) throw new Error('no EAS projectId in app config');
      const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
      await putPushToken({ token }, { timeoutMs: 15_000 });
      await kvSet(KV.pushToken, token);
      setup = { at: Date.now(), ok: true, note: `registered …${token.slice(-12)}` };
    }
  } catch (e) {
    setup = { at: Date.now(), ok: false, note: `error: ${errorMessage(e)}` };
  }
  await kvSet(KV.pushSetup, JSON.stringify(setup));
  return setup;
}

/**
 * Record a delivered push (no-op for anything that isn't a proactive push from our
 * worker). `notification.date` is when iOS delivered it.
 */
export async function recordNotification(n: Notifications.Notification): Promise<void> {
  const data = parsePushData(n.request.content.data);
  if (data?.kind !== 'proactive' || !data.messageId || data.createdAt === undefined) return;
  await recordPushDelivery(data.messageId, data.createdAt, n.date);
}

/**
 * Pick up pushes delivered while the app wasn't running (still in Notification
 * Centre). Ones the user swiped away are missed; ones tapped are recorded by the
 * response listener.
 */
export async function recordPresentedNotifications(): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const n of presented) await recordNotification(n);
}
