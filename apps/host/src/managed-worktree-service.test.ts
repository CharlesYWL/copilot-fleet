import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostToNodeMessageSchema,
  ManagedWorktreeSchema,
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

describe("Host managed workspace orchestration", () => {
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
});
