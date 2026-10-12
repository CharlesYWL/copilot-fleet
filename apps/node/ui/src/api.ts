export const sessionPath = (id: string, suffix = "") =>
  `/api/fleet-sessions/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`;

const pendingOperations = new Map<string, string>();

/** An uncertain response is retried with the same operation ID, not a new prompt. */
export async function nodeApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const changesState = method !== "GET" && method !== "HEAD";
  const headers = new Headers(init?.headers);
  let body = init?.body;
  let operationKey: string | undefined;
  if (changesState) {
    headers.set("content-type", "application/json");
    const payload = typeof body === "string" ? JSON.parse(body) : {};
    operationKey = `${method}:${path}:${JSON.stringify(payload)}`;
    const operationId = pendingOperations.get(operationKey) ?? crypto.randomUUID();
    pendingOperations.set(operationKey, operationId);
    body = JSON.stringify({ ...payload, operationId });
  }
  const response = await fetch(path, { ...init, headers, ...(body ? { body } : {}) });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  }
  const result = response.status === 204 ? undefined : await response.json();
  if (operationKey) pendingOperations.delete(operationKey);
  return result as T;
}
