import { z } from "zod";
import { CreateOrchestrationSchema } from "@fleet/protocol";

const STORAGE_KEY = "fleet.orchestration.pending.v1";
const PendingSchema = z
  .object({
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: CreateOrchestrationSchema.shape.requestId.unwrap(),
  })
  .strict();

function pending() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw === null ? undefined : PendingSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "Unable to read safe retry state. Allow session storage or clear this page's pending orchestration key.",
    );
  }
}

/** Persist only a digest and an opaque key, never the incident request itself. */
export async function orchestrationRequestKey(input: string): Promise<string> {
  if (!crypto.subtle)
    throw new Error(
      "Safe request retries require browser cryptography. Open the Host on localhost or HTTPS.",
    );
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const inputHash = [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const previous = pending();
  if (previous?.inputHash === inputHash) return previous.requestId;
  const requestId = crypto.randomUUID();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ inputHash, requestId }));
  } catch {
    throw new Error(
      "Unable to persist a safe retry key. Allow session storage before creating the task.",
    );
  }
  return requestId;
}

export function completeOrchestrationRequest(requestId: string): void {
  if (pending()?.requestId !== requestId) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    throw new Error(
      "Task created, but its retry key could not be cleared from session storage.",
    );
  }
}
