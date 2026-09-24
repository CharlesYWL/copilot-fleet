import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostToNodeMessageSchema,
  IntegrationPreviewSchema,
  ManagedWorktreeSchema,
  RepositoryProbeResultSchema,
  WorktreeIntegrationSchema,
  WorktreeObservationSchema,
  WorktreeOperationResultSchema,
  WorktreeOperationRequestSchema,
  type HostToNodeMessage,
  type ManagedWorktree,
  type WorktreeOperationRequest,
  type WorktreeOperationResult,
} from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { FleetService } from "./fleet-service.js";
import { ManagedWorktreeService } from "./managed-worktree-service.js";

const resources: { store: FleetStore; service: FleetService }[] = [];
afterEach(() => {
  for (const { service, store } of resources.splice(0)) {
    service.shutdown();
    store.close();
  }
});
function fixture(capable = true) {
  const store = new FleetStore(":memory:");
  const logs: Array<{ details: unknown; message: unknown }> = [];
  const log = {
    info(details: unknown, message: unknown) {
      logs.push({ details, message });
    },
    warn() {},
    error() {},
    debug() {},
  } as unknown as FastifyBaseLogger;
  const service = new FleetService(store, log);
  resources.push({ store, service });
  const { node } = store.registerNode({
    name: "Node",
    os: "win32",
    arch: "x64",
    version: "test",
    maxSessions: 8,
    capabilities: ["host-yolo", ...(capable ? ["managed-worktrees-v1"] : [])],
  });
  const frames: HostToNodeMessage[] = [];
  service.attachNode(node.id, {
    OPEN: 1,
    readyState: 1,
    send: (text) => frames.push(HostToNodeMessageSchema.parse(JSON.parse(text))),
    close() {},
  });
  store.setNodeOnline(node.id, true);
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const create = (mode: "auto" | "managed" | "legacy" = "managed") =>
    store.createRun({
      workspaceId: workspace.id,
      name: randomUUID(),
      objective: "task",
      workspaceMode: mode,
      sourcePlacementId: placement.id,
    });
  return { store, service, node, frames, placement, create, logs };
}
function acknowledgement(request: WorktreeOperationRequest): WorktreeOperationResult {
  const safeKey = createHash("sha256")
    .update(`${request.hostInstallationId}:${request.runId}:${request.generation}`)
    .digest("hex")
    .slice(0, 32);
  const physical = (key: string, path: string) => ({
    key,
    path,
    machineId: "machine",
    volume: "volume",
    fileId: key,
  });
  const path = `C:\\trees\\${safeKey}`;
  const worktree = ManagedWorktreeSchema.parse({
    id: request.worktreeId,
    runId: request.runId,
    taskKey: safeKey,
    sourcePlacementId: request.sourcePlacementId,
    originatingPlacementId: request.originatingPlacementId,
    executionPlacementId: request.sourcePlacementId,
    repositoryIdentity: request.repositoryIdentity || "f".repeat(64),
    repositoryObjectFormat: request.repositoryObjectFormat || "sha1",
    workspaceId: request.workspaceId,
    nodeId: request.nodeId,
    machineId: "machine",
    hostInstallationId: request.hostInstallationId,
    nodeInstallationId: "installation",
    repository: physical("repo", request.sourcePath),
    commonDirectory: physical("common", "C:\\repo\\.git"),
    managedRoot: physical("root", "C:\\trees"),
    generation: request.generation,
    version: request.expectedVersion + 1,
    path,
    ...(request.kind !== "reserve"
      ? { checkout: physical(`checkout-${safeKey}`, path) }
      : {}),
    branchRef: `refs/heads/fleet/${safeKey}`,
    pinRef: `refs/fleet/pins/${safeKey}`,
    baseSha: "a".repeat(40),
    baseRef: "refs/heads/main",
    allowGitHooks: request.allowGitHooks,
    state: request.kind === "reserve" ? "reserved" : "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return WorktreeOperationResultSchema.parse({
    operationId: request.operationId,
    worktreeId: request.worktreeId,
    generation: request.generation,
    nodeId: request.nodeId,
    hostInstallationId: request.hostInstallationId,
    ok: true,
    worktree,
    acknowledgedAt: new Date().toISOString(),
  });
}
function lastRequest(frames: HostToNodeMessage[]): WorktreeOperationRequest {
  const last = frames.filter((frame) => frame.type === "managed_worktree").at(-1);
  if (!last || last.type !== "managed_worktree")
    throw new Error("Expected a worktree operation");
  return last.request;
}

async function readyManaged(fixtureValue: ReturnType<typeof fixture>, aggregate = true) {
  const { create, frames, node, service, store } = fixtureValue;
  const run = create();
  const preparing = service.worktrees.prepare(run.id);
  const reserve = lastRequest(frames);
  service.worktrees.handleResult(node.id, acknowledgement(reserve));
  await preparing;
  const creating = service.worktrees.request(run.id, {
    kind: "create",
    actor: "test",
  });
  const createRequest = lastRequest(frames);
  service.worktrees.handleResult(node.id, acknowledgement(createRequest));
  await creating;
  if (aggregate) {
    const current = store.getRun(run.id)!;
    store.setRunWorkspaceBinding(run.id, {
      ...current.workspaceBinding!,
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: 1,
    });
    store.setRunState(run.id, "aggregating");
  }
  return store.getRun(run.id)!;
}

