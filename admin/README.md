# admin

Internal admin panel for the agent-chat POC: list registered devices, read a user's full
transcript (tool parts, proactive attempts, LLM tokens), edit the campaign silently, inject
events, force proactive messages, reset or delete an agent.

Vite + React + TypeScript, plain CSS, no router (hash routes `#/` and `#/users/:userId`).
The HTTP contract is `shared/src/admin.ts`.

## Dev

```sh
npm run worker:dev   # wrangler dev on :8787 (needs ADMIN_SECRET in worker/.dev.vars)
npm run admin:dev    # Vite on http://localhost:5173/admin/, proxies /admin/api → :8787
```

Log in with the `ADMIN_SECRET` value. It is kept in `localStorage` and sent as
`Authorization: Bearer <secret>` on every `/admin/api` call; a 401 clears it.

## Build

```sh
npm run admin:build  # = npm run build -w admin → admin/dist/admin/
npm run typecheck -w admin
```

## How it's served

The worker's `wrangler.jsonc` points its static assets at `admin/dist`, so the build output
ends up at `/admin/index.html` with assets under `/admin/assets/` (Vite `base: '/admin/'`).
There's no SPA fallback, which is why routing is hash-based. `npm run worker:deploy`
builds the admin first, then deploys the worker.
