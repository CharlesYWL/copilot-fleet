import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_EXECUTION_CAPABILITY,
  COMMAND_PERMISSIONS_CAPABILITY,
  COMMAND_LIMITS,
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  MANAGED_WORKTREES_CAPABILITY,
  ManagedWorktreeSchema,
  commandDigestPayload,
  type CommandExecution,
  type CommandExecutionHostMessage,
  type CommandPermissionMatch,
  type CommandReceipt,
  type PreparedCommand,
  type LeadPromptReceipt,
  MAX_ATTACHMENT_BYTES,
  CommandExecutionBackupSchema,
  PromptSchema,
} from "@fleet/protocol";
import type { AuthenticatedChannel } from "@fleet/protocol/node-auth";
import { FleetStore } from "./store.js";
import { FleetService } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";
import { HostIdentityService } from "./auth/host-identity.js";
import { OrchestratorEngine } from "./orchestrator/engine.js";
import { FleetTools } from "./orchestrator/tools.js";
import { LeadTokens } from "./orchestrator/lead-tokens.js";
import { mcpRoutes } from "./orchestrator/mcp-routes.js";
import { commandExecutionRoutes } from "./routes/command-executions.js";
import type { FleetAuth } from "./auth/service.js";
import { archiveRun, purgeRun } from "./orchestrator/lifecycle.js";
import { registerRequestGuard } from "./request-guard.js";
import { OPERATOR_COOKIE } from "./auth.js";
import { assertHostArchiveSize, HOST_ARCHIVE_BYTES } from "./backup-limits.js";
import { parseFleetControl } from "../ui/src/lib/fleet-wake.js";

const stores: FleetStore[] = [];
const directories: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as FastifyBaseLogger;
const readiness = {
  enabled: true,
  supported: true,
  reason: "",
  admissionVersion: 1,
  shells: ["windows-powershell-5.1" as const],
};
const capabilities = [
  COMMAND_EXECUTION_CAPABILITY,
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  MANAGED_WORKTREES_CAPABILITY,
];
const physical = (key: string, path: string) => ({
  key,
  path,
  machineId: "machine",
  volume: "volume",
  fileId: key,
});

function nativeReceipt(
  input: Pick<LeadPromptReceipt, "deliveryId" | "sessionId" | "state" | "at"> &
    Partial<LeadPromptReceipt>,
): LeadPromptReceipt {
  return {
    detail: "",
    nativeSessionId: `native-${input.sessionId}`,
    attemptId: input.deliveryId,
    ...input,
  };
}

