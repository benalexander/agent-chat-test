/**
 * Runtime configuration. EXPO_PUBLIC_* vars are inlined by Metro at build
 * time (see .env.example); access them with dot notation so inlining works.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8787').replace(/\/+$/, '');
export const APP_SECRET = process.env.EXPO_PUBLIC_APP_SECRET || 'dev-secret';

/** TaskManager name for the periodic background sync. */
export const BACKGROUND_TASK_NAME = 'agent-chat-background-sync';
/** Requested expo-background-task interval (minutes). 15 is the platform minimum. */
export const BACKGROUND_TASK_INTERVAL_MINUTES = 15;
/** Background sync gives up on GET /messages after this long. */
export const BACKGROUND_SYNC_TIMEOUT_MS = 10_000;
/** Foreground sync timeout (pull-to-refresh, polls). */
export const FOREGROUND_SYNC_TIMEOUT_MS = 15_000;
/** Poll interval while Coach is focused and the app is active. */
export const COACH_POLL_MS = 10_000;
