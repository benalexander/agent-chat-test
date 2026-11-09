const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_TIMEZONE = 'Australia/Melbourne';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Messages of history sent to the model per turn (PLAN: last 50, no summarisation). */
export const HISTORY_WINDOW = 50;
/** Cap for llmLog / proactiveLog rows. */
export const LOG_CAP = 200;
export const MILESTONES = [25, 50, 75, 100] as const;

export interface ProactiveTimings {
  /** How often the recurring proactive tick runs (seconds). */
  tickIntervalSeconds: number;
  /** No donations and no user messages for this long → inactivity trigger. */
  inactivityThresholdMs: number;
  /** Check-in cadence. In prod also gated to 18:00–21:00 local. */
  checkinIntervalMs: number;
  /** Only check in during the local evening window (prod only). */
  checkinAtLocalHour: number | null;
  /** Nothing proactive within this long of the user's last message. */
  cooldownMs: number;
  maxPerDay: number;
  quietStartHour: number;
  quietEndHour: number;
}

export function getTimings(devMode: boolean): ProactiveTimings {
  if (devMode) {
    return {
      tickIntervalSeconds: 30,
      inactivityThresholdMs: 2 * MINUTE,
      checkinIntervalMs: 3 * MINUTE,
      checkinAtLocalHour: null,
      cooldownMs: 30_000,
      maxPerDay: 2,
      quietStartHour: 21,
      quietEndHour: 8,
    };
  }
  return {
    // 15 min so the 18:00 check-in lands within the 18:00 hour.
    tickIntervalSeconds: 15 * 60,
    inactivityThresholdMs: 4 * DAY,
    checkinIntervalMs: 3 * DAY,
    checkinAtLocalHour: 18,
    cooldownMs: 10 * MINUTE,
    maxPerDay: 2,
    quietStartHour: 21,
    quietEndHour: 8,
  };
}

export function isDevMode(env: Cloudflare.Env): boolean {
  return String(env.DEV_MODE).toLowerCase() === 'true';
}

export function modelName(env: Cloudflare.Env): string {
  return env.MODEL || DEFAULT_MODEL;
}

export function llmMode(env: Cloudflare.Env): 'anthropic' | 'mock' {
  return String(env.LLM_MODE).toLowerCase() === 'mock' ? 'mock' : 'anthropic';
}
