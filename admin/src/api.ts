import {
  ADMIN_API_PREFIX,
  type AdminActionResponse,
  type AdminDonationRequest,
  type AdminErrorResponse,
  type AdminMilestoneRequest,
  type AdminProactiveRequest,
  type AdminUserDetail,
  type AdminUsersResponse,
  type UpdateCampaignRequest,
  type UpdateCampaignResponse,
} from '@agent-chat/shared';

const SECRET_KEY = 'agent-chat-admin-secret';

export function getSecret(): string | null {
  return localStorage.getItem(SECRET_KEY);
}

export function setSecret(secret: string): void {
  localStorage.setItem(SECRET_KEY, secret);
}

export function clearSecret(): void {
  localStorage.removeItem(SECRET_KEY);
}

/** Registered once by App so a 401 anywhere drops back to the login screen. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  body: AdminErrorResponse | null;
  constructor(status: number, body: AdminErrorResponse | null) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getSecret() ?? ''}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(ADMIN_API_PREFIX + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearSecret();
    onUnauthorized();
  }
  if (!res.ok) {
    let parsed: AdminErrorResponse | null = null;
    try {
      parsed = (await res.json()) as AdminErrorResponse;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

const userPath = (userId: string) => `/users/${encodeURIComponent(userId)}`;

export const api = {
  listUsers: () => request<AdminUsersResponse>('GET', '/users'),
  getUser: (userId: string) => request<AdminUserDetail>('GET', userPath(userId)),
  injectDonation: (userId: string, body: AdminDonationRequest) =>
    request<AdminActionResponse>('POST', `${userPath(userId)}/donation`, body),
  injectMilestone: (userId: string, body: AdminMilestoneRequest) =>
    request<AdminActionResponse>('POST', `${userPath(userId)}/milestone`, body),
  injectInactivity: (userId: string) =>
    request<AdminActionResponse>('POST', `${userPath(userId)}/inactivity`, {}),
  forceProactive: (userId: string, body: AdminProactiveRequest) =>
    request<AdminActionResponse>('POST', `${userPath(userId)}/proactive`, body),
  reset: (userId: string) => request<AdminActionResponse>('POST', `${userPath(userId)}/reset`, {}),
  updateCampaign: (userId: string, body: UpdateCampaignRequest) =>
    request<UpdateCampaignResponse>('PATCH', `${userPath(userId)}/campaign`, body),
  deleteUser: (userId: string) => request<AdminActionResponse>('DELETE', userPath(userId)),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