function open(path = ":memory:") {
  const store = new FleetStore(path);
  stores.push(store);
  return store;
}
function setup(path = ":memory:") {
  const store = open(path);
  new HostIdentityService(store).identity();
  const service = new FleetService(store, log, "test");
  const node = store.registerNode({
    name: "target",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities,
    maxSessions: 8,
  }).node;
  const workspace = store.createWorkspace("workspace", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const lead = store.createSession(placement, "orchestrate", false, "lead", {
    runRole: "lead",
  });
  store.transitionSession(lead.id, "starting");
  store.transitionSession(lead.id, "idle");
  const frames: CommandExecutionHostMessage[] = [];
  function connect(id = node.id, caps = capabilities, sealed = true) {
    const raw = {
      OPEN: 1,
      readyState: 1,
      send: (text: string) => frames.push(JSON.parse(text)),
      close() {},
    };
    // A real sealing link with a test channel: application frames are exposed only at this boundary.
    const channel = {
      seal: (text: string) => JSON.parse(text),
    } as unknown as AuthenticatedChannel;
    service.attachNode(id, sealed ? new SealedNodeLink(raw, channel) : raw);
    store.setNodeOnline(id, true, 0);
    return service.commands.nodeReady(id, {
      capabilities: caps,
      commandExecution: readiness,
    });
  }
  connect();
  function request(extra: Record<string, unknown> = {}) {
    return service.commands.request(lead.id, {
      target: { placementId: placement.id },
      command: "Write-Output ok",
      shell: "windows-powershell-5.1",
      reason: "Verify",
      requestKey: randomUUID(),
      ...extra,
    });
  }
  function prepared(execution: CommandExecution): PreparedCommand {
    const frame = frames.find(
      (entry) =>
        entry.type === "prepare_command_execution" &&
        entry.request.executionId === execution.id,
    );
    if (!frame || frame.type !== "prepare_command_execution")
      throw new Error("No preparation");
    const receivedAt = Date.now();
    const body = {
      ...frame.request,
      prepared: {
        cwd: execution.requestedPath,
        checkout: physical("checkout", execution.requestedPath),
        repository: physical("repository", "C:\\repo\\.git"),
        shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        admissionVersion: 1 as const,
        preparedAt: new Date(receivedAt).toISOString(),
        hostClockOffsetMs: Date.parse(frame.request.hostTime) - receivedAt,
        clockUncertaintyMs: COMMAND_LIMITS.clockUncertaintyMs,
      },
    };
    return {
      ...body,
      digest: createHash("sha256").update(commandDigestPayload(body)).digest("hex"),
    };
  }
  function prepare(execution: CommandExecution, descriptor = prepared(execution)) {
    expect(
      service.commands.handleNodeMessage(node.id, {
        type: "command_execution_prepared",
        executionId: execution.id,
        attemptId: execution.attemptId,
        ok: true,
        descriptor,
      }),
    ).toBe(true);
    return service.commands.get(execution.id)!;
  }
  function approve(execution: CommandExecution) {
    return service.commands.decide(
      execution.id,
      {
        decision: "allow_once",
        expectedVersion: execution.version,
        digest: execution.descriptor!.digest,
      },
      "administrator",
    );
  }
  function start() {
    return approve(prepare(request()));
  }
  function receipt(
    execution: CommandExecution,
    patch: Partial<CommandReceipt> = {},
  ): CommandReceipt {
    return {
      executionId: execution.id,
      attemptId: execution.attemptId,
      digest: execution.descriptor!.digest,
      state: "succeeded",
      ownership: "quiescent",
      exitCode: 0,
      reason: "completed",
      outcomeKnown: true,
      descendantCleanupForced: false,
      settledAt: new Date().toISOString(),
      finalOutputSeq: 0,
      gaps: [],
      ...patch,
    };
  }
  function result(execution: CommandExecution, patch: Partial<CommandReceipt> = {}) {
    return service.commands.handleNodeMessage(execution.nodeId, {
      type: "command_execution_update",
      receipt: receipt(execution, patch),
    });
  }
  return {
    store,
    service,
    node,
    lead,
    placement,
    workspace,
    frames,
    connect,
    request,
    prepared,
    prepare,
    approve,
    start,
    receipt,
    result,
  };
}

describe("Node-owned command permissions", () => {
  const permissionCapabilities = [...capabilities, COMMAND_PERMISSIONS_CAPABILITY];
  function permissionSetup() {
    const f = setup();
    expect(f.connect(f.node.id, permissionCapabilities)).toEqual({
      commandExecutions: true,
      commandPermissions: true,
      durableLeadDelivery: true,
    });
    return f;
  }
  function descriptor(
    f: ReturnType<typeof setup>,
    execution: CommandExecution,
    permission: Partial<CommandPermissionMatch> = {},
  ) {
    const body = f.prepared(execution);
    body.prepared.permission = {
      reusable: true,
      commandKey: "write-output",
      path: body.prepared.cwd,
      explanation: "Matches the command and canonical cwd; ordinary flags may differ.",
      policyVersion: 3,
      ...permission,
    };
    return {
      ...body,
      digest: createHash("sha256").update(commandDigestPayload(body)).digest("hex"),
    };
  }
  function decide(
    f: ReturnType<typeof setup>,
    execution: CommandExecution,
    scope: "session" | "always",
  ) {
    return f.service.commands.decide(
      execution.id,
      {
        decision: scope === "session" ? "allow_session" : "allow_always",
        digest: execution.descriptor!.digest,
        expectedVersion: execution.version,
      },
      "administrator",
    );
  }

  it("bypasses the legacy enabled gate only for a negotiated permission-capable Node", () => {
    const f = setup();
    const disabled = { ...readiness, enabled: false };
    f.service.commands.nodeReady(f.node.id, {
      capabilities,
      commandExecution: disabled,
    });
    expect(() => f.request()).toThrow("opted-in");
    f.service.commands.nodeReady(f.node.id, {
      capabilities: permissionCapabilities,
      commandExecution: disabled,
    });
    const execution = f.request();
    expect(f.prepare(execution, descriptor(f, execution)).state).toBe(
      "awaiting_approval",
    );
  });

  it.each([{ supported: false }, { admissionVersion: 2 }, { shells: [] }])(
    "preserves supervisor and shell readiness gates: %j",
    (patch) => {
      const f = permissionSetup();
      f.service.commands.nodeReady(f.node.id, {
        capabilities: permissionCapabilities,
        commandExecution: { ...readiness, ...patch },
      });
      expect(() => f.request()).toThrow("supported supervisor");
    },
  );

  it.each(["builtin", "session", "always"] as const)(
    "starts a digest-bound %s grant automatically without an approval popup",
    (grantedBy) => {
      const f = permissionSetup();
      const publish = vi.spyOn(f.service, "broadcast");
      const execution = f.request();
      const prepared = descriptor(f, execution, { grantedBy, ruleId: "rule-1" });
      const started = f.prepare(execution, prepared);
      expect(started).toMatchObject({
        state: "starting",
        automaticApproval: true,
        approvalScope: grantedBy === "builtin" ? "once" : grantedBy,
        approvedBy: `node:${f.node.id}:${grantedBy}`,
        descriptor: prepared,
      });
      expect(f.frames.find((frame) => frame.type === "start_command_execution")).toEqual({
        type: "start_command_execution",
        descriptor: prepared,
        approvedBy: started.approvedBy,
        approvedAt: started.approvedAt,
        approvalScope: started.approvalScope,
        automaticApproval: true,
        version: started.version,
      });
      expect(
        publish.mock.calls.some(
          ([frame]) =>
            frame.type === "command_execution" &&
            frame.execution.state === "awaiting_approval",
        ),
      ).toBe(false);
      expect(f.store.listNotifications().notifications).toHaveLength(0);
      expect(f.store.listSecurityAudit(10)[0]).toMatchObject({
        eventType: "command_execution_decision",
        actorKind: "node",
        actorId: f.node.id,
        detail: expect.stringContaining(`automatic_${grantedBy} ${prepared.digest}`),
      });
      expect(f.store.commands.exportBackup().executions[0]).toMatchObject({
        automaticApproval: true,
        descriptor: prepared,
      });
      expect(f.result(started)).toBe(true);
      expect(
        f.store.listNotifications().notifications.map((notice) => notice.kind),
      ).toEqual(["command_completion"]);
    },
  );

  it.each(["session", "always"] as const)(
    "sends an explicit %s decision and does not cache it as another request's authority",
    (scope) => {
      const f = permissionSetup();
      const execution = f.request();
      const awaiting = f.prepare(execution, descriptor(f, execution));
      const started = decide(f, awaiting, scope);
      expect(started).toMatchObject({
        state: "starting",
        approvalScope: scope,
        automaticApproval: false,
        approvedBy: "administrator",
      });
      expect(
        f.frames.find((frame) => frame.type === "start_command_execution"),
      ).toMatchObject({
        approvalScope: scope,
        automaticApproval: false,
        descriptor: awaiting.descriptor,
      });
      const next = f.request();
      expect(f.prepare(next, descriptor(f, next)).state).toBe("awaiting_approval");
      expect(f.store.commands.attempt(next.id)).toBeUndefined();
      expect(f.request({ requestKey: execution.requestKey }).id).toBe(execution.id);
      expect(
        f.frames.filter((frame) => frame.type === "start_command_execution"),
      ).toHaveLength(1);
    },
  );

  it.each(["legacy", "missing", "nonreusable", "missing-key"] as const)(
    "does not automatically approve %s permission evidence",
    (kind) => {
      const f = kind === "legacy" ? setup() : permissionSetup();
      const execution = f.request();
      const prepared =
        kind === "missing"
          ? f.prepared(execution)
          : descriptor(f, execution, {
              grantedBy: "always",
              ...(kind === "nonreusable" ? { reusable: false } : {}),
            });
      if (kind === "missing-key") {
        delete prepared.prepared.permission!.commandKey;
        prepared.digest = createHash("sha256")
          .update(commandDigestPayload(prepared))
          .digest("hex");
      }
      const awaiting = f.prepare(execution, prepared);
      expect(awaiting.state).toBe("awaiting_approval");
      for (const scope of ["session", "always"] as const)
        expect(() => decide(f, awaiting, scope)).toThrow(
          kind === "legacy" ? "Once only" : "command_permission_not_reusable",
        );
      expect(f.approve(awaiting).state).toBe("starting");
      const start = f.frames.find((frame) => frame.type === "start_command_execution")!;
      if (kind === "legacy") {
        expect(start).not.toHaveProperty("approvalScope");
        expect(start).not.toHaveProperty("automaticApproval");
      }
    },
  );

  it.each(["command", "node", "permission-path", "unhashed-rule"] as const)(
    "rejects forged %s metadata rather than converting it into a grant",
    (field) => {
      const f = permissionSetup();
      const execution = f.request();
      const prepared = descriptor(f, execution, { grantedBy: "always" });
      if (field === "command") prepared.command = "Remove-Item dangerous";
      if (field === "node") prepared.nodeId = randomUUID();
      if (field === "permission-path") prepared.prepared.permission!.path = "C:\\other";
      if (field === "unhashed-rule") prepared.prepared.permission!.ruleId = "forged";
      else
        prepared.digest = createHash("sha256")
          .update(commandDigestPayload(prepared))
          .digest("hex");
      expect(
        f.service.commands.handleNodeMessage(f.node.id, {
          type: "command_execution_prepared",
          executionId: execution.id,
          attemptId: execution.attemptId,
          ok: true,
          descriptor: prepared,
        }),
      ).toBe(false);
      expect(f.service.commands.get(execution.id)?.state).toBe("preparing");
      expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
        false,
      );
      expect(f.store.listSecurityAudit(10)).toHaveLength(0);
    },
  );

  it("rejects permission evidence from an unknown authenticated Node or replacement link", () => {
    const f = permissionSetup();
    const execution = f.request();
    const prepared = descriptor(f, execution, { grantedBy: "session" });
    const unknownNode = randomUUID();
    f.connect(unknownNode, permissionCapabilities);
    const message = {
      type: "command_execution_prepared",
      executionId: execution.id,
      attemptId: execution.attemptId,
      ok: true,
      descriptor: prepared,
    };
    expect(f.service.commands.handleNodeMessage(unknownNode, message)).toBe(false);
    f.connect(f.node.id, permissionCapabilities);
    expect(f.service.commands.handleNodeMessage(f.node.id, message)).toBe(true);
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "failed",
      reasonCode: "preparation_clock_unverified",
    });
    expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
      false,
    );
  });

  it("commits automatic audit evidence and accepted preparation atomically", () => {
    const f = permissionSetup();
    const execution = f.request();
    const prepared = descriptor(f, execution, { grantedBy: "always" });
    vi.spyOn(f.store, "recordSecurityAudit").mockImplementationOnce(() => {
      throw new Error("audit write failed");
    });
    expect(() => f.prepare(execution, prepared)).toThrow("audit write failed");
    expect(f.store.commands.get(execution.id)?.state).toBe("preparing");
    expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
    expect(f.store.commands.attempt(execution.id)).toBeUndefined();
    expect(f.prepare(execution, prepared).state).toBe("starting");
  });

  it("does not let a matching permission bypass the preparation clock proof", () => {
    const f = permissionSetup();
    const execution = f.request();
    const prepared = descriptor(f, execution, { grantedBy: "always" });
    prepared.prepared.clockUncertaintyMs = 0;
    prepared.digest = createHash("sha256")
      .update(commandDigestPayload(prepared))
      .digest("hex");
    expect(f.prepare(execution, prepared)).toMatchObject({
      state: "failed",
      reasonCode: "preparation_clock_inconsistent",
    });
    expect(f.store.commands.attempt(execution.id)?.start_version).toBeNull();
    expect(f.store.listSecurityAudit(10)).toHaveLength(0);
  });

  it("does not start a queued grant after the exact catalog target changes", () => {
    const f = permissionSetup();
    const first = f.start();
    const execution = f.request();
    expect(
      f.prepare(execution, descriptor(f, execution, { grantedBy: "always" })).state,
    ).toBe("queued");
    vi.spyOn(f.store, "getPlacement").mockReturnValue({
      ...f.placement,
      localPath: "C:\\moved",
    });
    f.result(first);
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "failed",
      reasonCode: "command_target_changed",
    });
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });

  it("rejects permission evidence after the lead stops and cancels queued automatic work", () => {
    const f = permissionSetup();
    const first = f.start();
    const queued = f.request();
    expect(f.prepare(queued, descriptor(f, queued, { grantedBy: "session" })).state).toBe(
      "queued",
    );
    const late = f.request();
    const lateDescriptor = descriptor(f, late, { grantedBy: "always" });
    f.store.setSessionControls(f.lead.id, { stopRequested: true });
    expect(f.prepare(late, lateDescriptor)).toMatchObject({
      state: "failed",
      reasonCode: "lead_not_live",
    });
    f.service.commands.tick();
    expect(f.service.commands.get(queued.id)?.state).toBe("cancelled");
    expect(() => f.request()).toThrow("lead_not_live");
    expect(f.result(first)).toBe(true);
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });

  it("rechecks negotiated permission support before dispatching queued automatic work", () => {
    const f = permissionSetup();
    const first = f.start();
    const queued = f.request();
    expect(f.prepare(queued, descriptor(f, queued, { grantedBy: "always" })).state).toBe(
      "queued",
    );
    f.service.commands.nodeReady(f.node.id, {
      capabilities,
      commandExecution: readiness,
    });
    f.result(first);
    expect(f.service.commands.get(queued.id)).toMatchObject({
      state: "failed",
      reasonCode: "command_permission_upgrade_required",
    });
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });

  it("settles a revoked queued rule as a refusal without blindly rerunning it", () => {
    const f = permissionSetup();
    const first = f.start();
    const pending = f.request();
    expect(
      f.prepare(pending, descriptor(f, pending, { grantedBy: "always" })).state,
    ).toBe("queued");
    f.result(first);
    const started = f.service.commands.get(pending.id)!;
    expect(started.state).toBe("starting");
    expect(
      f.result(started, {
        state: "failed",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
        reason: "command_permission_revoked",
      }),
    ).toBe(true);
    f.service.commands.tick();
    expect(f.service.commands.get(started.id)).toMatchObject({
      state: "failed",
      reasonCode: "command_permission_revoked",
      automaticApproval: true,
    });
    expect(
      f.frames.filter(
        (frame) =>
          frame.type === "start_command_execution" &&
          frame.descriptor.executionId === pending.id,
      ),
    ).toHaveLength(1);
    const fresh = f.request();
    expect(f.prepare(fresh, descriptor(f, fresh)).state).toBe("awaiting_approval");
  });

  it("revokes only this orchestrator's touched executing Nodes, not workers or all Nodes", () => {
    const f = permissionSetup();
    const execution = f.request();
    const first = decide(f, f.prepare(execution, descriptor(f, execution)), "session");
    f.result(first);
    const secondNode = f.store.registerNode({
      name: "second",
      os: "win32",
      arch: "x64",
      version: "test",
      capabilities: permissionCapabilities,
      maxSessions: 8,
    }).node;
    const secondPlacement = f.store.createPlacement(
      f.workspace.id,
      secondNode.id,
      "C:\\second",
    );
    f.connect(secondNode.id, permissionCapabilities);
    const second = f.request({ target: { placementId: secondPlacement.id } });
    expect(
      f.service.commands.handleNodeMessage(secondNode.id, {
        type: "command_execution_prepared",
        executionId: second.id,
        attemptId: second.attemptId,
        ok: true,
        descriptor: descriptor(f, second),
      }),
    ).toBe(true);
    f.result(decide(f, f.service.commands.get(second.id)!, "session"));
    const untouched = randomUUID();
    f.connect(untouched, permissionCapabilities);
    const send = vi.spyOn(f.service, "send");
    f.service.commands.revokeLead(f.lead.id);
    const revocations = send.mock.calls.filter(
      ([, frame]) =>
        (frame as CommandExecutionHostMessage).type === "revoke_command_session_grants",
    );
    expect(revocations).toHaveLength(2);
    expect(new Set(revocations.map(([link]) => link))).toEqual(
      new Set([f.service.nodeSocket(f.node.id), f.service.nodeSocket(secondNode.id)]),
    );
    for (const [, frame] of revocations)
      expect(frame).toEqual({
        type: "revoke_command_session_grants",
        hostId: first.hostId,
        leadSessionId: f.lead.id,
      });
    expect(f.store.commands.sessionGrantTargets()).toHaveLength(2);
    const renewed = f.request();
    f.result(decide(f, f.prepare(renewed, descriptor(f, renewed)), "session"));
    send.mockClear();
    f.service.commands.revokeLead(f.lead.id);
    expect(
      send.mock.calls.filter(
        ([, frame]) =>
          (frame as CommandExecutionHostMessage).type === "revoke_command_session_grants",
      ),
    ).toHaveLength(2);
  });

  it("revokes on terminal lead transitions and replays revocation after reconnect and retirement", () => {
    const f = permissionSetup();
    const execution = f.request();
    const started = decide(f, f.prepare(execution, descriptor(f, execution)), "session");
    f.result(started);
    const before = f.frames.length;
    f.service.settleCommandedSession(f.lead.id, "stopped", "stopped");
    expect(f.frames.slice(before)).toContainEqual({
      type: "revoke_command_session_grants",
      hostId: started.hostId,
      leadSessionId: f.lead.id,
    });
    const settled = f.service.commands.get(started.id)!;
    f.store.commands.update(settled.id, settled.version, { delivery: "orphaned" });
    f.store.commands.sweep(Date.now() + COMMAND_LIMITS.retentionMs + 1_000);
    expect(f.store.commands.get(started.id)).toBeUndefined();
    f.connect(f.node.id, permissionCapabilities);
    const reconnected = f.frames.length;
    f.service.commands.reconnect(f.node.id);
    expect(f.frames.slice(reconnected)).toContainEqual({
      type: "revoke_command_session_grants",
      hostId: started.hostId,
      leadSessionId: f.lead.id,
    });
    f.connect(f.node.id, capabilities);
    const legacy = f.frames.length;
    f.service.commands.reconnect(f.node.id);
    expect(
      f.frames
        .slice(legacy)
        .some((frame) => frame.type === "revoke_command_session_grants"),
    ).toBe(false);
  });

  it("reconciles an offline terminal lead's grants before accepting more preparations", () => {
    const f = permissionSetup();
    const execution = f.request();
    f.result(decide(f, f.prepare(execution, descriptor(f, execution)), "session"));
    f.service.commands.nodeDisconnected(f.node.id);
    f.store.transitionSession(f.lead.id, "stopped");
    f.connect(f.node.id, permissionCapabilities);
    const before = f.frames.length;
    f.service.commands.reconnect(f.node.id);
    expect(f.frames.slice(before)).toContainEqual({
      type: "revoke_command_session_grants",
      hostId: execution.hostId,
      leadSessionId: f.lead.id,
    });
    expect(() => f.request()).toThrow("lead_not_live");
  });

  it("persists an offline Node's revocation through lead resume and Host restart without invalidating Once identity", () => {
    const directory = resolve(".command-test-work", randomUUID());
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "host.db");
    const f = setup(path);
    f.connect(f.node.id, permissionCapabilities);
    const targetNode = f.store.registerNode({
      name: "offline-target",
      os: "win32",
      arch: "x64",
      version: "test",
      capabilities: permissionCapabilities,
      maxSessions: 8,
    }).node;
    const targetPlacement = f.store.createPlacement(
      f.workspace.id,
      targetNode.id,
      "C:\\offline-target",
    );
    f.connect(targetNode.id, permissionCapabilities);
    const target = { placementId: targetPlacement.id };
    const prepareTarget = (execution: CommandExecution, reusable = true) => {
      expect(
        f.service.commands.handleNodeMessage(targetNode.id, {
          type: "command_execution_prepared",
          executionId: execution.id,
          attemptId: execution.attemptId,
          ok: true,
          descriptor: descriptor(f, execution, { reusable }),
        }),
      ).toBe(true);
      return f.service.commands.get(execution.id)!;
    };
    f.result(decide(f, prepareTarget(f.request({ target })), "session"));
    const onceInput = {
      target,
      command: "Write-Output first; Write-Output once",
      shell: "windows-powershell-5.1" as const,
      reason: "Verify",
      requestKey: "preserved-once",
    };
    const once = f.approve(prepareTarget(f.request(onceInput), false));
    f.result(once);
    const attempt = f.store.commands.attempt(once.id);
    const leadLink = f.service.nodeSocket(f.node.id)!;
    const targetLink = f.service.nodeSocket(targetNode.id)!;
    f.service.commands.nodeDisconnected(targetNode.id);
    f.store.setNodeOnline(targetNode.id, false, 0);
    const offlineFrames = f.frames.length;
    f.service.settleCommandedSession(f.lead.id, "stopped", "operator stopped");
    f.store.transitionSession(f.lead.id, "starting");
    f.store.transitionSession(f.lead.id, "idle");
    const revocation = { hostId: once.hostId, leadSessionId: f.lead.id };
    expect(f.store.commands.sessionGrantRevocations(targetNode.id)).toEqual([revocation]);
    expect(
      f.frames
        .slice(offlineFrames)
        .some((frame) => frame.type === "revoke_command_session_grants"),
    ).toBe(false);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const store = open(path);
    const restarted = new FleetService(store, log, "restarted");
    expect(store.getSession(f.lead.id)?.state).toBe("idle");
    expect(store.commands.sessionGrantRevocations(targetNode.id)).toEqual([revocation]);
    restarted.attachNode(f.node.id, leadLink);
    restarted.commands.nodeReady(f.node.id, {
      capabilities: permissionCapabilities,
      commandExecution: readiness,
    });
    restarted.attachNode(targetNode.id, targetLink);
    restarted.commands.nodeReady(targetNode.id, {
      capabilities: permissionCapabilities,
      commandExecution: readiness,
    });
    const reconnected = f.frames.length;
    restarted.commands.reconnect(targetNode.id);
    expect(f.frames[reconnected]).toEqual({
      type: "revoke_command_session_grants",
      ...revocation,
    });
    expect(restarted.commands.request(f.lead.id, onceInput)).toMatchObject({
      id: once.id,
      attemptId: once.attemptId,
      state: "succeeded",
      approvalScope: "once",
    });
    expect(store.commands.attempt(once.id)).toEqual(attempt);
    expect(
      restarted.commands.request(f.lead.id, {
        ...onceInput,
        requestKey: "fresh-after-resume",
      }).state,
    ).toBe("preparing");
    expect(
      f.frames
        .slice(reconnected)
        .filter((frame) =>
          [
            "revoke_command_session_grants",
            "prepare_command_execution",
            "start_command_execution",
          ].includes(frame.type),
        )
        .map((frame) => frame.type),
    ).toEqual(["revoke_command_session_grants", "prepare_command_execution"]);
  });

  it("keeps a failed session revocation ahead of every new prepare", () => {
    const f = permissionSetup();
    const execution = f.request();
    f.result(decide(f, f.prepare(execution, descriptor(f, execution)), "session"));
    const send = f.service.send.bind(f.service);
    const sending = vi.spyOn(f.service, "send").mockImplementation((link, frame) => {
      if ((frame as CommandExecutionHostMessage).type === "revoke_command_session_grants")
        throw new Error("revocation delivery failed");
      return send(link, frame);
    });
    f.service.commands.revokeLead(f.lead.id);
    const before = f.frames.length;
    const refused = f.request();
    expect(refused).toMatchObject({
      state: "failed",
      reasonCode: "preparation_send_uncertain",
    });
    expect(
      f.frames.slice(before).some((frame) => frame.type === "prepare_command_execution"),
    ).toBe(false);
    sending.mockRestore();
    const retry = f.frames.length;
    expect(f.request().state).toBe("preparing");
    expect(f.frames.slice(retry).map((frame) => frame.type)).toEqual([
      "revoke_command_session_grants",
      "prepare_command_execution",
    ]);
  });

  it("never turns copied automatic metadata into a grant or a relaunched execution on restore", () => {
    const f = permissionSetup();
    f.start();
    const execution = f.request();
    const queued = f.prepare(
      execution,
      descriptor(f, execution, { grantedBy: "session" }),
    );
    expect(queued.state).toBe("queued");
    const restored = open();
    restored.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    const service = new FleetService(restored, log, "restored");
    service.attachNode(f.node.id, f.service.nodeSocket(f.node.id)!);
    service.commands.nodeReady(f.node.id, {
      capabilities: permissionCapabilities,
      commandExecution: readiness,
    });
    const before = f.frames.length;
    service.commands.reconnect(f.node.id);
    service.commands.tick();
    expect(service.commands.get(execution.id)).toMatchObject({
      state: "expired",
      reasonCode: "restore_authority_revoked",
      automaticApproval: true,
      approvalScope: "session",
    });
    expect(f.frames[before]).toMatchObject({
      type: "revoke_command_session_grants",
      hostId: execution.hostId,
      leadSessionId: f.lead.id,
    });
    expect(
      f.frames
        .slice(before)
        .some((frame) =>
          ["prepare_command_execution", "start_command_execution"].includes(frame.type),
        ),
    ).toBe(false);
    expect(
      restored
        .listNotifications()
        .notifications.some(
          (notice) => notice.kind === "command_approval" && notice.status === "active",
        ),
    ).toBe(false);
  });

  it("sends session revocations before a live restore disconnects Nodes", () => {
    const f = permissionSetup();
    const execution = f.request();
    f.result(decide(f, f.prepare(execution, descriptor(f, execution)), "session"));
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const before = f.frames.length;
    f.service.importHostBackup(backup);
    expect(f.frames.slice(before)).toContainEqual({
      type: "revoke_command_session_grants",
      hostId: execution.hostId,
      leadSessionId: f.lead.id,
    });
    expect(f.service.nodeSocket(f.node.id)).toBeUndefined();
  });

  it("requires current Microsoft administration for scope decisions and exposes the reviewed key", async () => {
    const f = permissionSetup();
    const execution = f.request();
    const awaiting = f.prepare(execution, descriptor(f, execution));
    const app = Fastify();
    apps.push(app);
    app.addHook("onRequest", async (request) => {
      if (request.headers["x-test-admin"] === "yes") request.fleetSession = {} as never;
    });
    let administrator = true;
    const auth = {
      administratorFor: () => (administrator ? { id: "admin" } : undefined),
      noAuthEnabled: () => true,
      noAuthEndpointAllowed: () => true,
    } as unknown as FleetAuth;
    await app.register(commandExecutionRoutes, { service: f.service, auth });
    const url = `/api/command-executions/${execution.id}/decision`;
    const payload = {
      decision: "allow_session",
      expectedVersion: awaiting.version,
      digest: awaiting.descriptor!.digest,
    };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    administrator = false;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { "x-test-admin": "yes" },
        })
      ).statusCode,
    ).toBe(403);
    administrator = true;
    const response = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { "x-test-admin": "yes" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().execution).toMatchObject({
      approvalScope: "session",
      descriptor: { prepared: { permission: awaiting.descriptor!.prepared.permission } },
    });
    const compound = f.request({ command: "Write-Output ok; Write-Output later" });
    const onceOnly = f.prepare(compound, descriptor(f, compound, { reusable: false }));
    const refused = await app.inject({
      method: "POST",
      url: `/api/command-executions/${compound.id}/decision`,
      headers: { "x-test-admin": "yes" },
      payload: {
        decision: "allow_always",
        digest: onceOnly.descriptor!.digest,
        expectedVersion: onceOnly.version,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe("command_permission_not_reusable");
  });
});

