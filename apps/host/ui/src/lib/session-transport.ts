import { api } from "../hooks/useFleet";

/** The Node entry uses the same views, but never the Host's auth/CSRF transport. */
let transport: { basePath: string; request: typeof api } | undefined;

export function configureSessionTransport(value: NonNullable<typeof transport>): void {
  transport = value;
}

export function sessionApiPath(sessionId: string, suffix: string): string {
  return `${transport?.basePath ?? "/api/sessions"}/${encodeURIComponent(sessionId)}/${suffix}`;
}

export function sessionRequest<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const request = transport?.request ?? api;
  return init === undefined ? request<T>(path) : request<T>(path, init);
}
