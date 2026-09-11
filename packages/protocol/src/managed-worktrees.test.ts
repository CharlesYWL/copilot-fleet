import { describe, expect, it } from "vitest";
import {
  HostBackupSchema,
  HostToNodeMessageSchema,
  ManagedWorktreePolicySchema,
  RunSchema,
  RunWorkspaceBindingSchema,
  WorkspaceModeSchema,
  resolveWorkspaceMode,
} from "./index.js";

describe("managed workspace protocol compatibility", () => {
  it("resolves explicit mode, Auto defaults and historical missing mode once", () => {
    expect(resolveWorkspaceMode("managed", false)).toMatchObject({
      requestedMode: "managed",
      effectiveMode: "managed",
      resolutionSource: "explicit",
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
    expect(backup.worktreeOperations).toEqual([]);
    expect(backup.worktreeIntegrations).toEqual([]);
    expect(backup.worktreeTombstones).toEqual([]);
    expect(ManagedWorktreePolicySchema.parse({})).toMatchObject({
      retentionDays: 7,
      maxPerRepository: 8,
      maxPerNode: 32,
    });
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
});
