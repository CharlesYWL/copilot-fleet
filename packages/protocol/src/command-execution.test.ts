import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMMAND_LIMITS,
  CommandExecutionHostMessageSchema,
  CommandExecutionBackupSchema,
  CommandExecutionSchema,
  CommandExecutionPageSchema,
  CommandDecisionSchema,
  PreparedCommandTargetSchema,
  LeadPromptDeliverySchema,
  LeadPromptReceiptSchema,
  CommandOutputEventSchema,
  CommandReceiptSchema,
  CommandTextSchema,
  RunCommandSchema,
  commandDigestPayload,
} from "./command-execution.js";
import {
  BrowserMessageSchema,
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
} from "./index.js";

const at = "2026-09-16T14:00:00.000Z";
const request = {
  target: { placementId: "checkout" },
  command: "git branch --show-current",
  shell: "windows-powershell-5.1",
  reason: "Inspect this checkout",
  timeoutMs: 5_000,
  requestKey: "inspect-1",
} as const;
const identity = {
  key: "machine:volume:file",
  path: "Q:\\repo",
  machineId: "machine",
  volume: "volume",
  fileId: "file",
};
const body = {
  ...request,
  executionId: randomUUID(),
  attemptId: randomUUID(),
  hostId: "host",
  nodeId: "node",
  leadSessionId: "lead",
  requestedPath: "Q:\\repo",
  createdAt: at,
  expiresAt: at,
  hostTime: at,
  prepared: {
    cwd: "Q:\\repo",
    checkout: identity,
    repository: identity,
    shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    admissionVersion: 1 as const,
    preparedAt: at,
    clockUncertaintyMs: 0,
    hostClockOffsetMs: 0,
  },
};