describe("bounded command preparation clocks", () => {
  const rehash = (descriptor: ReturnType<ReturnType<typeof setup>["prepared"]>) => {
    const { digest: _digest, ...body } = descriptor;
    return {
      ...body,
      digest: createHash("sha256").update(commandDigestPayload(body)).digest("hex"),
    };
  };

  it("rejects a claimed zero-uncertainty one-way estimate without granting approval", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    descriptor.prepared.clockUncertaintyMs = 0;
    expect(f.prepare(execution, rehash(descriptor))).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reasonCode: "preparation_clock_inconsistent",
    });
    expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
    expect(
      f.store
        .listNotifications()
        .notifications.some((entry) => entry.kind === "command_approval"),
    ).toBe(false);
    expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
      false,
    );
  });

  it.each([
    [5_000, "awaiting_approval"],
    [5_001, "failed"],
  ] as const)(
    "measures the exact preparation RTT boundary at %d ms",
    (elapsed, state) => {
      const f = setup();
      let wall = Date.now();
      let monotonic = 100;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const execution = f.request();
      const descriptor = f.prepared(execution);
      wall += elapsed;
      monotonic += elapsed;
      const prepared = f.prepare(execution, descriptor);
      expect(prepared.state).toBe(state);
      const clock = f.store.commands.preparationClock(execution.id)!;
      if (state === "awaiting_approval") expect(clock.elapsedMs).toBe(5_000);
      else {
        expect(prepared.reasonCode).toBe("preparation_rtt_exceeded");
        expect(clock.acceptedAt).toBeNull();
      }
      expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
        false,
      );
    },
  );

  it.each([-60_000, 60_000])(
    "accepts bounded offset estimation with a Node clock offset of %d ms",
    (offset) => {
      const f = setup();
      const execution = f.request();
      const descriptor = f.prepared(execution);
      descriptor.prepared.preparedAt = new Date(
        Date.parse(descriptor.hostTime) - offset,
      ).toISOString();
      descriptor.prepared.hostClockOffsetMs = offset;
      const awaiting = f.prepare(execution, rehash(descriptor));
      expect(awaiting.state).toBe("awaiting_approval");
      expect(awaiting.descriptor!.prepared.clockUncertaintyMs).toBe(5_000);
      expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toEqual(
        expect.any(String),
      );
      expect(f.approve(awaiting).state).toBe("starting");
    },
  );

  it.each([
    { elapsed: 100, jump: -1_001, reason: "host_clock_discontinuity" },
    { elapsed: 100, jump: 1_001, reason: "host_clock_discontinuity" },
    { elapsed: 4_900, jump: 101, reason: "preparation_rtt_exceeded" },
  ])(
    "does not hide wall-clock drift in the five-second uncertainty budget: %j",
    ({ elapsed, jump, reason }) => {
      const f = setup();
      let wall = Date.now();
      let monotonic = 100;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const execution = f.request();
      const descriptor = f.prepared(execution);
      wall += elapsed + jump;
      monotonic += elapsed;
      expect(f.prepare(execution, descriptor)).toMatchObject({
        state: "failed",
        reasonCode: reason,
      });
      expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
    },
  );

  it.each([
    {
      name: "aligned Node with five milliseconds of transit",
      sampleDelta: 5,
      offset: -5,
    },
    { name: "behind-clock receive sample", sampleDelta: -59_995, offset: 59_995 },
    {
      name: "ahead-clock receive sample",
      sampleDelta: 60_005,
      offset: -60_005,
    },
  ])(
    "accepts $name with a measured 163ms preparation round trip",
    ({ sampleDelta, offset }) => {
      const f = setup();
      let wall = Date.now();
      let monotonic = 100;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const execution = f.request();
      const descriptor = f.prepared(execution);
      descriptor.prepared.preparedAt = new Date(wall + sampleDelta).toISOString();
      descriptor.prepared.hostClockOffsetMs = offset;
      wall += 163;
      monotonic += 163;
      expect(f.prepare(execution, rehash(descriptor)).state).toBe("awaiting_approval");
      expect(f.store.commands.preparationClock(execution.id)?.elapsedMs).toBe(163);
    },
  );

  it("requires a receive-based offset even for an aligned Node arriving five milliseconds after send", () => {
    const f = setup();
    let wall = Date.now();
    let monotonic = 100;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const execution = f.request();
    const descriptor = f.prepared(execution);
    descriptor.prepared.preparedAt = new Date(wall + 5).toISOString();
    descriptor.prepared.hostClockOffsetMs = 0;
    wall += 163;
    monotonic += 163;
    expect(f.prepare(execution, rehash(descriptor))).toMatchObject({
      state: "failed",
      reasonCode: "preparation_clock_inconsistent",
      ownership: "not_started",
    });
  });

  it.each([-1, 164])(
    "rejects a mapped Node sample at %dms outside a 163ms measured interval",
    (mappedDelta) => {
      const f = setup();
      let wall = Date.now();
      let monotonic = 100;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const execution = f.request();
      const descriptor = f.prepared(execution);
      descriptor.prepared.preparedAt = new Date(wall + mappedDelta).toISOString();
      descriptor.prepared.hostClockOffsetMs = 0;
      wall += 163;
      monotonic += 163;
      expect(f.prepare(execution, rehash(descriptor))).toMatchObject({
        state: "failed",
        reasonCode: "preparation_clock_inconsistent",
      });
    },
  );

  it("rejects an offset outside the authenticated preparation interval", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    descriptor.prepared.hostClockOffsetMs += COMMAND_LIMITS.clockUncertaintyMs + 1;
    expect(f.prepare(execution, rehash(descriptor))).toMatchObject({
      state: "failed",
      reasonCode: "preparation_clock_inconsistent",
    });
  });

  it("fails missing original measurements instead of accepting a cached descriptor after Host restart", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    const restarted = new FleetService(f.store, log, "restarted");
    restarted.attachNode(f.node.id, f.service.nodeSocket(f.node.id)!);
    restarted.commands.nodeReady(f.node.id, {
      capabilities,
      commandExecution: readiness,
    });
    expect(
      restarted.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_prepared",
        executionId: execution.id,
        attemptId: execution.attemptId,
        ok: true,
        descriptor,
      }),
    ).toBe(true);
    expect(restarted.commands.get(execution.id)).toMatchObject({
      state: "failed",
      reasonCode: "preparation_clock_unverified",
      ownership: "not_started",
    });
    expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
  });

  it("does not renew the timestamp or preparation window after a Node reconnect", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    f.service.commands.nodeDisconnected(f.node.id);
    f.connect();
    f.service.commands.reconnect(f.node.id);
    expect(f.prepare(execution, descriptor)).toMatchObject({
      state: "failed",
      reasonCode: "preparation_connection_changed",
    });
    expect(f.store.commands.preparationClock(execution.id)?.hostTime).toBe(
      descriptor.hostTime,
    );
    expect(
      f.frames.filter((frame) => frame.type === "prepare_command_execution"),
    ).toHaveLength(1);
    expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
      false,
    );
  });

  it("sweeps an unanswered preparation after the bounded window without waiting for approval expiry", () => {
    const f = setup();
    let wall = Date.now();
    let monotonic = 100;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const execution = f.request();
    wall += 5_001;
    monotonic += 5_001;
    f.service.commands.tick();
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reasonCode: "preparation_rtt_exceeded",
    });
    expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
  });

  it("persists the accepted clock proof atomically with approval eligibility", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    const write = vi
      .spyOn(f.store.commands, "acceptPreparationClock")
      .mockImplementationOnce(() => {
        throw new Error("clock proof disk full");
      });
    expect(() => f.prepare(execution, descriptor)).toThrow("clock proof disk full");
    expect(f.service.commands.get(execution.id)?.state).toBe("preparing");
    expect(f.store.commands.preparationClock(execution.id)?.acceptedAt).toBeNull();
    write.mockRestore();
    expect(f.prepare(execution, descriptor).state).toBe("awaiting_approval");
  });

  it("rejects old approval metadata without a measured Host clock proof", () => {
    const f = setup();
    const execution = f.request();
    const awaiting = f.store.commands.update(execution.id, execution.version, {
      descriptor: f.prepared(execution),
      state: "awaiting_approval",
    });
    expect(f.approve(awaiting)).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reasonCode: "preparation_clock_unverified",
    });
    expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
      false,
    );
  });

  it("retains an already accepted clock proof and original expiry across Host restart", () => {
    const directory = resolve(".command-test-work", randomUUID());
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "host.db");
    const f = setup(path);
    const awaiting = f.prepare(f.request());
    const proof = f.store.commands.preparationClock(awaiting.id);
    const link = f.service.nodeSocket(f.node.id)!;
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const store = open(path);
    const restarted = new FleetService(store, log, "restarted");
    restarted.attachNode(f.node.id, link);
    restarted.commands.nodeReady(f.node.id, {
      capabilities,
      commandExecution: readiness,
    });
    expect(store.commands.preparationClock(awaiting.id)).toEqual(proof);
    const starting = restarted.commands.decide(
      awaiting.id,
      {
        decision: "allow_once",
        digest: awaiting.descriptor!.digest,
        expectedVersion: awaiting.version,
      },
      "admin",
    );
    expect(starting).toMatchObject({ state: "starting", expiresAt: awaiting.expiresAt });
    expect(
      f.frames.filter((frame) => frame.type === "prepare_command_execution"),
    ).toHaveLength(1);
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });
});

