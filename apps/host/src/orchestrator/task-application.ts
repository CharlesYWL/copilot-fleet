import {
  isChatsWorkspace,
  terminalSessionStates,
  type Run,
  type FleetSession,
  type Workspace,
  type WorkspaceMode,
} from "@fleet/protocol";
import type { FleetStore } from "../store.js";

/**
 * A refusal raised while opening a task, carrying the HTTP status and stable
 * code every caller maps it to. Shared by the browser route and the local
 * agent API so the two cannot drift on what "this task cannot be opened" means.
 */
export class TaskApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskApplicationError";
  }
}

/** The orchestrator a new task can be opened on, or undefined when there is none. */
export function findTaskLead(
  store: FleetStore,
  leadId: string,
): FleetSession | undefined {
  const lead = store.getSession(leadId);
  if (!lead || lead.runRole !== "lead" || terminalSessionStates.has(lead.state)) {
    return undefined;
  }
  return lead;
}

/** Whether a task opened in this workspace would get a Fleet-managed checkout. */
export function taskWouldBeManaged(
  store: FleetStore,
  workspaceId: string,
  workspaceMode: WorkspaceMode,
): boolean {
  return (
    !isChatsWorkspace(workspaceId) &&
    (workspaceMode === "managed" ||
      (workspaceMode === "auto" && store.getManagedWorktreesEnabled()))
  );
}

/**
 * The checks that depend on mutable state: whether the lead is stopping, the
 * source placement, and whether any online Node can hold the work.
 *
 * Separate from {@link findTaskLead} so an idempotent replay can be answered
 * between the two: a retry of a creation that already succeeded must get its
 * original answer even if the lead has since started stopping.
 */
export function assertTaskAdmissible(
  store: FleetStore,
  input: {
    lead: FleetSession;
    workspace: Workspace;
    workspaceMode: WorkspaceMode;
    sourcePlacementId?: string | undefined;
    /** Managed creation must be retry-safe; false refuses it as `idempotency_required`. */
    hasOperationId: boolean;
  },
): void {
  if (input.lead.stopRequested) {
    throw new TaskApplicationError(409, "lead_stopping", "The orchestrator is stopping");
  }
  if (
    input.sourcePlacementId &&
    store.getPlacement(input.sourcePlacementId)?.workspaceId !== input.workspace.id
  ) {
    throw new TaskApplicationError(
      409,
      "source_mismatch",
      "Select a source placement in this workspace.",
    );
  }
  const managed = taskWouldBeManaged(store, input.workspace.id, input.workspaceMode);
  if (managed && !input.sourcePlacementId) {
    throw new TaskApplicationError(
      409,
      "source_required",
      "Select the repository copy that should define this task’s baseline.",
    );
  }
  if (managed && !input.hasOperationId) {
    throw new TaskApplicationError(
      409,
      "idempotency_required",
      "Managed task creation requires an operationId.",
    );
  }
  const reachable = store
    .listPlacements()
    .some(
      (placement) =>
        placement.workspaceId === input.workspace.id &&
        store.getNode(placement.nodeId)?.online,
    );
  if (!reachable) {
    throw new TaskApplicationError(
      409,
      "workspace_unreachable",
      "No online node holds that workspace, so a task cannot run",
    );
  }
}

/**
 * The turn a new task arrives as.
 *
 * Shaped like the wake envelopes, because that is the form the orchestrator has
 * been treating as "a fact to act on" since its first turn. A bare sentence
 * from a person reads as something to reply to instead.
 *
 * It names the task by its ID as well as its name. Planning by name alone
 * resolved to whichever task already held that name, so a second task called
 * "Fix login" either adopted the wrong record or was refused as ambiguous; the
 * ID is the one handle {@link FleetTools.run} resolves first and exactly.
 */
export function taskBrief(input: {
  id: string;
  name: string;
  objective: string;
  workspace: string;
}): string {
  return [
    `<fleet-task id=${JSON.stringify(input.id)} name=${JSON.stringify(input.name)} workspace=${JSON.stringify(input.workspace)}>`,
    input.objective,
    "</fleet-task>",
    "",
    `Plan this with fleet_plan_task using task "${input.id}" (its exact task ID; the`,
    `name is "${input.name}"), then dispatch the work for its first phase and end your turn.`,
  ].join("\n");
}

export type CreateTaskOnLeadInput = {
  lead: FleetSession;
  workspace: Workspace;
  name: string;
  objective: string;
  workspaceMode: WorkspaceMode;
  sourcePlacementId?: string | undefined;
  integrationBaseRef?: string | undefined;
  integrationBranchRef?: string | undefined;
  integrationUsername?: string | undefined;
  policy?:
    | {
        maxParallel?: number | undefined;
        maxSessions?: number | undefined;
        maxWakes?: number | undefined;
      }
    | undefined;
  /**
   * Writes the caller needs in the same commit as the task — an idempotency
   * record, a ledger row. Runs inside the transaction, so it must only use
   * synchronous store methods.
   */
  record?: (run: Run) => void;
};

/**
 * Creates a task already owned by an orchestrator, running, and owing it a
 * brief — in one commit.
 *
 * It used to be two: the run and its replay record, then a separate update that
 * gave it an owner and the brief. A crash between them left an unowned task in
 * `awaiting_approval` that no orchestrator knew about and a retry could only
 * replay, never repair.
 *
 * Preparing a managed checkout, publishing and ticking the engine are left to
 * the caller, after this returns: they are network effects, and nothing here
 * may await.
 */
export function createTaskOnLead(store: FleetStore, input: CreateTaskOnLeadInput): Run {
  const template = store
    .listRuns()
    .find((entry) => entry.leadSessionId === input.lead.id);
  return store.writeAtomically(() => {
    const created = store.createRun({
      workspaceMode: input.workspaceMode,
      sourcePlacementId: input.sourcePlacementId,
      integrationBaseRef: input.integrationBaseRef,
      integrationBranchRef: input.integrationBranchRef,
      integrationUsername: input.integrationUsername,
      accessIntent: isChatsWorkspace(input.workspace.id) ? "no-checkout" : "checkout",
      workspaceId: input.workspace.id,
      name: input.name,
      objective: input.objective,
      policy: {
        ...(template ? template.policy : {}),
        ...(input.policy ?? {}),
        wakePolicy: "on_any_settle",
        onStepFailure: "wake",
      },
    });
    const run = store.updateRun(created.id, {
      leadSessionId: input.lead.id,
      state: "running",
      /*
       * The brief is owed rather than sent. It goes out on the first tick where
       * the orchestrator is free; an orchestrator running another task is the
       * ordinary case, and a prompt pushed at it mid-turn is refused by the
       * Node and reported only as a transcript notice — so a direct send here
       * would create a task nothing had been told about.
       */
      pendingPrompt: taskBrief({
        id: created.id,
        name: created.name,
        objective: created.objective,
        workspace: input.workspace.name,
      }),
    })!;
    input.record?.(run);
    return run;
  });
}
