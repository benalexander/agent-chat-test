import { createAnthropic } from '@ai-sdk/anthropic';
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

export function reportedModelName(env: Cloudflare.Env): string {
  return llmMode(env) === 'mock' ? `mock (${modelName(env)})` : modelName(env);
}
