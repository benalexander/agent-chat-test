/**
 * HTTP contract between the admin panel (served at /admin) and the Worker.
 * See PLAN.md "Admin panel".
 *
 * All /admin/api/* requests carry:
 *   Authorization: Bearer <ADMIN_SECRET>
 * The app's APP_SHARED_SECRET is rejected here, and ADMIN_SECRET is rejected on /api/*.
 *
 * Admin requests never count as device activity: they don't update the stored
 * timezone, the registry's lastSeen, or the agent's last-user-message / activity
 * timestamps (except where the action itself is the activity, e.g. an injected
 * donation updates campaign.lastActivityAt exactly as the app's debug route does).
 *
 * Routes for a userId that isn't in the registry return 404 `{ error: 'unknown_user' }`
 * (so a typo can't create a fresh agent).
 */
import type {
  CampaignState,
  DebugActionResponse,
  DebugState,
  ForceProactiveRequest,
  InjectDonationRequest,
  InjectMilestoneRequest,
  MessageMetadata,
} from './protocol';

export const ADMIN_API_PREFIX = '/admin/api';

// ---- Registry ----------------------------------------------------------------

/** Pushed by the agent to the registry whenever its messages or campaign change. */
export interface UserSummary {
  messageCount: number;
  /** createdAt of the newest message, or null if there are none. */
  lastMessageAt: number | null;
  raised: number;
  target: number;
  currency: 'AUD';
  /** When the agent last pushed this summary (ms). */
  updatedAt: number;
}

export interface RegistryEntry {
  userId: string;
  /** ms since epoch. Set by the first app request (or first summary push). */
  firstSeen: number;
  /** ms since epoch of the latest *app* request (throttled to once a minute). */
  lastSeen: number;
  /** Latest device timezone seen on an app request (IANA). */
  timezone: string | null;
  summary: UserSummary | null;
}

// ---- GET /admin/api/users ------------------------------------------------------

export interface AdminUsersResponse {
  /** Sorted by lastSeen descending. */
  users: RegistryEntry[];
}

// ---- GET /admin/api/users/:userId ------------------------------------------------

/**
 * One raw UIMessage part, as stored by AIChatAgent. Known shapes:
 *  - { type: 'text', text }
 *  - { type: 'reasoning', text }
 *  - { type: 'step-start' }
 *  - { type: `tool-${name}`, toolCallId, state, input?, output?, errorText? }
 *  - { type: 'dynamic-tool', toolName, toolCallId, state, input?, output?, errorText? }
 * Render unknown types as JSON.
 */
export interface AdminMessagePart {
  type: string;
  [key: string]: unknown;
}

export interface AdminMessage {
  id: string;
  /** Sync rev (see SyncMessage.rev); 0 if the message has never been revved. */
  rev: number;
  role: 'user' | 'assistant' | 'system';
  /** Concatenated text parts, for convenience. */
  text: string;
  parts: AdminMessagePart[];
  /** Null only for messages persisted before metadata stamping existed. */
  metadata: MessageMetadata | null;
}

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AdminUserDetail {
  user: RegistryEntry;
  /** Same shape the app's Debug tab gets (campaign, logs, schedules, timezone...). */
  state: DebugState;
  /** Whole thread, oldest first. */
  messages: AdminMessage[];
  /** Summed over the (capped) LLM log. */
  tokenTotals: { chat: TokenTotals; proactive: TokenTotals };
}

// ---- Actions on /admin/api/users/:userId/... ------------------------------------
//
//   POST   .../donation    InjectDonationRequest   → DebugActionResponse
//   POST   .../milestone   InjectMilestoneRequest  → DebugActionResponse
//   POST   .../inactivity  {}                      → DebugActionResponse
//   POST   .../proactive   ForceProactiveRequest   → DebugActionResponse  (bypasses guardrails)
//   POST   .../reset       {}                      → DebugActionResponse  (user stays registered)
//   PATCH  .../campaign    UpdateCampaignRequest   → UpdateCampaignResponse
//   DELETE /admin/api/users/:userId                → DebugActionResponse  (wipe agent + unregister)

export type AdminDonationRequest = InjectDonationRequest;
export type AdminMilestoneRequest = InjectMilestoneRequest;
export type AdminProactiveRequest = ForceProactiveRequest;
export type AdminActionResponse = DebugActionResponse;

/**
 * Silent edit: no proactive message is sent. `milestonesHit` is recomputed to every
 * threshold (25/50/75/100) at or below the new raised/target percentage, so passed
 * thresholds never fire later. Omitted fields are unchanged.
 */
export interface UpdateCampaignRequest {
  /** AUD, whole dollars, >= 0. */
  raised?: number;
  /** AUD, whole dollars, > 0. */
  target?: number;
  /** >= 0. */
  donorCount?: number;
  /** ms since epoch. */
  endsAt?: number;
}

export interface UpdateCampaignResponse {
  ok: boolean;
  campaign: CampaignState;
}

/** Error body for any non-2xx admin response. */
export interface AdminErrorResponse {
  error: string;
  message?: string;
}