describe("durable command notifications", () => {
  it("creates a bounded approval destination without copying command, reason, or logs", () => {
    const f = setup();
    f.store.setDefaultNotificationLifecycleEnabled(false);
    const execution = f.prepare(
      f.request({ command: "private-script-value", reason: "private-reason-value" }),
    );
    f.service.commands.tick();
    const notifications = f.store.listNotifications().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceKey: `command_approval:${execution.id}`,
      kind: "command_approval",
      category: "permission",
      status: "active",
      readAt: null,
      subject: { type: "command_execution", id: execution.id },
      navigation: { type: "command_execution", executionId: execution.id },
    });
    expect(JSON.stringify(notifications)).not.toContain("private-script-value");
    expect(JSON.stringify(notifications)).not.toContain("private-reason-value");
    expect(f.service.snapshot().notificationUnreadCount).toBe(1);
    f.approve(execution);
    expect(f.store.getNotification(notifications[0]!.id)).toMatchObject({
      status: "resolved",
      readAt: expect.any(String),
      resolvedAt: expect.any(String),
    });
    expect(f.store.notificationUnreadCount()).toBe(0);
    expect(f.store.commands.notificationPhase(execution.id)).toBe("closed");
  });

  it.each(["deny", "cancel", "expire"] as const)(
    "resolves approval on %s and creates exactly one completion",
    (action) => {
      const f = setup();
      const execution = f.prepare(f.request());
      if (action === "cancel") f.service.commands.cancel(execution.id);
      else
        f.service.commands.decide(
          execution.id,
          {
            decision: action === "deny" ? "deny" : "allow_once",
            expectedVersion: execution.version,
            digest: execution.descriptor!.digest,
          },
          "admin",
          action === "expire" ? Date.parse(execution.expiresAt) : Date.now(),
        );
      f.service.commands.reconcileNotifications();
      f.service.commands.reconcileNotifications();
      const notifications = f.store.listNotifications().notifications;
      expect(notifications).toHaveLength(2);
      expect(
        notifications.find((entry) => entry.kind === "command_approval")?.status,
      ).toBe("resolved");
      expect(
        notifications.find((entry) => entry.kind === "command_completion"),
      ).toMatchObject({
        status: "active",
        navigation: { type: "command_execution", executionId: execution.id },
        data: { ownership: "not_started", outcomeKnown: false, exitCode: null },
      });
      expect(f.store.notificationUnreadCount()).toBe(1);
      expect(f.store.commands.notificationPhase(execution.id)).toBe("completion");
    },
  );

  it("does not resolve a human completion notification when the lead merely accepts its wake", () => {
    const f = setup();
    const execution = f.start();
    const receipt = f.receipt(execution, {
      state: "failed",
      exitCode: 7,
      reason: "private failure output",
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    const notification = f.store
      .listNotifications()
      .notifications.find((entry) => entry.kind === "command_completion")!;
    expect(notification).toMatchObject({
      severity: "error",
      status: "active",
      data: { exitCode: 7 },
    });
    expect(JSON.stringify(notification)).not.toContain("private failure output");
    const delivery = f.frames.find((frame) => frame.type === "deliver_lead_prompt")!;
    if (delivery.type !== "deliver_lead_prompt") throw new Error("Expected wake");
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: nativeReceipt({
          deliveryId: delivery.delivery.deliveryId,
          sessionId: f.lead.id,
          state: "accepted",
          at: new Date().toISOString(),
        }),
      }),
    ).toBe(true);
    expect(f.store.getNotification(notification.id)?.status).toBe("active");
    f.service.notifications.dismiss(notification.id);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    f.service.commands.reconcileNotifications();
    expect(f.store.getNotification(notification.id)?.status).toBe("dismissed");
    expect(
      f.store.listNotifications({ includeDismissed: true }).notifications,
    ).toHaveLength(2);
  });

  it("does not ACK a completion before notification persistence and repairs a retry without duplicating", () => {
    const f = setup();
    const execution = f.start();
    const receipt = f.receipt(execution);
    const published = vi.spyOn(f.service, "publishNotification");
    const write = vi
      .spyOn(f.store.commands, "recordNotificationPhase")
      .mockImplementationOnce(() => {
        throw new Error("notification disk full");
      });
    expect(() =>
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toThrow("notification disk full");
    expect(f.store.commands.get(execution.id)?.state).toBe("succeeded");
    expect(f.store.commands.notificationPhase(execution.id)).toBe("closed");
    expect(
      f.store
        .listNotifications()
        .notifications.some((entry) => entry.kind === "command_completion"),
    ).toBe(false);
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack"),
    ).toHaveLength(0);
    expect(
      published.mock.calls.some(
        ([notification]) => notification.kind === "command_completion",
      ),
    ).toBe(false);
    write.mockRestore();
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    expect(
      f.store
        .listNotifications()
        .notifications.filter((entry) => entry.kind === "command_completion"),
    ).toHaveLength(1);
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack"),
    ).toHaveLength(1);
    expect(
      published.mock.calls.filter(
        ([notification]) => notification.kind === "command_completion",
      ),
    ).toHaveLength(1);
  });

  it("recovers an approval notification after a crash between execution and notification persistence", () => {
    const directory = resolve(".command-test-work", randomUUID());
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "host.db");
    const f = setup(path);
    const execution = f.request();
    const sync = vi
      .spyOn(f.service.notifications, "syncCommandExecution")
      .mockImplementationOnce(() => {
        throw new Error("interrupted publication");
      });
    expect(() => f.prepare(execution)).toThrow("interrupted publication");
    expect(f.store.commands.get(execution.id)?.state).toBe("awaiting_approval");
    sync.mockRestore();
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const store = open(path);
    const service = new FleetService(store, log, "restarted");
    expect(
      service
        .snapshot()
        .notifications.filter((entry) => entry.kind === "command_approval"),
    ).toHaveLength(1);
    service.commands.reconcileNotifications();
    expect(store.notificationUnreadCount()).toBe(1);
  });

  it("protects actionable read approvals from pruning and does not resurrect retired completions", () => {
    const f = setup();
    const execution = f.prepare(f.request());
    const approval = f.store.listNotifications().notifications[0]!;
    f.service.notifications.markRead(approval.id);
    const future = Date.now() + COMMAND_LIMITS.retentionMs + 1_000;
    expect(f.store.pruneNotifications(future)).toBe(0);
    f.service.commands.cancel(execution.id);
    const completion = f.store
      .listNotifications()
      .notifications.find((entry) => entry.kind === "command_completion")!;
    f.service.notifications.markRead(completion.id);
    expect(f.store.pruneNotifications(future)).toBe(2);
    f.service.commands.reconcileNotifications();
    expect(f.store.listNotifications().notifications).toEqual([]);
    expect(f.store.commands.notificationPhase(execution.id)).toBe("completion");
  });

  it("reconciles approval notices after restore quarantines dispatch authority", () => {
    const f = setup();
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const execution = f.prepare(f.request());
    f.service.importHostBackup(backup);
    expect(f.store.commands.get(execution.id)?.state).toBe("expired");
    const notifications = f.service.snapshot().notifications;
    expect(
      notifications.some(
        (entry) => entry.kind === "command_approval" && entry.status === "active",
      ),
    ).toBe(false);
    expect(
      notifications.filter((entry) => entry.kind === "command_completion"),
    ).toHaveLength(1);
    f.service.commands.reconcileNotifications();
    expect(f.store.notificationUnreadCount()).toBe(1);
  });
});

