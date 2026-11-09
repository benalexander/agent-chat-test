# worker

Cloudflare Worker + `CoachAgent` (an `AIChatAgent` Durable Object, one per device UUID). Spec: `../PLAN.md`; HTTP types: `../shared/src/protocol.ts`.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # APP_SHARED_SECRET=dev-secret, LLM_MODE=mock, DEV_MODE=true
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

Proactive messages respect quiet hours (21:00–08:00 in the `X-Timezone` you send), a 2/day cap, and a cooldown after your last message (30 s in `DEV_MODE`, 10 min otherwise). Use `POST debug/proactive` to force one.

## Config

| Name | Kind | Notes |
|---|---|---|
| `MODEL` | var | default `claude-sonnet-5-5` (e.g. `claude-haiku-5-5`) |
| `DEV_MODE` | var | `"true"`: check-in every 3 min, inactivity after 2 min, cooldown 30 s, tick every 30 s |
| `LLM_MODE` | var | `anthropic` (default) or `mock` |
| `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` | var | both set → calls go via `https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic/v1`; empty → Anthropic directly |
| `ANTHROPIC_API_KEY` | secret | sent as `x-api-key` |
| `APP_SHARED_SECRET` | secret | `Authorization: Bearer <secret>` on every request; unset → every request is 401 |
| `CF_AIG_TOKEN` | secret, optional | sent as `cf-aig-authorization` for an authenticated gateway |

## Deploy

```sh
cd worker
npx wrangler login
npx wrangler secret put APP_SHARED_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_AIG_TOKEN          # optional
# edit vars in wrangler.jsonc (AI_GATEWAY_*, DEV_MODE, MODEL) or pass --var
npx wrangler deploy                           # → https://agent-chat-test.<subdomain>.workers.dev
npx wrangler tail                             # live logs
```
