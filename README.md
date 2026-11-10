# Agent Chat POC

A fundraising-coach chat for the companion app: Expo iOS app ↔ Cloudflare Worker hosting one `AIChatAgent` Durable Object per device, with proactive messages and background-task local notifications.

- Design / spec: [`PLAN.md`](PLAN.md)
- Trial results template: [`FINDINGS.md`](FINDINGS.md)
- Worker details (config, deploy): [`worker/README.md`](worker/README.md)
- HTTP contract types: [`shared/src/protocol.ts`](shared/src/protocol.ts)

```
admin/    Admin panel (Vite + React), served by the worker at /admin
app/      Expo SDK 58 app (expo-router, Unistyles 3, expo-sqlite, expo-background-task)
worker/   Cloudflare Worker + CoachAgent (Agents SDK / @cloudflare/ai-chat, AI SDK + Anthropic)
shared/   protocol types imported by both
```

## Quick start (simulator, no API key)

```sh
npm install                                   # root; npm workspaces
cp worker/.dev.vars.example worker/.dev.vars  # LLM_MODE=mock, DEV_MODE=true, secret dev-secret
cp app/.env.example app/.env.local            # points at http://localhost:8787

npm run worker:dev                            # terminal 1: wrangler dev on :8787
cd app && npx expo run:ios                    # terminal 2: first time — builds the dev client
npm run app                                   # later: Metro only
```

`LLM_MODE=mock` streams canned coach replies (with a real tool call) so the whole loop works offline. For real replies set `LLM_MODE=anthropic` and `ANTHROPIC_API_KEY` in `worker/.dev.vars`.

Things to try:
- **Coach tab**: send a message; watch it stream, then swap to the stored copy.
- **Debug tab**: inject a donation (crossing 50% triggers a milestone message), force a proactive message, watch it appear on Coach within ~10 s.
- **Debug → Run background sync now**: exercises the background-task code path in the foreground (posts a notification on the simulator).

Proactive messages obey quiet hours (21:00–08:00 in the device timezone), 2/day, and a cooldown after your last message (30 s in `DEV_MODE`). "Force proactive" bypasses them.

## Admin panel

Browser panel for looking at conversations, injecting donations/milestones/inactivity, forcing proactive messages, editing the campaign, and resetting or deleting a user. Design in `PLAN.md` → "Admin panel"; details in [`admin/README.md`](admin/README.md).

```sh
npm run admin:build    # wrangler needs admin/dist to exist (worker tests also write a placeholder)
npm run worker:dev     # then open http://localhost:8787/admin, secret: ADMIN_SECRET (dev-admin)
npm run admin:dev      # optional: Vite with hot reload on http://localhost:5173/admin/, proxies the API to :8787
```

Users appear once their device makes a request (there's no backfill). Admin actions don't count as device activity. `worker:deploy` builds the admin panel first; set `ADMIN_SECRET` with `wrangler secret put ADMIN_SECRET`.

## Device trial (background notifications)

`BGTaskScheduler` doesn't run realistically on the simulator, so:

1. Deploy the worker (see `worker/README.md` → Deploy). Set `LLM_MODE=anthropic`, `DEV_MODE` as you prefer, secrets via `wrangler secret put`.
2. Set `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_APP_SECRET` in `app/.env.local` to the deployed values.
3. Build a dev client onto a physical iPhone: `cd app && npx expo run:ios --device` (or `eas build --profile development`).
4. Use the phone normally for several days. Debug tab shows background runs, notification delays (median/p90/max) and token logs; "Copy as JSON" to export.
5. Write up results in `FINDINGS.md`.

## Tests & checks

```sh
npm test            # worker (vitest-pool-workers, mock LLM) + app (jest: sync merge logic)
npm run typecheck
cd app && npx expo lint
```

## Notes / known quirks

- Root `package.json` pins `@babel/core` to v7 via `overrides` (a worklets peer pulled in Babel 8, which breaks jest-expo).
- Worker tests pin compatibility date 2026-08-22 (bundled workerd in `@cloudflare/vitest-pool-workers` 0.23, which is now deprecated in favour of `@cloudflare/vitest-plugin`); production uses 2026-11-01.
- `complete` is always `true` in `/messages`: `AIChatAgent` 0.12 only persists an assistant reply when its stream ends.
- Reset doesn't rewind the server rev counter; the app wipes its local DB on reset, so this is harmless.
- The app's "seen" tracking only counts the Coach tab being visible; messages that arrive while you sit on Debug can still be notified later.

## Simulator smoke test (Maestro)

With the worker and the dev build running: `maestro test app/.maestro/smoke.yaml`. Forces a proactive message, checks it appears on Coach with its badge, then runs the background-sync path and checks a notification was posted. Note `BGTaskScheduler` reports *Restricted* on the simulator, so the real background task only runs on a device.
