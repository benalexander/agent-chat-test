# Agent Chat POC — Findings

Fill in after a multi-day trial on a physical iPhone against the deployed worker. See `PLAN.md` for the success criteria.

**Trial period:**
**Device / iOS version:**
**Worker URL / model(s) tried:**

---

## 1. Chat UX — does streamed chat with a DO-backed agent feel good on iOS?

- Time to first token (typical / worst):
- Full reply latency (typical / worst):
- Sonnet 5.5 vs Haiku 5.5 — quality vs speed:
- Persona quality (tone, Australian English, figures correct, stays on topic):
- Rough edges (scrolling, keyboard, streaming bubble → stored message swap):

**Verdict:**

## 2. Persistence & sync — does DO source-of-truth + local SQLite mirror work?

- Offline launch shows history?
- Catch-up after airplane mode / app killed mid-stream (does the reply appear on next sync?):
- Any duplicates, ordering glitches or lost messages:
- Rev cursor behaviour (updates picked up correctly?):

**Verdict:**

## 3. Proactive outreach — useful, well-timed, not annoying?

| Trigger | Count sent | Count skipped (LLM) | Count blocked (guardrail) | Quality notes |
|---|---|---|---|---|
| donation | | | | |
| milestone | | | | |
| inactivity | | | | |
| checkin | | | | |

- Guardrails (2/day, quiet hours, cooldown) — right values?
- Token cost per proactive message (from Debug token log):

**Verdict:**

## 4. Background notifications — how often / how late?

Paste the Debug → "Copy as JSON" export into `trial-data/` and summarise:

- Background runs per 24 h (median / min / max):
- Notification delay after message creation (median / p90 / max):
- Behaviour after force-quit, Low Power Mode, overnight:
- Messages never notified (only seen on next open):

**Verdict:** Is background-task polling good enough, or is APNs push required?

---

## Cost snapshot

- Avg input / output tokens per chat turn:
- Avg tokens per proactive attempt:
- Estimated cost per active fundraiser per month (rough):

## Recommendation for the companion app
