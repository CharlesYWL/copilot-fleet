import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionBindingSchema,
  HostBackupSchema,
  ManagedWorktreeSchema,
  WorktreeOperationRequestSchema,
  type FleetSession,
} from "@fleet/protocol";
import { FleetStore } from "./store.js";

const stores: FleetStore[] = [];
const paths: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function open(path = ":memory:") {
  const store = new FleetStore(path);
  stores.push(store);
  return store;
}
function seed(store: FleetStore) {
  const { node } = store.registerNode({
    name: "Node",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["managed-worktrees-v1"],
    maxSessions: 8,
  });
  const workspace = store.createWorkspace("project", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\project");
  const run = store.createRun({
    workspaceId: workspace.id,
    name: "task",
    objective: "done",
    workspaceMode: "managed",
    sourcePlacementId: placement.id,
  });
  const physical = (key: string, path: string) => ({
    key,
    path,
    volume: "volume",
    fileId: key,
    machineId: "machine",
  });
  const tree = ManagedWorktreeSchema.parse({
    id: run.workspaceBinding!.managedWorktreeId,
    runId: run.id,
    taskKey: "safe",
    sourcePlacementId: placement.id,
    workspaceId: workspace.id,
    nodeId: node.id,
    machineId: "machine",
    hostInstallationId: store.worktreeHostInstallationId(),
    nodeInstallationId: "installation",
    repository: physical("repo", placement.localPath),
    commonDirectory: physical("common", "C:\\project\\.git"),
    managedRoot: physical("root", "C:\\.fleet-worktrees"),
    checkout: physical("checkout", "C:\\.fleet-worktrees\\safe"),
    path: "C:\\.fleet-worktrees\\safe",
    generation: 1,
    version: 2,
    branchRef: "refs/heads/fleet/safe",
    pinRef: "refs/fleet/pins/safe",
    baseSha: "a".repeat(40),
    state: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.putManagedWorktree(tree);
  store.setRunWorkspaceBinding(run.id, {
    ...run.workspaceBinding!,
    initialization: "ready",
    baseSha: tree.baseSha,
    resolvedPath: tree.path,
    checkoutKey: tree.checkout!.key,
  });
  return { run: store.getRun(run.id)!, tree, placement, workspace };
}

describe("durable managed workspace store", () => {
  it("persists the disabled default and resolved mode independently across setting edits and restart", async () => {
    const path = resolve(".mwi-test-work", randomUUID());
    paths.push(path);
    await mkdir(path, { recursive: true });
    let store = open(join(path, "host.db"));
    const workspace = store.createWorkspace("repository", "");
    expect(store.getManagedWorktreesEnabled()).toBe(false);
    const legacy = store.createRun({
      workspaceId: workspace.id,
      name: "A",
      objective: "done",
      workspaceMode: "auto",
    });
    store.setManagedWorktreesEnabled(true);
    const managed = store.createRun({
      workspaceId: workspace.id,
      name: "B",
      objective: "done",
      workspaceMode: "auto",
    });
    const historical = store.createRun({
      workspaceId: workspace.id,
      name: "old",
      objective: "done",
    });
    store.setManagedWorktreesEnabled(false);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = open(join(path, "host.db"));
    expect(store.getRun(legacy.id)!.workspaceBinding).toMatchObject({
      requestedMode: "auto",
      effectiveMode: "legacy",
      resolutionSource: "app_default",
    });
    expect(store.getRun(managed.id)!.workspaceBinding).toMatchObject({
      effectiveMode: "managed",
      resolutionSource: "app_default",
    });
    expect(store.getRun(historical.id)!.workspaceBinding).toMatchObject({
      effectiveMode: "legacy",
      resolutionSource: "historical",
    });
    expect(store.listManagedWorktrees()).toEqual([]);
  });

  it("rejects rebinding, protects source catalog identity and persists cleanup tombstones before purge refusal", () => {
    const store = open();
    const { run, tree, placement } = seed(store);
    expect(() =>
      store.setRunWorkspaceBinding(run.id, {
        ...run.workspaceBinding!,
        baseSha: "b".repeat(40),
      }),
    ).toThrow("cannot be changed");
    expect(() => store.putManagedWorktree({ ...tree, generation: 2 })).toThrow(
      "cannot be changed",
    );
    expect(() => store.updatePlacement(placement.id, "C:\\elsewhere")).toThrow(
      "ownership",
    );
    expect(() => store.deleteRun(run.id)).toThrow("tombstone");
    expect(store.listWorktreeTombstones()).toHaveLength(1);
    expect(store.getRun(run.id)).toBeDefined();
    store.putManagedWorktree({
      ...tree,
      state: "removed",
      version: tree.version + 1,
      removedAt: new Date().toISOString(),
    });
    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.listWorktreeTombstones()[0]!.state).toBe("reconciled");
    expect(store.getManagedWorktree(tree.id)).toBeDefined();
  });

  it("quarantines restored managed binding/step/session/operation metadata without restoring execution ownership", () => {
    const source = open();
    const { run, tree, placement } = seed(source);
    const session = source.createSession(placement, "implement", false, "worker", {
      runId: run.id,
      runRole: "worker",
    });
    const binding = ExecutionBindingSchema.parse({
      worktreeId: tree.id,
      generation: 1,
      sourcePlacementId: placement.id,
      cwd: tree.path,
      checkoutKey: tree.checkout!.key,
      leaseAttempt: "original-attempt",
    });
    source.setSessionExecutionBinding(session.id, binding);
    const step = source.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "implement",
      prompt: "task",
      placementId: placement.id,
    });
    source.updateRunStep(step.id, { executionBinding: binding, sessionId: session.id });
    source.putWorktreeOperation({
      request: WorktreeOperationRequestSchema.parse({
        operationId: randomUUID(),
        kind: "observe",
        worktreeId: tree.id,
        runId: run.id,
        sourcePlacementId: placement.id,
        workspaceId: run.workspaceId,
        sourcePath: placement.localPath,
        nodeId: tree.nodeId,
        hostInstallationId: tree.hostInstallationId,
        expectedVersion: tree.version,
        generation: 1,
        actor: "test",
      }),
      state: "intent",
      createdAt: new Date().toISOString(),
    });
    const backup = source.exportHostBackup({ enrollmentToken: "" });
    const target = open();
    target.replaceHostBackup(backup);
    expect(target.getRun(run.id)!.workspaceBinding!.initialization).toBe("quarantined");
    expect(target.getManagedWorktree(tree.id)!.state).toBe("quarantined");
    expect(target.getSession(session.id)!.executionBinding!.quarantined).toBe(true);
    expect(target.getRunStep(step.id)!.executionBinding!.quarantined).toBe(true);
    expect(target.listWorktreeOperations()[0]!.state).toBe("quarantined");
    expect(() => target.deleteRun(run.id)).toThrow();
    expect(JSON.stringify(backup)).not.toContain("nodeIncarnation");
    expect(JSON.stringify(backup)).not.toContain("processesQuiesced");
  });

  it("accepts an old backup as Legacy even when the current default is managed", () => {
    const source = open();
    const { run } = seed(source);
    const backup = source.exportHostBackup({ enrollmentToken: "" });
    const historical = {
      ...backup,
      managedWorktrees: undefined,
      worktreeOperations: undefined,
      runs: backup.runs.map(({ workspaceBinding: _binding, ...entry }) => entry),
      defaults: {
        ...backup.defaults,
        managedWorktreesEnabled: undefined,
        managedWorktreePolicy: undefined,
      },
    };
    const target = open();
    target.setManagedWorktreesEnabled(true);
    target.replaceHostBackup(HostBackupSchema.parse(historical));
    expect(target.getRun(run.id)!.workspaceBinding!.effectiveMode).toBe("legacy");
    expect(target.getManagedWorktreesEnabled()).toBe(false);
    expect(target.listManagedWorktrees()).toEqual([]);
  });

  it("keeps worktree ownership after session deletion and rejects execution binding changes", () => {
    const store = open();
    const { tree, run, placement } = seed(store);
    const session = store.createSession(placement, "task", false, "", { runId: run.id });
    const binding: NonNullable<FleetSession["executionBinding"]> = {
      worktreeId: tree.id,
      generation: 1,
      sourcePlacementId: placement.id,
      cwd: tree.path,
      checkoutKey: tree.checkout!.key,
      accessClass: "shell",
      leaseAttempt: "1",
      quarantined: false,
    };
    store.setSessionExecutionBinding(session.id, binding);
    expect(() =>
      store.setSessionExecutionBinding(session.id, {
        ...binding,
        cwd: placement.localPath,
      }),
    ).toThrow();
    store.transitionSession(session.id, "failed");
    store.deleteSession(session.id);
    expect(store.getManagedWorktree(tree.id)).toBeDefined();
  });
});
