# Agent Chat POC — Plan

Agreed design (from the grilling session, 2026-11-09). See `start.md` for the original brief.

## Goal / success criteria

The POC answers four questions:

1. **Chat UX** — does streamed chat with a Durable-Object-backed agent feel good on iOS?
2. **Persistence & sync** — does DO-as-source-of-truth + local SQLite mirror work (offline reads, catch-up on reconnect)?
3. **Proactive outreach** — can the agent start conversations (schedule- and event-driven) with useful content?
4. **Background notifications** — how often / how late does a background-task poll turn an agent message into a local notification?

Out of scope: auth, multi-campaign, Android, production hardening, cost modelling (token counts are logged only).

## Repo layout

`agent-chat-test/`, git repo, npm workspaces (no Turborepo):

- `app/` — Expo app. Same stack as `../companion-app`: Expo SDK 58, RN 0.88, expo-router, Unistyles 3. Ridgeway theme tokens copied in.
- `worker/` — Cloudflare Worker + agent.
- `shared/` — TypeScript protocol types, imported by both.

## Worker

- `AIChatAgent` from `@cloudflare/ai-chat` (not `agents/ai-chat-agent`, which now throws). `nodejs_compat` flag.
- One agent instance per fundraiser, named by a device-generated UUID (kept in SecureStore on the device).
- Shared-secret auth (`Authorization: Bearer <secret>`), checked before the request reaches the agent. Device timezone sent on every request as `X-Timezone` (IANA name); the agent stores the latest.
- LLM: Anthropic via Cloudflare AI Gateway using the AI SDK (`createAnthropic({ baseURL, headers })`; use `x-api-key`, plus `cf-aig-authorization` if the gateway is authenticated). Default Sonnet 5.5 (`claude-sonnet-5-5`), switchable via env var (e.g. Haiku 5.5 `claude-haiku-5-5`).
- Persona: warm, upbeat, concise (2–4 sentences unless asked), **Australian English**, AUD. Never invents figures (tools/snapshot only). No guilt-tripping / pressure on donors. Gently redirects off-topic. No medical/financial/legal advice.
- Context per turn: system prompt + campaign snapshot + last 50 messages. No summarisation.
- Tools (read-only): `get_campaign_summary` (target, raised, %, donor count, days left), `get_recent_donations`.
- Every LLM call logs input/output tokens + latency (stored in DO, shown in Debug).

### Mock campaign

"Ridgeway Half Marathon", target **A$500**, held in the DO. Seeded on creation with A$120 from 4 donors, 6 weeks remaining. Events are injected via debug endpoints.

### Sync

- Own `rev` table `(message_id, rev INTEGER)`; `rev` is a global monotonic counter bumped on **every insert and update**, via an overridden `persistMessages` (call `super` first). The SDK's internal `seq` is private and not bumped on updates, so not used.
- `GET /messages?since=<rev>` returns changed messages + latest rev.
- `POST /chat {clientMessageId, text}` — idempotently appends the user message (id = `clientMessageId`), runs `saveMessages`, streams back the AI SDK UI message stream. Client reads via `expo/fetch` + `readUIMessageStream` from `ai`. Not using `useChat`/`useAgentChat`.
- If the stream drops, the server still completes the reply; the next sync recovers it.

### Proactive

- Single continuous thread. Proactive messages are normal assistant messages with metadata `origin: 'proactive'` and a `trigger`.
- Triggers:
  - `donation` — LLM decides whether worth messaging.
  - `milestone` — 25/50/75/100%, always messages (fires when a donation crosses a threshold, or injected).
  - `inactivity` — 4 days with no donations and no user messages.
  - `checkin` — scheduled every 3 days at 18:00 local.
- Guardrails: max 2 proactive/day, quiet hours 21:00–08:00 device-local, nothing within 10 min of the user's last message. Messages blocked by guardrails are dropped (and logged), not queued.
- Dev: "force proactive now" bypasses guardrails; `DEV_MODE` env var compresses intervals to minutes.

## App

- Two tabs:
  - **Coach** — chat: streaming bubble, proactive badge, pending/failed states with tap-to-retry, pull-to-refresh. Polls every 10 s while visible + syncs on app foreground. Unread badge on the tab.
  - **Debug** — inject events (donation w/ amount, milestone, inactivity), force proactive, campaign state, token/latency log, background-run log, notification-delay stats (median/p90/max, runs in last 24 h, "Copy as JSON"), notification permission status, "reset agent + local DB".
- UI renders from SQLite only. User messages written locally first (`status='pending'`), become `sent` on server confirmation. Immutable once complete. Partial streams live in memory only. No offline outbox.
- No onboarding. Request notification permission on first launch. Tapping a notification opens Coach.
- If notification permission is denied, Debug shows it; background sync still runs and logs.

## Background notifications

- `expo-background-task`, minimum interval 15 min.
- On wake: `GET /messages?since=lastRev` (10 s timeout) → upsert SQLite → local notification for any **complete** assistant message with `rev > lastSeenRev` and not yet `notified`. One message → text preview; several → grouped ("Your coach sent 3 messages").
- `lastSeenRev` = advanced while Coach tab is visible in foreground. No notification while foregrounded.
- Each run logged to `bg_runs` (woke at, app state, fetched count, notified count, error). Each notification records delay = notified time − server `createdAt`.
- No APNs push; documented as fallback if delays are bad.

## Environments

- Simulator ↔ `wrangler dev` (localhost) for chat iteration.
- Physical iPhone dev build ↔ deployed `*.workers.dev` for background testing.
- Secrets via `wrangler secret` (`ANTHROPIC_API_KEY`, `APP_SHARED_SECRET`, optional `CF_AIG_TOKEN`). wrangler is a devDependency of `worker/`.

## Tests

- Worker: `@cloudflare/vitest-pool-workers` — rev cursor (insert+update bump, `since` correctness), proactive guardrails (cap, quiet hours, cooldown), auth. LLM stubbed with the AI SDK mock model.
- App: unit tests for sync merge logic (pending→sent, dedupe, `lastSeenRev`). UI tested manually.

## Deliverables

`README.md` (run/deploy instructions) and `FINDINGS.md` template with a section per success question, to be filled in after a multi-day device trial.

## HTTP contract

All routes: `Authorization: Bearer <APP_SHARED_SECRET>`, `X-Timezone: <IANA tz>`. `<userId>` is the device UUID; the worker routes to the agent with `getAgentByName(env.CoachAgent, userId)`. Types live in `shared/src/protocol.ts`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/:userId/chat` | `ChatRequest` | AI SDK UI message stream (SSE) |
| GET | `/api/:userId/messages?since=<rev>` | — | `SyncResponse` |
| GET | `/api/:userId/debug/state` | — | `DebugState` |
| POST | `/api/:userId/debug/donation` | `InjectDonationRequest` | `DebugActionResponse` |
| POST | `/api/:userId/debug/milestone` | `InjectMilestoneRequest` | `DebugActionResponse` |
| POST | `/api/:userId/debug/inactivity` | — | `DebugActionResponse` |
| POST | `/api/:userId/debug/proactive` | `ForceProactiveRequest` | `DebugActionResponse` |
| POST | `/api/:userId/debug/reset` | — | `DebugActionResponse` |
