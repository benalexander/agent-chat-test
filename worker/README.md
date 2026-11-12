# worker

Cloudflare Worker + `CoachAgent` (an `AIChatAgent` Durable Object, one per device UUID) + `Registry` (a singleton Durable Object listing users for the admin panel). Spec: `../PLAN.md`; HTTP types: `../shared/src/protocol.ts` (app) and `../shared/src/admin.ts` (admin).

## Local dev

```sh
cp .dev.vars.example .dev.vars   # APP_SHARED_SECRET=dev-secret, ADMIN_SECRET=dev-admin, LLM_MODE=mock, DEV_MODE=true
npm run dev -w worker            # http://localhost:8787
npm test -w worker               # vitest + @cloudflare/vitest-pool-workers (mock LLM)
npm run typecheck -w worker
npm run cf-typegen -w worker     # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

`LLM_MODE=mock` uses the AI SDK mock model (canned coach text, a real tool call for progress questions, fake token counts), so nothing needs an API key. For real replies set `LLM_MODE=anthropic` and `ANTHROPIC_API_KEY` in `.dev.vars`.

```sh
curl -N -H "Authorization: Bearer dev-secret" -H "X-Timezone: Australia/Melbourne" -H "content-type: application/json" \
  -X POST localhost:8787/api/test-user/chat -d '{"clientMessageId":"m-1","text":"How much have I raised?"}'
curl -H "Authorization: Bearer dev-secret" "localhost:8787/api/test-user/messages?since=0"
curl -H "Authorization: Bearer dev-secret" -H "content-type: application/json" \
  -X POST localhost:8787/api/test-user/debug/donation -d '{"amount":120,"donorName":"Nana"}'
```

Admin API (same origin as the admin UI at `http://localhost:8787/admin/`):

```sh
curl -H "Authorization: Bearer dev-admin" localhost:8787/admin/api/users
curl -H "Authorization: Bearer dev-admin" localhost:8787/admin/api/users/test-user
curl -H "Authorization: Bearer dev-admin" -H "content-type: application/json" \
  -X PATCH localhost:8787/admin/api/users/test-user/campaign -d '{"raised":260}'
```

Proactive messages respect quiet hours (21:00–08:00 in the `X-Timezone` you send), a daily cap (20/day for the initial trial; check-ins hourly but max 2/day, inactivity after 2 h but max 1/day with `DEV_MODE=false`), and a cooldown after your last message (30 s in `DEV_MODE`, 10 min otherwise). Use `POST debug/proactive` to force one.

## Config

| Name | Kind | Notes |
|---|---|---|
| `MODEL` | var | default `claude-sonnet-5-5` (e.g. `claude-haiku-5-5`) |
| `DEV_MODE` | var | `"true"`: check-in every 3 min, inactivity after 2 min, cooldown 30 s, tick every 30 s |
| `LLM_MODE` | var | `anthropic` (default) or `mock` |
| `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` | var | both set → calls go via `https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic/v1`; empty → Anthropic directly |
| `ANTHROPIC_API_KEY` | secret | sent as `x-api-key` |
| `APP_SHARED_SECRET` | secret | `Authorization: Bearer <secret>` on every request; unset → every request is 401 |
| `ADMIN_SECRET` | secret | `Authorization: Bearer <secret>` on `/admin/api/*` only; unset (or equal to `APP_SHARED_SECRET`) → every admin request is 401. Rejected on `/api/*` |
| `CF_AIG_TOKEN` | secret, optional | sent as `cf-aig-authorization` for an authenticated gateway |
| `EXPO_ACCESS_TOKEN` | secret, optional | sent as Bearer to the Expo push service; required once enhanced push security is on |

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /`, `GET /health` | none | `{ ok: true }` |
| `/api/:userId/*` | `APP_SHARED_SECRET` | app API (chat, messages, push-token, debug/*), CORS `*`. Each request also registers/refreshes the user in the Registry (see below) |
| `/admin/api/*` | `ADMIN_SECRET` | admin API, no CORS (same origin). Contract and route list: `../shared/src/admin.ts` |
| `/admin/` | none (UI asks for the admin secret) | static admin UI from `../admin/dist` (Vite `base: '/admin/'`, hash routing); `/admin` redirects to `/admin/` |

Admin routes for a userId not in the Registry return 404 `{ error: 'unknown_user' }` without touching the agent. The Worker calls agents over DO RPC for admin actions (never `onRequest`), so admin requests don't change the stored device timezone, `lastSeen`, or the agent's activity/cooldown markers. `DELETE /admin/api/users/:userId` calls the Agents SDK `destroy()` (drops all storage, alarms and schedules, then aborts the DO) and then removes the Registry entry.

## Push

Proactive messages are pushed via Expo (`src/push.ts`). The device registers its token with `PUT /api/:userId/push-token` (`ExponentPushToken[...]`; latest wins, kept across reset). Each send is logged (`DebugState.push.log`: ticket, then receipt ~15 min later via the `checkPushReceipts` schedule). `DeviceNotRegistered` clears the token. A failed push never fails the proactive message. Test: `POST /api/:userId/debug/push-test` or the admin "Send test push".

## Registry

`Registry` (SQLite DO, `idFromName('global')`) stores one `RegistryEntry` per user (`firstSeen`, `lastSeen`, `timezone`, `summary`). Writers:

- the Worker, via `ctx.waitUntil` on every authorised app request: `lastSeen` + valid `X-Timezone`. The Registry skips the write if `lastSeen` is < 60 s old and the timezone is unchanged; an in-isolate memo skips the RPC too.
- each `CoachAgent`, whenever its messages (after `persistMessages`) or campaign change, and on reset: a `UserSummary` (message count, last message time, raised/target). Pushes are coalesced (one in flight, one follow-up), failures are logged and caught up by the next change. Whichever writer comes first creates the entry.

Users that existed before the Registry was added appear after their next app request.

## Admin UI assets

`wrangler.jsonc` serves `../admin/dist` as static assets with `run_worker_first: ["/api/*", "/admin/api/*"]`; any path that isn't an asset (`/`, `/health`, ...) falls through to the Worker. Build the UI with `npm run admin:build` before `wrangler dev`/`deploy` (the root `worker:deploy` script does); wrangler refuses to start if the directory is missing. The test run (`test/global-setup.ts`) writes a placeholder `admin/dist/admin/index.html` if the UI hasn't been built, so the assets directory always exists; a real Vite build replaces it.

## Deploy

```sh
cd worker
npx wrangler login
npx wrangler secret put APP_SHARED_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_AIG_TOKEN          # optional
npx wrangler secret put EXPO_ACCESS_TOKEN     # optional (needed with enhanced push security)
# edit vars in wrangler.jsonc (AI_GATEWAY_*, DEV_MODE, MODEL) or pass --var
(cd .. && npm run admin:build)                # admin UI → ../admin/dist (root `npm run worker:deploy` does both)
npx wrangler deploy                           # → https://agent-chat-test.<subdomain>.workers.dev
npx wrangler tail                             # live logs
```
