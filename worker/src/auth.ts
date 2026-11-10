/** Constant-time-ish string compare (lengths leak, which is fine for this POC). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerMatches(request: Request, secret: string | undefined): boolean {
  if (!secret) return false; // fail closed if the secret isn't configured
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return !!match && safeEqual(match[1].trim(), secret);
}

/** App routes (/api/*): APP_SHARED_SECRET only. */
export function isAuthorized(request: Request, env: Cloudflare.Env): boolean {
  return bearerMatches(request, env.APP_SHARED_SECRET);
}

/**
 * Admin routes (/admin/api/*): ADMIN_SECRET only. Fails closed if it's unset, or if it
 * was configured equal to APP_SHARED_SECRET (the app secret must never grant admin).
 */
export function isAdminAuthorized(request: Request, env: Cloudflare.Env): boolean {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  if (secret === env.APP_SHARED_SECRET) {
    console.warn('[admin] ADMIN_SECRET equals APP_SHARED_SECRET; admin API disabled');
    return false;
  }
  return bearerMatches(request, secret);
}