describe("approved command arbitration and transport", () => {
  it("prepares first, hashes the exact canonical descriptor, and never starts without approval", () => {
    const f = setup();
    const execution = f.request({ command: "echo a\r\necho b" });
    expect(f.frames.map((frame) => frame.type)).toEqual(["prepare_command_execution"]);
    const awaiting = f.prepare(execution);
    f.service.commands.tick();
    expect(awaiting.state).toBe("awaiting_approval");
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(0);
    const started = f.approve(awaiting);
    expect(started.state).toBe("starting");
    expect(started.ownership).toBe("unknown");
    expect(started.exitCode).toBeNull();
    expect(f.store.commands.attempt(started.id)?.start_version).toBe(started.version);
    expect(() => f.approve(awaiting)).toThrow("approval_conflict");
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });

  it("rejects descriptor tampering, different authenticated Nodes, and digest/approval races", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    const frame = {
      type: "command_execution_prepared",
      executionId: execution.id,
      attemptId: execution.attemptId,
      ok: true,
      descriptor,
    };
    expect(f.service.commands.handleNodeMessage("foreign", frame)).toBe(false);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        ...frame,
        descriptor: { ...descriptor, command: "echo changed" },
      }),
    ).toBe(false);
    const changed = { ...descriptor, command: "echo changed" };
    const { digest: _digest, ...changedBody } = changed;
    changed.digest = createHash("sha256")
      .update(commandDigestPayload(changedBody))
      .digest("hex");
    expect(
      f.service.commands.handleNodeMessage(f.node.id, { ...frame, descriptor: changed }),
    ).toBe(false);
    const awaiting = f.prepare(execution);
    expect(() =>
      f.service.commands.decide(
        execution.id,
        {
          decision: "allow_once",
          expectedVersion: awaiting.version,
          digest: "0".repeat(64),
        },
        "admin",
      ),
    ).toThrow("approval_conflict");
    const denied = f.service.commands.decide(
      execution.id,
      {
        decision: "deny",
        expectedVersion: awaiting.version,
        digest: awaiting.descriptor!.digest,
      },
      "admin",
    );
    expect(denied).toMatchObject({
      state: "denied",
      ownership: "not_started",
      exitCode: null,
    });
    expect(() => f.approve(awaiting)).toThrow("approval_conflict");
  });

  it("expires approval and queued authority without renewing deadlines", () => {
    const f = setup();
    const awaiting = f.prepare(f.request());
    const expired = f.service.commands.decide(
      awaiting.id,
      {
        decision: "allow_once",
        expectedVersion: awaiting.version,
        digest: awaiting.descriptor!.digest,
      },
      "admin",
      Date.parse(awaiting.expiresAt),
    );
    expect(expired.state).toBe("expired");
    f.start();
    const queued = f.approve(f.prepare(f.request()));
    expect(queued.state).toBe("queued");
    f.service.commands.tick(Date.parse(queued.expiresAt));
    expect(f.service.commands.get(queued.id)?.state).toBe("expired");
  });

  it("retains request-key identity across retries, changed bodies, and expired keys", () => {
    const f = setup();
    const execution = f.request({ requestKey: "same" });
    expect(f.request({ requestKey: "same" }).id).toBe(execution.id);
    expect(() => f.request({ requestKey: "same", command: "changed" })).toThrow(
      "request_key_conflict",
    );
    expect(() =>
      f.service.commands.request(
        f.lead.id,
        {
          target: execution.target,
          command: execution.command,
          shell: execution.shell,
          reason: execution.reason,
          requestKey: "same",
        },
        Date.parse(execution.createdAt) + COMMAND_LIMITS.retryMs,
      ),
    ).toThrow("request_expired");
    expect(f.frames).toHaveLength(1);
  });

  it("requires original capabilities, a sealed link, and independent durable lead support", () => {
    const f = setup();
    expect(
      f.connect(f.node.id, [...capabilities, COMMAND_PERMISSIONS_CAPABILITY], false),
    ).toEqual({
      commandExecutions: false,
      commandPermissions: false,
      durableLeadDelivery: false,
    });
    expect(() => f.request()).toThrow("durable_lead_delivery_required");
    f.connect(f.node.id, [DURABLE_LEAD_DELIVERY_CAPABILITY]);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_inventory",
        readiness,
        executions: [],
      }),
    ).toBe(true);
    expect(() => f.request()).toThrow("requires an opted-in");
    f.service.commands.nodeReady(f.node.id, {
      capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_inventory",
        readiness,
        executions: [],
      }),
    ).toBe(false);
    f.connect(f.node.id, [COMMAND_EXECUTION_CAPABILITY]);
    expect(() => f.request()).toThrow("durable_lead_delivery_required");
  });

  it("keeps sealed recovery available after opt-out without permitting another prepare or start", () => {
    const f = setup();
    const running = f.start();
    const queued = f.approve(f.prepare(f.request()));
    expect(queued.state).toBe("queued");
    f.service.commands.nodeDisconnected(f.node.id);
    f.service.commands.cancel(running.id);
    const disabled = {
      enabled: false,
      supported: false,
      reason: "Local opt-out; replaying durable evidence",
      shells: [],
      admissionVersion: 1,
    };
    f.connect(f.node.id, [DURABLE_LEAD_DELIVERY_CAPABILITY]);
    expect(
      f.service.commands.nodeReady(f.node.id, {
        capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
        commandExecution: disabled,
      }),
    ).toEqual({
      commandExecutions: true,
      commandPermissions: false,
      durableLeadDelivery: true,
    });
    f.service.commands.reconnect(f.node.id);
    expect(f.frames.some((frame) => frame.type === "reconcile_command_executions")).toBe(
      true,
    );
    expect(
      f.frames.some(
        (frame) =>
          frame.type === "cancel_command_execution" && frame.executionId === running.id,
      ),
    ).toBe(true);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_inventory",
        readiness: disabled,
        executions: [
          f.receipt(running, {
            state: "cancelled",
            ownership: "quiescent",
            exitCode: null,
            outcomeKnown: false,
            finalOutputSeq: 1,
          }),
        ],
      }),
    ).toBe(true);
    expect(f.service.commands.get(running.id)).toMatchObject({
      state: "cancelled",
      outputComplete: false,
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_output",
        event: {
          executionId: running.id,
          attemptId: running.attemptId,
          sequence: 1,
          stream: "stdout",
          data: Buffer.from("retained output").toString("base64"),
          at: running.createdAt,
        },
      }),
    ).toBe(true);
    expect(f.service.commands.get(running.id)?.outputComplete).toBe(true);
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack").at(-1),
    ).toMatchObject({
      executionId: running.id,
      terminal: true,
      throughSeq: 1,
    });
    expect(f.service.commands.get(queued.id)).toMatchObject({
      state: "failed",
      ownership: "not_started",
    });
    expect(() => f.request()).toThrow("Local opt-out");
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
    expect(
      f.frames.filter((frame) => frame.type === "prepare_command_execution"),
    ).toHaveLength(2);
  });

  it("does not inherit recovery negotiation when a replacement link has not sent ready", () => {
    const f = setup();
    const first = f.service.nodeSocket(f.node.id)!;
    const replacement = new SealedNodeLink(
      {
        OPEN: 1,
        readyState: 1,
        send() {},
        close() {},
      },
      { seal: (data: string) => JSON.parse(data) } as unknown as AuthenticatedChannel,
    );
    expect(replacement).not.toBe(first);
    f.service.attachNode(f.node.id, replacement);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_inventory",
        readiness,
        executions: [],
      }),
    ).toBe(false);
    expect(() => f.request()).toThrow("durable_lead_delivery_required");
  });

  it("checks live owner and task ownership on every request/read/cancel", () => {
    const f = setup();
    const other = f.store.createSession(f.placement, "other", false, "other", {
      runRole: "lead",
    });
    f.store.transitionSession(other.id, "starting");
    f.store.transitionSession(other.id, "idle");
    const execution = f.request();
    expect(() =>
      f.service.commands.read(other.id, { executionId: execution.id }),
    ).toThrow("execution_not_found");
    expect(() => f.service.commands.cancel(execution.id, other.id)).toThrow(
      "execution_not_found",
    );
    const run = f.store.createRun({
      workspaceId: f.workspace.id,
      name: "other task",
      objective: "done",
    });
    f.store.updateRun(run.id, { leadSessionId: other.id });
    expect(() => f.request({ taskId: run.id })).toThrow("task_owner_conflict");
    f.store.setSessionControls(f.lead.id, { stopRequested: true });
    expect(() => f.request()).toThrow("lead_not_live");
    expect(() =>
      f.service.commands.read(f.lead.id, { executionId: execution.id }),
    ).toThrow("lead_not_live");
  });

  it("bounds admission and command UTF-8 size", () => {
    const f = setup();
    expect(() => f.request({ command: "😀".repeat(5000) })).toThrow();
    for (let i = 0; i < COMMAND_LIMITS.maxLeadPending; i++) f.request();
    expect(() => f.request()).toThrow("admission_limit");
  });

  it("cancels before start durably and never rewrites proven completion", () => {
    const f = setup();
    const awaiting = f.prepare(f.request());
    const cancelled = f.service.commands.cancel(awaiting.id);
    expect(cancelled).toMatchObject({
      state: "cancelled",
      exitCode: null,
      ownership: "not_started",
    });
    expect(f.store.commands.attempt(awaiting.id)?.cancelled).toBe(1);
    expect(() => f.approve(awaiting)).toThrow("approval_conflict");
    const running = f.start();
    expect(f.service.commands.cancel(running.id)).toMatchObject({
      state: "cancelling",
      ownership: "unknown",
    });
    expect(f.result(running)).toBe(true);
    expect(f.service.commands.cancel(running.id).state).toBe("succeeded");
  });

  it.each(["cancelled", "expired", "failed"] as const)(
    "accepts authenticated Node-local %s before Host approval without inventing start authority",
    (state) => {
      const f = setup();
      const awaiting = f.prepare(f.request());
      expect(f.store.commands.attempt(awaiting.id)).toBeUndefined();
      expect(awaiting.approvedAt).toBeUndefined();
      expect(awaiting.cancelRequested).toBe(false);
      f.service.commands.nodeReady(f.node.id, {
        capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
        commandExecution: {
          enabled: false,
          supported: false,
          reason: "Local opt-out or shutdown",
          shells: [],
          admissionVersion: 1,
        },
      });
      const receipt = f.receipt(awaiting, {
        state,
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
        reason: "Node locally revoked prepared work",
        finalOutputSeq: 0,
      });
      expect(
        f.service.commands.handleNodeMessage(f.node.id, {
          type: "command_execution_update",
          receipt,
        }),
      ).toBe(true);
      const settled = f.service.commands.get(awaiting.id)!;
      expect(settled).toMatchObject({
        state,
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
        outputComplete: true,
        finalOutputSeq: 0,
        cancelRequested: false,
      });
      expect(settled.version).toBeGreaterThan(awaiting.version);
      expect(settled.approvedAt).toBeUndefined();
      expect(f.store.commands.attempt(awaiting.id)).toMatchObject({
        start_version: null,
        cancelled: 1,
      });
      expect(
        f.frames.filter((frame) => frame.type === "command_execution_ack").at(-1),
      ).toMatchObject({
        executionId: awaiting.id,
        terminal: true,
        throughSeq: 0,
      });
      expect(
        f.service.commands.handleNodeMessage(f.node.id, {
          type: "command_execution_update",
          receipt,
        }),
      ).toBe(true);
      expect(f.service.commands.get(awaiting.id)?.version).toBe(settled.version);
      expect(f.frames.some((frame) => frame.type === "start_command_execution")).toBe(
        false,
      );
      expect(() => f.approve(awaiting)).toThrow("approval_conflict");
      expect(
        f.store
          .listNotifications()
          .notifications.find((notification) => notification.kind === "command_approval")
          ?.status,
      ).toBe("resolved");
    },
  );

  it("never accepts execution or output evidence under an unapproved prepared identity", () => {
    const f = setup();
    const awaiting = f.prepare(f.request());
    expect(f.result(awaiting)).toBe(false);
    expect(
      f.result(awaiting, {
        state: "failed",
        ownership: "quiescent",
        exitCode: 7,
        outcomeKnown: true,
      }),
    ).toBe(false);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt: f.receipt(awaiting, {
          state: "running",
          ownership: "active",
          exitCode: null,
          outcomeKnown: false,
          startedAt: new Date().toISOString(),
          settledAt: undefined,
          finalOutputSeq: undefined,
        }),
      }),
    ).toBe(false);
    const output = {
      executionId: awaiting.id,
      attemptId: awaiting.attemptId,
      sequence: 1,
      stream: "stdout",
      data: "YQ==",
      at: awaiting.createdAt,
    };
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_output",
        event: output,
      }),
    ).toBe(false);
    for (const patch of [
      { outcomeKnown: true },
      { exitCode: 1 },
      { descendantCleanupForced: true },
      { finalOutputSeq: 1 },
      { gaps: [{ from: 1, to: 1 }] },
      { startedAt: new Date().toISOString() },
      { digest: "0".repeat(64) },
      { attemptId: randomUUID() },
    ]) {
      expect(
        f.result(awaiting, {
          state: "cancelled",
          ownership: "not_started",
          exitCode: null,
          outcomeKnown: false,
          ...patch,
        }),
      ).toBe(false);
    }
    expect(f.service.commands.get(awaiting.id)?.state).toBe("awaiting_approval");
    expect(f.frames.some((frame) => frame.type === "command_execution_ack")).toBe(false);
  });

  it("accepts local cancellation of approved-but-undispatched queued work", () => {
    const f = setup();
    f.start();
    const queued = f.approve(f.prepare(f.request()));
    expect(queued.state).toBe("queued");
    expect(f.store.commands.attempt(queued.id)).toBeUndefined();
    expect(
      f.result(queued, {
        state: "cancelled",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
        reason: "Node opted out before dispatch",
      }),
    ).toBe(true);
    expect(f.service.commands.get(queued.id)).toMatchObject({
      state: "cancelled",
      ownership: "not_started",
      approvedBy: "administrator",
    });
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
  });

  it("persists a local no-start refusal before ACK and rolls back failed writes", () => {
    const f = setup();
    const awaiting = f.prepare(f.request());
    const receipt = f.receipt(awaiting, {
      state: "cancelled",
      ownership: "not_started",
      exitCode: null,
      outcomeKnown: false,
    });
    const write = vi
      .spyOn(f.store.commands, "recordReceipt")
      .mockImplementationOnce(() => {
        throw new Error("no-start persistence failed");
      });
    expect(() =>
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toThrow("no-start persistence failed");
    expect(f.service.commands.get(awaiting.id)?.state).toBe("awaiting_approval");
    expect(f.store.commands.attempt(awaiting.id)).toBeUndefined();
    expect(f.frames.some((frame) => frame.type === "command_execution_ack")).toBe(false);
    write.mockRestore();
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack"),
    ).toHaveLength(1);
  });

  it("clears provisional startedAt when the supervisor proves no release occurred", () => {
    const f = setup();
    const execution = f.start();
    const provisional = f.receipt(execution, {
      state: "running",
      ownership: "active",
      exitCode: null,
      outcomeKnown: false,
      startedAt: new Date().toISOString(),
      settledAt: undefined,
      finalOutputSeq: undefined,
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt: provisional,
      }),
    ).toBe(true);
    const before = f.service.commands.get(execution.id)!;
    expect(before.startedAt).toEqual(provisional.startedAt);
    expect(
      f.result(execution, {
        state: "failed",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
        reason: "Supervisor proved the root was never released",
      }),
    ).toBe(true);
    const after = f.service.commands.get(execution.id)!;
    expect(after).toMatchObject({
      state: "failed",
      ownership: "not_started",
      exitCode: null,
    });
    expect(after).not.toHaveProperty("startedAt");
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("preserves exact unsigned Windows exit evidence without coercing it to success", () => {
    const f = setup();
    const execution = f.start();
    expect(f.result(execution, { state: "failed", exitCode: 4_294_967_295 })).toBe(true);
    expect(
      f.service.commands.read(f.lead.id, { executionId: execution.id }).execution,
    ).toMatchObject({
      state: "failed",
      ownership: "quiescent",
      outcomeKnown: true,
      exitCode: 4_294_967_295,
    });
  });

  it("reconciles prepared inventory and cancellation racing a late preparation without granting start", () => {
    const f = setup();
    const execution = f.request();
    const descriptor = f.prepared(execution);
    f.service.commands.cancel(execution.id);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_inventory",
        readiness,
        executions: [
          {
            executionId: execution.id,
            attemptId: execution.attemptId,
            digest: descriptor.digest,
            state: "awaiting_approval",
            ownership: "not_started",
            exitCode: null,
            reason: "",
          },
        ],
      }),
    ).toBe(true);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_prepared",
        executionId: execution.id,
        attemptId: execution.attemptId,
        ok: true,
        descriptor,
      }),
    ).toBe(true);
    const current = f.service.commands.get(execution.id)!;
    expect(
      f.result(current, {
        state: "cancelled",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
      }),
    ).toBe(true);
    expect(f.service.commands.get(execution.id)?.state).toBe("cancelled");
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(0);
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack").at(-1),
    ).toMatchObject({ terminal: true, throughSeq: 0 });
  });

  it("keeps lost starts/ACKs unresolved across reconnect and accepts only matching receipts", () => {
    const f = setup();
    const execution = f.start();
    f.service.commands.nodeDisconnected(f.node.id);
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "reconciliation_required",
      ownership: "unknown",
      exitCode: null,
    });
    f.connect();
    f.service.commands.reconnect(f.node.id);
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(1);
    expect(f.frames.some((frame) => frame.type === "reconcile_command_executions")).toBe(
      true,
    );
    expect(f.result(execution, { attemptId: randomUUID() })).toBe(false);
    expect(f.result(execution, { digest: "0".repeat(64) })).toBe(false);
    const receipt = f.receipt(execution);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    const version = f.service.commands.get(execution.id)!.version;
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    expect(f.service.commands.get(execution.id)!.version).toBe(version);
    expect(f.frames.filter((frame) => frame.type === "deliver_lead_prompt")).toHaveLength(
      1,
    );
  });

  it.each([
    { state: "succeeded", exitCode: null },
    { state: "succeeded", ownership: "unknown" },
    { state: "succeeded", descendantCleanupForced: true },
    { state: "succeeded", outcomeKnown: false },
    { state: "interrupted", ownership: "active" },
    { state: "failed", exitCode: 0 },
    { state: "running", settledAt: new Date().toISOString() },
  ] as Partial<CommandReceipt>[])(
    "refuses success-shaped or contradictory receipt %j",
    (patch) => {
      const f = setup();
      const execution = f.start();
      expect(f.result(execution, patch)).toBe(false);
      expect(f.service.commands.get(execution.id)?.state).toBe("starting");
      expect(
        f.frames.filter((frame) => frame.type === "command_execution_ack"),
      ).toHaveLength(0);
    },
  );

  it("distinguishes interrupted quiescent outcome from unknown process ownership", () => {
    const f = setup();
    const execution = f.start();
    expect(
      f.result(execution, {
        state: "interrupted",
        ownership: "quiescent",
        exitCode: null,
        outcomeKnown: false,
        reason: "parent_lost",
      }),
    ).toBe(true);
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "interrupted",
      ownership: "quiescent",
      outcomeKnown: false,
      exitCode: null,
    });
  });
});

