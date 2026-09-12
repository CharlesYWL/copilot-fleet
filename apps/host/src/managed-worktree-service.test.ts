import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostToNodeMessageSchema,
  IntegrationPreviewSchema,
  ManagedWorktreeSchema,
  WorktreeIntegrationSchema,
  WorktreeObservationSchema,
  WorktreeOperationResultSchema,
  type HostToNodeMessage,
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
  const log = {
    info() {},
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
  return { store, service, node, frames, placement, create };
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
    updatedAt: new Date().toISOString(),
  });
  const targetRef = options.targetRef ?? "refs/heads/main";
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
    request.kind === "integrate"
      ? WorktreeIntegrationSchema.parse({
          id: request.operationId,
          worktreeId: request.worktreeId,
          generation: request.generation,
          preview,
          approvedTaskSha: preview.taskSha,
          approvedDiffIdentity: preview.diffIdentity,
          state: integrationState,
          preState: "clean",
          resultSha: preview.targetSha,
          conflicts: integrationState === "conflicted" ? ["same.txt"] : [],
          validationState: integrationState === "conflicted" ? "not_run" : "passed",
          validationSummary: options.noChanges
            ? "No committed task changes require integration."
            : "Merge result is clean and contains the reviewed task commit.",
          validationStartedAt: new Date().toISOString(),
          validatedAt: new Date().toISOString(),
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

  it("infers only the pinned source target and deduplicates mismatched-ref attention across retry", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    const start = kit.frames.length;

    kit.service.worktrees.advanceAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(start);
    const previewRequest = lastRequest(kit.frames);
    expect(previewRequest).toMatchObject({
      kind: "integration_preview",
      targetPlacementId: kit.placement.id,
    });
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
      aggregationTargetRef: "refs/heads/main",
    });
    expect(kit.store.listNotifications().notifications).toHaveLength(1);

    const beforeRetry = kit.frames.length;
    kit.service.worktrees.retryAggregation(run.id);
    await expect.poll(() => kit.frames.length).toBeGreaterThan(beforeRetry);
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
      { phase: "cleanup", targetRef: "refs/heads/main" },
    );
    expect(kit.store.listNotifications().notifications[0]).toMatchObject({
      data: {
        reason: "integration",
        code: "cleanup_failed",
        phase: "cleanup",
        targetRef: "refs/heads/main",
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
      aggregationPhase: "preview",
    });
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
      targetRef: "refs/heads/main",
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
    const previewRequest = lastRequest(kit.frames);
    kit.service.worktrees.handleResult(
      kit.node.id,
      operationResult(kit.store, previewRequest),
    );
    await expect.poll(() => lastRequest(kit.frames).kind).toBe("integrate");
  });

  it("escalates an automatic merge conflict with one controller notification", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

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
        targetRef: "refs/heads/main",
      },
    });
  });

  it("records no changes, quiesces, retains and cleans before completing", async () => {
    const kit = fixture();
    const run = await readyManaged(kit);
    let seen = kit.frames.length;
    kit.service.worktrees.advanceAggregation(run.id);

    for (const kind of [
      "integration_preview",
      "integrate",
      "quiesce",
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
      aggregationTargetRef: "refs/heads/main",
      aggregationSummary: expect.stringContaining("No committed changes"),
    });
    expect(kit.store.worktreeForRun(run.id)?.state).toBe("removed");
    expect(
      kit.store
        .listWorktreeOperations()
        .filter((entry) => entry.request.actor === "host-integration-controller")
        .map((entry) => entry.request.kind),
    ).toEqual(["integration_preview", "integrate", "quiesce", "retain", "cleanup"]);
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
      dependsOn: ["writer"],
      position: 1,
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
});
