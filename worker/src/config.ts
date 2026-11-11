const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  /** Check-in cadence. If checkinAtLocalHour is set, also gated to that local hour. */
  checkinIntervalMs: number;
  /** Only check in during this local hour (null = no time-of-day gate). */
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
  // Initial device trial (2026-11-11): hourly check-ins, inactivity after 2 h, 20/day cap,
  // so background notifications get exercised often. Original design (PLAN.md): check-in
  // every 3 days at 18:00 local (checkinAtLocalHour: 18, 15-min tick), inactivity after
  // 4 days, 2/day.
  return {
    // 5 min so hourly check-ins don't drift much (the tick itself makes no LLM call).
    tickIntervalSeconds: 5 * 60,
    inactivityThresholdMs: 2 * HOUR,
    checkinIntervalMs: 1 * HOUR,
    checkinAtLocalHour: null,
    cooldownMs: 10 * MINUTE,
    maxPerDay: 20,
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