describe("durable command output", () => {
  function output(
    f: ReturnType<typeof setup>,
    execution: CommandExecution,
    sequence: number,
    data = Buffer.from(`chunk${sequence}`).toString("base64"),
  ) {
    return {
      type: "command_execution_output",
      event: {
        executionId: execution.id,
        attemptId: execution.attemptId,
        sequence,
        stream: "stdout",
        data,
        at: execution.createdAt,
      },
    };
  }
  it("preserves raw bytes, deduplicates replay, and waits for the final output watermark", () => {
    const f = setup();
    const execution = f.start();
    const event = output(
      f,
      execution,
      2,
      Buffer.from([0xff, 0x00, 0xc3]).toString("base64"),
    );
    expect(f.service.commands.handleNodeMessage(f.node.id, event)).toBe(true);
    expect(f.service.commands.handleNodeMessage(f.node.id, event)).toBe(true);
    expect(() =>
      f.service.commands.handleNodeMessage(f.node.id, {
        ...event,
        event: { ...event.event, data: "eA==" },
      }),
    ).toThrow("output_identity_conflict");
    expect(f.result(execution, { finalOutputSeq: 3, gaps: [{ from: 3, to: 3 }] })).toBe(
      true,
    );
    expect(f.service.commands.get(execution.id)?.outputComplete).toBe(false);
    expect(f.service.commands.handleNodeMessage(f.node.id, output(f, execution, 1))).toBe(
      true,
    );
    expect(f.service.commands.get(execution.id)?.outputComplete).toBe(true);
    const page = f.service.commands.read(f.lead.id, {
      executionId: execution.id,
      format: "raw",
    });
    expect(page.events).toHaveLength(2);
    expect(page.events[1]!.data).toBe(event.event.data);
    expect(page.nextSeq).toBe(3);
    expect(page.outputComplete).toBe(true);
    const text = new FleetTools(f.service, f.lead.id).getExecution({
      executionId: execution.id,
    });
    expect(JSON.parse(text.text).decodingLoss).toBe(true);
    expect(() =>
      f.service.commands.handleNodeMessage(f.node.id, output(f, execution, 4)),
    ).toThrow("output_after_final_watermark");
  });

  it("retains lifecycle ACK only after durable storage succeeds", () => {
    const f = setup();
    const execution = f.start();
    vi.spyOn(f.store.commands, "recordReceipt").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => f.result(execution)).toThrow("disk full");
    expect(f.service.commands.get(execution.id)?.state).toBe("starting");
    expect(
      f.frames.filter((frame) => frame.type === "command_execution_ack"),
    ).toHaveLength(0);
  });

  it("uses explicit quota gaps and never treats a dropped tail as missing lifecycle evidence", () => {
    const f = setup();
    const execution = f.start();
    f.store.commands.update(execution.id, execution.version, {
      outputBytes: COMMAND_LIMITS.outputBytes,
    });
    expect(f.service.commands.handleNodeMessage(f.node.id, output(f, execution, 1))).toBe(
      true,
    );
    expect(f.result(execution, { finalOutputSeq: 1 })).toBe(true);
    expect(f.service.commands.get(execution.id)).toMatchObject({
      outputComplete: true,
      gaps: [{ from: 1, to: 1 }],
    });
    expect(
      f.service.commands.read(f.lead.id, { executionId: execution.id }).events,
    ).toEqual([]);
  });

  it("bounds raw pages and malformed oversized chunks", () => {
    const f = setup();
    const execution = f.start();
    expect(
      f.service.commands.handleNodeMessage(f.node.id, output(f, execution, 1, "???")),
    ).toBe(false);
    const chunk = Buffer.alloc(COMMAND_LIMITS.chunkBytes, 42).toString("base64");
    expect(
      f.service.commands.handleNodeMessage(f.node.id, output(f, execution, 1, chunk)),
    ).toBe(true);
    expect(() =>
      f.service.commands.read(f.lead.id, { executionId: execution.id, limitBytes: 100 }),
    ).toThrow("requires");
    expect(
      f.service.commands.read(f.lead.id, {
        executionId: execution.id,
        limitBytes: COMMAND_LIMITS.pageBytes,
      }).events,
    ).toHaveLength(1);
  });

  it("allows replay-horizon gap refinement without another completion prompt", () => {
    const f = setup();
    const execution = f.start();
    const receipt = f.receipt(execution, { finalOutputSeq: 5 });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt,
      }),
    ).toBe(true);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt: { ...receipt, gaps: [{ from: 1, to: 5 }] },
      }),
    ).toBe(true);
    expect(f.service.commands.get(execution.id)?.outputComplete).toBe(true);
    expect(f.frames.filter((frame) => frame.type === "deliver_lead_prompt")).toHaveLength(
      1,
    );
  });
});

describe("lead reservations survive ticks and restart", () => {
  it("requires complete native identities and refuses handoff changes before releasing a reservation", () => {
    const f = setup();
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "Native-bound turn",
      attachments: [],
    });
    const record = f.store.commands.reserved(f.lead.id)!;
    const basic = {
      deliveryId: record.delivery.deliveryId,
      sessionId: f.lead.id,
      state: "accepted" as const,
      at: new Date().toISOString(),
    };
    const receive = (receipt: unknown) =>
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt,
      });
    expect(receive(basic)).toBe(false);
    expect(receive({ ...basic, nativeSessionId: "native-only" })).toBe(false);
    const accepted = nativeReceipt({
      ...basic,
      nativeSessionId: "conversation-a",
      attemptId: randomUUID(),
    });
    expect(receive(accepted)).toBe(true);
    expect(receive({ ...accepted, state: "uncertain" })).toBe(true);
    expect(receive({ ...accepted, state: "settled", attemptId: randomUUID() })).toBe(
      false,
    );
    expect(
      receive({ ...accepted, state: "settled", nativeSessionId: "conversation-b" }),
    ).toBe(false);
    expect(receive({ ...accepted, state: "rejected_busy" })).toBe(false);
    expect(f.store.commands.reserved(f.lead.id)?.state).toBe("uncertain");
    expect(receive({ ...accepted, state: "settled" })).toBe(true);
    expect(f.store.commands.reserved(f.lead.id)).toBeUndefined();
    expect(f.store.commands.prompt(record.delivery.deliveryId)?.receipt).toMatchObject({
      nativeSessionId: "conversation-a",
      attemptId: accepted.attemptId,
      state: "settled",
    });
  });

  it("allows a new native attempt only after a safe busy retry", () => {
    const f = setup();
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "Busy turn",
      attachments: [],
    });
    const record = f.store.commands.reserved(f.lead.id)!;
    const busy = nativeReceipt({
      deliveryId: record.delivery.deliveryId,
      sessionId: f.lead.id,
      state: "rejected_busy",
      at: new Date().toISOString(),
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: busy,
      }),
    ).toBe(true);
    f.service.commands.tick();
    const replacement = { ...busy, state: "accepted" as const, attemptId: randomUUID() };
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: replacement,
      }),
    ).toBe(false);
    for (const state of ["uncertain", "settled"] as const)
      expect(
        f.service.commands.handleNodeMessage(f.node.id, {
          type: "lead_prompt_receipt",
          receipt: { ...replacement, state },
        }),
      ).toBe(false);
    f.store.appendEvent({
      eventId: randomUUID(),
      sessionId: f.lead.id,
      sequence: 1,
      type: "state",
      payload: { state: "idle" },
      createdAt: new Date().toISOString(),
    });
    f.service.commands.tick();
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: replacement,
      }),
    ).toBe(true);
    expect(f.store.commands.reserved(f.lead.id)?.receipt?.attemptId).toBe(
      replacement.attemptId,
    );
  });

  it("preserves normal lead attachments through acceptance and uncertainty, then retires their bytes on settlement", () => {
    const f = setup();
    const attachments = [
      {
        name: "evidence.txt",
        mimeType: "text/plain",
        data: Buffer.from("exact attachment bytes").toString("base64"),
      },
    ];
    expect(
      f.service.dispatch(f.node.id, {
        type: "prompt",
        sessionId: f.lead.id,
        prompt: "Read the attachment",
        attachments,
      }).sent,
    ).toBe(true);
    const frame = f.frames.find((entry) => entry.type === "deliver_lead_prompt")!;
    if (frame.type !== "deliver_lead_prompt") throw new Error("Missing delivery");
    expect(frame.delivery.attachments).toEqual(attachments);
    const receipt = nativeReceipt({
      deliveryId: frame.delivery.deliveryId,
      sessionId: f.lead.id,
      state: "accepted",
      at: new Date().toISOString(),
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt,
      }),
    ).toBe(true);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: { ...receipt, state: "uncertain" },
      }),
    ).toBe(true);
    expect(
      f.store.commands.prompt(frame.delivery.deliveryId)?.delivery.attachments,
    ).toEqual(attachments);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: { ...receipt, state: "settled" },
      }),
    ).toBe(true);
    const retired = f.store.commands.prompt(frame.delivery.deliveryId)!;
    expect(retired.delivery.attachments).toBeUndefined();
    expect(retired.receipt).toMatchObject({
      attemptId: receipt.attemptId,
      nativeSessionId: receipt.nativeSessionId,
    });
    expect(retired.delivery.deliveryId).toBe(frame.delivery.deliveryId);
  });

  it("preserves a 100,000-character non-ASCII human prompt with the full ten-MiB attachment allowance", () => {
    const f = setup();
    const data = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x62).toString("base64");
    const input = PromptSchema.parse({
      prompt: "\u754c".repeat(100_000),
      attachments: [{ name: "full.bin", mimeType: "application/octet-stream", data }],
    });
    expect(input.prompt.length).toBe(100_000);
    expect(Buffer.byteLength(input.prompt, "utf8")).toBe(300_000);
    expect(
      f.service.dispatch(f.node.id, {
        type: "prompt",
        sessionId: f.lead.id,
        ...input,
      }).sent,
    ).toBe(true);
    const sent = f.frames.find((frame) => frame.type === "deliver_lead_prompt");
    if (sent?.type !== "deliver_lead_prompt")
      throw new Error("Expected durable human delivery");
    expect(sent.delivery.prompt).toBe(input.prompt);
    expect(f.store.commands.reserved(f.lead.id)?.delivery.prompt).toBe(input.prompt);
    expect(f.store.commands.reserved(f.lead.id)?.delivery.attachments?.[0]?.data).toBe(
      data,
    );
    expect(
      f.store.commands.exportBackup().prompts[0]?.delivery.attachments?.[0]?.data,
    ).toBe(data);
    expect(() => f.request()).not.toThrow();
    f.service.commands.revokeLead(f.lead.id);
    expect(f.store.commands.prompts(f.lead.id)).toEqual([]);
    expect(
      f.store.commands.prompt(sent.delivery.deliveryId)?.delivery.attachments,
    ).toBeUndefined();
    expect(f.store.commands.prompt(sent.delivery.deliveryId)?.delivery.prompt).not.toBe(
      input.prompt,
    );
  });

  it("checks decoded attachment bounds and complete serialized queue size before persistence", () => {
    const f = setup();
    const dispatch = (data: string) =>
      f.service.dispatch(f.node.id, {
        type: "prompt",
        sessionId: f.lead.id,
        prompt: "Inspect",
        attachments: [{ name: "large.bin", mimeType: "application/octet-stream", data }],
      });
    expect(() =>
      dispatch(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")),
    ).toThrow("10 MiB");
    expect(() => dispatch('"'.repeat(9 * 1024 * 1024))).toThrow("lead_prompt_too_large");
    expect(f.store.commands.prompts(f.lead.id)).toEqual([]);
    expect(f.frames.filter((entry) => entry.type === "deliver_lead_prompt")).toEqual([]);
  });

  it("persists native handoff continuity and attachment bytes across an ordinary Host restart", () => {
    const directory = resolve(".command-test-work", randomUUID());
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "host.db");
    const f = setup(path);
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "Persist native evidence",
      attachments: [{ name: "proof.txt", mimeType: "text/plain", data: "cHJvb2Y=" }],
    });
    const record = f.store.commands.reserved(f.lead.id)!;
    const receipt = nativeReceipt({
      deliveryId: record.delivery.deliveryId,
      sessionId: f.lead.id,
      state: "accepted",
      at: new Date().toISOString(),
      attemptId: randomUUID(),
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt,
      }),
    ).toBe(true);
    const link = f.service.nodeSocket(f.node.id)!;
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const store = open(path);
    const service = new FleetService(store, log);
    service.attachNode(f.node.id, link);
    service.commands.nodeReady(f.node.id, { capabilities, commandExecution: readiness });
    expect(store.commands.reserved(f.lead.id)).toMatchObject({
      state: "uncertain",
      receipt: { nativeSessionId: receipt.nativeSessionId, attemptId: receipt.attemptId },
      delivery: { attachments: [{ data: "cHJvb2Y=" }] },
    });
    expect(
      service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: { ...receipt, state: "settled", attemptId: randomUUID() },
      }),
    ).toBe(false);
    expect(
      service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: { ...receipt, state: "settled" },
      }),
    ).toBe(true);
    expect(
      store.commands.prompt(receipt.deliveryId)?.delivery.attachments,
    ).toBeUndefined();
  });

  it("durably queues competing ordinary task briefs instead of dropping the second across ticks", () => {
    const f = setup();
    const runs = ["first", "second"].map((name) => {
      const run = f.store.createRun({
        workspaceId: f.workspace.id,
        name,
        objective: name,
      });
      return f.store.updateRun(run.id, {
        state: "awaiting_lead",
        leadSessionId: f.lead.id,
        pendingPrompt: `${name} brief`,
      })!;
    });
    const engine = new OrchestratorEngine(f.service);
    engine.tick();
    engine.tick();
    engine.tick();
    const deliveries = f.frames.filter((frame) => frame.type === "deliver_lead_prompt");
    expect(deliveries).toHaveLength(1);
    expect(f.store.commands.prompts(f.lead.id)).toHaveLength(2);
    expect(runs.map((run) => f.store.getRun(run.id)?.pendingPrompt)).toEqual(["", ""]);
    const delivery = deliveries[0]!;
    if (delivery.type !== "deliver_lead_prompt") throw new Error();
    f.service.commands.handleNodeMessage(f.node.id, {
      type: "lead_prompt_receipt",
      receipt: nativeReceipt({
        deliveryId: delivery.delivery.deliveryId,
        sessionId: f.lead.id,
        state: "settled",
        at: new Date().toISOString(),
      }),
    });
    engine.tick();
    expect(f.frames.filter((frame) => frame.type === "deliver_lead_prompt")).toHaveLength(
      2,
    );
  });

  it("serializes standalone completion with human prompts, accepts != settles, and retries busy only after an idle transition", () => {
    const f = setup();
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "Human first",
      attachments: [],
    });
    const execution = f.start();
    f.result(execution);
    const engine = new OrchestratorEngine(f.service);
    engine.tick();
    engine.tick(Date.now() + 30_000);
    const deliveries = () =>
      f.frames.filter((frame) => frame.type === "deliver_lead_prompt");
    expect(deliveries()).toHaveLength(1);
    const human = deliveries()[0]!;
    if (human.type !== "deliver_lead_prompt") throw new Error();
    const receipt = (
      state: "accepted" | "settled" | "rejected_busy" | "uncertain",
      id = human.delivery.deliveryId,
    ) =>
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: nativeReceipt({
          deliveryId: id,
          sessionId: f.lead.id,
          state,
          at: new Date().toISOString(),
        }),
      });
    expect(receipt("accepted")).toBe(true);
    engine.tick();
    expect(deliveries()).toHaveLength(1);
    expect(receipt("settled")).toBe(true);
    engine.tick();
    expect(deliveries()).toHaveLength(2);
    const completion = deliveries()[1]!;
    if (completion.type !== "deliver_lead_prompt") throw new Error();
    expect(receipt("rejected_busy", completion.delivery.deliveryId)).toBe(true);
    engine.tick();
    engine.tick(Date.now() + 300_000);
    expect(deliveries()).toHaveLength(2);
    f.store.appendEvent({
      eventId: randomUUID(),
      sessionId: f.lead.id,
      sequence: 1,
      type: "state",
      payload: { state: "idle" },
      createdAt: new Date().toISOString(),
    });
    engine.tick();
    expect(deliveries()).toHaveLength(3);
    expect((deliveries()[2] as typeof completion).delivery.deliveryId).toBe(
      completion.delivery.deliveryId,
    );
    receipt("uncertain", completion.delivery.deliveryId);
    engine.tick(Date.now() + 86_400_000);
    expect(deliveries()).toHaveLength(3);
    expect(f.service.commands.get(execution.id)?.delivery).toBe("uncertain");
    expect(f.store.listRuns()).toEqual([]);
  });

  it("delivers to a different durable Node rather than to the execution Node", () => {
    const f = setup();
    const remote = f.store.registerNode({
      name: "remote",
      os: "linux",
      arch: "x64",
      version: "test",
      capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
      maxSessions: 3,
    }).node;
    const placement = f.store.createPlacement(
      f.workspace.id,
      remote.id,
      "C:\\coordinator",
    );
    const lead = f.store.createSession(placement, "lead", false, "remote lead", {
      runRole: "lead",
    });
    f.store.transitionSession(lead.id, "starting");
    f.store.transitionSession(lead.id, "idle");
    f.connect(remote.id, [DURABLE_LEAD_DELIVERY_CAPABILITY]);
    const execution = f.service.commands.request(lead.id, {
      target: { placementId: f.placement.id },
      command: "echo test",
      shell: "windows-powershell-5.1",
      requestKey: "remote",
      reason: "test",
    });
    const started = f.approve(f.prepare(execution));
    expect(f.result(started)).toBe(true);
    const delivery = f.frames.find((frame) => frame.type === "deliver_lead_prompt");
    expect(delivery).toMatchObject({
      delivery: { sessionId: lead.id },
    });
    expect(delivery!.delivery.prompt).toContain(
      `<fleet-command-result executionId="${execution.id}"`,
    );
    expect(delivery!.delivery.prompt.endsWith("</fleet-command-result>")).toBe(true);
    expect(parseFleetControl(delivery!.delivery.prompt)).toEqual({
      title: "Command succeeded",
      detail: `${started.nodeName} · ${execution.id.slice(0, 8)}`,
    });
  });

  it("persists attempts, output, cancel intent, and uncertain prompt reservations over real SQLite reopen", () => {
    const directory = resolve(".command-test-work", randomUUID());
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "host.db");
    const f = setup(path);
    const execution = f.start();
    f.service.commands.cancel(execution.id);
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "persist",
      attachments: [],
    });
    const deliveryId = f.store.commands.reserved(f.lead.id)!.delivery.deliveryId;
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const store = open(path);
    expect(store.commands.get(execution.id)).toMatchObject({
      state: "reconciliation_required",
      ownership: "unknown",
      cancelRequested: true,
    });
    expect(store.commands.attempt(execution.id)?.cancelled).toBe(1);
    expect(store.commands.reserved(f.lead.id)).toMatchObject({
      state: "uncertain",
      delivery: { deliveryId },
    });
    expect(() => store.deleteSession(f.lead.id)).toThrow();
    store.commands.quarantine(true);
    expect(() =>
      store.commands.request(
        f.lead.id,
        execution.requestKey,
        execution.requestDigest,
        Date.now(),
      ),
    ).toThrow("request_expired");
  });

  it("exports unresolved evidence but blocks restoration while local ownership is unresolved", () => {
    const f = setup();
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    f.start();
    expect(
      f.store.exportHostBackup({ enrollmentToken: "" }).commandExecutionData?.executions,
    ).toHaveLength(1);
    expect(() => f.service.importHostBackup(backup)).toThrow("Cancel and reconcile");
    expect(f.service.nodeSocket(f.node.id)).toBeDefined();
  });
});

