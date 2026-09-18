import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandReceiptSchema,
  type CommandExecutionNodeMessage,
  type CommandPreparation,
} from "@fleet/protocol";
import { canonicalPath } from "./canonical-path.js";
import { CommandJournal } from "./command-journal.js";
import {
  CommandExecutionManager,
  type CommandProcessResult,
  type CommandSupervisor,
} from "./command-execution-manager.js";
import { NodeAdmission } from "./node-admission.js";
import { RepositoryParticipation } from "./repository-participation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(validateTarget?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "fleet-recovery-contract-"));
  const requestedPath = join(root, "checkout");
  await mkdir(requestedPath);
  const checkout = await canonicalPath(requestedPath);
  const cwd = checkout.path;
  const repositories = new RepositoryParticipation(async () => ({
    cwd,
    checkout,
    repository: checkout,
    git: false,
  }));
  await repositories.activate([cwd], true);
  const journal = new CommandJournal(join(root, "journal"), false);
  cleanups.push(async () => {
    journal.close();
    await rm(root, { recursive: true, force: true });
  });
  const admission = new NodeAdmission();
  const messages: CommandExecutionNodeMessage[] = [];
  const recover = vi.fn<CommandSupervisor["recover"]>(async () => undefined);
  const supervisor: CommandSupervisor = {
    readiness: async () => ({
      supported: true,
      reason: "",
      shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    }),
    prepare: vi.fn(async () => {
      throw new Error("Submitted code must not start in recovery fixtures");
    }),
    recover,
  };
  const manager = new CommandExecutionManager({
    journal,
    admission,
    repositories,
    supervisor,
    connection: () => ({
      sealed: true,
      negotiated: true,
      hostId: "host",
      nodeId: "node",
    }),
    send: (message) => {
      messages.push(message);
      return true;
    },
    ...(validateTarget ? { validateTarget } : {}),
  });
  await manager.configure(true);
  const request: CommandPreparation = {
    executionId: randomUUID(),
    attemptId: randomUUID(),
    hostId: "host",
    nodeId: "node",
    leadSessionId: "lead",
    target: { placementId: "placement" },
    requestedPath: cwd,
    command: "Write-Output fixture",
    shell: "windows-powershell-5.1",
    reason: "Recovery fixture",
    requestKey: randomUUID(),
    timeoutMs: 1000,
    createdAt: new Date().toISOString(),
    hostTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await manager.handle({ type: "prepare_command_execution", request });
  const prepared = messages.find(
    (message) => message.type === "command_execution_prepared",
  );
  if (prepared?.type !== "command_execution_prepared" || !prepared.descriptor)
    throw new Error(`Preparation failed: ${JSON.stringify(prepared)}`);
  const descriptor = prepared.descriptor;
  const reconcile = () =>
    manager.handle({
      type: "reconcile_command_executions",
      hostId: "host",
      executions: [
        { executionId: request.executionId, attemptId: request.attemptId, afterSeq: 0 },
      ],
    });
  return {
    root,
    journal,
    admission,
    manager,
    request,
    descriptor,
    messages,
    recover,
    supervisor,
    reconcile,
  };
}