describe("remote command contracts", () => {
  it("accepts approval metadata in detail and live updates while an old browser schema reproduces the reported error", () => {
    const execution = CommandExecutionSchema.parse({
      ...request,
      id: body.executionId,
      attemptId: body.attemptId,
      version: 3,
      hostId: body.hostId,
      nodeId: body.nodeId,
      nodeName: "Node",
      leadSessionId: body.leadSessionId,
      requestedPath: body.requestedPath,
      requestDigest: "a".repeat(64),
      state: "queued",
      ownership: "not_started",
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      approvalScope: "once",
      automaticApproval: false,
    });
    const page = {
      execution,
      events: [],
      nextSeq: 0,
      hasMore: false,
      outputComplete: false,
    };
    const legacy = CommandExecutionPageSchema.extend({
      execution: CommandExecutionSchema.omit({
        approvalScope: true,
        automaticApproval: true,
      }),
    }).safeParse(page);
    expect(legacy.success).toBe(false);
    if (!legacy.success)
      expect(legacy.error.issues).toContainEqual(
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["approvalScope", "automaticApproval"],
          path: ["execution"],
        }),
      );
    expect(CommandExecutionPageSchema.parse(page).execution).toMatchObject({
      approvalScope: "once",
      automaticApproval: false,
    });
    expect(
      BrowserMessageSchema.parse({ type: "command_execution", execution }),
    ).toMatchObject({ execution: { approvalScope: "once", automaticApproval: false } });
  });
  it("carries all operator approval scopes without treating malformed decisions as approval", () => {
    for (const decision of ["allow_once", "allow_session", "allow_always", "deny"]) {
      expect(
        CommandDecisionSchema.safeParse({
          decision,
          expectedVersion: 2,
          digest: "a".repeat(64),
        }).success,
      ).toBe(true);
    }
    expect(
      CommandDecisionSchema.safeParse({
        decision: "allow_all",
        expectedVersion: 2,
        digest: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      CommandDecisionSchema.safeParse({
        decision: "allow_always",
        expectedVersion: -1,
        digest: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
  it("includes the exact reusable rule and policy version in prepared target evidence", () => {
    const permission = {
      reusable: true,
      commandKey: "git status",
      path: body.prepared.cwd,
      policyVersion: 3,
      explanation: "Ordinary flags ignored",
      grantedBy: "session" as const,
    };
    expect(
      PreparedCommandTargetSchema.parse({ ...body.prepared, permission }).permission,
    ).toEqual(permission);
    expect(
      commandDigestPayload({
        ...body,
        prepared: { ...body.prepared, permission },
      }),
    ).not.toEqual(commandDigestPayload(body));
  });
  it("preserves bounded existing attachments through durable lead delivery", () => {
    const delivery = {
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "Inspect this file",
      attachments: [{ name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=" }],
    };
    expect(LeadPromptDeliverySchema.parse(delivery)).toEqual(delivery);
    expect(
      LeadPromptDeliverySchema.safeParse({
        ...delivery,
        attachments: Array.from({ length: 7 }, () => delivery.attachments[0]),
      }).success,
    ).toBe(false);
    expect(
      LeadPromptDeliverySchema.safeParse({
        ...delivery,
        attachments: [{ ...delivery.attachments[0], data: "" }],
      }).success,
    ).toBe(false);
  });

  it("carries stable native conversation and attempt identities in lead receipts", () => {
    const receipt = {
      deliveryId: randomUUID(),
      sessionId: "lead",
      state: "accepted",
      detail: "",
      at,
      nativeSessionId: "native-lead",
      attemptId: randomUUID(),
    };
    expect(LeadPromptReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      LeadPromptReceiptSchema.safeParse({ ...receipt, attemptId: "invalid" }).success,
    ).toBe(false);
    expect(
      LeadPromptReceiptSchema.safeParse({ ...receipt, nativeSessionId: "" }).success,
    ).toBe(false);
  });

  it("defines a complete portable evidence envelope rather than an opaque payload", () => {
    const backup = {
      version: 1,
      namespace: randomUUID(),
      executions: [],
      events: [],
      requests: [],
      attempts: [],
      fences: [],
      evidence: [],
      prompts: [],
      notifications: [],
      clocks: [],
    };
    expect(CommandExecutionBackupSchema.parse(backup)).toEqual(backup);
    expect(
      CommandExecutionBackupSchema.safeParse({
        ...backup,
        attempts: [{ executionId: randomUUID() }],
      }).success,
    ).toBe(false);
    expect(
      CommandExecutionBackupSchema.safeParse({
        ...backup,
        namespace: "not-an-identity",
      }).success,
    ).toBe(false);
  });
  it("requires one exact target and an explicit supported shell edition", () => {
    expect(RunCommandSchema.safeParse(request).success).toBe(true);
    expect(RunCommandSchema.safeParse({ ...request, shell: "powershell" }).success).toBe(
      false,
    );
    expect(RunCommandSchema.safeParse({ ...request, target: {} }).success).toBe(false);
    expect(
      RunCommandSchema.safeParse({
        ...request,
        target: { placementId: "checkout", worktreeId: "tree", generation: 1 },
      }).success,
    ).toBe(false);
    expect(RunCommandSchema.safeParse({ ...request, timeoutMs: 3_600_001 }).success).toBe(
      false,
    );
    expect(RunCommandSchema.safeParse({ ...request, approved: true }).success).toBe(
      false,
    );
  });

  it("bounds UTF-8 bytes rather than characters and rejects NUL", () => {
    expect(
      CommandTextSchema.safeParse("a".repeat(COMMAND_LIMITS.scriptBytes)).success,
    ).toBe(true);
    expect(
      CommandTextSchema.safeParse("a".repeat(COMMAND_LIMITS.scriptBytes + 1)).success,
    ).toBe(false);
    expect(CommandTextSchema.safeParse("界".repeat(5_461)).success).toBe(true);
    expect(CommandTextSchema.safeParse("界".repeat(5_462)).success).toBe(false);
    expect(CommandTextSchema.safeParse("git\0status").success).toBe(false);
  });

  it("hashes the approved descriptor in schema order, excluding its own digest", () => {
    const payload = commandDigestPayload(body);
    const digest = createHash("sha256").update(payload).digest("hex");
    const withDigest = { digest, ...body };
    expect(commandDigestPayload(withDigest)).toBe(payload);
    expect(commandDigestPayload({ ...body, command: "npm run build" })).not.toBe(payload);
    expect(
      commandDigestPayload({
        ...body,
        prepared: { ...body.prepared, cwd: "Q:\\other" },
      }),
    ).not.toBe(payload);
    expect(
      CommandExecutionHostMessageSchema.safeParse({
        type: "start_command_execution",
        descriptor: withDigest,
        approvedBy: "admin",
        approvedAt: at,
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("cannot encode success with unknown ownership, lost outcome or killed descendants", () => {
    const receipt = {
      executionId: body.executionId,
      attemptId: body.attemptId,
      digest: "a".repeat(64),
      state: "succeeded",
      ownership: "quiescent",
      outcomeKnown: true,
      exitCode: 0,
      reason: "",
    };
    expect(CommandReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const patch of [
      { ownership: "unknown" },
      { outcomeKnown: false },
      { exitCode: null },
      { descendantCleanupForced: true },
    ])
      expect(CommandReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(
        false,
      );
    expect(
      CommandReceiptSchema.safeParse({
        ...receipt,
        state: "interrupted",
        exitCode: null,
        outcomeKnown: false,
      }).success,
    ).toBe(true);
    expect(
      CommandReceiptSchema.safeParse({
        ...receipt,
        state: "interrupted",
        ownership: "not_started",
        exitCode: null,
        outcomeKnown: false,
      }).success,
    ).toBe(false);
    expect(
      CommandReceiptSchema.safeParse({
        ...receipt,
        state: "reconciliation_required",
        ownership: "unknown",
      }).success,
    ).toBe(true);
  });

  it("bounds raw output frames, sequence numbers, and Base64 encoding", () => {
    const event = {
      executionId: body.executionId,
      attemptId: body.attemptId,
      sequence: 1,
      stream: "stdout",
      at,
      data: Buffer.alloc(COMMAND_LIMITS.chunkBytes).toString("base64"),
    };
    expect(CommandOutputEventSchema.safeParse(event).success).toBe(true);
    expect(
      CommandOutputEventSchema.safeParse({
        ...event,
        data: Buffer.alloc(COMMAND_LIMITS.chunkBytes + 1).toString("base64"),
      }).success,
    ).toBe(false);
    expect(CommandOutputEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(
      false,
    );
    expect(
      CommandOutputEventSchema.safeParse({ ...event, data: "not base64" }).success,
    ).toBe(false);
  });

  it("keeps new message negotiation off for an older Host", () => {
    const welcome = HostToNodeMessageSchema.parse({ type: "welcome", nodeId: "node" });
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("Expected welcome");
    expect(welcome.commandExecutions).toBe(false);
    expect(welcome.durableLeadDelivery).toBe(false);
    expect(
      NodeToHostMessageSchema.safeParse({
        type: "command_execution_prepared",
        executionId: body.executionId,
        attemptId: body.attemptId,
        ok: true,
      }).success,
    ).toBe(false);
  });
});
