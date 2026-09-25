import type { AdminRoom, FinishSessionResponse, PublicRoom, RuntimeConfig, SessionRecord, StartSessionRequest } from '@nerditulos/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'http_error';
    throw new ApiError(response.status, code, body);
  }
  return body as T;
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  return parse<RuntimeConfig>(await fetch('/api/config', { cache: 'no-store' }));
}

export async function fetchRooms(): Promise<PublicRoom[]> {
  const body = await parse<{ rooms: PublicRoom[] }>(await fetch('/api/rooms', { cache: 'no-store' }));
  return body.rooms;
}

export async function fetchRoom(slug: string): Promise<PublicRoom> {
  return parse<PublicRoom>(await fetch(`/api/rooms/${encodeURIComponent(slug)}`, { cache: 'no-store' }));
}

/** Supplies the Clerk session token, or null when there is none (demo mode, signed out). */
export type TokenSupplier = () => Promise<string | null>;

async function adminFetch<T>(getToken: TokenSupplier, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return parse<T>(await fetch(path, { ...init, headers, cache: 'no-store' }));
}

/** `GET /api/admin/me`: how the server sees this browser. */
export type AdminMe = { mode: 'demo' } | { mode: 'clerk'; userId: string; exp: number };

export const adminApi = {
  me: (getToken: TokenSupplier) => adminFetch<AdminMe>(getToken, '/api/admin/me'),
  rooms: (getToken: TokenSupplier) => adminFetch<{ rooms: AdminRoom[] }>(getToken, '/api/admin/rooms'),
  session: (getToken: TokenSupplier, sessionId: string) => adminFetch<{ session: SessionRecord }>(getToken, `/api/admin/sessions/${encodeURIComponent(sessionId)}`),
  prepare: (getToken: TokenSupplier, slug: string, input: { title: string; sourceLanguage: 'es' | 'en' }) =>
    adminFetch<{ session: SessionRecord }>(getToken, `/api/admin/rooms/${encodeURIComponent(slug)}/sessions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  start: (getToken: TokenSupplier, sessionId: string, input: StartSessionRequest = {}) =>
    adminFetch<{ session: SessionRecord }>(getToken, `/api/admin/sessions/${encodeURIComponent(sessionId)}/start`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  finish: (getToken: TokenSupplier, sessionId: string) =>
    adminFetch<FinishSessionResponse>(getToken, `/api/admin/sessions/${encodeURIComponent(sessionId)}/finish`, { method: 'POST' }),
  delete: (getToken: TokenSupplier, sessionId: string) =>
    adminFetch<null>(getToken, `/api/admin/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
};
