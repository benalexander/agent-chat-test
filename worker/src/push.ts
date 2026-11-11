/**
 * Expo push service client (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 * Two steps per notification:
 *  1. send → a "ticket" per message: Expo accepted it (with an id) or rejected it.
 *  2. getReceipts(ticket ids), ~15 min later → whether APNs accepted it. A
 *     `DeviceNotRegistered` error (from either step) means the token is dead.
 *
 * If EXPO_ACCESS_TOKEN is set it's sent as a Bearer token (required once "enhanced push
 * security" is on for the Expo account). `fetchFn` is injectable for tests.
 */
import type { PushData } from '@agent-chat/shared';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo recommends checking receipts after ~15 minutes. */
export const RECEIPT_DELAY_SECONDS = 15 * 60;

const TOKEN_RE = /^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/;
export const isExpoPushToken = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t);

export const PUSH_TITLE = 'Your coach';
const PREVIEW_MAX = 178;

/** Same preview rules as the app's local notifications (app/src/sync/merge.ts). */
export function pushPreview(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return (t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : t) || 'New message';
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: PushData;
  sound: 'default';
  priority: 'high';
}

export type Ticket = { status: 'ok'; id: string } | { status: 'error'; error: string };
export type Receipt = { status: 'ok' } | { status: 'error'; error: string };

type FetchFn = typeof fetch;

function headers(accessToken: string | undefined): HeadersInit {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

interface ExpoError {
  message?: string;
  details?: { error?: string };
}
const errorCode = (e: ExpoError | undefined, fallback: string) => e?.details?.error ?? e?.message ?? fallback;

/** Sends one notification. Never throws: transport and API errors become an error ticket. */
export async function sendPush(
  message: PushMessage,
  opts: { accessToken?: string; fetchFn?: FetchFn } = {},
): Promise<Ticket> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(EXPO_PUSH_SEND_URL, {
      method: 'POST',
      headers: headers(opts.accessToken),
      body: JSON.stringify([message]),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: ({ status: 'ok'; id: string } | ({ status: 'error' } & ExpoError))[];
      errors?: { code?: string; message?: string }[];
    } | null;
    if (!res.ok || !body?.data?.[0]) {
      const e = body?.errors?.[0];
      return { status: 'error', error: e?.code ?? e?.message ?? `HTTP ${res.status}` };
    }
    const t = body.data[0];
    return t.status === 'ok' ? { status: 'ok', id: t.id } : { status: 'error', error: errorCode(t, 'unknown') };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Receipts by ticket id. Ids Expo doesn't know yet are absent. Throws on transport errors. */
export async function getReceipts(
  ids: string[],
  opts: { accessToken?: string; fetchFn?: FetchFn } = {},
): Promise<Record<string, Receipt>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(EXPO_PUSH_RECEIPTS_URL, {
    method: 'POST',
    headers: headers(opts.accessToken),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`getReceipts HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { status: 'ok' } | ({ status: 'error' } & ExpoError)> };
  const out: Record<string, Receipt> = {};
  for (const [id, r] of Object.entries(body.data ?? {})) {
    out[id] = r.status === 'ok' ? { status: 'ok' } : { status: 'error', error: errorCode(r, 'unknown') };
  }
  return out;
}
