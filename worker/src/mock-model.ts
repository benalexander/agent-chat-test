/**
 * LLM_MODE=mock: canned but plausible coach behaviour using the AI SDK's own mock
 * model, so the whole system (streaming, tools, persistence, proactive flow) works
 * end-to-end without an API key. Token usage is faked (~4 chars/token).
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { CampaignState, ProactiveTrigger } from '@agent-chat/shared';
import { campaignSummary, recentDonations } from './campaign';
import type { ProactiveContext } from './prompts';

export interface MockContext {
  campaign: CampaignState;
  now: number;
  proactive?: ProactiveContext;
  /** Per-chunk delay for streamed text (ms). Tests use 0. */
  chunkDelayMs?: number;
}

function usage(inputChars: number, outputChars: number): LanguageModelV4Usage {
  const input = Math.max(1, Math.round(inputChars / 4));
  const output = Math.max(1, Math.round(outputChars / 4));
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function promptChars(prompt: LanguageModelV4Prompt): number {
  return JSON.stringify(prompt).length;
}

function lastMessage(prompt: LanguageModelV4Prompt) {
  return prompt[prompt.length - 1];
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === 'user') {
      return m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
    }
  }
  return '';
}

/** Split into word-ish chunks so the client sees a realistic stream. */
function chunkText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function textStream(text: string, inputChars: number, delay: number): ReadableStream<LanguageModelV4StreamPart> {
  const id = 'text-1';
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: `mock-${crypto.randomUUID()}`, modelId: 'mock-coach', timestamp: new Date() },
    { type: 'text-start', id },
    ...chunkText(text).map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id, delta })),
    { type: 'text-end', id },
    { type: 'finish', usage: usage(inputChars, text.length), finishReason: { unified: 'stop', raw: 'end_turn' } },
  ];
  return simulateReadableStream({ chunks, initialDelayInMs: delay * 4, chunkDelayInMs: delay });
}

function toolCallStream(toolName: string, input: unknown, inputChars: number): ReadableStream<LanguageModelV4StreamPart> {
  const toolCallId = `call_${crypto.randomUUID().slice(0, 8)}`;
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', usage: usage(inputChars, 20), finishReason: { unified: 'tool-calls', raw: 'tool_use' } },
  ];
  return simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 });
}

function chatReply(userText: string, ctx: MockContext): string {
  const s = campaignSummary(ctx.campaign, ctx.now);
  const t = userText.toLowerCase();
  if (/\b(hi|hello|hey|g'day)\b/.test(t)) {
    return `G'day! Great to hear from you. You're at A$${s.raised} of your A$${s.target} goal for ${s.charity}, with ${s.daysLeft} days to go. What would you like to work on today?`;
  }
  if (/train|run|km|pace|injur|sore/.test(t)) {
    return `Nice one for keeping the training ticking over! A training update with a photo is one of the easiest ways to remind people what you're working towards. For anything injury-related, a physio is the best person to check in with.`;
  }
  if (/idea|share|post|ask|email|social/.test(t)) {
    return `A short personal post about why ${s.charity} matters to you usually works well, plus a link to your page. You could also thank your ${s.donorCount} donors publicly, which tends to nudge others along. Want me to draft something?`;
  }
  return `Thanks for the message! You've raised A$${s.raised} so far (${s.percentRaised}% of A$${s.target}), and every bit helps ${s.charity}. Let me know if you'd like ideas for your next update.`;
}

function proactiveText(ctx: MockContext): string {
  const s = campaignSummary(ctx.campaign, ctx.now);
  const p = ctx.proactive;
  const trigger: ProactiveTrigger = p?.trigger ?? 'manual';
  switch (trigger) {
    case 'milestone':
      return `Woohoo, you've hit ${p?.milestone ?? Math.floor(s.percentRaised / 25) * 25}% of your goal! That's A$${s.raised} raised for ${s.charity}. A quick thank-you post to your donors would be a lovely way to keep the momentum going.`;
    case 'inactivity':
      return `Hey, just checking in! Things have been a bit quiet on the fundraising front lately. A quick training update or photo from your last run is an easy, no-pressure way to remind people about your page.`;
    case 'checkin':
      return `Evening check-in! You're on A$${s.raised} of A$${s.target} with ${s.daysLeft} days to go. How's the training feeling this week?`;
    case 'donation': {
      const d = p?.donation;
      return d
        ? `Nice! ${d.donorName} just donated A$${d.amount}${d.message ? ` and said "${d.message}"` : ''}. You might like to send them a quick thank-you.`
        : `You've just had a new donation come in. Lovely stuff!`;
    }
    default:
      return `Quick hello from your coach! You're ${s.percentRaised}% of the way to A$${s.target} for ${s.charity}. Keep it up, you're doing great.`;
  }
}

function donationDecision(ctx: MockContext): { send: boolean; message: string } {
  const d = ctx.proactive?.donation;
  // Plausible LLM judgement: message on bigger gifts or ones with a personal note.
  const send = !!d && (d.amount >= 50 || !!d.message);
  return { send, message: send ? proactiveText(ctx) : '' };
}

export function createMockModel(ctx: MockContext) {
  const delay = ctx.chunkDelayMs ?? 40;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-coach',
    doStream: async (options: LanguageModelV4CallOptions) => {
      const inputChars = promptChars(options.prompt);
      const last = lastMessage(options.prompt);
      const userText = lastUserText(options.prompt);
      // Exercise multi-step tool use: progress questions call get_campaign_summary first.
      const wantsFigures = /raised|progress|how much|target|total|donat|goal/i.test(userText);
      if (last?.role === 'user' && wantsFigures && options.tools?.some((t) => t.name === 'get_campaign_summary')) {
        return { stream: toolCallStream('get_campaign_summary', {}, inputChars) };
      }
      let text: string;
      if (last?.role === 'tool') {
        const s = campaignSummary(ctx.campaign, ctx.now);
        const latest = recentDonations(ctx.campaign, 1)[0];
        text = `You've raised A$${s.raised} of your A$${s.target} target (${s.percentRaised}%) from ${s.donorCount} donors, with ${s.daysLeft} days to go.${latest ? ` Your most recent donation was A$${latest.amount} from ${latest.donorName.replace(/\.$/, '')}.` : ''} Great work, keep it rolling!`;
      } else {
        text = chatReply(userText, ctx);
      }
      return { stream: textStream(text, inputChars, delay) };
    },
    doGenerate: async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
      const inputChars = promptChars(options.prompt);
      const text =
        options.responseFormat?.type === 'json' || ctx.proactive?.trigger === 'donation'
          ? JSON.stringify(donationDecision(ctx))
          : proactiveText(ctx);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: usage(inputChars, text.length),
        warnings: [],
      };
    },
  });
}