function operationResult(
  store: FleetStore,
  request: WorktreeOperationRequest,
  options: {
    targetRef?: string;
    noChanges?: boolean;
    verifiedClean?: boolean;
    legacyNoChangesAwaitingPublication?: boolean;
    publicationRequired?: boolean;
    integrationState?: "integrated" | "no_changes" | "conflicted";
  } = {},
): WorktreeOperationResult {
  const current = store.getAnyManagedWorkspace(request.worktreeId)!;
  const state =
    request.kind === "retain"
      ? "retained"
      : request.kind === "cleanup"
        ? "removed"
        : current.state;
  const integrationState =
    options.integrationState ?? (options.noChanges ? "no_changes" : "integrated");
  const worktree = ManagedWorktreeSchema.parse({
    ...current,
    version: request.expectedVersion + 1,
    state,
    integrationState:
      request.kind === "integrate" ? integrationState : current.integrationState,
    retainedAt: request.kind === "retain" ? new Date().toISOString() : current.retainedAt,
    removedAt: request.kind === "cleanup" ? new Date().toISOString() : current.removedAt,
    ...(options.verifiedClean
      ? {
          observation: WorktreeObservationSchema.parse({
            generation: current.generation,
            observedAt: new Date().toISOString(),
            head: current.baseSha,
            dirty: false,
          }),
        }
      : {}),
    updatedAt: new Date().toISOString(),
  });
  const targetRef =
    options.targetRef ??
    store.getRun(request.runId)?.workspaceBinding?.integrationTargetRef ??
    "refs/heads/main";
  const preview = IntegrationPreviewSchema.parse({
    id:
      request.kind === "integration_preview"
        ? request.operationId
        : (request.previewId ?? "unused-preview"),
    worktreeId: request.worktreeId,
    generation: request.generation,
    taskSha: current.resultSha || current.baseSha,
    diffIdentity: "automatic-diff",
    diff: options.noChanges ? "" : "+change\n",
    targetPlacementId: request.targetPlacementId ?? current.sourcePlacementId,
    target: current.repository,
    targetRef,
    targetBaseRef: request.integrationBaseRef,
    targetRemote:
      request.integrationRemote ??
      store.getRun(request.runId)?.workspaceBinding?.integrationRemote ??
      "",
    targetSha: current.baseSha,
    taskDirty: false,
    targetDirty: false,
    hasCommittedChanges: !options.noChanges,
    baseContainedByTarget: true,
    targetAdvancedFromBase: false,
    alreadyIntegrated: false,
    observedAt: new Date().toISOString(),
  });
  const integration =
    request.kind === "integrate" || request.kind === "publish"
      ? WorktreeIntegrationSchema.parse({
          id: request.kind === "publish" ? request.integrationId : request.operationId,
          worktreeId: request.worktreeId,
          generation: request.generation,
          preview,
          approvedTaskSha: preview.taskSha,
          approvedDiffIdentity: preview.diffIdentity,
          state: integrationState,
          preState: "clean",
          resultSha: options.publicationRequired ? "c".repeat(40) : preview.targetSha,
          finalTree: options.publicationRequired ? "d".repeat(40) : preview.targetSha,
          conflicts: integrationState === "conflicted" ? ["same.txt"] : [],
          validationState: integrationState === "conflicted" ? "not_run" : "passed",
          validationSummary: options.noChanges
            ? "No committed task changes require integration."
            : "Merge result is clean and contains the reviewed task commit.",
          validationStartedAt: new Date().toISOString(),
          validatedAt: new Date().toISOString(),
          publishState:
            request.kind === "publish" ||
            (options.noChanges && !options.legacyNoChangesAwaitingPublication)
              ? "published"
              : "awaiting_approval",
          publicationFileCount: options.publicationRequired ? 1 : 0,
          publicationCommitCount: options.publicationRequired ? 1 : 0,
          publishedAt:
            request.kind === "publish" ||
            (options.noChanges && !options.legacyNoChangesAwaitingPublication)
              ? new Date().toISOString()
              : "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      : undefined;
  return WorktreeOperationResultSchema.parse({
    operationId: request.operationId,
    worktreeId: request.worktreeId,
    generation: request.generation,
    nodeId: request.nodeId,
    hostInstallationId: request.hostInstallationId,
    ok: true,
    worktree,
    ...(request.kind === "integration_preview" ? { preview } : {}),
    ...(integration ? { integration } : {}),
    acknowledgedAt: new Date().toISOString(),
  });
}

describe("Host managed workspace orchestration", () => {
  it("blocks a task on setup failure, deduplicates attention, and resumes only after creation succeeds", async () => {
    const { create, frames, node, service, store } = fixture();
    const created = create();
    store.setRunState(created.id, "running");
    const preparing = service.worktrees.prepare(created.id);
    const reserve = lastRequest(frames);
    const failure = WorktreeOperationResultSchema.parse({
      operationId: reserve.operationId,
      worktreeId: reserve.worktreeId,
      generation: reserve.generation,
      nodeId: reserve.nodeId,
      hostInstallationId: reserve.hostInstallationId,
      ok: false,
      code: "invalid_baseline",
      error: "private raw Git output and C:\\repo",
      retryable: true,
      acknowledgedAt: new Date().toISOString(),
    });

    expect(service.worktrees.handleResult(node.id, failure)).toBe(true);
    await preparing;
    expect(store.getRun(created.id)).toMatchObject({
      state: "blocked",
      workspaceBinding: {
        initialization: "blocked",
        setupState: "failed",
        setupCode: "invalid_baseline",
        setupSummary:
          "Fleet could not resolve a committed baseline from the selected repository.",
        setupResumeState: "running",
      },
    });
    const notification = store.listNotifications().notifications[0]!;
    expect(notification).toMatchObject({
      severity: "error",
      title: expect.stringContaining("Workspace setup failed"),
      navigation: { type: "run", runId: created.id },
      status: "active",
    });
    expect(JSON.stringify(notification)).not.toContain("C:\\repo");

    const retrying = service.worktrees.request(created.id, {
      kind: "reserve",
      actor: "test",
    });
    const retriedReserve = lastRequest(frames);
    expect(service.worktrees.handleResult(node.id, acknowledgement(retriedReserve))).toBe(
      true,
    );
    await retrying;
    expect(store.getRun(created.id)).toMatchObject({
      state: "running",
      workspaceBinding: {
        initialization: "reserved",
        setupState: "running",
        baseRef: "refs/heads/main",
      },
    });
    expect(store.listNotifications().notifications).toHaveLength(1);

    const creating = service.worktrees.request(created.id, {
      kind: "create",
      actor: "test",
    });
    const createRequest = lastRequest(frames);
    expect(service.worktrees.handleResult(node.id, acknowledgement(createRequest))).toBe(
      true,
    );
    await creating;
    expect(store.getRun(created.id)).toMatchObject({
      state: "running",
      workspaceBinding: {
        initialization: "ready",
        setupState: "succeeded",
        baseRef: "refs/heads/main",
      },
    });
    expect(store.getNotification(notification.id)).toMatchObject({
      status: "resolved",
      readAt: expect.any(String),
    });
    expect(store.notificationUnreadCount()).toBe(0);
  });

  it("records intent before dispatch and rejects out-of-order, wrong-owner, generation and path acknowledgements", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    const request = lastRequest(frames);
    expect(store.getWorktreeOperation(request.operationId)!.state).toBe("intent");
    const result = acknowledgement(request);
    expect(service.worktrees.handleResult("wrong-node", result)).toBe(false);
    expect(
      service.worktrees.handleResult(node.id, { ...result, operationId: randomUUID() }),
    ).toBe(false);
    expect(service.worktrees.handleResult(node.id, { ...result, generation: 2 })).toBe(
      false,
    );
    expect(
      service.worktrees.handleResult(node.id, {
        ...result,
        worktree: { ...result.worktree!, path: "C:\\repo" },
      }),
    ).toBe(false);
    expect(store.worktreeForRun(run.id)).toBeUndefined();
    expect(service.worktrees.handleResult(node.id, result)).toBe(true);
    await preparing;
    expect(service.worktrees.handleResult(node.id, result)).toBe(true);
    expect(store.getRun(run.id)!.workspaceBinding!.baseSha).toBe("a".repeat(40));
    expect(store.listManagedWorktrees()).toHaveLength(1);
    await service.worktrees.prepare(run.id);
    expect(frames.filter((frame) => frame.type === "managed_worktree")).toHaveLength(1);
  });

  it("sends no unsupported frames to an old Node and allocates nothing when Auto is off", async () => {
    const { create, frames, service, store } = fixture(false);
    const managed = create();
    await service.worktrees.prepare(managed.id);
    expect(store.getRun(managed.id)!.workspaceBinding).toMatchObject({
      effectiveMode: "managed",
      initialization: "blocked",
    });
    expect(store.getRun(managed.id)!.workspaceBinding!.error).toContain("Upgrade");
    const legacy = create("auto");
    await service.worktrees.prepare(legacy.id);
    expect(store.getRun(legacy.id)!.workspaceBinding!.effectiveMode).toBe("legacy");
    expect(frames).toEqual([]);
    expect(store.listManagedWorktrees()).toEqual([]);
    expect(store.listWorktreeOperations()).toEqual([]);
    expect(store.listNotificationHydration()).toHaveLength(1);
    expect(JSON.stringify(store.listNotificationHydration())).not.toContain("C:\\\\repo");
  });

  it("persists explicit Git hook consent across reservation and creation", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    store.setRunWorkspaceBinding(run.id, {
      ...run.workspaceBinding!,
      allowGitHooks: true,
    });
    const preparing = service.worktrees.prepare(run.id);
    const reserve = lastRequest(frames);
    expect(reserve.allowGitHooks).toBe(true);
    expect(service.worktrees.handleResult(node.id, acknowledgement(reserve))).toBe(true);
    await preparing;

    const creating = service.worktrees.request(run.id, {
      kind: "create",
      actor: "test",
    });
    const createRequest = lastRequest(frames);
    expect(createRequest.allowGitHooks).toBe(true);
    expect(service.worktrees.handleResult(node.id, acknowledgement(createRequest))).toBe(
      true,
    );
    await creating;

    expect(store.getRun(run.id)!.workspaceBinding!.allowGitHooks).toBe(true);
    expect(store.worktreeForRun(run.id)!.allowGitHooks).toBe(true);
  });

  it("enforces the same binding for initial dispatch, manual prompt, resume and reviewer transfer", async () => {
    const { create, frames, node, service, store, placement } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await preparing;
    const creating = service.worktrees.request(run.id, { kind: "create", actor: "test" });
    const created = acknowledgement(lastRequest(frames));
    service.worktrees.handleResult(node.id, created);
    await creating;
    const started = service.createAndStartSession({
      placement,
      prompt: "implement",
      yolo: false,
      runId: run.id,
      runRole: "worker",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const command = frames.at(-1);
    expect(command).toMatchObject({
      type: "command",
      command: {
        type: "start_session",
        localPath: created.worktree!.path,
        executionBinding: { worktreeId: created.worktree!.id, generation: 1 },
      },
    });
    store.transitionSession(started.session.id, "starting");
    store.transitionSession(started.session.id, "idle");
    const competitor = service.createAndStartSession({
      placement,
      prompt: "review",
      yolo: false,
      runId: run.id,
      runRole: "reviewer",
      readOnly: true,
    });
    expect(competitor.ok).toBe(false);
    service.dispatch(node.id, {
      type: "prompt",
      sessionId: started.session.id,
      prompt: "fix-up",
      attachments: [],
    });
    expect(frames.at(-1)).toMatchObject({
      type: "command",
      command: { type: "prompt", executionBinding: { cwd: created.worktree!.path } },
    });
    store.transitionSession(started.session.id, "stopped");
    const transferred = service.createAndStartSession({
      placement,
      prompt: "review",
      yolo: false,
      runId: run.id,
      runRole: "reviewer",
      readOnly: true,
    });
    expect(transferred.ok).toBe(true);
    if (transferred.ok)
      expect(transferred.session.executionBinding!.checkoutKey).toBe(
        started.session.executionBinding!.checkoutKey,
      );
  });

  it("accepts a derived step binding before the new session is attached to the step", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    const primary = kit.store.worktreeForRun(run.id)!;
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "implement",
      prompt: "change",
      category: "implement",
      position: 0,
    });
    const derived = ManagedWorktreeSchema.parse({
      ...primary,
      id: "worktree-derived",
      taskKey: "derived-task",
      path: "C:\\trees\\derived",
      branchRef: "refs/heads/fleet/derived",
      pinRef: "refs/fleet/pins/derived",
      checkout: {
        ...primary.checkout!,
        key: "derived-checkout",
        path: "C:\\trees\\derived",
        fileId: "derived-checkout",
      },
      workspaceKind: "step",
      ownerStepId: step.id,
    });
    kit.store.putDerivedWorkspace(derived);
    const binding = {
      worktreeId: derived.id,
      generation: derived.generation,
      sourcePlacementId: derived.sourcePlacementId,
      cwd: derived.path,
      checkoutKey: derived.checkout!.key,
      accessClass: "shell" as const,
      leaseAttempt: "derived-attempt",
      quarantined: false,
    };
    kit.store.updateRunStep(step.id, {
      state: "starting",
      managedWorktreeId: derived.id,
      workspaceState: "ready",
      executionBinding: binding,
    });

    const started = kit.service.createAndStartSession({
      placement: kit.placement,
      prompt: "change",
      yolo: false,
      runId: run.id,
      runRole: "worker",
      executionBinding: binding,
    });

    expect(started.ok).toBe(true);
    if (started.ok)
      expect(started.session.executionBinding).toMatchObject({
        worktreeId: binding.worktreeId,
        generation: binding.generation,
        checkoutKey: binding.checkoutKey,
        cwd: binding.cwd,
      });
  });

  it.each(["step", "derived"] as const)(
    "reconciliation clears only the matching %s session quarantine",
    async (workspaceKind) => {
      const kit = fixture();
      const run = await readyManaged(kit, false);
      const primary = kit.store.worktreeForRun(run.id)!;
      const step = kit.store.upsertRunStep(run.id, {
        stepKey: "worker",
        title: "worker",
        prompt: "work",
        category: "explore",
      });
      const taskKey = createHash("sha256")
        .update(
          [
            primary.hostInstallationId,
            run.id,
            workspaceKind,
            step.id,
            primary.generation,
          ].join(":"),
        )
        .digest("hex")
        .slice(0, 32);
      const cwd = "C:\\trees\\" + taskKey;
      const tree = ManagedWorktreeSchema.parse({
        ...primary,
        id: "worktree-reconciled",
        taskKey,
        path: cwd,
        branchRef: "refs/heads/fleet/" + taskKey,
        pinRef: "refs/fleet/pins/" + taskKey,
        checkout: {
          ...primary.checkout!,
          key: "derived-checkout",
          fileId: "derived-checkout",
          path: cwd,
        },
        workspaceKind,
        ownerStepId: step.id,
        state: "quarantined",
      });
      kit.store.putDerivedWorkspace(tree);
      const binding = {
        worktreeId: tree.id,
        generation: tree.generation,
        sourcePlacementId: tree.sourcePlacementId,
        cwd,
        checkoutKey: tree.checkout!.key,
        accessClass: "shell" as const,
        leaseAttempt: "reconcile-attempt",
        quarantined: true,
      };
      const sessions = [
        binding,
        { ...binding, worktreeId: "another-worktree" },
        { ...binding, generation: tree.generation + 1 },
      ].map((executionBinding) => {
        const session = kit.store.createSession(kit.placement, "work", false, "", {
          runId: run.id,
          runRole: "worker",
        });
        kit.store.setSessionExecutionBinding(session.id, executionBinding);
        return session;
      });
      kit.store.updateRunStep(step.id, {
        sessionId: sessions[0]!.id,
        executionBinding: binding,
        managedWorktreeId: tree.id,
      });
      const request = WorktreeOperationRequestSchema.parse({
        ...lastRequest(kit.frames),
        operationId: randomUUID(),
        kind: "reconcile",
        worktreeId: tree.id,
        workspaceKind,
        ownerStepId: step.id,
        expectedVersion: tree.version,
        expectedPath: tree.path,
        expectedBranchRef: tree.branchRef,
      });
      kit.store.putWorktreeOperation({
        request,
        state: "intent",
        createdAt: new Date().toISOString(),
      });
      const result = operationResult(kit.store, request);
      result.worktree!.state = "ready";

      expect(kit.service.worktrees.handleResult(kit.node.id, result)).toBe(true);
      expect(
        sessions.map(
          (session) => kit.store.getSession(session.id)!.executionBinding!.quarantined,
        ),
      ).toEqual([false, true, true]);
    },
  );

  it("quarantines restores and never automatically replays or launches their managed metadata", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await preparing;
    const backup = store.exportHostBackup({ enrollmentToken: "" });
    store.replaceHostBackup(backup);
    const before = frames.length;
    service.worktrees.onNodeReconciled(node.id);
    await expect(
      service.worktrees.request(run.id, { kind: "cleanup", actor: "operator" }),
    ).rejects.toThrow("reconciliation");
    expect(() => service.worktrees.bindingFor(store.getRun(run.id)!)).toThrow();
    expect(frames).toHaveLength(before);
  });

  it("replays the persisted envelope after a Host service restart and reconciles Node loss without source fallback", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const pending = service.worktrees.prepare(run.id);
    const original = lastRequest(frames);
    service.worktrees.shutdown();
    await pending;
    const restarted = new ManagedWorktreeService(service);
    try {
      restarted.onNodeReconciled(node.id);
      expect(lastRequest(frames)).toEqual(original);
      expect(restarted.handleResult(node.id, acknowledgement(original))).toBe(true);
      const creating = restarted.request(run.id, { kind: "create", actor: "test" });
      expect(restarted.handleResult(node.id, acknowledgement(lastRequest(frames)))).toBe(
        true,
      );
      await creating;
      const before = restarted.bindingFor(store.getRun(run.id)!)!;
      restarted.nodeLost(node.id);
      expect(store.worktreeForRun(run.id)!.state).toBe("unavailable");
      expect(() => restarted.bindingFor(store.getRun(run.id)!)).toThrow(
        "source fallback is prohibited",
      );
      restarted.onNodeReconciled(node.id);
      const reconcile = lastRequest(frames);
      expect(reconcile.kind).toBe("reconcile");
      expect(restarted.handleResult(node.id, acknowledgement(reconcile))).toBe(true);
      expect(restarted.bindingFor(store.getRun(run.id)!)).toMatchObject({
        cwd: before.cwd,
        checkoutKey: before.checkoutKey,
        worktreeId: before.worktreeId,
        generation: before.generation,
      });
    } finally {
      restarted.shutdown();
    }
  });

  it("prioritizes current tasks when replaying bounded reconnect operations", async () => {
    const { create, frames, node, service, store } = fixture();
    const runs = [create(), create(), create()];
    const pending = runs.map((run) => service.worktrees.prepare(run.id));
    service.worktrees.shutdown();
    await Promise.all(pending);
    store.updateRun(runs[0]!.id, { state: "completed" });
    frames.splice(0);

    const restarted = new ManagedWorktreeService(service);
    try {
      restarted.onNodeReconciled(node.id);

      expect(
        frames
          .filter((frame) => frame.type === "managed_worktree")
          .map((frame) => frame.request.runId)
          .sort(),
      ).toEqual([runs[1]!.id, runs[2]!.id].sort());
    } finally {
      restarted.shutdown();
    }
  });

  it("bounds retention to two operations per minute and skips dirty, unknown, unintegrated and unexpired trees", async () => {
    const { create, frames, node, service, store } = fixture();
    const at = Date.now();
    const eligible: string[] = [];
    for (const state of [
      "dirty",
      "unknown",
      "unintegrated",
      "unexpired",
      "a",
      "b",
      "c",
    ]) {
      const run = create();
      const preparing = service.worktrees.prepare(run.id);
      service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
      await preparing;
      const creating = service.worktrees.request(run.id, {
        kind: "create",
        actor: "test",
      });
      service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
      await creating;
      store.updateRun(run.id, { state: "completed" });
      store.putManagedWorktree({
        ...store.worktreeForRun(run.id)!,
        state: "retained",
        integrationState: state === "unintegrated" ? "not_requested" : "integrated",
        expiresAt: new Date(at + (state === "unexpired" ? 86_400_000 : -1)).toISOString(),
        observation: WorktreeObservationSchema.parse({
          generation: 1,
          observedAt: new Date(at).toISOString(),
          dirty: state === "dirty" ? true : state === "unknown" ? null : false,
        }),
      });
      if (["a", "b", "c"].includes(state)) eligible.push(run.id);
    }
    frames.splice(0);
    service.worktrees.sweep(at);
    const requests = () =>
      frames
        .filter((frame) => frame.type === "managed_worktree")
        .map((frame) => frame.request);
    expect(requests()).toHaveLength(2);
    expect(requests().every((request) => request.kind === "cleanup")).toBe(true);
    service.worktrees.sweep(at + 59_999);
    expect(requests()).toHaveLength(2);
    service.worktrees.sweep(at + 60_000);
    expect(
      requests()
        .map((request) => request.runId)
        .sort(),
    ).toEqual(eligible.sort());
  });

  it("starts a bounded orphan-retention sweep immediately after Node reconciliation", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await preparing;
    const creating = service.worktrees.request(run.id, {
      kind: "create",
      actor: "test",
    });
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await creating;
    store.updateRun(run.id, { state: "completed" });
    frames.splice(0);

    service.worktrees.onNodeReconciled(node.id);

    expect(lastRequest(frames)).toMatchObject({
      runId: run.id,
      kind: "retain",
      actor: "bounded-retention",
    });
  });

  it("uses a Fleet-owned integration target and deduplicates mismatched-ref attention across retry", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    const start = kit.frames.length;

    kit.service.worktrees.advanceAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(start);
    const quiesceRequest = lastRequest(kit.frames);
    expect(quiesceRequest.kind).toBe("quiesce");
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, quiesceRequest),
    );
    await expect.poll(() => lastRequest(kit.frames).kind).toBe("integration_preview");
    const previewRequest = lastRequest(kit.frames);
    expect(previewRequest).toMatchObject({
      kind: "integration_preview",
    });
    expect(previewRequest.targetPlacementId).toBeUndefined();
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, previewRequest, {
        targetRef: "refs/heads/changed",
      }),
    );
    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("blocked");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "attention",
      aggregationCode: "target_ref_mismatch",
      aggregationTargetRef: run.workspaceBinding!.integrationTargetRef,
    });
    expect(kit.store.listNotifications().notifications).toHaveLength(1);

    const beforeRetry = kit.frames.length;
    kit.service.worktrees.retryAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(beforeRetry);
    const retriedQuiesce = lastRequest(kit.frames);
    expect(retriedQuiesce.kind).toBe("quiesce");
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, retriedQuiesce),
    );
    await expect.poll(() => lastRequest(kit.frames).kind).toBe("integration_preview");
    const retriedPreview = lastRequest(kit.frames);
    expect(retriedPreview.operationId).not.toBe(previewRequest.operationId);
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, retriedPreview, {
        targetRef: "refs/heads/changed",
      }),
    );
    await expect
      .poll(() => kit.store.getRun(run.id)?.workspaceBinding?.aggregationState)
      .toBe("attention");
    expect(kit.store.listNotifications().notifications).toHaveLength(1);
    kit.service.notifications.createWorktreeAttention(
      run.id,
      `aggregation:${run.workspaceBinding!.generation}`,
      "integration",
      "cleanup_failed",
      { phase: "cleanup", targetRef: run.workspaceBinding!.integrationTargetRef },
    );
    expect(kit.store.listNotifications().notifications[0]).toMatchObject({
      data: {
        reason: "integration",
        code: "cleanup_failed",
        phase: "cleanup",
        targetRef: run.workspaceBinding!.integrationTargetRef,
      },
      body: expect.stringContaining("during cleanup"),
    });
  });

  it("routes managed human approval into aggregation instead of completion", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    kit.store.setRunState(run.id, "awaiting_human");

    const aggregating = kit.service.worktrees.beginAggregation(run.id);

    expect(aggregating.state).toBe("aggregating");
    expect(aggregating.workspaceBinding).toMatchObject({
      aggregationState: "in_progress",
      aggregationPhase: "quiesce",
    });
  });

  it("escalates repeated automatic quiescence failures instead of retrying forever", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe("quiesce");
      seen = kit.frames.length;
      kit.service.worktrees.handleResult(
        kit.node.id,
        WorktreeOperationResultSchema.parse({
          operationId: request.operationId,
          worktreeId: request.worktreeId,
          generation: request.generation,
          nodeId: request.nodeId,
          hostInstallationId: request.hostInstallationId,
          ok: false,
          retryable: true,
          code: "process_still_running",
          error: "A supervised child is still running.",
          acknowledgedAt: new Date().toISOString(),
        }),
      );
      await expect
        .poll(() => kit.store.getWorktreeOperation(request.operationId)?.result?.code)
        .toBe("process_still_running");
      if (attempt < 3) {
        await expect
          .poll(
            () => kit.store.getRun(run.id)?.workspaceBinding?.aggregationAutomaticRetries,
          )
          .toBe(attempt);
        kit.service.worktrees.advanceAggregation(run.id);
      }
    }

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("blocked");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "attention",
      aggregationCode: "automatic_retry_exhausted",
      aggregationAttempt: 3,
      aggregationAutomaticRetries: 2,
    });
    expect(kit.store.listNotifications().notifications).toHaveLength(1);
  });

  it("repairs stale Git administration and resumes finalization automatically", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    kit.frames.splice(0);
    kit.service.worktrees.advanceAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(0);
    const quiesce = lastRequest(kit.frames);
    expect(quiesce.kind).toBe("quiesce");
    const current = kit.store.getAnyManagedWorkspace(quiesce.worktreeId)!;
    kit.service.worktrees.handleResult(
      kit.node.id,
      WorktreeOperationResultSchema.parse({
        operationId: quiesce.operationId,
        worktreeId: quiesce.worktreeId,
        generation: quiesce.generation,
        nodeId: quiesce.nodeId,
        hostInstallationId: quiesce.hostInstallationId,
        ok: false,
        retryable: false,
        code: "registry_moved",
        error: "Git registration points to a stale missing path.",
        worktree: { ...current, version: quiesce.expectedVersion + 1 },
        acknowledgedAt: new Date().toISOString(),
      }),
    );

    await expect.poll(() => kit.frames.length).toBeGreaterThan(1);
    const repair = lastRequest(kit.frames);
    expect(repair).toMatchObject({
      kind: "reconcile",
      actor: "host-finalization-controller",
    });
    kit.service.worktrees.handleResult(kit.node.id, operationResult(kit.store, repair));

    await expect.poll(() => kit.frames.length).toBeGreaterThan(2);
    expect(lastRequest(kit.frames)).toMatchObject({
      kind: "quiesce",
      worktreeId: current.id,
    });
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationAttempt: 2,
      aggregationState: "in_progress",
    });
  });

  it("uses plan-approved recovery for transient Node loss without blocking the task", async () => {
    vi.useFakeTimers();
    const kit = fixture();
    try {
      const run = await readyManaged(kit);
      kit.store.setNodeOnline(kit.node.id, false);
      const beforeRetry = kit.frames.length;

      kit.service.worktrees.advanceAggregation(run.id);
      await Promise.resolve();
      await Promise.resolve();

      expect(kit.store.getRun(run.id)).toMatchObject({
        state: "aggregating",
        workspaceBinding: {
          aggregationState: "in_progress",
          aggregationCode: "node_unavailable",
          aggregationAttempt: 2,
          aggregationAutomaticRetries: 1,
        },
      });
      expect(kit.store.listNotifications().notifications).toHaveLength(0);

      kit.store.setNodeOnline(kit.node.id, true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(kit.frames.length).toBeGreaterThan(beforeRetry);
      expect(lastRequest(kit.frames).kind).toBe("quiesce");
    } finally {
      kit.service.worktrees.shutdown();
      vi.useRealTimers();
    }
  });

  it("exhausts the approved recovery budget before asking for attention", async () => {
    vi.useFakeTimers();
    const kit = fixture();
    try {
      const run = await readyManaged(kit);
      kit.store.setNodeOnline(kit.node.id, false);

      kit.service.worktrees.advanceAggregation(run.id);
      await Promise.resolve();
      await Promise.resolve();
      for (const delay of [1_000, 3_000, 10_000]) {
        await vi.advanceTimersByTimeAsync(delay);
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(kit.store.getRun(run.id)).toMatchObject({
        state: "blocked",
        workspaceBinding: {
          aggregationState: "attention",
          aggregationCode: "node_unavailable",
          aggregationAttempt: 4,
          aggregationAutomaticRetries: 3,
        },
      });
      expect(kit.store.listNotifications().notifications).toHaveLength(1);
    } finally {
      kit.service.worktrees.shutdown();
      vi.useRealTimers();
    }
  });

  it("does not reuse a terminal integration for a newer workspace result", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    const tree = kit.store.worktreeForRun(run.id)!;
    const oldPreview = IntegrationPreviewSchema.parse({
      id: "old-preview",
      worktreeId: tree.id,
      generation: tree.generation,
      taskSha: tree.baseSha,
      diffIdentity: "old-diff",
      diff: "+old\n",
      targetPlacementId: kit.placement.id,
      target: tree.repository,
      targetRef: run.workspaceBinding!.integrationTargetRef,
      targetSha: tree.baseSha,
      taskDirty: false,
      targetDirty: false,
      hasCommittedChanges: true,
      baseContainedByTarget: true,
      targetAdvancedFromBase: false,
      alreadyIntegrated: false,
      observedAt: new Date().toISOString(),
    });
    kit.store.putWorktreeIntegration(
      WorktreeIntegrationSchema.parse({
        id: "old-integration",
        worktreeId: tree.id,
        generation: tree.generation,
        preview: oldPreview,
        approvedTaskSha: oldPreview.taskSha,
        approvedDiffIdentity: oldPreview.diffIdentity,
        state: "integrated",
        preState: "clean",
        resultSha: tree.baseSha,
        validationState: "passed",
        validationSummary: "Old result",
        validationStartedAt: new Date().toISOString(),
        validatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    kit.store.putManagedWorktree({
      ...tree,
      resultSha: "b".repeat(40),
      version: tree.version + 1,
    });
    const seen = kit.frames.length;

    kit.service.worktrees.advanceAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
    const quiesceRequest = lastRequest(kit.frames);
    expect(quiesceRequest.kind).toBe("quiesce");
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, quiesceRequest),
    );
    await expect.poll(() => lastRequest(kit.frames).kind).toBe("integration_preview");
    const previewRequest = lastRequest(kit.frames);
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, previewRequest),
    );
    await expect.poll(() => lastRequest(kit.frames).kind).toBe("integrate");
  });

  it("sends a rejected publication review back through the retained orchestrator", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    const lead = kit.store.createSession(kit.placement, "orchestrate", false, "", {
      runRole: "lead",
    });
    kit.store.transitionSession(lead.id, "starting");
    kit.store.transitionSession(lead.id, "idle");
    kit.store.updateRun(run.id, { leadSessionId: lead.id });
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (const kind of ["quiesce", "integration_preview", "integrate"] as const) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe(kind);
      seen = kit.frames.length;
      kit.service.worktrees.handleResult(
        kit.node.id,
        operationResult(kit.store, request, {
          publicationRequired: kind === "integrate",
        }),
      );
    }
    await expect
      .poll(() => kit.store.getRun(run.id)?.workspaceBinding?.aggregationPhase)
      .toBe("await_publish_approval");
    const integration = kit.store
      .listWorktreeIntegrations(kit.store.worktreeForRun(run.id)!.id)
      .at(-1)!;
    kit.store.putPublicationApproval({
      approvalId: randomUUID(),
      runId: run.id,
      integrationId: integration.id,
      targetRemote: integration.preview.targetRemote,
      targetRef: integration.preview.targetRef,
      expectedRemoteSha: "",
      finalResultSha: integration.resultSha,
      finalTreeSha: integration.finalTree,
      approvedBy: "operator",
      approvedAt: new Date().toISOString(),
    });

    const reopened = kit.service.worktrees.requestPublicationChanges(
      run.id,
      "Add the missing regression test.",
      "administrator",
    );

    expect(reopened).toMatchObject({
      state: "running",
      failureReason: "",
      pendingPrompt: expect.stringContaining("Add the missing regression test."),
      workspaceBinding: {
        aggregationState: "not_started",
        aggregationPhase: "idle",
        aggregationAttempt: 2,
      },
    });
    expect(kit.store.getPublicationApproval(run.id)).toBeUndefined();
    expect(
      kit.store.listWorktreeIntegrations(integration.worktreeId).at(-1),
    ).toMatchObject({
      validationState: "failed",
      publishState: "failed",
      error: "Publication was rejected pending requested changes.",
    });
    expect(kit.store.listIntegrationAttempts(run.id).at(-1)).toMatchObject({
      status: "attention",
      publishState: "failed",
    });
    expect(kit.store.listRunNotes(run.id).at(-1)?.body).toContain(
      "Add the missing regression test.",
    );
  });

  it("escalates an automatic merge conflict with one controller notification", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
    const quiesce = lastRequest(kit.frames);
    expect(quiesce.kind).toBe("quiesce");
    seen = kit.frames.length;
    kit.service.worktrees.handleResult(kit.node.id, operationResult(kit.store, quiesce));
    await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
    const preview = lastRequest(kit.frames);
    seen = kit.frames.length;
    kit.service.worktrees.handleResult(kit.node.id, operationResult(kit.store, preview));
    await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
    const integrate = lastRequest(kit.frames);
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, integrate, {
        integrationState: "conflicted",
      }),
    );

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("blocked");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "attention",
      aggregationCode: "integration_conflict",
      aggregationPhase: "integrate",
    });
    const notifications = kit.store.listNotifications().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "managed_worktree_attention",
      data: {
        reason: "integration",
        phase: "integrate",
        targetRef: run.workspaceBinding!.integrationTargetRef,
      },
    });
  });

  it("records no changes, quiesces, retains and cleans before completing", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (const kind of [
      "quiesce",
      "integration_preview",
      "integrate",
      "retain",
      "cleanup",
    ] as const) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe(kind);
      seen = kit.frames.length;
      kit.service.worktrees.handleResult(
        kit.node.id,
        operationResult(kit.store, request, { noChanges: true }),
      );
    }

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("completed");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "completed",
      aggregationPhase: "done",
      aggregationTargetRef: run.workspaceBinding!.integrationTargetRef,
      aggregationSummary: expect.stringContaining("No committed changes"),
    });
    expect(kit.store.worktreeForRun(run.id)?.state).toBe("removed");
    expect(
      kit.store
        .listWorktreeOperations()
        .filter((entry) => entry.request.actor === "host-integration-controller")
        .map((entry) => entry.request.kind),
    ).toEqual(["quiesce", "integration_preview", "integrate", "retain", "cleanup"]);
  });

  it.each(["failed", "cancelled"] as const)(
    "finalizes clean managed workspaces while preserving the %s task outcome",
    async (outcome) => {
      const kit = fixture();
      const run = await readyManaged(kit, false);
      if (outcome === "cancelled")
        kit.store.cancelRunWithUnfinishedSteps(run.id, "operator cancelled", true);
      else kit.store.setRunState(run.id, "running");
      let seen = kit.frames.length;

      kit.service.worktrees.beginFinalization(run.id, outcome, `${outcome} reason`);
      for (const kind of ["quiesce", "retain", "cleanup"] as const) {
        await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
        const request = lastRequest(kit.frames);
        expect(request.kind).toBe(kind);
        seen = kit.frames.length;
        kit.service.worktrees.handleResult(
          kit.node.id,
          operationResult(kit.store, request, { verifiedClean: true }),
        );
      }

      await expect
        .poll(() => kit.store.getRun(run.id)?.workspaceBinding?.aggregationState)
        .toBe("completed");
      expect(kit.store.getRun(run.id)).toMatchObject({
        state: outcome,
        failureReason: outcome === "cancelled" ? "operator cancelled" : "failed reason",
        workspaceBinding: {
          finalizationOutcome: outcome,
          aggregationPhase: "done",
          aggregationSummary: expect.stringContaining("cleaned managed workspaces"),
        },
      });
      expect(kit.store.worktreeForRun(run.id)?.state).toBe("removed");
      expect(
        kit.store
          .listWorktreeOperations()
          .filter((entry) => entry.request.actor === "host-integration-controller")
          .map((entry) => entry.request.kind),
      ).toEqual(["quiesce", "retain", "cleanup"]);
    },
  );

  it("keeps a failed writer workspace in authoritative aggregation inspection", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    const primary = kit.store.worktreeForRun(run.id)!;
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "failed-writer",
      title: "failed writer",
      prompt: "change files",
      category: "implement",
      position: 0,
    });
    const failedTree = ManagedWorktreeSchema.parse({
      ...primary,
      id: "worktree-failed-writer",
      taskKey: "failed-writer",
      path: "C:\\trees\\failed-writer",
      branchRef: "refs/heads/fleet/failed-writer",
      pinRef: "refs/fleet/pins/failed-writer",
      checkout: {
        ...primary.checkout!,
        key: "failed-writer-checkout",
        path: "C:\\trees\\failed-writer",
        fileId: "failed-writer-checkout",
      },
      workspaceKind: "step",
      ownerStepId: step.id,
      observation: WorktreeObservationSchema.parse({
        generation: primary.generation,
        observedAt: new Date().toISOString(),
        head: primary.baseSha,
        unstaged: true,
        dirty: true,
      }),
    });
    kit.store.putDerivedWorkspace(failedTree);
    kit.store.updateRunStep(step.id, {
      state: "starting",
      managedWorktreeId: failedTree.id,
      workspaceState: "ready",
    });
    kit.store.updateRunStep(step.id, { state: "running" });
    kit.store.updateRunStep(step.id, { state: "failed" });
    const aggregationWorkspaces = Reflect.get(
      kit.service.worktrees,
      "aggregationWorkspaces",
    ) as (runId: string) => ManagedWorktree[];
    expect(
      aggregationWorkspaces.call(kit.service.worktrees, run.id).map((tree) => tree.id),
    ).toEqual([primary.id, failedTree.id]);
  });

  it("reconciles a persisted no-change integration without approval or a remote push", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (const kind of [
      "quiesce",
      "integration_preview",
      "integrate",
      "publish",
      "retain",
      "cleanup",
    ] as const) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe(kind);
      if (kind === "publish") expect(request.publicationApproval).toBeUndefined();
      seen = kit.frames.length;
      kit.service.worktrees.handleResult(
        kit.node.id,
        operationResult(kit.store, request, {
          noChanges: true,
          legacyNoChangesAwaitingPublication: kind === "integrate",
        }),
      );
    }

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("completed");
    expect(kit.store.getPublicationApproval(run.id)).toBeUndefined();
    expect(kit.store.worktreeForRun(run.id)?.state).toBe("removed");
  });

  it("completes integration while retaining ignored-only generated output", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (const kind of [
      "quiesce",
      "integration_preview",
      "integrate",
      "publish",
      "retain",
      "cleanup",
    ] as const) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe(kind);
      seen = kit.frames.length;
      if (kind !== "cleanup") {
        kit.service.worktrees.handleResult(
          kit.node.id,
          operationResult(kit.store, request),
        );
        if (kind === "integrate")
          kit.service.worktrees.approvePublication(run.id, randomUUID(), "operator");
        continue;
      }
      const current = kit.store.getAnyManagedWorkspace(request.worktreeId)!;
      kit.service.worktrees.handleResult(
        kit.node.id,
        WorktreeOperationResultSchema.parse({
          operationId: request.operationId,
          worktreeId: request.worktreeId,
          generation: request.generation,
          nodeId: request.nodeId,
          hostInstallationId: request.hostInstallationId,
          ok: false,
          retryable: false,
          code: "dirty_or_unknown",
          error:
            "Staged, unstaged, untracked, ignored or unknown data prevents this operation. No files were deleted.",
          worktree: {
            ...current,
            version: request.expectedVersion + 1,
            state: "retained",
            observation: WorktreeObservationSchema.parse({
              generation: current.generation,
              observedAt: new Date().toISOString(),
              head: current.resultSha || current.baseSha,
              staged: false,
              unstaged: false,
              untracked: false,
              ignored: true,
              dirty: true,
            }),
          },
          acknowledgedAt: new Date().toISOString(),
        }),
      );
    }

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("completed");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "completed",
      aggregationPhase: "done",
      aggregationSummary: expect.stringContaining(
        "1 workspace retained because ignored generated output was present.",
      ),
    });
    expect(kit.store.worktreeForRun(run.id)?.state).toBe("retained");
  });

  it("cleans a verified unchanged run without reserving the integration target", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "investigate",
      title: "investigate",
      prompt: "inspect only",
      category: "explore",
      position: 0,
    });
    const started = kit.service.createAndStartSession({
      placement: kit.placement,
      prompt: "inspect only",
      yolo: false,
      runId: run.id,
      runRole: "worker",
      readOnly: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    kit.store.updateRunStep(step.id, {
      state: "starting",
      sessionId: started.session.id,
    });
    kit.store.updateRunStep(step.id, { state: "running" });
    kit.store.updateRunStep(step.id, { state: "succeeded", resultSha: "" });
    kit.store.transitionSession(started.session.id, "starting");
    kit.store.transitionSession(started.session.id, "stopped");
    const current = kit.store.getRun(run.id)!;
    kit.store.setRunWorkspaceBinding(run.id, {
      ...current.workspaceBinding!,
      baseRef: "",
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: 1,
    });
    kit.store.setRunState(run.id, "aggregating");
    kit.frames.splice(0);
    let seen = 0;

    kit.service.worktrees.advanceAggregation(run.id);
    for (const kind of ["quiesce", "retain", "cleanup"] as const) {
      await expect.poll(() => kit.frames.length).toBeGreaterThan(seen);
      const request = lastRequest(kit.frames);
      expect(request.kind).toBe(kind);
      seen = kit.frames.length;
      kit.service.worktrees.handleResult(
        kit.node.id,
        operationResult(kit.store, request, {
          verifiedClean: request.kind === "quiesce",
        }),
      );
    }

    await expect.poll(() => kit.store.getRun(run.id)?.state).toBe("completed");
    expect(kit.store.getRun(run.id)?.workspaceBinding).toMatchObject({
      aggregationState: "completed",
      aggregationPhase: "done",
      aggregationTargetRef: "",
      aggregationSummary:
        "No committed changes; verified task workspaces and cleaned them without merge integration.",
    });
    expect(
      kit.store
        .listWorktreeOperations()
        .filter((entry) => entry.request.actor === "host-integration-controller")
        .map((entry) => entry.request.kind),
    ).toEqual(["quiesce", "retain", "cleanup"]);
  });

  it("prepares a composed workspace for a read-only dependent", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await preparing;
    const creating = service.worktrees.request(run.id, {
      kind: "create",
      actor: "test",
    });
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await creating;
    const primary = store.worktreeForRun(run.id)!;
    const writer = store.upsertRunStep(run.id, {
      stepKey: "writer",
      title: "writer",
      prompt: "write",
      category: "implement",
      position: 0,
      phaseIndex: 0,
    });
    const writerTree = ManagedWorktreeSchema.parse({
      ...primary,
      id: "worktree-writer",
      taskKey: "writer-safe",
      path: "C:\\trees\\writer-safe",
      branchRef: "refs/heads/fleet/writer-safe",
      pinRef: "refs/fleet/pins/writer-safe",
      checkout: {
        ...primary.checkout!,
        key: "writer-checkout",
        path: "C:\\trees\\writer-safe",
        fileId: "writer-checkout",
      },
      workspaceKind: "step",
      ownerStepId: writer.id,
      resultSha: "b".repeat(40),
    });
    store.putDerivedWorkspace(writerTree);
    store.updateRunStep(writer.id, {
      state: "starting",
      managedWorktreeId: writerTree.id,
      workspaceState: "ready",
      executionBinding: {
        worktreeId: writerTree.id,
        generation: writerTree.generation,
        sourcePlacementId: writerTree.sourcePlacementId,
        cwd: writerTree.path,
        checkoutKey: writerTree.checkout!.key,
        accessClass: "shell",
        leaseAttempt: "writer",
        quarantined: false,
      },
    });
    store.updateRunStep(writer.id, { state: "running" });
    store.updateRunStep(writer.id, {
      state: "succeeded",
      workspaceState: "completed",
      resultSha: writerTree.resultSha,
    });
    const review = store.upsertRunStep(run.id, {
      stepKey: "review",
      title: "review",
      prompt: "review",
      category: "review-deep",
      position: 1,
      phaseIndex: 1,
    });
    frames.splice(0);

    expect(service.worktrees.ensureStepReady(store.getRun(run.id)!, review)).toBe(
      undefined,
    );
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    expect(lastRequest(frames)).toMatchObject({
      kind: "reserve",
      workspaceKind: "derived",
      ownerStepId: review.id,
      composition: {
        predecessors: [
          {
            stepId: writer.id,
            worktreeId: writerTree.id,
            resultSha: writerTree.resultSha,
          },
        ],
      },
    });
  });

  it("composes a writer from a read-only predecessor that advanced the primary checkout", async () => {
    const { create, frames, node, service, store } = fixture();
    const run = create();
    const preparing = service.worktrees.prepare(run.id);
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await preparing;
    const creating = service.worktrees.request(run.id, {
      kind: "create",
      actor: "test",
    });
    service.worktrees.handleResult(node.id, acknowledgement(lastRequest(frames)));
    await creating;
    const primary = store.worktreeForRun(run.id)!;
    const advancedHead = "b".repeat(40);
    store.putManagedWorktree(
      ManagedWorktreeSchema.parse({
        ...primary,
        observation: {
          ...primary.observation,
          generation: primary.generation,
          observedAt: new Date().toISOString(),
          head: advancedHead,
          dirty: false,
        },
      }),
    );
    const investigate = store.upsertRunStep(run.id, {
      stepKey: "investigate",
      title: "investigate",
      prompt: "inspect network-latest main",
      category: "explore",
      position: 0,
      phaseIndex: 0,
    });
    store.updateRunStep(investigate.id, { state: "starting" });
    store.updateRunStep(investigate.id, { state: "running" });
    store.updateRunStep(investigate.id, { state: "succeeded" });
    const implement = store.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "implement",
      prompt: "implement from the inspected revision",
      category: "implement",
      position: 1,
      phaseIndex: 1,
    });
    frames.splice(0);

    expect(
      service.worktrees.ensureStepReady(store.getRun(run.id)!, implement),
    ).toBeUndefined();
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    expect(lastRequest(frames)).toMatchObject({
      kind: "reserve",
      workspaceKind: "derived",
      ownerStepId: implement.id,
      composition: {
        baseSha: primary.baseSha,
        predecessors: [
          {
            stepId: investigate.id,
            worktreeId: primary.id,
            resultSha: advancedHead,
          },
        ],
      },
    });
  });

  it("settles a step when managed finalization fails instead of retrying forever", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    kit.store.setRunState(run.id, "running");
    const primary = kit.store.worktreeForRun(run.id)!;
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "implement",
      prompt: "change files",
      category: "implement",
      position: 0,
    });
    const tree = ManagedWorktreeSchema.parse({
      ...primary,
      id: "worktree-finalize-failure",
      taskKey: "finalize-failure",
      path: "C:\\trees\\finalize-failure",
      branchRef: "refs/heads/fleet/finalize-failure",
      pinRef: "refs/fleet/pins/finalize-failure",
      checkout: {
        ...primary.checkout!,
        key: "finalize-failure-checkout",
        path: "C:\\trees\\finalize-failure",
        fileId: "finalize-failure-checkout",
      },
      workspaceKind: "step",
      ownerStepId: step.id,
    });
    kit.store.putDerivedWorkspace(tree);
    kit.store.updateRunStep(step.id, {
      state: "starting",
      managedWorktreeId: tree.id,
      workspaceState: "ready",
    });
    kit.store.updateRunStep(step.id, { state: "running" });
    kit.frames.splice(0);

    expect(kit.service.worktrees.finalizeStep(kit.store.getRun(run.id)!, step)).toBe(
      false,
    );
    const request = lastRequest(kit.frames);
    kit.service.worktrees.handleResult(
      kit.node.id,
      WorktreeOperationResultSchema.parse({
        operationId: request.operationId,
        worktreeId: request.worktreeId,
        generation: request.generation,
        nodeId: request.nodeId,
        hostInstallationId: request.hostInstallationId,
        ok: false,
        retryable: false,
        code: "dirty_or_unknown",
        error: "The managed checkout is dirty.",
        acknowledgedAt: new Date().toISOString(),
      }),
    );

    await expect.poll(() => kit.store.getRunStep(step.id)?.state).toBe("failed");
    expect(kit.store.getRunStep(step.id)).toMatchObject({
      workspaceState: "blocked",
      workspaceError: "The managed checkout is dirty.",
      output: "Managed workspace finalization failed: The managed checkout is dirty.",
    });
  });

  it("allocates independent writable steps across verified matching Nodes", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    const second = kit.store.registerNode({
      name: "Node 2",
      os: "win32",
      arch: "x64",
      version: "test",
      maxSessions: 8,
      capabilities: ["host-yolo", "managed-worktrees-v1", "portable-worktree-results-v1"],
    }).node;
    kit.store.setNodeOnline(second.id, true);
    const placement2 = kit.store.createPlacement(run.workspaceId, second.id, "D:\\repo");
    kit.store.putPlacementRepositoryCapability({
      placementId: placement2.id,
      nodeId: second.id,
      localPath: placement2.localPath,
      repositoryIdentity: {
        id: run.workspaceBinding!.repositoryIdentity,
        objectFormat: "sha1",
        evidence: "roots",
        remoteHash: "",
        rootHash: "e".repeat(64),
      },
      baseSha: run.workspaceBinding!.baseSha,
      baseAvailable: true,
      baseMaterializable: false,
      portableResultsSupported: true,
      portabilityReason: "",
      verifiedAt: new Date().toISOString(),
      error: "",
    });
    const remoteFrames: HostToNodeMessage[] = [];
    kit.service.attachNode(second.id, {
      OPEN: 1,
      readyState: 1,
      send: (text) => remoteFrames.push(HostToNodeMessageSchema.parse(JSON.parse(text))),
      close() {},
    });
    const first = kit.store.upsertRunStep(run.id, {
      stepKey: "one",
      title: "one",
      prompt: "one",
      category: "implement",
      placementId: kit.placement.id,
      position: 0,
    });
    const secondStep = kit.store.upsertRunStep(run.id, {
      stepKey: "two",
      title: "two",
      prompt: "two",
      category: "implement",
      position: 1,
    });
    kit.frames.splice(0);
    kit.service.worktrees.ensureStepReady(kit.store.getRun(run.id)!, first);
    kit.service.worktrees.ensureStepReady(kit.store.getRun(run.id)!, secondStep);
    await expect.poll(() => remoteFrames.length).toBeGreaterThan(0);
    expect(lastRequest(remoteFrames)).toMatchObject({
      kind: "reserve",
      sourcePlacementId: placement2.id,
      originatingPlacementId: kit.placement.id,
      repositoryIdentity: run.workspaceBinding!.repositoryIdentity,
    });
  });

  it("keeps a new step local when another verified Node has no lower estimated cost", async () => {
    const kit = fixture();
    const run = await readyManaged(kit, false);
    const second = kit.store.registerNode({
      name: "Node 2",
      os: "win32",
      arch: "x64",
      version: "test",
      maxSessions: 8,
      capabilities: ["host-yolo", "managed-worktrees-v1", "portable-worktree-results-v1"],
    }).node;
    kit.store.setNodeOnline(second.id, true);
    const placement2 = kit.store.createPlacement(run.workspaceId, second.id, "D:\\repo");
    kit.store.putPlacementRepositoryCapability({
      placementId: placement2.id,
      nodeId: second.id,
      localPath: placement2.localPath,
      repositoryIdentity: {
        id: run.workspaceBinding!.repositoryIdentity,
        objectFormat: "sha1",
        evidence: "roots",
        remoteHash: "",
        rootHash: "e".repeat(64),
      },
      baseSha: run.workspaceBinding!.baseSha,
      baseAvailable: true,
      baseMaterializable: false,
      portableResultsSupported: true,
      portabilityReason: "",
      verifiedAt: new Date().toISOString(),
      error: "",
    });
    const remoteFrames: HostToNodeMessage[] = [];
    kit.service.attachNode(second.id, {
      OPEN: 1,
      readyState: 1,
      send: (text) => remoteFrames.push(HostToNodeMessageSchema.parse(JSON.parse(text))),
      close() {},
    });
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "local",
      title: "local",
      prompt: "local",
      category: "explore",
      position: 0,
    });
    kit.frames.splice(0);

    kit.service.worktrees.ensureStepReady(kit.store.getRun(run.id)!, step);

    await expect.poll(() => kit.frames.length).toBeGreaterThan(0);
    expect(lastRequest(kit.frames)).toMatchObject({
      kind: "reserve",
      sourcePlacementId: kit.placement.id,
      originatingPlacementId: kit.placement.id,
    });
    expect(remoteFrames).toHaveLength(0);
    expect(kit.logs).toContainEqual({
      details: expect.objectContaining({
        event: "managed_placement_selected",
        selected_node_id: kit.node.id,
        selected_placement_id: kit.placement.id,
        schedule_reason: "lowest_cost_with_locality_tiebreak",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            node_id: second.id,
            placement_id: placement2.id,
            predicted_total_ms: 0,
          }),
        ]),
      }),
      message: "Selected managed repository placement",
    });
  });

  it("waits for repository pool proofs before binding a new step to the origin", async () => {
    const kit = fixture();
    const second = kit.store.registerNode({
      name: "Node 2",
      os: "win32",
      arch: "x64",
      version: "test",
      maxSessions: 8,
      capabilities: ["host-yolo", "managed-worktrees-v1", "portable-worktree-results-v1"],
    }).node;
    kit.store.setNodeOnline(second.id, true);
    const placement2 = kit.store.createPlacement(
      kit.placement.workspaceId,
      second.id,
      "D:\\repo",
    );
    const remoteFrames: HostToNodeMessage[] = [];
    kit.service.attachNode(second.id, {
      OPEN: 1,
      readyState: 1,
      send: (text) => remoteFrames.push(HostToNodeMessageSchema.parse(JSON.parse(text))),
      close() {},
    });

    const run = await readyManaged(kit, false);
    const probe = remoteFrames.find((frame) => frame.type === "repository_probe");
    expect(probe).toMatchObject({
      type: "repository_probe",
      request: {
        placementId: placement2.id,
        baseSha: run.workspaceBinding!.baseSha,
        expectedRepositoryIdentity: run.workspaceBinding!.repositoryIdentity,
      },
    });
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "pool",
      title: "pool",
      prompt: "pool",
      category: "explore",
      position: 0,
    });
    const busy = kit.store.upsertRunStep(run.id, {
      stepKey: "busy-origin",
      title: "busy-origin",
      prompt: "busy-origin",
      category: "explore",
      placementId: kit.placement.id,
      position: 1,
    });
    kit.store.updateRunStep(busy.id, { state: "running" });
    kit.frames.splice(0);
    remoteFrames.splice(0);

    expect(
      kit.service.worktrees.ensureStepReady(kit.store.getRun(run.id)!, step),
    ).toBeUndefined();
    expect(kit.frames.some((frame) => frame.type === "managed_worktree")).toBe(false);
    const refreshed = remoteFrames.find((frame) => frame.type === "repository_probe");
    if (!refreshed || refreshed.type !== "repository_probe")
      throw new Error("Expected a repository capability probe");
    expect(
      kit.service.worktrees.handleRepositoryProbe(
        second.id,
        RepositoryProbeResultSchema.parse({
          operationId: refreshed.request.operationId,
          runId: run.id,
          placementId: placement2.id,
          nodeId: second.id,
          ok: true,
          capability: {
            placementId: placement2.id,
            nodeId: second.id,
            localPath: placement2.localPath,
            repositoryIdentity: {
              id: run.workspaceBinding!.repositoryIdentity,
              objectFormat: "sha1",
              evidence: "roots",
              remoteHash: "",
              rootHash: "e".repeat(64),
            },
            baseSha: run.workspaceBinding!.baseSha,
            baseAvailable: true,
            baseMaterializable: false,
            portableResultsSupported: true,
            portabilityReason: "",
            verifiedAt: new Date().toISOString(),
            error: "",
          },
          code: "",
          error: "",
        }),
      ),
    ).toBe(true);

    kit.service.worktrees.ensureStepReady(
      kit.store.getRun(run.id)!,
      kit.store.getRunStep(step.id)!,
    );
    await expect.poll(() => remoteFrames.length).toBeGreaterThan(1);
    expect(lastRequest(remoteFrames)).toMatchObject({
      kind: "reserve",
      sourcePlacementId: placement2.id,
      originatingPlacementId: kit.placement.id,
    });
    expect(kit.logs).toContainEqual({
      details: expect.objectContaining({
        event: "repository_probe_decision",
        candidate_count_known: 2,
        candidate_count_pending: 0,
        probe_wait_ms: expect.any(Number),
        schedule_reason: "all_eligible_probes_resolved",
      }),
      message: "Repository placement probes resolved before scheduling",
    });
    expect(kit.logs).toContainEqual({
      details: expect.objectContaining({
        event: "managed_placement_selected",
        selected_node_id: second.id,
        selected_placement_id: placement2.id,
        schedule_reason: "lower_estimated_completion_cost",
      }),
      message: "Selected managed repository placement",
    });
  });
});
