import { describe, expect, it } from "vitest";
import {
  HostBackupSchema,
  HostToNodeMessageSchema,
  IntegrationPreviewSchema,
  ManagedWorktreePolicySchema,
  ManagedWorktreeSchema,
  NodeToHostMessageSchema,
  RunSchema,
  RunWorkspaceBindingSchema,
  WorktreeIntegrationSchema,
  WorkspaceModeSchema,
  resolveWorkspaceMode,
} from "./index.js";

describe("managed workspace protocol compatibility", () => {
  it("resolves explicit mode, Auto defaults and historical missing mode once", () => {
    expect(resolveWorkspaceMode("managed", false)).toMatchObject({
      requestedMode: "managed",
      effectiveMode: "managed",
      resolutionSource: "explicit",
      setupState: "pending",
      setupAttempt: 1,
    });
    expect(resolveWorkspaceMode("legacy", true)).toMatchObject({
      effectiveMode: "legacy",
      resolutionSource: "explicit",
    });
    expect(resolveWorkspaceMode("auto", true)).toMatchObject({
      effectiveMode: "managed",
      resolutionSource: "app_default",
    });
    expect(resolveWorkspaceMode("auto", false)).toMatchObject({
      effectiveMode: "legacy",
      resolutionSource: "app_default",
    });
    expect(resolveWorkspaceMode(undefined, true)).toMatchObject({
      effectiveMode: "legacy",
      resolutionSource: "historical",
    });
    expect(resolveWorkspaceMode("managed", true, "no-checkout")).toMatchObject({
      effectiveMode: "legacy",
      resolutionSource: "no_checkout",
    });
    expect(WorkspaceModeSchema.safeParse("parallel-writers").success).toBe(false);
  });

  it("parses historical Runs and archives as Legacy with empty metadata arrays", () => {
    const now = new Date().toISOString();
    const run = RunSchema.parse({
      id: "run",
      workspaceId: "w",
      name: "task",
      objective: "done",
      state: "running",
      createdAt: now,
      updatedAt: now,
    });
    expect(run.workspaceBinding).toEqual(RunWorkspaceBindingSchema.parse({}));
    expect(
      RunWorkspaceBindingSchema.parse({
        effectiveMode: "managed",
        initialization: "ready",
        baseSha: "a".repeat(40),
      }),
    ).toMatchObject({
      setupState: "not_required",
      setupAttempt: 0,
      baseRef: "",
    });
    const backup = HostBackupSchema.parse({
      kind: "copilot-fleet-host",
      version: 1,
      exportedAt: now,
      tunnel: { provider: "cloudflare", enabled: false },
      defaults: { yolo: false, autoResume: true },
      nodes: [],
      workspaces: [],
      placements: [],
      sessions: [],
      events: [],
      runs: [run],
    });
    expect(backup.defaults.managedWorktreesEnabled).toBe(false);
    expect(backup.managedWorktrees).toEqual([]);
    expect(backup.derivedWorkspaces).toEqual([]);
    expect(backup.worktreeOperations).toEqual([]);
    expect(backup.worktreeIntegrations).toEqual([]);
    expect(backup.worktreeTombstones).toEqual([]);
    expect(backup.workspaceResults).toEqual([]);
    expect(ManagedWorktreePolicySchema.parse({})).toMatchObject({
      retentionDays: 7,
      maxPerRepository: 8,
      maxPerNode: 32,
    });
  });

  it("defaults old worktrees to primary while preserving derived composition provenance", () => {
    const now = new Date().toISOString();
    const physical = {
      key: "checkout",
      path: "C:\\repo",
      machineId: "machine",
      volume: "volume",
      fileId: "file",
    };
    const old = ManagedWorktreeSchema.parse({
      id: "tree",
      runId: "run",
      taskKey: "safe",
      sourcePlacementId: "placement",
      workspaceId: "workspace",
      nodeId: "node",
      machineId: "machine",
      hostInstallationId: "host",
      nodeInstallationId: "node-install",
      repository: physical,
      commonDirectory: physical,
      managedRoot: physical,
      generation: 1,
      version: 0,
      path: "C:\\tree",
      branchRef: "refs/heads/fleet/safe",
      pinRef: "refs/fleet/pins/safe",
      baseSha: "a".repeat(40),
      state: "ready",
      createdAt: now,
      updatedAt: now,
    });
    expect(old.workspaceKind).toBe("primary");
    expect(old.originatingPlacementId).toBe("placement");
    expect(old.executionPlacementId).toBe("placement");
    expect(
      ManagedWorktreeSchema.parse({
        ...old,
        id: "derived",
        workspaceKind: "derived",
        ownerStepId: "join",
        composition: {
          baseSha: old.baseSha,
          predecessors: [
            {
              stepId: "left",
              stepKey: "left",
              position: 0,
              worktreeId: "left-tree",
              resultSha: "b".repeat(40),
            },
          ],
          state: "pending",
        },
      }).composition,
    ).toMatchObject({
      state: "pending",
      predecessors: [{ stepId: "left", position: 0 }],
    });
  });

  it("keeps sourcePlacementId compatible while carrying repository and chunk metadata", () => {
    const binding = RunWorkspaceBindingSchema.parse({
      sourcePlacementId: "origin",
      repositoryIdentity: "f".repeat(64),
      repositoryObjectFormat: "sha1",
    });
    expect(binding.originatingPlacementId).toBe("origin");
    expect(
      NodeToHostMessageSchema.parse({
        type: "artifact_upload_chunk",
        transfer: {
          operationId: "00000000-0000-4000-8000-000000000000",
          resultId: "result",
          artifactId: "a".repeat(64),
          offset: 0,
          data: Buffer.from("chunk").toString("base64"),
        },
      }).type,
    ).toBe("artifact_upload_chunk");
  });

  it("keeps legacy commands valid and rejects untyped or unversioned worktree operations", () => {
    expect(
      HostToNodeMessageSchema.parse({
        type: "command",
        command: {
          type: "start_session",
          commandId: "c",
          sessionId: "s",
          localPath: "C:\\repo",
          prompt: "task",
        },
      }).type,
    ).toBe("command");
    expect(
      HostToNodeMessageSchema.safeParse({
        type: "managed_worktree",
        request: { kind: "force_delete" },
      }).success,
    ).toBe(false);
  });

  it("keeps historical integration records compatible while distinguishing validation and no-change outcomes", () => {
    const now = new Date().toISOString();
    const checkout = {
      key: "checkout",
      path: "C:\\repo",
      machineId: "machine",
      volume: "volume",
      fileId: "file",
    };
    const preview = IntegrationPreviewSchema.parse({
      id: "preview",
      worktreeId: "tree",
      generation: 1,
      taskSha: "a".repeat(40),
      diffIdentity: "diff",
      diff: "",
      targetPlacementId: "placement",
      target: checkout,
      targetRef: "refs/heads/main",
      targetSha: "a".repeat(40),
      taskDirty: false,
      targetDirty: false,
      alreadyIntegrated: false,
      observedAt: now,
    });
    expect(preview).toMatchObject({
      hasCommittedChanges: true,
      baseContainedByTarget: false,
      targetAdvancedFromBase: false,
    });
    expect(
      WorktreeIntegrationSchema.parse({
        id: "integration",
        worktreeId: "tree",
        generation: 1,
        preview,
        approvedTaskSha: preview.taskSha,
        approvedDiffIdentity: preview.diffIdentity,
        state: "no_changes",
        preState: "clean",
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({
      state: "no_changes",
      validationState: "not_run",
      validationSummary: "",
      validatedAt: "",
    });
  });
});
