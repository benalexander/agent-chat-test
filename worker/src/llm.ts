import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapAISDK } from 'agents/observability/ai';
import * as ai from 'ai';
import type { LanguageModel } from 'ai';
import { llmMode, modelName } from './config';
import { createMockModel, type MockContext } from './mock-model';

/**
 * Anthropic via Cloudflare AI Gateway when AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_ID are
 * set, otherwise Anthropic directly. The AI SDK provider sends the key as `x-api-key`;
 * `cf-aig-authorization` is added only for authenticated gateways.
 */
export function createModel(env: Cloudflare.Env, mock: MockContext): LanguageModel {
  if (llmMode(env) === 'mock') return createMockModel(mock);

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set (or set LLM_MODE=mock)');
  }
  const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const baseURL =
    accountId && gatewayId ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1` : undefined;
  const headers: Record<string, string> = {};
  if (baseURL && env.CF_AIG_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;

  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(baseURL ? { baseURL } : {}),
    headers,
  });
  return anthropic(modelName(env));
}

/**
 * AI SDK functions wrapped for Workers tracing: each call becomes an `invoke_agent`
 * span with model-call and tool spans under it (dashboard → Agents). Message and tool
 * payloads are stored on the spans (POC: handy for debugging; conversation text ends
 * up in the Cloudflare dashboard).
 */
const traced = wrapAISDK(ai, { storeMessages: true, storeTools: true });
export const generateText: typeof ai.generateText = traced.generateText;
export const streamText: typeof ai.streamText = traced.streamText;

/** Identity fields for traced calls: agent = user's coach, conversation = user id. */
export function traceIdentity(userId: string, functionId: 'chat' | `proactive.${string}`) {
  return {
    runtimeContext: { agentId: userId, agentName: 'coach', conversationId: userId },
    telemetry: { functionId: `coach.${functionId}` },
  };
}

export function reportedModelName(env: Cloudflare.Env): string {
  return llmMode(env) === 'mock' ? `mock (${modelName(env)})` : modelName(env);
}