describe("managed command fences and lifecycle", () => {
  function managed(f: ReturnType<typeof setup>) {
    const run = f.store.createRun({
      workspaceId: f.workspace.id,
      name: "managed",
      objective: "done",
      workspaceMode: "managed",
      sourcePlacementId: f.placement.id,
    });
    f.store.updateRun(run.id, { leadSessionId: f.lead.id });
    f.store.setRunState(run.id, "running");
    const tree = ManagedWorktreeSchema.parse({
      id: run.workspaceBinding!.managedWorktreeId,
      runId: run.id,
      taskKey: "safe",
      sourcePlacementId: f.placement.id,
      workspaceId: f.workspace.id,
      nodeId: f.node.id,
      machineId: "machine",
      hostInstallationId: f.store.worktreeHostInstallationId(),
      nodeInstallationId: "node-installation",
      repository: physical("repository", f.placement.localPath),
      commonDirectory: physical("common", "C:\\repo\\.git"),
      managedRoot: physical("root", "C:\\fleet"),
      checkout: physical("checkout", "C:\\fleet\\safe"),
      path: "C:\\fleet\\safe",
      generation: 1,
      version: 2,
      branchRef: "refs/heads/fleet/safe",
      pinRef: "refs/fleet/pins/safe",
      baseSha: "a".repeat(40),
      state: "ready",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    f.store.putManagedWorktree(tree);
    f.store.setRunWorkspaceBinding(run.id, {
      ...run.workspaceBinding!,
      initialization: "ready",
      resolvedPath: tree.path,
      checkoutKey: tree.checkout!.key,
    });
    return {
      run: f.store.getRun(run.id)!,
      tree,
      request: () =>
        f.request({ target: { worktreeId: tree.id, generation: tree.generation } }),
    };
  }

  it.each(["sealed", "composition", "review"] as const)(
    "refuses %s evidence task-wide and never falls back to source",
    (kind) => {
      const f = setup();
      const m = managed(f);
      if (kind === "sealed")
        f.store.putManagedWorktree({ ...m.tree, resultSha: "b".repeat(40) });
      if (kind === "composition")
        f.store.putManagedWorktree({
          ...m.tree,
          resultRecordedAt: new Date().toISOString(),
        });
      if (kind === "review") f.store.advanceRunToReview(m.run.id);
      expect(() => m.request()).toThrow("managed_target_not_mutable");
      expect(() => f.request({ taskId: m.run.id })).toThrow("source placement");
    },
  );

  it("installs a fence before start and blocks workers, sealing, phase advancement, and purge", async () => {
    const f = setup();
    const m = managed(f);
    const execution = f.approve(f.prepare(m.request()));
    expect(f.store.commands.fence(m.run.id)).toMatchObject({
      executionId: execution.id,
      revision: 1,
      state: "executing",
    });
    expect(() => f.store.setRunState(m.run.id, "completed")).toThrow(
      "command may have changed",
    );
    expect(() => f.store.updateRun(m.run.id, { phaseIndex: 1 })).toThrow();
    expect(() => purgeRun(f.service, m.run.id)).toThrow("Cancel and reconcile");
    expect(() => f.service.worktrees.finalizeStep(m.run, {} as never)).toThrow();
    expect(() => f.service.worktrees.beginAggregation(m.run.id)).toThrow();
    await expect(
      f.service.worktrees.request(m.run.id, { kind: "cleanup", actor: "test" }),
    ).rejects.toThrow();
    archiveRun(f.service, m.run.id, "stop");
    expect(f.service.commands.get(execution.id)).toMatchObject({
      state: "cancelling",
      cancelRequested: true,
    });
    expect(f.store.commands.fence(m.run.id)?.state).toBe("executing");
  });

  it("requires a fresh observation after failed/changed commands; old observation never releases the fence", async () => {
    const f = setup();
    const m = managed(f);
    const observe = vi
      .spyOn(f.service.worktrees, "observeCommandTarget")
      .mockResolvedValue({ result: { ok: false } } as never);
    const execution = f.approve(f.prepare(m.request()));
    expect(f.result(execution, { state: "failed", exitCode: 2 })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(observe).toHaveBeenCalled();
    expect(f.store.commands.fence(m.run.id)?.state).toBe("observation_required");
    expect(() => f.store.assertCommandVerification(m.run.id)).toThrow();
  });

  it("releases execution-only fencing on fresh evidence but still requires new verification before handover", async () => {
    const f = setup();
    const m = managed(f);
    vi.spyOn(f.service.worktrees, "observeCommandTarget").mockImplementation(
      async () =>
        ({
          result: {
            ok: true,
            worktree: {
              ...m.tree,
              observation: {
                generation: 1,
                observedAt: new Date(Date.now() + 1).toISOString(),
                pathExists: true,
                registered: true,
              },
            },
          },
        }) as never,
    );
    const execution = f.approve(f.prepare(m.request()));
    expect(f.result(execution)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store.commands.fence(m.run.id)?.state).toBe("verification_required");
    expect(() => f.store.commands.assertTaskUnfenced(m.run.id)).not.toThrow();
    expect(() => f.store.assertCommandVerification(m.run.id)).toThrow(
      "new successful verification",
    );
  });

  it("a second proven-no-start does not erase earlier command verification debt", () => {
    const f = setup();
    const m = managed(f);
    const changedAt = new Date(Date.now() - 1_000).toISOString();
    f.store.commands.putFence({
      taskId: m.run.id,
      executionId: randomUUID(),
      revision: 2,
      state: "verification_required",
      changedAt,
    });
    const execution = f.approve(f.prepare(m.request()));
    expect(
      f.result(execution, {
        state: "failed",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
      }),
    ).toBe(true);
    expect(f.store.commands.fence(m.run.id)).toMatchObject({
      state: "verification_required",
      changedAt,
      revision: 3,
    });
    expect(() => f.store.assertCommandVerification(m.run.id)).toThrow();
  });

  it("rejects preparation aliases resolving to a managed checkout", () => {
    const f = setup();
    managed(f);
    const execution = f.request();
    const descriptor = f.prepared(execution);
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_prepared",
        executionId: execution.id,
        attemptId: execution.attemptId,
        ok: true,
        descriptor,
      }),
    ).toBe(false);
  });
});

