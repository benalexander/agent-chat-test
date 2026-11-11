/**
 * HTTP contract between the Expo app and the Cloudflare Worker.
 * See PLAN.md "HTTP contract" for the route table.
 *
 * All requests carry:
 *   Authorization: Bearer <APP_SHARED_SECRET>
 *   X-Timezone: <IANA timezone, e.g. "Australia/Melbourne">
 */

export const HEADER_TIMEZONE = 'X-Timezone';

export type ProactiveTrigger = 'donation' | 'milestone' | 'inactivity' | 'checkin' | 'manual';

/**
 * - `user`: sent by the fundraiser
 * - `reply`: assistant reply to a user message
 * - `proactive`: assistant message the agent initiated
 */
export type MessageOrigin = 'user' | 'reply' | 'proactive';

/** Stored in UIMessage.metadata on the server. */
export interface MessageMetadata {
  origin: MessageOrigin;
  trigger?: ProactiveTrigger;
  /** Server time (ms since epoch) the message was first persisted. */
  createdAt: number;
}

/** A message as seen by the sync endpoint: flattened to text. */
export interface SyncMessage {
  /** UIMessage id. For user messages this equals the client's clientMessageId. */
  id: string;
  /** Monotonic, global per agent; bumped on every insert and update. */
  rev: number;
  role: 'user' | 'assistant';
  /** Concatenated text parts (tool parts omitted). */
  text: string;
  origin: MessageOrigin;
  trigger?: ProactiveTrigger;
  createdAt: number;
  /** False while an assistant message is still streaming. Only notify on complete messages. */
  complete: boolean;
}

// ---- POST /api/:userId/chat ------------------------------------------------

export interface ChatRequest {
  /** Client-generated UUID; used as the message id so retries are idempotent. */
  clientMessageId: string;
  text: string;
}
// Response: AI SDK UI message stream (SSE), parse with `readUIMessageStream`.

// ---- GET /api/:userId/messages?since=<rev> ---------------------------------

export interface SyncResponse {
  /** Messages with rev > since, ordered by rev ascending. */
  messages: SyncMessage[];
  /** Highest rev the server has (>= since). Store as the next cursor. */
  latestRev: number;
}

// ---- Debug ------------------------------------------------------------------

export interface Donation {
  id: string;
  donorName: string;
  amount: number; // AUD, whole dollars
  message?: string;
  at: number; // ms
}

export interface CampaignState {
  name: string;
  charity: string;
  currency: 'AUD';
  target: number;
  raised: number;
  donorCount: number;
  startedAt: number;
  endsAt: number;
  donations: Donation[];
  /** Milestone percentages already announced (25/50/75/100). */
  milestonesHit: number[];
  lastActivityAt: number;
}

export interface LlmLogEntry {
  at: number;
  kind: 'chat' | 'proactive';
  trigger?: ProactiveTrigger;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** For proactive: whether the LLM chose to send / guardrails allowed it. */
  outcome?: 'sent' | 'skipped_by_llm' | 'blocked_by_guardrail' | 'error';
  note?: string;
}

export interface ProactiveLogEntry {
  at: number;
  trigger: ProactiveTrigger;
  outcome: 'sent' | 'skipped_by_llm' | 'blocked_by_guardrail' | 'error';
  reason?: string;
}

export interface DebugState {
  userId: string;
  timezone: string | null;
  devMode: boolean;
  model: string;
  campaign: CampaignState;
  latestRev: number;
  proactiveSentToday: number;
  llmLog: LlmLogEntry[];
  proactiveLog: ProactiveLogEntry[];
  /** `time` = next run, ms since epoch. */
  schedules: { id: string; callback: string; time: number; type: string }[];
  push: PushState;
}

// ---- Push (Expo push service) ------------------------------------------------

/** PUT /api/:userId/push-token. Latest device wins (one token per user). */
export interface PushTokenRequest {
  /** ExponentPushToken[...] from Notifications.getExpoPushTokenAsync. */
  token: string;
}

/** Response of PUT /push-token. */
export interface PushTokenResponse {
  ok: boolean;
}

/**
 * One push attempt. `ticket` is Expo's immediate answer (accepted or rejected);
 * `receipt` is APNs' answer, checked ~15 min later.
 */
export interface PushLogEntry {
  at: number;
  kind: 'proactive' | 'test';
  /** Message id for proactive pushes. */
  messageId?: string;
  /** 'no_token': nothing was sent because the device hasn't registered a token. */
  ticket: 'ok' | 'error' | 'no_token';
  ticketId?: string;
  receipt?: 'ok' | 'error';
  receiptAt?: number;
  /** Expo/APNs error code or message (e.g. DeviceNotRegistered). */
  error?: string;
}

export interface PushState {
  /** Last 12 characters of the stored token, or null if none. */
  tokenTail: string | null;
  tokenUpdatedAt: number | null;
  /** Newest first, capped. */
  log: PushLogEntry[];
}

/** data payload of every push notification. */
export interface PushData {
  url: '/';
  kind: PushLogEntry['kind'];
  messageId?: string;
  /** Server createdAt of the message (ms), for delivery-delay measurement. */
  createdAt?: number;
}

export interface InjectDonationRequest {
  amount: number;
  donorName?: string;
  message?: string;
}

export interface InjectMilestoneRequest {
  percent: 25 | 50 | 75 | 100;
}

export interface ForceProactiveRequest {
  trigger?: ProactiveTrigger;
}

export interface DebugActionResponse {
  ok: boolean;
  /** For proactive actions: what happened. */
  outcome?: ProactiveLogEntry['outcome'];
  message?: string;
}