describe("command recovery contracts", () => {
  it("preserves a published no-start cancellation across an admission crash", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    record.admissionIntent = true;
    record.leasesReleased = false;
    record.cancelRequested = true;
    record.receipt = {
      ...record.receipt,
      state: "cancelled",
      reason: "Operator cancelled before launch",
      settledAt: new Date().toISOString(),
      finalOutputSeq: 0,
    };
    f.journal.save(record);
    const published = structuredClone(record.receipt);
    await f.reconcile();
    expect(f.journal.get(f.request.executionId)!.receipt).toEqual(published);
    expect(f.journal.get(f.request.executionId)!.leasesReleased).toBe(true);
    await f.reconcile();
    expect(f.journal.get(f.request.executionId)!.receipt).toEqual(published);
    expect(f.supervisor.prepare).not.toHaveBeenCalled();
  });

  it("settles a pre-launch admission crash with a coherent no-start failure", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    record.admissionIntent = true;
    record.leasesReleased = false;
    f.journal.save(record);
    expect(f.journal.get(f.request.executionId)!.admissionIntent).toBe(true);
    await f.reconcile();
    const recovered = f.journal.get(f.request.executionId)!;
    expect(recovered.receipt).toMatchObject({
      state: "failed",
      ownership: "not_started",
      exitCode: null,
    });
    expect(recovered.leasesReleased).toBe(true);
    expect(CommandReceiptSchema.safeParse(recovered.receipt).success).toBe(true);
    expect(f.supervisor.prepare).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not rewrite a published cancellation during admission unwind (release persistence failure=%s)",
    async (failRelease) => {
      let entered!: () => void;
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let calls = 0;
      const f = await fixture(async () => {
        if (++calls === 2) {
          entered();
          await gate;
        }
      });
      const starting = f.manager.handle({
        type: "start_command_execution",
        descriptor: f.descriptor,
        approvedBy: "operator",
        approvedAt: new Date().toISOString(),
        version: 1,
      });
      await waiting;
      await f.manager.handle({
        type: "cancel_command_execution",
        hostId: "host",
        executionId: f.request.executionId,
        attemptId: f.request.attemptId,
        reason: "Operator cancelled",
      });
      const published = structuredClone(f.journal.get(f.request.executionId)!.receipt);
      if (failRelease) {
        f.journal.db.exec(`CREATE TEMP TRIGGER fail_release BEFORE UPDATE ON executions
        WHEN json_extract(NEW.data,'$.leasesReleased')=1
        BEGIN SELECT RAISE(ABORT, 'fixture release persistence failure'); END;`);
      }
      resume();
      if (failRelease) {
        await expect(starting).rejects.toThrow("fixture release persistence failure");
        expect(f.journal.get(f.request.executionId)!.receipt).toEqual(published);
        f.journal.db.exec("DROP TRIGGER fail_release");
        await f.reconcile();
      } else await starting;
      expect(f.journal.get(f.request.executionId)!.receipt).toEqual(published);
      expect(f.journal.get(f.request.executionId)!.leasesReleased).toBe(true);
      expect(f.admission.active).toEqual([]);
      expect(f.supervisor.prepare).not.toHaveBeenCalled();
    },
  );

  it("recovers only unjournaled native bytes and does not replay them under new sequences", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    record.launchIntent = true;
    record.receipt.state = "running";
    record.receipt.ownership = "active";
    f.journal.save(record);
    const stdout = Buffer.from("prefix-retained native output");
    const stderr = Buffer.from([255, 0, 128, 10]);
    f.journal.output(record, {
      executionId: f.request.executionId,
      attemptId: f.request.attemptId,
      sequence: 1,
      stream: "stdout",
      data: stdout.subarray(0, 7).toString("base64"),
      at: new Date().toISOString(),
    });
    const attempt = join(
      f.journal.directory,
      record.namespace,
      f.request.executionId,
      f.request.attemptId,
    );
    await mkdir(attempt, { recursive: true });
    await writeFile(join(attempt, "stdout.bin"), stdout);
    await writeFile(join(attempt, "stderr.bin"), stderr);
    const stats = (bytes: Buffer) => ({
      bytes: bytes.length,
      retainedBytes: bytes.length,
      droppedBytes: 0,
    });
    const result: CommandProcessResult = {
      ownership: "quiescent",
      exitCode: 0,
      outcomeKnown: true,
      started: true,
      reason: "completed",
      descendantCleanupForced: false,
      outputComplete: true,
      stdout: stats(stdout),
      stderr: stats(stderr),
    };
    f.recover.mockResolvedValue(result);
    await f.reconcile();
    const events = f.journal.events(f.request.executionId, 0);
    const read = (stream: "stdout" | "stderr") =>
      Buffer.concat(
        events
          .filter((event) => event.stream === stream)
          .map((event) => Buffer.from(event.data, "base64")),
      );
    expect(read("stdout")).toEqual(stdout);
    expect(read("stderr")).toEqual(stderr);
    expect(f.journal.get(f.request.executionId)!.receipt.gaps).toEqual([]);
    const sequence = f.journal.get(f.request.executionId)!.lastSequence;
    await f.reconcile();
    expect(f.journal.get(f.request.executionId)!.lastSequence).toBe(sequence);
    expect(f.journal.events(f.request.executionId, 0)).toEqual(events);
  });

  it("commits stream offsets and output events atomically", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    f.journal.db.exec(`CREATE TEMP TRIGGER fail_offset BEFORE INSERT ON output_offsets
      BEGIN SELECT RAISE(ABORT, 'fixture offset failure'); END;`);
    expect(() =>
      f.journal.output(record, {
        executionId: f.request.executionId,
        attemptId: f.request.attemptId,
        sequence: 1,
        stream: "stdout",
        data: "aGVsbG8=",
        at: new Date().toISOString(),
      }),
    ).toThrow("fixture offset failure");
    expect(record.capturedBytes).toBe(0);
    expect(record.lastSequence).toBe(0);
    expect(f.journal.get(f.request.executionId)!.capturedBytes).toBe(0);
    expect(f.journal.outputOffset(f.request.executionId, "stdout")).toBe(0);
    expect(f.journal.events(f.request.executionId, 0)).toEqual([]);
  });

  it("recovers retained bytes with quiescence-only evidence without claiming a known outcome or deleting uncertain logs", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    record.admissionIntent = true;
    record.launchIntent = true;
    record.leasesReleased = false;
    record.receipt.state = "reconciliation_required";
    record.receipt.ownership = "unknown";
    f.journal.save(record);
    const bytes = Buffer.from("retained bytes after parent loss");
    f.journal.output(record, {
      executionId: f.request.executionId,
      attemptId: f.request.attemptId,
      sequence: 1,
      stream: "stdout",
      data: bytes.subarray(0, 5).toString("base64"),
      at: new Date().toISOString(),
    });
    const attempt = join(
      f.journal.directory,
      record.namespace,
      f.request.executionId,
      f.request.attemptId,
    );
    await mkdir(attempt, { recursive: true });
    await writeFile(join(attempt, "stdout.bin"), bytes);
    f.recover.mockResolvedValue({
      ownership: "quiescent",
      reason: "receipt_missing",
      exitCode: null,
      outcomeKnown: false,
      started: null,
      interrupted: true,
      descendantCleanupForced: false,
      outputComplete: false,
      stdout: { bytes: 0, retainedBytes: 0, droppedBytes: 0 },
      stderr: { bytes: 0, retainedBytes: 0, droppedBytes: 0 },
    });
    await f.reconcile();
    const events = f.journal.events(f.request.executionId, 0);
    expect(
      Buffer.concat(events.map((event) => Buffer.from(event.data, "base64"))),
    ).toEqual(bytes);
    expect(f.journal.get(f.request.executionId)!.receipt).toMatchObject({
      state: "interrupted",
      ownership: "quiescent",
      outcomeKnown: false,
      exitCode: null,
      gaps: [{ from: 3, to: 3 }],
    });
    expect(await readFile(join(attempt, "stdout.bin"))).toEqual(bytes);
    await f.reconcile();
    expect(f.journal.events(f.request.executionId, 0)).toEqual(events);
  });

  it("reports parent loss before native release as failed/not_started", async () => {
    const f = await fixture();
    const record = f.journal.get(f.request.executionId)!;
    record.launchIntent = true;
    f.journal.save(record);
    f.recover.mockResolvedValue({
      ownership: "quiescent",
      exitCode: null,
      outcomeKnown: false,
      started: false,
      reason: "parent_lost",
      interrupted: true,
      descendantCleanupForced: false,
    });
    await f.reconcile();
    expect(f.journal.get(f.request.executionId)!.receipt).toMatchObject({
      state: "failed",
      ownership: "not_started",
      exitCode: null,
    });
  });
});