describe("complete command backup evidence", () => {
  it("round-trips all command evidence, rotates the namespace, and never launches copied prompt payloads", () => {
    const f = setup();
    const run = f.store.createRun({
      workspaceId: f.workspace.id,
      name: "backup task",
      objective: "retain evidence",
    });
    f.store.updateRun(run.id, { leadSessionId: f.lead.id, state: "running" });
    const execution = f.approve(f.prepare(f.request({ taskId: run.id })));
    const event = {
      executionId: execution.id,
      attemptId: execution.attemptId,
      sequence: 2,
      stream: "stderr" as const,
      data: Buffer.from([0xff, 0x00, 0x7f]).toString("base64"),
      at: execution.createdAt,
    };
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_output",
        event,
      }),
    ).toBe(true);
    expect(
      f.result(execution, {
        state: "failed",
        exitCode: 7,
        finalOutputSeq: 2,
        gaps: [{ from: 1, to: 1 }],
      }),
    ).toBe(true);
    const delivery = f.store.commands.reserved(f.lead.id)!;
    const accepted = nativeReceipt({
      deliveryId: delivery.delivery.deliveryId,
      sessionId: f.lead.id,
      state: "accepted",
      at: new Date().toISOString(),
      nativeSessionId: "stable-native",
      attemptId: randomUUID(),
    });
    expect(
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: accepted,
      }),
    ).toBe(true);
    f.service.dispatch(f.node.id, {
      type: "prompt",
      sessionId: f.lead.id,
      prompt: "Queued human evidence",
      attachments: [
        { name: "proof.bin", mimeType: "application/octet-stream", data: "AAH/" },
      ],
    });
    f.store.commands.putFence({
      taskId: run.id,
      executionId: execution.id,
      revision: 4,
      state: "verification_required",
      changedAt: new Date().toISOString(),
    });
    const stepId = randomUUID();
    f.store.commands.recordStepEvidence(run.id, stepId);
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const original = CommandExecutionBackupSchema.parse(backup.commandExecutionData);
    expect(original).toMatchObject({
      version: 1,
      executions: [expect.objectContaining({ id: execution.id, exitCode: 7 })],
      events: [event],
      requests: [expect.objectContaining({ revoked: false })],
      attempts: [
        expect.objectContaining({ receipt: expect.objectContaining({ exitCode: 7 }) }),
      ],
      fences: [expect.objectContaining({ revision: 4 })],
      evidence: [{ stepId, taskId: run.id, revision: 4 }],
      notifications: [expect.objectContaining({ phase: "completion" })],
      clocks: [
        expect.objectContaining({
          acceptedAt: expect.any(String),
          hostTime: execution.descriptor!.hostTime,
        }),
      ],
    });
    expect(original.prompts).toHaveLength(2);
    expect(
      original.prompts.some((record) => record.delivery.attachments?.length === 1),
    ).toBe(true);
    const restored = open();
    const previousNamespace = restored.commands.namespace();
    restored.replaceHostBackup(backup);
    const archived = restored.exportHostBackup({
      enrollmentToken: "",
    }).commandExecutionData!;
    expect(archived.namespace).not.toBe(original.namespace);
    expect(archived.namespace).not.toBe(previousNamespace);
    expect(archived.events).toEqual([event]);
    expect(archived.requests.every((request) => request.revoked)).toBe(true);
    expect(archived.attempts[0]).toMatchObject({
      cancelled: true,
      receipt: original.attempts[0]!.receipt,
    });
    expect(archived.fences[0]).toMatchObject({
      revision: 5,
      state: "observation_required",
    });
    expect(archived.evidence).toEqual(original.evidence);
    expect(archived.clocks[0]).toMatchObject({
      hostTime: original.clocks[0]!.hostTime,
      acceptedAt: null,
      elapsedMs: null,
    });
    expect(
      archived.prompts.every(
        (record) => record.state === "orphaned" && !record.delivery.attachments,
      ),
    ).toBe(true);
    expect(
      archived.prompts.find(
        (record) => record.delivery.deliveryId === accepted.deliveryId,
      )?.receipt,
    ).toEqual(accepted);
    expect(() =>
      restored.commands.request(
        f.lead.id,
        execution.requestKey,
        execution.requestDigest,
        Date.now(),
      ),
    ).toThrow("request_expired");
    const service = new FleetService(restored, log, "restored");
    const before = f.frames.length;
    service.attachNode(f.node.id, f.service.nodeSocket(f.node.id)!);
    service.commands.nodeReady(f.node.id, { capabilities, commandExecution: readiness });
    service.commands.reconnect(f.node.id);
    service.commands.tick();
    expect(
      f.frames
        .slice(before)
        .some((frame) =>
          [
            "start_command_execution",
            "prepare_command_execution",
            "deliver_lead_prompt",
          ].includes(frame.type),
        ),
    ).toBe(false);
    expect(
      service.commands.read(undefined, { executionId: execution.id }).events,
    ).toEqual([event]);
  });

  it("merges local and imported request identities rather than deleting newer local evidence", () => {
    const f = setup();
    const first = f.prepare(f.request({ requestKey: "first" }));
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    f.service.commands.cancel(first.id);
    const second = f.request({ requestKey: "newer-local" });
    f.store.replaceHostBackup(backup);
    const merged = f.store.commands.exportBackup();
    expect(merged.executions.map((execution) => execution.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(merged.requests.map((request) => request.requestKey).sort()).toEqual([
      "first",
      "newer-local",
    ]);
    expect(merged.requests.every((request) => request.revoked)).toBe(true);
    expect(f.store.commands.get(first.id)?.state).toBe("cancelled");
    expect(f.store.commands.get(second.id)?.state).toBe("expired");
    f.service.commands.reconcileNotifications();
    expect(
      f.store
        .listNotifications()
        .notifications.some(
          (notification) =>
            notification.kind === "command_approval" && notification.status === "active",
        ),
    ).toBe(false);
  });

  it("quarantines imported in-flight attempts and only reconciles/cancels them after reconnect", () => {
    const f = setup();
    const execution = f.start();
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const restored = open();
    restored.replaceHostBackup(backup);
    const service = new FleetService(restored, log, "restored");
    expect(service.commands.get(execution.id)).toMatchObject({
      state: "reconciliation_required",
      ownership: "unknown",
      cancelRequested: true,
      delivery: "orphaned",
    });
    const before = f.frames.length;
    service.attachNode(f.node.id, f.service.nodeSocket(f.node.id)!);
    service.commands.nodeReady(f.node.id, { capabilities, commandExecution: readiness });
    service.commands.reconnect(f.node.id);
    expect(
      f.frames
        .slice(before)
        .some((frame) => frame.type === "reconcile_command_executions"),
    ).toBe(true);
    expect(
      f.frames.slice(before).some((frame) => frame.type === "cancel_command_execution"),
    ).toBe(true);
    expect(
      service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_update",
        receipt: f.receipt(execution, {
          state: "cancelled",
          ownership: "quiescent",
          exitCode: null,
          outcomeKnown: false,
        }),
      }),
    ).toBe(true);
    expect(service.commands.get(execution.id)?.delivery).toBe("orphaned");
    expect(
      f.frames
        .slice(before)
        .some((frame) =>
          ["start_command_execution", "deliver_lead_prompt"].includes(frame.type),
        ),
    ).toBe(false);
  });

  it.each(["request", "command", "output", "native"] as const)(
    "rolls back conflicting %s evidence and namespace rotation",
    (kind) => {
      const f = setup();
      const execution = f.start();
      const event = {
        executionId: execution.id,
        attemptId: execution.attemptId,
        sequence: 1,
        stream: "stdout" as const,
        data: "AQI=",
        at: execution.createdAt,
      };
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "command_execution_output",
        event,
      });
      f.result(execution, { finalOutputSeq: 1 });
      const delivery = f.store.commands.reserved(f.lead.id)!;
      f.service.commands.handleNodeMessage(f.node.id, {
        type: "lead_prompt_receipt",
        receipt: nativeReceipt({
          deliveryId: delivery.delivery.deliveryId,
          sessionId: f.lead.id,
          state: "accepted",
          at: new Date().toISOString(),
        }),
      });
      const before = f.store.commands.exportBackup();
      const backup = f.store.exportHostBackup({ enrollmentToken: "" });
      const data = backup.commandExecutionData!;
      if (kind === "request") data.requests[0]!.digest = "0".repeat(64);
      if (kind === "command") data.executions[0]!.command = "different command";
      if (kind === "output") data.events[0]!.data = "AQM=";
      if (kind === "native") data.prompts[0]!.receipt!.attemptId = randomUUID();
      expect(() => f.store.replaceHostBackup(backup)).toThrow("Conflicting");
      expect(f.store.commands.exportBackup()).toEqual(before);
      expect(f.store.getSession(f.lead.id)).toBeDefined();
    },
  );

  it("recomputes output completeness from restored bytes rather than trusting a copied complete flag", () => {
    const f = setup();
    const execution = f.start();
    f.service.commands.handleNodeMessage(f.node.id, {
      type: "command_execution_output",
      event: {
        executionId: execution.id,
        attemptId: execution.attemptId,
        sequence: 1,
        stream: "stdout",
        data: "AQI=",
        at: execution.createdAt,
      },
    });
    f.result(execution, { finalOutputSeq: 1 });
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    backup.commandExecutionData!.events = [];
    const restored = open();
    restored.replaceHostBackup(backup);
    expect(restored.commands.get(execution.id)).toMatchObject({
      state: "succeeded",
      outcomeKnown: true,
      outputComplete: false,
      outputBytes: 0,
      finalOutputSeq: 1,
    });
  });

  it("keeps legacy archives readable while revoking local command authority", () => {
    const f = setup();
    const legacy = f.store.exportHostBackup({ enrollmentToken: "" });
    delete legacy.commandExecutionData;
    const execution = f.prepare(f.request());
    const before = f.store.commands.namespace();
    f.store.replaceHostBackup(legacy);
    expect(f.store.commands.namespace()).not.toBe(before);
    expect(f.store.commands.get(execution.id)).toMatchObject({
      state: "expired",
      ownership: "not_started",
      delivery: "orphaned",
    });
    expect(f.store.commands.exportBackup().requests[0]?.revoked).toBe(true);
  });

  it("preserves multiple pending identities while revoking every restored approval", () => {
    const f = setup();
    const first = f.prepare(f.request());
    const second = f.prepare(f.request());
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const restored = open();
    restored.replaceHostBackup(backup);
    for (const execution of [first, second])
      expect(restored.commands.get(execution.id)).toMatchObject({
        state: "expired",
        ownership: "not_started",
        delivery: "orphaned",
      });
    expect(
      restored.commands.exportBackup().requests.every((request) => request.revoked),
    ).toBe(true);
    expect(
      restored.commands.exportBackup().clocks.every((clock) => clock.acceptedAt === null),
    ).toBe(true);
  });

  it("carries command payloads through the actual portable data/security restore path", () => {
    const f = setup();
    f.store.insertAdministrator({
      tenantId: "test-tenant",
      objectId: "test-owner",
      username: "owner@example.test",
      displayName: "Test owner",
      addedVia: "claim",
    });
    f.store.setSetting("auth.csrfKey", "fixture-csrf-key");
    new LeadTokens(f.store);
    const execution = f.prepare(f.request());
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const {
      enrollmentToken: _token,
      kind: _kind,
      version: _version,
      nodes,
      ...data
    } = backup;
    const restored = open();
    restored.importPortableBackup({
      data: { ...data, nodes: nodes.map(({ secretHash: _secretHash, ...node }) => node) },
      security: f.store.exportSecurityBackup(),
    });
    expect(restored.commands.get(execution.id)).toMatchObject({
      state: "expired",
      ownership: "not_started",
      delivery: "orphaned",
    });
    expect(restored.commands.exportBackup().requests[0]?.executionId).toBe(execution.id);
    expect(restored.commands.namespace()).not.toBe(
      backup.commandExecutionData!.namespace,
    );
  });

  it("refuses a genuinely oversized complete archive instead of dropping evidence", () => {
    expect(() =>
      assertHostArchiveSize({ bytes: "x".repeat(HOST_ARCHIVE_BYTES) }),
    ).toThrow("50 MiB");
    const f = setup();
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    expect(() => assertHostArchiveSize(backup)).not.toThrow();
    expect(
      CommandExecutionBackupSchema.safeParse(backup.commandExecutionData).success,
    ).toBe(true);
  });
});

describe("command MCP and administrator routes", () => {
  it("inherits real origin, host, cookie, and CSRF guards for command writes", async () => {
    const f = setup();
    const execution = f.prepare(f.request());
    const app = Fastify();
    apps.push(app);
    const auth = {
      classify: () => ({ kind: "loopback-http" }),
      noAuthEnabled: () => false,
      audit() {},
      verifySession: (token: string) =>
        token === "test" ? { tokenHash: "test-hash" } : undefined,
      sessionStillAuthorized: () => true,
      sessions: { verifyCsrf: (_hash: string, token: string) => token === "csrf-test" },
      administratorFor: () => ({ id: "admin" }),
    } as unknown as FleetAuth;
    registerRequestGuard(app, { store: f.store, auth, allowlist: {} });
    await app.register(commandExecutionRoutes, { service: f.service, auth });
    const url = `/api/command-executions/${execution.id}/decision`;
    const payload = {
      decision: "allow_once",
      expectedVersion: execution.version,
      digest: execution.descriptor!.digest,
    };
    const headers = { cookie: `${OPERATOR_COOKIE}=test`, "x-csrf-token": "csrf-test" };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { ...headers, origin: "https://other.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { ...headers, host: "other.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      f.frames.filter((frame) => frame.type === "start_command_execution"),
    ).toHaveLength(0);
    expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(
      200,
    );
  });

  it("uses live MCP ownership and exact shared schemas; approval is never an MCP tool", async () => {
    const f = setup();
    const app = Fastify();
    apps.push(app);
    const tokens = new LeadTokens(f.store);
    await app.register(mcpRoutes, { service: f.service, tokens });
    const token = tokens.mint({ sessionId: f.lead.id, runId: "", nodeId: f.node.id });
    const rpc = (method: string, params?: unknown) =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id: 1, method, params },
      });
    const listed = (await rpc("tools/list"))
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toContain("fleet_run_command");
    expect(listed).toContain("fleet_get_execution");
    expect(listed).toContain("fleet_cancel_execution");
    expect(listed).not.toContain("fleet_approve_command");
    const response = (
      await rpc("tools/call", {
        name: "fleet_run_command",
        arguments: {
          target: { placementId: f.placement.id },
          command: "echo test",
          reason: "test",
          shell: "windows-powershell-5.1",
          requestKey: "rpc",
        },
      })
    ).json();
    expect(response.result.isError).not.toBe(true);
    expect(JSON.parse(response.result.content[0].text).state).toBe("preparing");
    expect(
      (await rpc("tools/call", { name: "fleet_list_nodes", arguments: {} })).json().result
        .content[0].text,
    ).toContain(f.placement.id);
    f.store.setSessionControls(f.lead.id, { stopRequested: true });
    expect(
      (
        await rpc("tools/call", {
          name: "fleet_run_command",
          arguments: {
            target: { placementId: f.placement.id },
            command: "echo test",
            reason: "test",
            shell: "windows-powershell-5.1",
            requestKey: "stopped",
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("requires an administrator for browser decisions and returns raw byte pages even for text view", async () => {
    const f = setup();
    const execution = f.prepare(f.request());
    const app = Fastify();
    apps.push(app);
    app.addHook("onRequest", async (request) => {
      if (request.headers["x-test-admin"] === "yes") request.fleetSession = {} as never;
    });
    const auth = {
      administratorFor: () => ({ id: "admin" }),
      requireRecentReauth: () => true,
    } as unknown as FleetAuth;
    await app.register(commandExecutionRoutes, { service: f.service, auth });
    const decision = {
      decision: "allow_once",
      expectedVersion: execution.version,
      digest: execution.descriptor!.digest,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/command-executions/${execution.id}/decision`,
          payload: decision,
        })
      ).statusCode,
    ).toBe(403);
    const approved = await app.inject({
      method: "POST",
      url: `/api/command-executions/${execution.id}/decision`,
      headers: { "x-test-admin": "yes" },
      payload: decision,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().execution.state).toBe("starting");
    const list = await app.inject({
      url: `/api/command-executions?leadSessionId=${f.lead.id}`,
    });
    expect(list.json().executions).toHaveLength(1);
    const page = await app.inject({
      url: `/api/command-executions/${execution.id}?afterSeq=0&format=text`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().events).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/command-executions/${execution.id}/cancel`,
        })
      ).statusCode,
    ).toBe(403);
  });
});
