import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import {
  convertToModelMessages,
  generateText,
  Output,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type GenerateTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import type {
  CampaignState,
  ChatRequest,
  DebugActionResponse,
  DebugState,
  LlmLogEntry,
  MessageMetadata,
  ProactiveLogEntry,
  ProactiveTrigger,
  SyncMessage,
  SyncResponse,
} from '@agent-chat/shared';
import { applyDonation, campaignSummary, recentDonations, seedCampaign } from './campaign';
import { DEFAULT_TIMEZONE, getTimings, HISTORY_WINDOW, isDevMode } from './config';
import { checkGuardrails, checkinDue, countOnLocalDay, inactivityDue, isValidTimezone } from './guardrails';
import { createModel, reportedModelName } from './llm';
import { metadataOf, revContent, toSyncMessage, withDefaultMetadata } from './messages';
import { proactiveInstruction, systemPrompt, type ProactiveContext } from './prompts';
import { CoachStore } from './store';

type Outcome = ProactiveLogEntry['outcome'];

const KV = {
  campaign: 'campaign',
  timezone: 'timezone',
  lastUserMessageAt: 'last_user_message_at',
  lastInactivityAt: 'last_inactivity_at',
  lastCheckinAt: 'last_checkin_at',
} as const;

const ChatRequestSchema = z.object({
  clientMessageId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(8000),
});
const DonationSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  donorName: z.string().max(100).optional(),
  message: z.string().max(1000).optional(),
});
const MilestoneSchema = z.object({ percent: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]) });
const ForceSchema = z.object({
  trigger: z.enum(['donation', 'milestone', 'inactivity', 'checkin', 'manual']).optional(),
});
const DonationDecisionSchema = z.object({
  send: z.boolean().describe('Whether to message the fundraiser about this donation now'),
  message: z.string().describe('The message to send (empty if send is false)'),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class CoachAgent extends AIChatAgent<Cloudflare.Env> {
  /** Test hook: per-chunk delay for the mock model's streaming. */
  mockChunkDelayMs: number | undefined;

  #store: CoachStore | undefined;
  /**
   * POST /chat waiters, keyed by the user message id. When onChatMessage starts the
   * turn for that message, it tees the UI message stream and hands one branch here.
   */
  #httpSinks = new Map<string, Deferred<ReadableStream<Uint8Array>>>();
  /** User message ids whose reply turn is queued or running. */
  #answering = new Set<string>();

  private get store(): CoachStore {
    return (this.#store ??= new CoachStore(this.ctx.storage.sql));
  }

  // ---- lifecycle ---------------------------------------------------------------

  async onStart(): Promise<void> {
    if (!this.store.get<CampaignState>(KV.campaign)) this.seed();
    await this.ensureSchedules();
  }

  private seed(): void {
    const now = Date.now();
    this.store.set(KV.campaign, seedCampaign(now));
    this.store.set(KV.lastCheckinAt, now);
  }

  /**
   * One recurring tick drives both inactivity and check-in triggers. scheduleEvery is
   * idempotent on (callback, interval, payload), so calling this on every wake is
   * safe; we only cancel ticks left over from a different DEV_MODE interval.
   */
  private async ensureSchedules(): Promise<void> {
    const interval = getTimings(isDevMode(this.env)).tickIntervalSeconds;
    for (const s of this.getSchedules()) {
      if (s.callback === 'proactiveTick' && !(s.type === 'interval' && s.intervalSeconds === interval)) {
        await this.cancelSchedule(s.id);
      }
    }
    await this.scheduleEvery(interval, 'proactiveTick');
  }

  // ---- state helpers -------------------------------------------------------------

  private campaign(): CampaignState {
    let c = this.store.get<CampaignState>(KV.campaign);
    if (!c) {
      this.seed();
      c = this.store.get<CampaignState>(KV.campaign)!;
    }
    return c;
  }

  private storedTimezone(): string | null {
    return this.store.get<string>(KV.timezone) ?? null;
  }

  private timezone(): string {
    return this.storedTimezone() ?? DEFAULT_TIMEZONE;
  }

  private log(entry: LlmLogEntry): void {
    this.store.logLlm(entry);
  }

  // ---- persistence + rev cursor ------------------------------------------------------

  /**
   * Every write path in AIChatAgent (saveMessages, end of a streamed reply, our
   * proactive messages) goes through persistMessages. We stamp missing metadata
   * before the write, then bump our own rev for every message whose content is new
   * or changed. The SDK can persist the same message more than once; the content
   * hash makes unchanged rewrites a no-op for sync.
   */
  override async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean },
  ): Promise<void> {
    const now = Date.now();
    const stamped = messages.map((m) => withDefaultMetadata(m, now));
    await super.persistMessages(stamped, excludeBroadcastIds, options);
    for (const m of this.messages) this.store.touch(m.id, revContent(m));
  }

  // ---- chat ---------------------------------------------------------------------

  private tools(): ToolSet {
    return {
      get_campaign_summary: tool({
        description:
          'Live campaign figures: target, amount raised, percent, remaining, donor count, days left, milestones reached. All amounts in AUD.',
        inputSchema: z.object({}),
        execute: async () => campaignSummary(this.campaign(), Date.now()),
      }),
      get_recent_donations: tool({
        description: 'Most recent donations (newest first), with donor name, amount (AUD), optional message and time.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional().describe('How many (default 5)') }),
        execute: async ({ limit }) => recentDonations(this.campaign(), limit ?? 5),
      }),
    };
  }

  /** Last HISTORY_WINDOW messages as model messages; must start with a user turn. */
  private async historyForModel(tools: ToolSet): Promise<ModelMessage[]> {
    const window = this.messages.slice(-HISTORY_WINDOW);
    const converted = await convertToModelMessages(window, { tools, ignoreIncompleteToolCalls: true });
    if (converted[0]?.role !== 'user') {
      converted.unshift({ role: 'user', content: '(Earlier conversation omitted.)' });
    }
    return converted;
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const now = Date.now();
    const campaign = this.campaign();
    const tz = this.timezone();
    const tools = this.tools();
    const model = createModel(this.env, { campaign, now, chunkDelayMs: this.mockChunkDelayMs });
    const modelName = reportedModelName(this.env);
    const started = Date.now();

    const result = streamText({
      model,
      instructions: systemPrompt(campaign, now, tz),
      messages: await this.historyForModel(tools),
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onEnd: (event) => {
        this.log({
          at: Date.now(),
          kind: 'chat',
          model: modelName,
          inputTokens: event.totalUsage.inputTokens ?? 0,
          outputTokens: event.totalUsage.outputTokens ?? 0,
          latencyMs: Date.now() - started,
          note: `steps=${event.steps.length}`,
        });
      },
      onError: ({ error }) => {
        this.log({
          at: Date.now(),
          kind: 'chat',
          model: modelName,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - started,
          outcome: 'error',
          note: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const response = result.toUIMessageStreamResponse({
      // Known id up front so the streamed message and the synced one match.
      generateMessageId: () => `reply_${crypto.randomUUID()}`,
      messageMetadata: ({ part }) =>
        part.type === 'start' ? ({ origin: 'reply', createdAt: Date.now() } satisfies MessageMetadata) : undefined,
      onError: (error) => (error instanceof Error ? error.message : 'The coach had a problem replying.'),
    });

    // If an HTTP POST /chat is waiting on this turn, tee the SSE bytes: one branch goes
    // back to AIChatAgent (which persists + broadcasts), the other to the HTTP client.
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    const sink = lastUser ? this.#httpSinks.get(lastUser.id) : undefined;
    if (sink && response.body) {
      this.#httpSinks.delete(lastUser!.id);
      const [forAgent, forHttp] = response.body.tee();
      sink.resolve(forHttp);
      return new Response(forAgent, { status: response.status, headers: response.headers });
    }
    return response;
  }

  /**
   * POST /chat → streamed AI SDK UI message stream (SSE).
   *
   * Design: we do NOT call streamText ourselves here. We append the user message and
   * run a normal AIChatAgent turn via saveMessages(), and onChatMessage tees the
   * response stream to this HTTP request. Why this option:
   *  - the turn runs inside AIChatAgent's turn queue (serialised with other turns),
   *    its keepAlive, persistence, WebSocket broadcast and recovery machinery;
   *  - AIChatAgent reads its tee branch to the end regardless of the HTTP client, and
   *    a cancelled tee branch does not cancel the source, so if the phone drops the
   *    connection the reply still completes and is persisted (next sync recovers it);
   *  - the turn promise is also handed to ctx.waitUntil.
   *
   * Idempotency (clientMessageId = UIMessage id):
   *  - new id → append + reply (200 stream)
   *  - id exists and a reply already followed it, or its reply is in progress → 409
   *    `{ error: 'duplicate', replied: boolean }` (nothing appended or generated;
   *    the client should mark it sent and sync)
   *  - id exists but no reply ever followed (e.g. the earlier turn failed) → no
   *    re-append, but a reply is generated and streamed (200)
   */
  private async handleChat(request: Request): Promise<Response> {
    const parsed = ChatRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: 'invalid_body', details: parsed.error.issues }, 400);
    const body: ChatRequest = parsed.data;
    const id = body.clientMessageId;

    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      const replied = this.messages
        .slice(idx + 1)
        .some((m) => m.role === 'assistant' && metadataOf(m).origin !== 'proactive');
      if (replied || this.#answering.has(id)) {
        return json({ error: 'duplicate', clientMessageId: id, replied }, 409);
      }
    } else if (this.#answering.has(id)) {
      return json({ error: 'duplicate', clientMessageId: id, replied: false }, 409);
    }

    const now = Date.now();
    const userMessage: UIMessage = {
      id,
      role: 'user',
      parts: [{ type: 'text', text: body.text }],
      metadata: { origin: 'user', createdAt: now } satisfies MessageMetadata,
    };
    this.store.set(KV.lastUserMessageAt, now);
    const c = this.campaign();
    this.store.set(KV.campaign, { ...c, lastActivityAt: Math.max(c.lastActivityAt, now) });

    const sink = deferred<ReadableStream<Uint8Array>>();
    this.#httpSinks.set(id, sink);
    this.#answering.add(id);
    const turn = this.saveMessages((current) =>
      current.some((m) => m.id === id) ? [...current] : [...current, userMessage],
    ).finally(() => {
      this.#answering.delete(id);
      this.#httpSinks.delete(id);
    });
    this.ctx.waitUntil(turn.catch(() => undefined));

    const first = await Promise.race([
      sink.promise.then((stream) => ({ stream })),
      turn.then(
        (r) => ({ result: r }),
        (e: unknown) => ({ result: { status: 'error', error: e instanceof Error ? e.message : String(e) } }),
      ),
    ]);
    if ('stream' in first) {
      return new Response(first.stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-vercel-ai-ui-message-stream': 'v1',
          'x-accel-buffering': 'no',
        },
      });
    }
    return json({ error: 'turn_failed', ...first.result }, 500);
  }

  // ---- sync -------------------------------------------------------------------------

  private handleMessages(url: URL): Response {
    const sinceRaw = url.searchParams.get('since') ?? '0';
    const since = Number.parseInt(sinceRaw, 10);
    if (!Number.isFinite(since) || since < 0) return json({ error: 'invalid_since' }, 400);
    const byId = new Map(this.messages.map((m) => [m.id, m]));
    const messages: SyncMessage[] = [];
    for (const { messageId, rev } of this.store.changedSince(since)) {
      const m = byId.get(messageId);
      const sm = m ? toSyncMessage(m, rev) : null;
      if (sm) messages.push(sm);
    }
    const body: SyncResponse = { messages, latestRev: Math.max(since, this.store.latestRev()) };
    return json(body);
  }

  // ---- proactive ----------------------------------------------------------------------

  private logProactive(trigger: ProactiveTrigger, outcome: Outcome, reason?: string, at = Date.now()): void {
    this.store.logProactive({ at, trigger, outcome, ...(reason ? { reason } : {}) });
  }

  /**
   * Run one proactive attempt: guardrails → LLM → persist as an assistant message
   * with metadata { origin: 'proactive', trigger }. Blocked attempts are dropped
   * (logged), not queued.
   */
  async runProactive(ctx: ProactiveContext, opts: { force?: boolean } = {}): Promise<{ outcome: Outcome; message?: string }> {
    const now = Date.now();
    const tz = this.timezone();
    const timings = getTimings(isDevMode(this.env));
    const decision = checkGuardrails({
      now,
      timeZone: tz,
      sentAt: this.store.proactiveSentAt(),
      lastUserMessageAt: this.store.get<number>(KV.lastUserMessageAt) ?? null,
      force: opts.force,
      rules: timings,
    });
    const modelName = reportedModelName(this.env);
    if (!decision.allowed) {
      this.logProactive(ctx.trigger, 'blocked_by_guardrail', decision.reason);
      return { outcome: 'blocked_by_guardrail', message: decision.reason };
    }

    const campaign = this.campaign();
    const started = Date.now();
    let text: string;
    let llmOutcome: Outcome = 'sent';
    try {
      const model = createModel(this.env, { campaign, now, proactive: ctx });
      const tools = this.tools();
      const messages: ModelMessage[] = [
        ...(await this.historyForModel(tools)),
        { role: 'user', content: proactiveInstruction(ctx, campaign, now) },
      ];
      const instructions = systemPrompt(campaign, now, tz);
      let usage: { inputTokens?: number; outputTokens?: number };
      if (ctx.trigger === 'donation') {
        // The LLM decides whether a plain donation is worth a message.
        const res = await generateText({
          model,
          instructions,
          messages,
          output: Output.object({ schema: DonationDecisionSchema }),
        });
        usage = res.totalUsage;
        const out = res.output;
        text = out?.send ? out.message.trim() : '';
        if (!text) llmOutcome = 'skipped_by_llm';
      } else {
        // milestone / inactivity / checkin / manual always produce a message.
        const res = await generateText({ model, instructions, messages, tools, stopWhen: stepCountIs(3) });
        usage = res.totalUsage;
        text = res.text.trim();
        if (!text) throw new Error('empty proactive message');
      }
      this.log({
        at: Date.now(),
        kind: 'proactive',
        trigger: ctx.trigger,
        model: modelName,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        latencyMs: Date.now() - started,
        outcome: llmOutcome,
        ...(opts.force ? { note: 'forced' } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log({
        at: Date.now(),
        kind: 'proactive',
        trigger: ctx.trigger,
        model: modelName,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        outcome: 'error',
        note: msg,
      });
      this.logProactive(ctx.trigger, 'error', msg);
      return { outcome: 'error', message: msg };
    }

    if (llmOutcome === 'skipped_by_llm') {
      this.logProactive(ctx.trigger, 'skipped_by_llm');
      return { outcome: 'skipped_by_llm' };
    }

    const createdAt = Date.now();
    const message: UIMessage = {
      id: `proactive_${crypto.randomUUID()}`,
      role: 'assistant',
      parts: [{ type: 'text', text }],
      metadata: { origin: 'proactive', trigger: ctx.trigger, createdAt } satisfies MessageMetadata,
    };
    await this.persistMessages([...this.messages, message]);
    this.logProactive(ctx.trigger, 'sent', opts.force ? 'forced' : undefined, createdAt);
    return { outcome: 'sent', message: text };
  }

  /** Recurring schedule callback (see ensureSchedules). */
  async proactiveTick(): Promise<void> {
    const now = Date.now();
    const timings = getTimings(isDevMode(this.env));
    const c = this.campaign();
    const lastUser = this.store.get<number>(KV.lastUserMessageAt) ?? 0;
    const lastActivityAt = Math.max(c.lastActivityAt, lastUser);
    if (
      inactivityDue({
        now,
        lastActivityAt,
        lastInactivityAt: this.store.get<number>(KV.lastInactivityAt) ?? null,
        thresholdMs: timings.inactivityThresholdMs,
      })
    ) {
      this.store.set(KV.lastInactivityAt, now);
      await this.runProactive({ trigger: 'inactivity' });
      return;
    }
    if (
      checkinDue({
        now,
        timeZone: this.timezone(),
        lastCheckinAt: this.store.get<number>(KV.lastCheckinAt) ?? c.startedAt,
        intervalMs: timings.checkinIntervalMs,
        atLocalHour: timings.checkinAtLocalHour,
      })
    ) {
      this.store.set(KV.lastCheckinAt, now);
      await this.runProactive({ trigger: 'checkin' });
    }
  }

  // ---- debug ---------------------------------------------------------------------------

  private async debugState(): Promise<DebugState> {
    const now = Date.now();
    const tz = this.timezone();
    return {
      userId: this.name,
      timezone: this.storedTimezone(),
      devMode: isDevMode(this.env),
      model: reportedModelName(this.env),
      campaign: this.campaign(),
      latestRev: this.store.latestRev(),
      proactiveSentToday: countOnLocalDay(this.store.proactiveSentAt(), now, tz),
      llmLog: this.store.llmLog(),
      proactiveLog: this.store.proactiveLog(),
      schedules: this.getSchedules().map((s) => ({
        id: s.id,
        callback: String(s.callback),
        time: s.time * 1000,
        type: s.type,
      })),
    };
  }

  private async debugDonation(input: z.infer<typeof DonationSchema>): Promise<DebugActionResponse> {
    const now = Date.now();
    const { campaign, donation, crossed } = applyDonation(this.campaign(), input, now, `don_${crypto.randomUUID()}`);
    this.store.set(KV.campaign, campaign);
    if (crossed.length > 0) {
      // A milestone message covers the donation too; announce the highest crossed.
      const r = await this.runProactive({ trigger: 'milestone', milestone: crossed[crossed.length - 1], donation });
      return { ok: true, ...r };
    }
    const r = await this.runProactive({ trigger: 'donation', donation });
    return { ok: true, ...r };
  }

  private async debugReset(): Promise<DebugActionResponse> {
    this.resetTurnState();
    for (const s of this.#httpSinks.values()) s.resolve(new ReadableStream({ start: (c) => c.close() }));
    this.#httpSinks.clear();
    this.#answering.clear();
    // Deletes every stored chat message (internal option of persistMessages).
    await super.persistMessages([], [], { _deleteStaleRows: true });
    this.store.clearRevs();
    this.store.clearLogs();
    const tz = this.storedTimezone();
    this.store.clearKv();
    if (tz) this.store.set(KV.timezone, tz);
    this.seed();
    for (const s of this.getSchedules()) {
      if (s.callback === 'proactiveTick') await this.cancelSchedule(s.id);
    }
    await this.ensureSchedules();
    return { ok: true, message: `reset; ${this.messages.length} messages remain` };
  }

  // ---- HTTP routing ----------------------------------------------------------------------

  async onRequest(request: Request): Promise<Response> {
    const tz = request.headers.get('X-Timezone');
    if (isValidTimezone(tz) && tz !== this.storedTimezone()) this.store.set(KV.timezone, tz);

    const url = new URL(request.url);
    // Worker forwards /api/:userId/<route>
    const route = url.pathname.split('/').filter(Boolean).slice(2).join('/');
    const method = request.method.toUpperCase();

    try {
      if (method === 'POST' && route === 'chat') return await this.handleChat(request);
      if (method === 'GET' && route === 'messages') return this.handleMessages(url);
      if (method === 'GET' && route === 'debug/state') return json(await this.debugState());

      if (method === 'POST' && route.startsWith('debug/')) {
        const body = await readJson(request);
        if (body === undefined) return json({ error: 'invalid_json' }, 400);
        switch (route) {
          case 'debug/donation': {
            const p = DonationSchema.safeParse(body);
            if (!p.success) return json({ error: 'invalid_body', details: p.error.issues }, 400);
            return json(await this.debugDonation(p.data));
          }
          case 'debug/milestone': {
            const p = MilestoneSchema.safeParse(body);
            if (!p.success) return json({ error: 'invalid_body', details: p.error.issues }, 400);
            const c = this.campaign();
            if (!c.milestonesHit.includes(p.data.percent)) {
              this.store.set(KV.campaign, {
                ...c,
                milestonesHit: [...c.milestonesHit, p.data.percent].sort((a, b) => a - b),
              });
            }
            return json({ ok: true, ...(await this.runProactive({ trigger: 'milestone', milestone: p.data.percent })) });
          }
          case 'debug/inactivity':
            this.store.set(KV.lastInactivityAt, Date.now());
            return json({ ok: true, ...(await this.runProactive({ trigger: 'inactivity' })) });
          case 'debug/proactive': {
            const p = ForceSchema.safeParse(body);
            if (!p.success) return json({ error: 'invalid_body', details: p.error.issues }, 400);
            return json({ ok: true, ...(await this.runProactive({ trigger: p.data.trigger ?? 'manual' }, { force: true })) });
          }
          case 'debug/reset':
            return json(await this.debugReset());
        }
      }
      return json({ error: 'not_found', route }, 404);
    } catch (e) {
      console.error('[CoachAgent] request failed', route, e);
      return json({ error: 'internal', message: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
}

