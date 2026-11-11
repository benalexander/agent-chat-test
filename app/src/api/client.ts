/**
 * HTTP client for every route in PLAN.md's contract table. Uses expo/fetch
 * (streaming bodies + AbortSignal). Every request carries the shared secret and
 * the device's IANA timezone.
 */
import {
  HEADER_TIMEZONE,
  type ChatRequest,
  type DebugActionResponse,
  type DebugState,
  type ForceProactiveRequest,
  type InjectDonationRequest,
  type InjectMilestoneRequest,
  type PushTokenRequest,
  type PushTokenResponse,
  type SyncResponse,
} from '@agent-chat/shared';
import { fetch } from 'expo/fetch';

import { API_URL, APP_SECRET } from '../config';
import { deviceTimezone } from '../lib/format';
import { getUserId } from '../lib/identity';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${APP_SECRET}`,
    [HEADER_TIMEZONE]: deviceTimezone(),
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function url(path: string): Promise<string> {
  const userId = await getUserId();
  return `${API_URL}/api/${encodeURIComponent(userId)}${path}`;
}

/** Combines an optional caller signal with an optional timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  if (!timeoutMs) return { signal, clear: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

interface RequestOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function requestJson<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, opts: RequestOpts = {}) {
  const { signal, clear } = withTimeout(opts.signal, opts.timeoutMs);
  try {
    const res = await fetch(await url(path), {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clear();
  }
}

// ---- routes ----

/** GET /messages?since=<rev> */
export function getMessages(since: number, opts?: RequestOpts): Promise<SyncResponse> {
  return requestJson<SyncResponse>('GET', `/messages?since=${since}`, undefined, opts);
}

/**
 * POST /chat. Resolves once headers arrive; the caller reads the SSE body
 * (see chat/stream.ts). Throws ApiError for non-2xx.
 */
export async function postChat(req: ChatRequest, signal?: AbortSignal) {
  const res = await fetch(await url('/chat'), {
    method: 'POST',
    headers: { ...headers(true), Accept: 'text/event-stream' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `POST /chat → ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new ApiError(res.status, 'POST /chat returned no body');
  return res.body;
}

/** PUT /push-token. Latest device wins on the server. */
export function putPushToken(body: PushTokenRequest, opts?: RequestOpts): Promise<PushTokenResponse> {
  return requestJson<PushTokenResponse>('PUT', '/push-token', body, opts);
}

export const debugApi = {
  state: (opts?: RequestOpts) => requestJson<DebugState>('GET', '/debug/state', undefined, opts),
  donation: (body: InjectDonationRequest) => requestJson<DebugActionResponse>('POST', '/debug/donation', body),
  milestone: (body: InjectMilestoneRequest) => requestJson<DebugActionResponse>('POST', '/debug/milestone', body),
  inactivity: () => requestJson<DebugActionResponse>('POST', '/debug/inactivity'),
  proactive: (body: ForceProactiveRequest = {}) =>
    requestJson<DebugActionResponse>('POST', '/debug/proactive', body),
  reset: () => requestJson<DebugActionResponse>('POST', '/debug/reset'),
  pushTest: () => requestJson<DebugActionResponse>('POST', '/debug/push-test'),
};
