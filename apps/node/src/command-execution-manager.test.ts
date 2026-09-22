import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_LIMITS,
  GetCommandExecutionSchema,
  commandObservationClock,
  PreparedCommandSchema,
  type CommandExecutionNodeMessage,
  type CommandPreparation,
  type PreparedCommand,
} from "@fleet/protocol";
import { canonicalPath } from "./canonical-path.js";
import { CommandJournal, privateJournalDirectory } from "./command-journal.js";
import {
  CommandExecutionManager,
  type CommandProcessResult,
  type CommandSupervisor,
} from "./command-execution-manager.js";
import { NodeAdmission } from "./node-admission.js";
import { RepositoryParticipation } from "./repository-participation.js";
import { CommandPermissions } from "./command-permissions.js";
import type { CommandPermissionRule, CommandExecutionHostMessage } from "@fleet/protocol";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const directories: string[] = [];
const journals: CommandJournal[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
  vi.mocked(fsPromises.rm).mockImplementation(actual.rm).mockClear();
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const result = (overrides: Partial<CommandProcessResult> = {}): CommandProcessResult => ({
  exitCode: 0,
  ownership: "quiescent",
  reason: "completed",
  descendantCleanupForced: false,
  ...overrides,
});

async function fixture(
  clock: { now?: () => number; monotonic?: () => number } = {},
  negotiatedPermissions = true,
) {
  const directory = resolve(`.command-manager-test-${randomUUID()}`);
  directories.push(directory);
  const cwd = join(directory, "checkout");
  mkdirSync(cwd, { recursive: true });
  const checkout = await canonicalPath(cwd);
  const repositories = new RepositoryParticipation(async () => ({
    cwd,
    checkout,
    repository: checkout,
    git: false,
  }));
  const journal = new CommandJournal(join(directory, "journal"), false);
  journals.push(journal);
  const admission = new NodeAdmission();
  const messages: CommandExecutionNodeMessage[] = [];
  let complete!: (value: CommandProcessResult) => void;
  const completion = new Promise<CommandProcessResult>((done) => {
    complete = done;
  });
  const release = vi.fn(async () => {});
  const cancel = vi.fn(async () => {
    complete(result({ cancelled: true, exitCode: null }));
  });
  const prepare = vi.fn<CommandSupervisor["prepare"]>(async () => ({
    identity: { executionId: "native" },
    release,
    cancel,
    result: completion,
  }));
  const supervisor: CommandSupervisor = {
    readiness: vi.fn(async () => ({
      supported: true,
      reason: "fixture ready",
      shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    })),
    prepare,
    recover: vi.fn(async () => undefined),
  };
  const context = {
    sealed: true,
    negotiated: true,
    permissions: negotiatedPermissions,
    hostId: "host",
    nodeId: "node",
  };
  let deliver = true;
  let rules: CommandPermissionRule[] = [];
  const saveRules = vi.fn(
    async (
      update: (current: readonly CommandPermissionRule[]) => CommandPermissionRule[],
    ) => {
      rules = update(rules);
    },
  );
  const resolveExecutable = vi.fn((name: string) => ({
    path: join(directory, "trusted-tools", `${name}.exe`),
    fingerprint: "a".repeat(64),
  }));
  const permissions = new CommandPermissions({
    getRules: () => rules,
    saveRules,
    resolveExecutable,
  });
  const options = {
    ...clock,
    journal,
    admission,
    repositories,
    supervisor,
    permissions,
    connection: () => context,
    send: (message: CommandExecutionNodeMessage) => {
      if (deliver) messages.push(message);
      return deliver;
    },
  };
  const manager = new CommandExecutionManager(options);
  await manager.configure(true);
  const request: CommandPreparation = {
    executionId: randomUUID(),
    attemptId: randomUUID(),
    hostId: "host",
    nodeId: "node",
    leadSessionId: "lead",
    target: { placementId: "placement" },
    requestedPath: cwd,
    command: "throw 'must not run during preparation'",
    shell: "windows-powershell-5.1",
    reason: "test",
    requestKey: randomUUID(),
    timeoutMs: 1000,
    hostTime: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const prepared = async () => {
    await manager.handle({ type: "prepare_command_execution", request });
    const message = messages
      .filter((entry) => entry.type === "command_execution_prepared")
      .at(-1);
    expect(message).toMatchObject({ ok: true });
    return (
      message as Extract<
        CommandExecutionNodeMessage,
        { type: "command_execution_prepared" }
      >
    ).descriptor!;
  };
  const start = (
    descriptor: PreparedCommand,
    approval: Partial<
      Extract<CommandExecutionHostMessage, { type: "start_command_execution" }>
    > = {},
  ) =>
    manager.handle({
      type: "start_command_execution",
      descriptor,
      approvedBy: "operator",
      approvedAt: new Date().toISOString(),
      version: 1,
      ...approval,
    });
  return {
    ...options,
    manager,
    request,
    prepared,
    start,
    prepare,
    release,
    cancel,
    complete,
    completion,
    messages,
    cwd,
    saveRules,
    resolveExecutable,
    rules: () => rules,
    setRules: (next: CommandPermissionRule[]) => {
      rules = next;
    },
    disconnect: () => {
      deliver = false;
    },
    reconnect: () => {
      deliver = true;
    },
  };
}

describe("approved command execution", () => {
  it.each(["session", "always"] as const)(
    "accepts a %s flag variant after the prepared descriptor JSON/schema roundtrip",
    async (scope) => {
      const f = await fixture();
      f.request.command = "git status --short";
      await f.start(await f.prepared(), { approvalScope: scope });
      f.complete(result());
      await f.manager.cancelAll("wait for first completion");
      Object.assign(f.request, {
        executionId: randomUUID(),
        attemptId: randomUUID(),
        requestKey: randomUUID(),
        command: "git status --branch",
      });
      const descriptor = PreparedCommandSchema.parse(
        JSON.parse(JSON.stringify(await f.prepared())),
      );
      expect(descriptor.prepared.permission?.grantedBy).toBe(scope);
      let finish!: (value: CommandProcessResult) => void;
      const completion = new Promise<CommandProcessResult>((resolve) => {
        finish = resolve;
      });
      f.prepare.mockResolvedValueOnce({
        identity: { executionId: "second-native-process" },
        release: f.release,
        cancel: async () => {
          finish(result({ cancelled: true }));
        },
        result: completion,
      });
      try {
        await f.start(descriptor, { approvalScope: scope, automaticApproval: true });
        expect(f.prepare).toHaveBeenCalledTimes(2);
        expect(f.release).toHaveBeenCalledTimes(2);
        expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("running");
      } finally {
        finish(result());
        await f.manager.cancelAll("wait for second completion");
      }
    },
  );

  it("terminal-refuses changed executable identity before launch, including explicit Once", async () => {
    const f = await fixture();
    f.request.command = "git status --short";
    const descriptor = await f.prepared();
    f.resolveExecutable.mockReturnValue({
      path: join(f.cwd, "..", "different-tools", "git.exe"),
      fingerprint: "b".repeat(64),
    });
    await f.start(descriptor, { approvalScope: "once" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reason: expect.stringContaining("executable identity changed"),
    });
    expect(f.admission.active).toEqual([]);
  });

  it("omits permission evidence from the hashed descriptor for a legacy Host and still accepts Once", async () => {
    const f = await fixture({}, false);
    f.request.command = "git status";
    const descriptor = await f.prepared();
    expect(descriptor.prepared).not.toHaveProperty("permission");
    await f.start(descriptor);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.complete(result());
    await f.manager.cancelAll("wait for completion");
  });

  it.each([
    { approvalScope: "session" as const },
    { approvalScope: "always" as const },
    { automaticApproval: true },
  ])("refuses unnegotiated permission reuse: %j", async (approval) => {
    const f = await fixture({}, false);
    const descriptor = await f.prepared();
    await f.start(descriptor, approval);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt.reason).toContain("negotiate");
  });

  it("reports unavailable supervisor readiness, not a missing local opt-in", async () => {
    const f = await fixture();
    vi.mocked(f.supervisor.readiness).mockRejectedValueOnce(
      new Error("native job supervision unavailable"),
    );
    await expect(f.manager.configure(true)).rejects.toThrow("supervision unavailable");
    expect(f.manager.readiness).toMatchObject({
      enabled: true,
      supported: false,
      reason: expect.stringContaining("Command supervisor unavailable"),
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("prepares without local opt-in and waits for an explicit Host approval when no grant matches", async () => {
    const f = await fixture();
    f.request.command = "git status --short";
    const descriptor = await f.prepared();
    expect(descriptor.prepared.permission).toMatchObject({
      reusable: true,
      commandKey: `git status @sha256:${"a".repeat(64)}`,
    });
    expect(descriptor.prepared.permission?.grantedBy).toBeUndefined();
    expect(descriptor.prepared.permission?.path).toBe(descriptor.prepared.cwd);
    expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe(
      "awaiting_approval",
    );
    expect(f.prepare).not.toHaveBeenCalled();
    await f.start(descriptor, { automaticApproval: true });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reason: expect.stringContaining("fresh Host approval"),
    });
  });

  it("a Once approval is exact-preparation-only, never a grant for another request", async () => {
    const f = await fixture();
    f.request.command = "git status";
    await f.start(await f.prepared(), { approvalScope: "once" });
    f.complete(result());
    await f.manager.cancelAll("wait for completion");
    Object.assign(f.request, {
      executionId: randomUUID(),
      attemptId: randomUUID(),
      requestKey: randomUUID(),
    });
    const next = await f.prepared();
    expect(next.prepared.permission?.grantedBy).toBeUndefined();
    expect(f.journal.get(next.executionId)?.receipt.state).toBe("awaiting_approval");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.rules()).toEqual([]);
  });

  it("stores session permission before launch, matches flag variants, and honors authenticated Host revocation", async () => {
    const f = await fixture();
    f.request.command = "git status --short";
    const descriptor = await f.prepared();
    await f.start(descriptor, { approvalScope: "session" });
    expect(f.permissions.evaluate(f.request, f.cwd).grantedBy).toBe("session");
    expect(f.rules()).toEqual([]);
    f.complete(result());
    await f.manager.cancelAll("wait for completion");
    Object.assign(f.request, {
      executionId: randomUUID(),
      attemptId: randomUUID(),
      requestKey: randomUUID(),
      command: "git status --branch",
    });
    const next = await f.prepared();
    expect(next.prepared.permission?.grantedBy).toBe("session");
    await expect(
      f.manager.handle({
        type: "revoke_command_session_grants",
        hostId: "other",
        leadSessionId: "lead",
      }),
    ).rejects.toThrow("identity mismatch");
    await f.manager.handle({
      type: "revoke_command_session_grants",
      hostId: "host",
      leadSessionId: "lead",
    });
    await f.start(next, { automaticApproval: true });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.journal.get(next.executionId)?.receipt.reason).toContain("revoked");
  });

  it("persists Always before launch and refuses a prepared automatic approval after rule removal", async () => {
    const f = await fixture();
    f.request.command = "npm run build";
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async (input) => {
      expect(f.rules()).toEqual([
        expect.objectContaining({
          commandKey: `npm run build @sha256:${"a".repeat(64)}`,
          hostId: "host",
        }),
      ]);
      return prepare(input);
    });
    await f.start(await f.prepared(), { approvalScope: "always" });
    f.complete(result());
    await f.manager.cancelAll("wait for completion");
    Object.assign(f.request, {
      executionId: randomUUID(),
      attemptId: randomUUID(),
      requestKey: randomUUID(),
    });
    const next = await f.prepared();
    expect(next.prepared.permission?.grantedBy).toBe("always");
    f.setRules([]);
    await f.start(next, { automaticApproval: true });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.journal.get(next.executionId)?.receipt.reason).toContain("revoked");
  });

  it("reports persistence failure without launching or leaking admission", async () => {
    const f = await fixture();
    f.request.command = "git status";
    f.saveRules.mockRejectedValueOnce(new Error("settings disk full"));
    const descriptor = await f.prepared();
    await f.start(descriptor, { approvalScope: "always" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "failed",
      ownership: "not_started",
      reason: expect.stringContaining("settings disk full"),
    });
    expect(f.admission.active).toEqual([]);
  });

  it("runs ordinary placement commands alongside existing participants without stopping them", async () => {
    const f = await fixture();
    const sessions = await f.repositories.participate([f.cwd], "existing-session");
    try {
      const descriptor = await f.prepared();
      await f.start(descriptor);
      expect(f.prepare).toHaveBeenCalledTimes(1);
      await sessions.leases[0]!.revalidate();
      f.complete(result());
      await f.manager.cancelAll("wait for completion");
    } finally {
      sessions.leases[0]!.release();
    }
  });

  it.each(["managed", "legacy"] as const)(
    "retains exclusive checkout admission for %s commands",
    async (kind) => {
      const f = await fixture({}, kind !== "legacy");
      if (kind === "managed")
        f.request.target = { worktreeId: randomUUID(), generation: 1 };
      const sessions = await f.repositories.participate([f.cwd], "session:existing");
      try {
        const descriptor = await f.prepared();
        await f.start(descriptor);
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.journal.get(descriptor.executionId)?.receipt.reason).toContain(
          "Checkout busy",
        );
        await sessions.leases[0]!.revalidate();
      } finally {
        sessions.leases[0]!.release();
      }
    },
  );

  it("pairs the receive-time offset with preparedAt even when metadata preparation completes later", async () => {
    const hostTime = Date.parse("2026-09-16T15:41:25.382Z");
    let wall = hostTime + 5;
    let monotonic = 0;
    const f = await fixture({ now: () => wall, monotonic: () => monotonic });
    Object.assign(f.request, {
      hostTime: new Date(hostTime).toISOString(),
      createdAt: new Date(hostTime).toISOString(),
      expiresAt: new Date(hostTime + 60000).toISOString(),
    });
    const target = await f.repositories.resolve(f.cwd);
    vi.spyOn(f.repositories, "resolve").mockImplementation(async () => {
      wall = hostTime + 163;
      monotonic = 158;
      return target;
    });
    const descriptor = await f.prepared();
    expect(descriptor.prepared).toMatchObject({
      preparedAt: "2026-09-16T15:41:25.387Z",
      hostClockOffsetMs: -5,
      clockUncertaintyMs: 5000,
    });
    expect(
      Date.parse(descriptor.prepared.preparedAt) + descriptor.prepared.hostClockOffsetMs,
    ).toBe(Date.parse(descriptor.hostTime));
    expect(descriptor.prepared.preparedAt).not.toBe(new Date(wall).toISOString());
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("replays and acknowledges an offline opt-out receipt after restart without re-enabling launch", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.disconnect();
    f.connection().sealed = false;
    f.connection().negotiated = false;
    await f.manager.configure(false);
    const cancelled = f.journal.get(descriptor.executionId)!.receipt;
    expect(cancelled.state).toBe("cancelled");
    const restarted = new CommandExecutionManager({
      ...f,
      admission: new NodeAdmission(),
    });
    await restarted.recoverAll();
    f.reconnect();
    f.connection().sealed = true;
    f.connection().negotiated = true;
    f.messages.length = 0;
    restarted.inventory();
    expect(f.messages).toContainEqual({
      type: "command_execution_inventory",
      readiness: expect.objectContaining({ enabled: false, supported: false }),
      executions: [cancelled],
    });
    await restarted.handle({
      type: "command_execution_ack",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      digest: descriptor.digest,
      throughSeq: cancelled.finalOutputSeq!,
      terminal: true,
    });
    expect(f.journal.get(descriptor.executionId)?.terminalAck).toBe(true);
    await restarted.handle({
      type: "prepare_command_execution",
      request: { ...f.request, executionId: randomUUID(), requestKey: randomUUID() },
    });
    expect(f.messages.at(-1)).toMatchObject({
      type: "command_execution_prepared",
      ok: false,
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.supervisor.readiness).toHaveBeenCalledTimes(1);
  });

  it.each(["EPERM", "EBUSY", "ENOTEMPTY", "EIO"])(
    "keeps ACK lifecycle-only and handles retention cleanup %s without changing the outcome",
    async (code) => {
      let wall = Date.now();
      const f = await fixture({ now: () => wall, monotonic: () => 0 });
      const descriptor = await f.prepared();
      await f.start(descriptor);
      const record = f.journal.get(descriptor.executionId)!;
      const attempt = join(
        f.journal.directory,
        record.namespace,
        descriptor.executionId,
        descriptor.attemptId,
      );
      mkdirSync(attempt);
      writeFileSync(join(attempt, "terminal.json"), "inert retained proof fixture");
      writeFileSync(join(attempt, "supervisor.exe"), "inert retained executable fixture");
      f.complete(result());
      await vi.waitFor(() =>
        expect(f.messages).toContainEqual(
          expect.objectContaining({
            type: "command_execution_update",
            receipt: expect.objectContaining({ state: "succeeded" }),
          }),
        ),
      );
      const terminal = f.journal.get(descriptor.executionId)!.receipt;
      wall += COMMAND_LIMITS.replayMs + 1;
      const actualRemove = (await vi.importActual<typeof fsPromises>("node:fs/promises"))
        .rm;
      const failure = Object.assign(new Error(`fixture cleanup ${code}`), { code });
      const remove = vi
        .mocked(fsPromises.rm)
        .mockClear()
        .mockImplementation(async (path, options) => {
          if (path === attempt) throw failure;
          await actualRemove(path, options);
        });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        f.manager.handle({
          type: "command_execution_ack",
          executionId: descriptor.executionId,
          attemptId: descriptor.attemptId,
          digest: descriptor.digest,
          throughSeq: 0,
          terminal: true,
        }),
      ).resolves.toBeUndefined();
      expect(remove).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(f.journal.get(descriptor.executionId)?.terminalAck).toBe(true);

      if (code === "EIO") await expect(f.manager.recoverAll()).rejects.toBe(failure);
      else {
        await expect(f.manager.recoverAll()).resolves.toBeUndefined();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(code));
      }
      expect(remove).toHaveBeenCalledWith(attempt, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      expect(f.journal.get(descriptor.executionId)?.receipt).toEqual(terminal);
      expect(f.journal.get(descriptor.executionId)?.artifactCleanupComplete).toBe(false);
      expect(existsSync(join(attempt, "terminal.json"))).toBe(true);
      expect(f.manager.unsettled).toBe(false);
      expect(f.admission.reason).toBe("");

      remove.mockImplementation(actualRemove);
      await f.manager.recoverAll();
      expect(existsSync(attempt)).toBe(false);
      expect(f.journal.get(descriptor.executionId)?.artifactCleanupComplete).toBe(true);
      expect(f.journal.get(descriptor.executionId)?.receipt).toEqual(terminal);
    },
  );

  it("does not overwrite a native reader diagnostic with a later release error", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    f.prepare.mockResolvedValueOnce({
      identity: { executionId: descriptor.executionId },
      result: Promise.resolve(
        result({
          reason: "receipt_missing",
          error: "original native reader failure",
          ownership: "unknown",
          exitCode: null,
          outcomeKnown: false,
          interrupted: true,
        }),
      ),
      release: async () => {
        await new Promise<void>((done) => setImmediate(done));
        throw new Error("attempt has already settled");
      },
      cancel: async () => {},
    });
    await f.start(descriptor);
    const record = f.journal.get(descriptor.executionId)!;
    expect(record.supervisionError).toBe("original native reader failure");
    expect(record.receipt.reason).toContain("original native reader failure");
    expect(record.receipt.reason).not.toContain("already settled");
    expect(record.receipt.ownership).toBe("unknown");
  });

  it("preserves the original pre-readiness failure when cancellation cleanup follows", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    f.prepare.mockRejectedValueOnce(new Error("fixture readiness identity mismatch"));
    await f.start(descriptor);
    await expect(f.manager.cancelAll("fixture cleanup")).rejects.toThrow(
      "ownership remains unknown",
    );
    const record = f.journal.get(descriptor.executionId)!;
    expect(record.supervisionError).toContain("fixture readiness identity mismatch");
    expect(record.receipt.reason).toContain("fixture readiness identity mismatch");
    expect(record.receipt.ownership).toBe("unknown");
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("preserves a supervisor reader error separately from missing outcome evidence", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.complete(
      result({
        reason: "receipt_missing",
        error: "fixture receipt reader failed",
        ownership: "unknown",
        exitCode: null,
        outcomeKnown: false,
        interrupted: true,
      }),
    );
    await vi.waitFor(() =>
      expect(f.journal.get(descriptor.executionId)?.supervisionError).toBe(
        "fixture receipt reader failed",
      ),
    );
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "reconciliation_required",
      ownership: "unknown",
      reason: "receipt_missing: fixture receipt reader failed",
    });
  });

  it("retains acknowledged native attempts through the replay horizon and keeps tombstones after cleanup", async () => {
    let wall = Date.now();
    const f = await fixture({ now: () => wall, monotonic: () => 0 });
    const descriptor = await f.prepared();
    await f.start(descriptor);
    const record = f.journal.get(descriptor.executionId)!;
    const attempt = join(
      f.journal.directory,
      record.namespace,
      descriptor.executionId,
      descriptor.attemptId,
    );
    mkdirSync(attempt);
    writeFileSync(join(attempt, "supervisor.exe"), "inert fixture artifact");
    const scriptPaths = ["command.ps1", "invoke.ps1", "supervisor.ps1"].map((name) =>
      join(attempt, name),
    );
    for (const path of scriptPaths) writeFileSync(path, "inert fixture script");
    f.complete(result());
    await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    await f.manager.handle({
      type: "command_execution_ack",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      digest: descriptor.digest,
      throughSeq: 0,
      terminal: true,
    });
    expect(existsSync(attempt)).toBe(true);
    expect(scriptPaths.every(existsSync)).toBe(true);
    wall += COMMAND_LIMITS.replayMs - 1;
    await f.manager.recoverAll();
    expect(existsSync(attempt)).toBe(true);
    expect(scriptPaths.every(existsSync)).toBe(true);
    wall += 1;
    await f.manager.recoverAll();
    expect(existsSync(attempt)).toBe(false);
    expect(f.journal.get(descriptor.executionId)?.artifactCleanupComplete).toBe(true);
    wall += COMMAND_LIMITS.retentionMs;
    f.journal.prune(wall);
    expect(f.journal.retired(descriptor.executionId)).toBe(true);
  });

  it.each([
    {
      reason: "start_expired",
      cancelled: false,
      outcomeKnown: true,
      expected: "expired",
    },
    { reason: "cancelled", cancelled: true, outcomeKnown: true, expected: "cancelled" },
    {
      reason: "supervisor_error",
      cancelled: false,
      outcomeKnown: false,
      expected: "failed",
    },
  ])(
    "preserves authoritative no-start evidence for $reason",
    async ({ reason, cancelled, outcomeKnown, expected }) => {
      const f = await fixture();
      const descriptor = await f.prepared();
      await f.start(descriptor);
      f.complete(
        result({ reason, started: false, exitCode: null, cancelled, outcomeKnown }),
      );
      await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
      const record = f.journal.get(descriptor.executionId)!;
      expect(record.receipt).toMatchObject({
        state: expected,
        ownership: "not_started",
        exitCode: null,
        finalOutputSeq: 0,
      });
      expect(record.receipt.startedAt).toBeUndefined();
      expect(record.leasesReleased).toBe(true);
    },
  );

  it("preserves the exact unsigned Windows DWORD exit code", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.complete(result({ started: true, exitCode: 4294967295 }));
    await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "failed",
      ownership: "quiescent",
      exitCode: 4294967295,
      outcomeKnown: true,
    });
  });

  it.each([-120000, 120000])(
    "converts the immutable Host expiry with offset %d and the full five-second uncertainty",
    async (offset) => {
      const hostTime = Date.now();
      const nodeTime = hostTime - offset;
      const f = await fixture({ now: () => nodeTime, monotonic: () => 0 });
      Object.assign(f.request, {
        hostTime: new Date(hostTime).toISOString(),
        createdAt: new Date(hostTime).toISOString(),
        expiresAt: new Date(hostTime + 60000).toISOString(),
      });
      const readinessCalls = vi.mocked(f.supervisor.readiness).mock.calls.length;
      const descriptor = await f.prepared();
      expect(descriptor.prepared).toMatchObject({
        preparedAt: new Date(nodeTime).toISOString(),
        hostClockOffsetMs: offset,
        clockUncertaintyMs: 5000,
      });
      expect(f.supervisor.readiness).toHaveBeenCalledTimes(readinessCalls);
      await f.start(descriptor);
      expect(f.prepare.mock.calls[0]![0].startExpiresAt).toBe(nodeTime + 54000);
      f.complete(result());
      await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    },
  );

  it.each([-60_000, 0, 60_000])(
    "passes F5 the original approved clock and budget to the supervisor without resetting at launch (%d)",
    async (offset) => {
      const hostTime = Date.now();
      let wall = hostTime + offset;
      let mono = 0;
      const f = await fixture({ now: () => wall, monotonic: () => mono });
      Object.assign(f.request, {
        hostTime: new Date(hostTime).toISOString(),
        createdAt: new Date(hostTime).toISOString(),
        expiresAt: new Date(hostTime + 1_800_000).toISOString(),
        maintenanceObservation: { recordId: "record", generation: 1, wakeId: "turn" },
        observationBudget: {
          deadlineAt: new Date(hostTime + 120_000).toISOString(),
          requests: 39,
        },
      });
      const descriptor = await f.prepared();
      wall += 70_000;
      mono += 70_000;
      await f.start(descriptor, {
        approvedAt: new Date(hostTime + 20_000).toISOString(),
      });
      const context = f.prepare.mock.calls[0]![0].observationClock!;
      expect(context).toEqual(
        commandObservationClock(
          descriptor,
          descriptor.prepared.preparedAt,
          context.monotonicNs,
        ),
      );
      expect(context.nodeTime).toBe(new Date(hostTime + offset).toISOString());
      expect(context.budget).toEqual(f.request.observationBudget);
      expect(context.hostClockOffsetMs).toBe(0 - offset);
      expect(context.digest).toBe(descriptor.digest);
      f.complete(result());
      await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    },
  );

  it("keeps the original clock sample on replay and expires on monotonic time despite a small wall-clock rollback", async () => {
    const hostTime = Date.now();
    let wall = hostTime - 120000;
    let monotonic = 0;
    const f = await fixture({ now: () => wall, monotonic: () => monotonic });
    Object.assign(f.request, {
      hostTime: new Date(hostTime).toISOString(),
      createdAt: new Date(hostTime).toISOString(),
      expiresAt: new Date(hostTime + 30000).toISOString(),
    });
    const descriptor = await f.prepared();
    wall += 23500;
    monotonic += 24000;
    await f.manager.handle({ type: "prepare_command_execution", request: f.request });
    const replay = f.messages
      .filter((message) => message.type === "command_execution_prepared")
      .at(-1)!;
    expect(replay).toMatchObject({ ok: true, descriptor });
    await f.start(descriptor);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "expired",
      ownership: "not_started",
    });
  });

  it.each(["slow", "discontinuous"] as const)(
    "refuses %s metadata preparation without creating a new approval descriptor",
    async (failure) => {
      const hostTime = Date.now();
      let wall = hostTime;
      let monotonic = 0;
      const f = await fixture({ now: () => wall, monotonic: () => monotonic });
      const target = await f.repositories.resolve(f.cwd);
      vi.spyOn(f.repositories, "resolve").mockImplementation(async () => {
        monotonic += failure === "slow" ? 5001 : 10;
        wall += failure === "slow" ? 5001 : 2000;
        return target;
      });
      await f.manager.handle({ type: "prepare_command_execution", request: f.request });
      expect(f.messages.at(-1)).toMatchObject({
        type: "command_execution_prepared",
        ok: false,
        error: expect.stringMatching(
          failure === "slow" ? /five-second clock bound/ : /Clock discontinuity/,
        ),
      });
      expect(f.journal.get(f.request.executionId)).toBeUndefined();
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  it("does not turn a zero root exit into success when the supervisor reports an unknown outcome", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.complete(result({ outcomeKnown: false }));
    await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "interrupted",
      ownership: "quiescent",
      exitCode: 0,
      outcomeKnown: false,
    });
    expect(f.admission.active).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")(
    "integrates the real supervisor without launching a Copilot session",
    async () => {
      const f = await fixture();
      privateJournalDirectory(f.journal.directory);
      const { nativeCommandSupervisor } = await import("./command-supervisor-adapter.js");
      const manager = new CommandExecutionManager({
        ...f,
        supervisor: nativeCommandSupervisor,
      });
      await manager.configure(true);
      const request = {
        ...f.request,
        command: '[Console]::Write("manager-native-smoke"); exit 7',
        timeoutMs: 5000,
        hostTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      await manager.handle({ type: "prepare_command_execution", request });
      const prepared = f.messages.find(
        (entry) => entry.type === "command_execution_prepared",
      );
      expect(prepared).toMatchObject({ ok: true });
      const descriptor = (
        prepared as Extract<
          CommandExecutionNodeMessage,
          { type: "command_execution_prepared" }
        >
      ).descriptor!;
      try {
        await manager.handle({
          type: "start_command_execution",
          descriptor,
          approvedBy: "fixture-operator",
          approvedAt: new Date().toISOString(),
          version: 1,
        });
        await vi.waitFor(() => expect(manager.unsettled).toBe(false), { timeout: 20000 });
        expect(f.journal.get(request.executionId)?.receipt).toMatchObject({
          state: "failed",
          exitCode: 7,
          ownership: "quiescent",
          outcomeKnown: true,
        });
        const output = f.journal
          .events(request.executionId, 0)
          .map((event) => Buffer.from(event.data, "base64"));
        expect(Buffer.concat(output).toString("utf8")).toBe("manager-native-smoke");
      } finally {
        if (manager.unsettled) {
          // Preserve uncertain native evidence, rather than deleting a potentially live attempt.
          const root = directories.find((directory) => f.cwd.startsWith(directory))!;
          directories.splice(directories.indexOf(root), 1);
          await manager.cancelAll("Native smoke fixture cleanup.");
        }
      }
    },
    60000,
  );

  it("arbitrates cancellation while supervisor readiness is in flight without releasing the process", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    let ready!: () => void;
    const readiness = new Promise<void>((done) => {
      ready = done;
    });
    f.prepare.mockImplementationOnce(async () => {
      await readiness;
      return {
        identity: { executionId: descriptor.executionId },
        release: f.release,
        cancel: f.cancel,
        result: f.completion,
      };
    });
    const starting = f.start(descriptor);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    await f.manager.handle({
      type: "cancel_command_execution",
      hostId: "host",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      reason: "racing cancellation",
    });
    ready();
    await starting;
    expect(f.release).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "cancelled",
      ownership: "quiescent",
    });
    expect(f.admission.active).toEqual([]);
  });

  it("releases cross-installation leases only after recovered quiescence while preserving an unknown outcome", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    vi.mocked(f.supervisor.recover).mockResolvedValue(
      result({ exitCode: null, interrupted: true }),
    );
    const restarted = new CommandExecutionManager({
      ...f,
      admission: new NodeAdmission(),
    });
    await restarted.recoverAll();
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "interrupted",
      ownership: "quiescent",
      outcomeKnown: false,
    });
    expect(f.journal.get(descriptor.executionId)?.leasesReleased).toBe(true);
    const target = await f.repositories.resolve(f.cwd);
    const leases = await new RepositoryParticipation(async () => target).acquire(
      [target],
      "next command",
      "exclusive",
      true,
    );
    leases[0]!.release();
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(["live", "recovered", "missing"] as const)(
    "blocks other installations on %s unknown command ownership until verified recovery",
    async (kind) => {
      const f = await fixture();
      const descriptor = await f.prepared();
      await f.start(descriptor);
      const uncertain = result({
        ownership: "unknown",
        exitCode: null,
        reason: "Unverified descendants",
      });
      const restarted = new CommandExecutionManager({
        ...f,
        admission: new NodeAdmission(),
      });
      if (kind === "live") {
        f.complete(uncertain);
        await vi.waitFor(() =>
          expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe(
            "reconciliation_required",
          ),
        );
      } else {
        vi.mocked(f.supervisor.recover).mockResolvedValue(
          kind === "missing" ? undefined : uncertain,
        );
        await restarted.recoverAll();
      }
      expect(f.journal.get(descriptor.executionId)?.receipt.ownership).toBe("unknown");
      const target = await f.repositories.resolve(f.cwd);
      const other = new RepositoryParticipation(async () => target);
      await expect(other.participate([f.cwd], "session:other")).rejects.toThrow(
        "Checkout busy",
      );
      await expect(other.acquire([target], "command:other", "command")).rejects.toThrow(
        "Checkout busy",
      );
      vi.mocked(f.supervisor.recover).mockResolvedValue(
        result({ interrupted: true, exitCode: null }),
      );
      await restarted.recoverAll();
      const leases = await other.acquire([target], "command:after-recovery", "command");
      leases[0]!.release();
      expect(f.journal.get(descriptor.executionId)?.leasesReleased).toBe(true);
      expect(f.prepare).toHaveBeenCalledTimes(1);
    },
  );

  it("coalesces truncated output into explicit gaps and retires ACKed history without forgetting execution identity", async () => {
    let wall = Date.now();
    const f = await fixture({ now: () => wall });
    const descriptor = await f.prepared();
    const record = f.journal.get(descriptor.executionId)!;
    record.outputBytes = COMMAND_LIMITS.outputBytes;
    f.journal.save(record);
    await f.start(descriptor);
    f.prepare.mock.calls[0]![0].onOutput("stdout", Buffer.alloc(8 * 1024 * 3));
    f.complete(result());
    await vi.waitFor(() =>
      expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("succeeded"),
    );
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      gaps: [{ from: 1, to: 3 }],
      finalOutputSeq: 3,
    });
    expect(f.journal.events(descriptor.executionId, 0)).toEqual([]);
    await f.manager.handle({
      type: "command_execution_ack",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      digest: descriptor.digest,
      throughSeq: 3,
      terminal: true,
    });
    wall += COMMAND_LIMITS.retentionMs + 1000;
    await f.manager.recoverAll();
    f.journal.prune(wall);
    expect(f.journal.get(descriptor.executionId)).toBeUndefined();
    expect(f.journal.retired(descriptor.executionId)).toBe(true);
    await f.manager.handle({ type: "prepare_command_execution", request: f.request });
    expect(f.messages.at(-1)).toMatchObject({
      type: "command_execution_prepared",
      ok: false,
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent preparation tickets and refuses clock-discontinuous approval", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: COMMAND_LIMITS.maxNodePending + 1 }, (_, index) =>
        f.manager.handle({
          type: "prepare_command_execution",
          request: {
            ...f.request,
            executionId: randomUUID(),
            requestKey: `key-${index}`,
          },
        }),
      ),
    );
    expect(f.journal.all()).toHaveLength(COMMAND_LIMITS.maxNodePending);
    expect(
      f.messages.filter(
        (entry) => entry.type === "command_execution_prepared" && !entry.ok,
      ),
    ).toHaveLength(1);
    const descriptor = f.journal.all()[0]!.descriptor;
    const restarted = new CommandExecutionManager({
      ...f,
      admission: new NodeAdmission(),
    });
    await restarted.configure(true);
    await restarted.handle({
      type: "start_command_execution",
      descriptor,
      approvedBy: "operator",
      approvedAt: new Date().toISOString(),
      version: 1,
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("failed");
  });

  it("does metadata-only preparation, binds approval and launches once with bounded raw output", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.admission.active).toEqual([]);
    expect(f.journal.get(descriptor.executionId)?.launchIntent).toBe(false);
    await f.start(descriptor);
    await f.start(descriptor);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    const input = f.prepare.mock.calls[0]![0];
    input.onOutput("stdout", Buffer.alloc(50000, 255));
    const events = f.messages.filter(
      (entry) => entry.type === "command_execution_output",
    );
    expect(events).toHaveLength(7);
    expect(events.map((entry) => entry.event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const chunks = events.map((entry) => Buffer.from(entry.event.data, "base64"));
    const defaultPageBytes = GetCommandExecutionSchema.parse({
      executionId: descriptor.executionId,
    }).limitBytes;
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      8192, 8192, 8192, 8192, 8192, 8192, 848,
    ]);
    expect(chunks.every((chunk) => chunk.length <= defaultPageBytes)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(50000, 255));
    f.complete(result());
    await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    const receipt = f.journal.get(descriptor.executionId)!.receipt;
    expect(receipt).toMatchObject({
      state: "succeeded",
      ownership: "quiescent",
      finalOutputSeq: 7,
    });
    await f.manager.handle({
      type: "command_execution_ack",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      digest: descriptor.digest,
      throughSeq: 7,
      terminal: true,
    });
    expect(f.journal.get(descriptor.executionId)?.terminalAck).toBe(true);
    expect(f.admission.active).toEqual([]);
  });

  it("durably cancels before prepare/start and never executes a later duplicate", async () => {
    const f = await fixture();
    await f.manager.handle({
      type: "cancel_command_execution",
      hostId: "host",
      executionId: f.request.executionId,
      attemptId: f.request.attemptId,
      reason: "operator cancelled",
    });
    const descriptor = await f.prepared();
    await f.start(descriptor);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("cancelled");
  });

  it("refuses tampered approvals and unnegotiated transport", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start({ ...descriptor, command: "different script" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("failed");
    f.connection().sealed = false;
    await expect(
      f.manager.handle({ type: "prepare_command_execution", request: f.request }),
    ).rejects.toThrow("sealed");
  });

  it("persists output offline and replays with final watermark and forced-cleanup outcome", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.disconnect();
    f.prepare.mock.calls[0]![0].onOutput("stderr", Buffer.from([0, 255, 10]));
    f.complete(result({ descendantCleanupForced: true }));
    await vi.waitFor(() => expect(f.manager.unsettled).toBe(false));
    f.reconnect();
    f.manager.inventory();
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: "command_execution_output",
        event: expect.objectContaining({ data: "AP8K", sequence: 1 }),
      }),
    );
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "interrupted",
      exitCode: 0,
      descendantCleanupForced: true,
      finalOutputSeq: 1,
    });
  });

  it("retains unknown ownership across recovery and never relaunches a crashed attempt", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    const record = f.journal.get(descriptor.executionId)!;
    record.launchIntent = true;
    record.receipt.state = "starting";
    record.receipt.ownership = "unknown";
    f.journal.save(record);
    vi.mocked(f.supervisor.recover).mockImplementation(
      async (_directory, _identity, _descriptor, persistIdentity) => {
        persistIdentity?.({
          executionId: descriptor.executionId,
          attemptId: descriptor.attemptId,
          jobId: "manifest-job",
        });
        return undefined;
      },
    );
    const restarted = new CommandExecutionManager(f);
    await restarted.recoverAll();
    await restarted.configure(true);
    await restarted.handle({
      type: "start_command_execution",
      descriptor,
      approvedBy: "operator",
      approvedAt: new Date().toISOString(),
      version: 1,
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.journal.get(descriptor.executionId)?.identity).toMatchObject({
      jobId: "manifest-job",
    });
    expect(f.journal.get(descriptor.executionId)?.receipt).toMatchObject({
      state: "reconciliation_required",
      ownership: "unknown",
    });
  });

  it("opt-out cancels active jobs and persists receipts without a connection", async () => {
    const f = await fixture();
    const descriptor = await f.prepared();
    await f.start(descriptor);
    f.disconnect();
    await f.manager.configure(false);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.journal.get(descriptor.executionId)?.receipt.state).toBe("cancelled");
    expect(f.manager.readiness.enabled).toBe(false);
    expect(f.admission.active).toEqual([]);
  });
});
