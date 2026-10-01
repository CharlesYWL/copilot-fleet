import type { RunStep, StepAdmission, WorkerResumeRequest } from "@fleet/protocol";

/** Newest first, one entry per request, the highest version winning. */
export function mergeResumeRequests(
  current: readonly WorkerResumeRequest[],
  incoming: readonly WorkerResumeRequest[],
): WorkerResumeRequest[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  for (const request of incoming) {
    const known = byId.get(request.id);
    if (!known || known.version <= request.version) byId.set(request.id, request);
  }
  return [...byId.values()]
    .sort(
      (a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id),
    )
    .slice(0, 100);
}

export const admissionStateLabels: Record<StepAdmission["state"], string> = {
  queued: "Queued",
  blocked: "Blocked",
  awaiting_approval: "Awaiting approval",
  starting: "Starting",
  running: "Running",
};

/** A queued follow-up in a retained worker that "Resume now" can act on. */
export function canResumeNow(step: RunStep): boolean {
  const admission = step.admission;
  return (
    step.state === "pending" &&
    Boolean(step.sessionId) &&
    Boolean(admission?.resumable) &&
    admission?.state !== "starting" &&
    admission?.state !== "awaiting_approval"
  );
}

export function requestedByLabel(request: WorkerResumeRequest): string {
  return request.requestedBy.kind === "orchestrator"
    ? `Orchestrator ${request.requestedBy.id}`
    : `Operator ${request.requestedBy.id || "(this Host)"}`;
}
