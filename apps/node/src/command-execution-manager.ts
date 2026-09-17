import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import {
  COMMAND_ADMISSION_VERSION,
  COMMAND_LIMITS,
  CommandExecutionHostMessageSchema,
  CommandPreparationSchema,
  PreparedCommandSchema,
  commandDigestPayload,
  terminalCommandExecutionStates,
  type CommandExecutionHostMessage,
  type CommandExecutionNodeMessage,
  type CommandPreparation,
  type CommandReadiness,
  type PreparedCommand,
  type CommandOutputEvent,
} from "@fleet/protocol";
import type { CommandJournal, CommandJournalRecord } from "./command-journal.js";
import type { NodeAdmission, AdmissionTicket } from "./node-admission.js";
import type {
  RepositoryParticipation,
  RepositoryTarget,
} from "./repository-participation.js";
import { CheckoutLocks, type CheckoutLease } from "./checkout-locks.js";
import { assertCommandStorage } from "./command-storage.js";

// Atomic sequence events must fit the Host's default 16 KiB output page.
const OUTPUT_CHUNK_BYTES = Math.min(COMMAND_LIMITS.chunkBytes, 8 * 1024);
const CLOCK_DRIFT_TOLERANCE_MS = 1000;

export type CommandProcessResult = {
  exitCode: number | null;
  reason: string;
  descendantCleanupForced: boolean;
  ownership: "quiescent" | "unknown";
  interrupted?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  started?: boolean | null;
  outcomeKnown?: boolean;
  error?: string | null;
  outputComplete?: boolean;
  stdout?: { bytes: number; retainedBytes: number; droppedBytes: number };
  stderr?: { bytes: number; retainedBytes: number; droppedBytes: number };
};
export type PreparedCommandProcess = {
  identity: object;
  release(): void | Promise<void>;
  cancel(): void | Promise<void>;
  result: Promise<CommandProcessResult>;
};
export type CommandSupervisor = {
  readiness(): Promise<{ supported: boolean; reason: string; shellPath?: string }>;
  prepare(input: {
    executionId: string;
    attemptId: string;
    directory: string;
    cwd: string;
    command: string;
    timeoutMs: number;
    startExpiresAt: number;
    onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => void;
  }): Promise<PreparedCommandProcess>;
  recover(
    directory: string,
    identity?: object,
    descriptor?: PreparedCommand,
    persistIdentity?: (identity: object) => void,
  ): Promise<CommandProcessResult | undefined>;
};
export type CommandConnection = {
  sealed: boolean;
  negotiated: boolean;
  hostId: string;
  nodeId: string;
};
type Running = {
  record: CommandJournalRecord;
  ticket: AdmissionTicket;
  leases: CheckoutLease[];
  process?: PreparedCommandProcess;
  settling?: Promise<void>;
};

export class CommandExecutionManager {
  private readonly active = new Map<string, Running>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly recoveryReads = new Map<string, Promise<void>>();
  private artifactCleanup: Promise<void> | undefined;
  private readonly clocks = new Map<string, { wall: number; monotonic: number }>();
  private readonly liveCursors = new Map<string, number>();
  private supported = false;
  private enabled = false;
  private reason = "Remote command execution is disabled locally.";
  private shellPath = "";
  private stopped = false;

  constructor(
    private readonly options: {
      journal: CommandJournal;
      admission: NodeAdmission;
      repositories: RepositoryParticipation;
      supervisor: CommandSupervisor;
      connection: () => CommandConnection;
      send: (message: CommandExecutionNodeMessage) => boolean;
      validateTarget?: (
        descriptor: CommandPreparation,
        target: RepositoryTarget,
      ) => Promise<void>;
      locks?: CheckoutLocks;
      now?: () => number;
      monotonic?: () => number;
      warn?: (message: string) => void;
    },
  ) {
    options.journal.onFailure = (error) =>
      options.admission.quarantine(
        `Command lifecycle journal cannot persist evidence: ${String(error)}`,
      );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private monotonic(): number {
    return this.options.monotonic?.() ?? performance.now();
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  get readiness(): CommandReadiness {
    return {
      enabled: this.enabled,
      supported: this.supported && !this.options.admission.reason && !this.stopped,
      reason: this.options.admission.reason || this.reason,
      shells: this.supported ? ["windows-powershell-5.1"] : [],
      admissionVersion: COMMAND_ADMISSION_VERSION,
    };
  }
  get unsettled(): boolean {
    return (
      this.active.size > 0 ||
      this.options.journal
        .all()
        .some(
          (record) =>
            record.receipt.ownership === "unknown" ||
            record.receipt.ownership === "active",
        )
    );
  }

  async configure(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.reason = "Remote command execution is disabled locally.";
      await this.cancelAll("Local owner disabled remote commands.");
      return;
    }
    const ready = await this.options.supervisor.readiness();
    this.supported = ready.supported && !!ready.shellPath;
    this.shellPath = ready.shellPath ?? "";
    this.reason = ready.reason;
    if (!this.supported)
      throw new Error(ready.reason || "Command supervisor is unavailable.");
    this.stopped = false;
  }

  private connection(start = false): CommandConnection {
    const context = this.options.connection();
    if (!context.sealed || !context.negotiated)
      throw new Error(
        "Command execution requires a negotiated mutually authenticated sealed channel.",
      );
    if (start && (!this.enabled || !this.readiness.supported))
      throw new Error(this.readiness.reason || "Local command admission is disabled.");
    return context;
  }

  async handle(input: CommandExecutionHostMessage): Promise<void> {
    const message = CommandExecutionHostMessageSchema.parse(input);
    if (message.type === "deliver_lead_prompt") return;
    const context = this.connection();
    if (message.type === "prepare_command_execution") {
      const previous = this.preparing.get(message.request.executionId);
      if (previous) {
        await previous;
        return this.prepare(message.request);
      }
      const pending = this.prepare(message.request);
      this.preparing.set(message.request.executionId, pending);
      try {
        await pending;
      } finally {
        this.preparing.delete(message.request.executionId);
      }
    } else if (message.type === "start_command_execution") {
      const pending = this.starting.get(message.descriptor.executionId);
      if (pending) {
        await pending;
        return;
      }
      const start = this.start(message.descriptor, message.approvedAt).catch(
        (error: unknown) => {
          const record = this.options.journal.get(message.descriptor.executionId);
          if (
            !record ||
            record.launchIntent ||
            record.descriptor.digest !== message.descriptor.digest ||
            record.hostId !== this.options.connection().hostId ||
            record.nodeId !== this.options.connection().nodeId
          )
            throw error;
          if (terminalCommandExecutionStates.has(record.receipt.state)) throw error;
          record.receipt = {
            ...record.receipt,
            state: this.startExpired(record.descriptor) ? "expired" : "failed",
            ownership: "not_started",
            reason: String(error).slice(0, 4000),
            settledAt: this.iso(),
            finalOutputSeq: 0,
          };
          this.options.journal.save(record);
          this.sendReceipt(record);
        },
      );
      this.starting.set(message.descriptor.executionId, start);
      try {
        await start;
      } finally {
        this.starting.delete(message.descriptor.executionId);
      }
    } else if (message.type === "cancel_command_execution") {
      if (message.hostId !== context.hostId)
        throw new Error("Cancellation Host identity mismatch.");
      await this.cancel(message.executionId, message.attemptId, message.reason);
    } else if (message.type === "reconcile_command_executions") {
      if (message.hostId !== context.hostId)
        throw new Error("Reconciliation Host identity mismatch.");
      for (const request of message.executions) {
        const record = this.options.journal.get(request.executionId);
        if (
          !record ||
          record.hostId !== context.hostId ||
          record.descriptor.attemptId !== request.attemptId
        )
          continue;
        this.liveCursors.set(request.executionId, request.afterSeq);
        await this.recover(record);
        this.replay(record, request.afterSeq);
      }
      this.inventory();
    } else {
      const record =
        this.active.get(message.executionId)?.record ??
        this.options.journal.get(message.executionId);
      if (
        !record ||
        record.hostId !== context.hostId ||
        record.descriptor.attemptId !== message.attemptId ||
        record.descriptor.digest !== message.digest
      )
        throw new Error("Command acknowledgement identity mismatch.");
      if (message.terminal && !terminalCommandExecutionStates.has(record.receipt.state))
        throw new Error("Cannot acknowledge a nonterminal command.");
      this.options.journal.acknowledge(record, message.throughSeq, message.terminal);
    }
  }

  private async prepare(input: CommandPreparation): Promise<void> {
    // preparedAt is this receive-time clock sample, not metadata-completion time.
    const wall = this.now();
    const monotonic = this.monotonic();
    const request = CommandPreparationSchema.parse(input);
    try {
      const context = this.connection(true);
      if (request.hostId !== context.hostId || request.nodeId !== context.nodeId)
        throw new Error("Prepared command enrollment identity mismatch.");
      const prior = this.options.journal.get(request.executionId);
      if (prior) {
        if (prior.namespace !== this.options.journal.namespace)
          throw new Error("Preparation belongs to a retired Node identity namespace.");
        const { prepared: _prepared, digest: _digest, ...stored } = prior.descriptor;
        if (
          JSON.stringify(CommandPreparationSchema.parse(stored)) !==
          JSON.stringify(request)
        )
          throw new Error("Execution identity was reused with different preparation.");
        this.prepared(prior.descriptor);
        this.sendReceipt(prior);
        return;
      }
      const journal = this.options.journal;
      if (journal.retired(request.executionId))
        throw new Error(
          "Execution identity expired and remains retired; use a new request and approval.",
        );
      this.expirePrepared();
      if (
        journal
          .all()
          .filter((entry) => !terminalCommandExecutionStates.has(entry.receipt.state))
          .length +
          this.preparing.size >=
        COMMAND_LIMITS.maxNodePending
      )
        throw new Error("Node command preparation quota is full.");
      await this.cleanupAcknowledgedArtifacts();
      journal.prune(this.now());
      const hostTime = Date.parse(request.hostTime);
      const hostClockOffsetMs = hostTime - wall;
      if (
        Date.parse(request.expiresAt) >
          Date.parse(request.createdAt) + COMMAND_LIMITS.approvalMs ||
        Date.parse(request.expiresAt) <=
          hostTime + COMMAND_LIMITS.clockUncertaintyMs + CLOCK_DRIFT_TOLERANCE_MS
      )
        throw new Error(
          "Command approval/start authorization expired or exceeds policy.",
        );
      // Fixed rev-parse/stat metadata only. No lease, script file, or submitted code here.
      await assertCommandStorage(this.options.journal.directory);
      const target = await this.options.repositories.resolve(request.requestedPath);
      if (target.cwd !== target.checkout.path)
        throw new Error(
          "V1 command placements must name a physical checkout root, not a nested directory.",
        );
      if (!this.options.repositories.enabled(target))
        throw new Error("This repository has not completed local activation.");
      await this.options.validateTarget?.(request, target);
      const current = this.connection(true);
      if (current.hostId !== context.hostId || current.nodeId !== context.nodeId)
        throw new Error("Node enrollment changed during preparation.");
      if (this.options.admission.reason) throw new Error(this.options.admission.reason);
      const elapsed = this.monotonic() - monotonic;
      if (elapsed < 0 || Math.abs(this.now() - wall - elapsed) > CLOCK_DRIFT_TOLERANCE_MS)
        throw new Error("Clock discontinuity during command preparation.");
      if (elapsed > COMMAND_LIMITS.clockUncertaintyMs)
        throw new Error(
          "Preparation exceeded the five-second clock bound; request fresh preparation.",
        );
      if (
        elapsed >=
        Date.parse(request.expiresAt) -
          hostTime -
          COMMAND_LIMITS.clockUncertaintyMs -
          CLOCK_DRIFT_TOLERANCE_MS
      )
        throw new Error("Command start authorization expired during preparation.");
      const body = {
        ...request,
        prepared: {
          cwd: target.cwd,
          checkout: target.checkout,
          repository: target.repository,
          shellPath: this.shellPath,
          admissionVersion: COMMAND_ADMISSION_VERSION as 1,
          preparedAt: new Date(wall).toISOString(),
          clockUncertaintyMs: COMMAND_LIMITS.clockUncertaintyMs,
          // Host must bound send-to-reply RTT AND hostTime-to-reply age by five seconds.
          hostClockOffsetMs,
        },
      };
      const descriptor = PreparedCommandSchema.parse({
        ...body,
        digest: createHash("sha256").update(commandDigestPayload(body)).digest("hex"),
      });
      const cancelled = journal.cancellation(request.executionId);
      if (
        cancelled &&
        (cancelled.host !== request.hostId || cancelled.attempt !== request.attemptId)
      )
        throw new Error("Cancellation identity mismatch.");
      const record: CommandJournalRecord = {
        hostId: request.hostId,
        nodeId: request.nodeId,
        namespace: journal.namespace,
        descriptor,
        launchIntent: false,
        admissionIntent: false,
        leasesReleased: true,
        artifactCleanupComplete: false,
        released: false,
        cancelRequested: !!cancelled,
        terminalAck: false,
        acknowledgedSeq: 0,
        lastSequence: 0,
        outputBytes: 0,
        capturedBytes: 0,
        receipt: {
          executionId: request.executionId,
          attemptId: request.attemptId,
          digest: descriptor.digest,
          state: cancelled ? "cancelled" : "awaiting_approval",
          ownership: "not_started",
          exitCode: null,
          reason: cancelled ? "Cancellation preceded approval/start." : "",
          outcomeKnown: false,
          descendantCleanupForced: false,
          gaps: [],
          ...(cancelled ? { settledAt: this.iso(), finalOutputSeq: 0 } : {}),
        },
      };
      journal.save(record);
      this.clocks.set(request.executionId, { wall, monotonic });
      this.prepared(descriptor);
      if (cancelled) this.sendReceipt(record);
    } catch (error) {
      if (
        this.options.connection().hostId !== request.hostId ||
        this.options.connection().nodeId !== request.nodeId
      )
        return;
      this.options.send({
        type: "command_execution_prepared",
        executionId: request.executionId,
        attemptId: request.attemptId,
        ok: false,
        error: String(error).slice(0, 4000),
      });
    }
  }

  private prepared(descriptor: PreparedCommand): void {
    if (
      this.options.connection().hostId !== descriptor.hostId ||
      this.options.connection().nodeId !== descriptor.nodeId
    )
      return;
    this.options.send({
      type: "command_execution_prepared",
      executionId: descriptor.executionId,
      attemptId: descriptor.attemptId,
      ok: true,
      descriptor,
    });
  }

  private assertStart(
    record: CommandJournalRecord,
    descriptor: PreparedCommand,
    approvedAt: string,
  ): void {
    const context = this.connection(true);
    if (
      record.hostId !== context.hostId ||
      record.nodeId !== context.nodeId ||
      record.namespace !== this.options.journal.namespace ||
      record.descriptor.digest !== descriptor.digest ||
      createHash("sha256").update(commandDigestPayload(descriptor)).digest("hex") !==
        descriptor.digest
    )
      throw new Error(
        "Approved immutable command descriptor does not match preparation.",
      );
    if (
      Date.parse(approvedAt) < Date.parse(descriptor.createdAt) ||
      Date.parse(approvedAt) >
        this.now() +
          descriptor.prepared.hostClockOffsetMs +
          descriptor.prepared.clockUncertaintyMs
    )
      throw new Error("Approval timestamp is invalid.");
    const clock = this.clocks.get(descriptor.executionId);
    if (
      !clock ||
      this.monotonic() < clock.monotonic ||
      Math.abs(this.now() - clock.wall - (this.monotonic() - clock.monotonic)) >
        CLOCK_DRIFT_TOLERANCE_MS
    )
      throw new Error(
        "Clock discontinuity or Node restart invalidated unstarted preparation; request new approval.",
      );
    if (this.startExpired(descriptor))
      throw new Error("Approved start authorization expired.");
    if (descriptor.prepared.shellPath !== this.shellPath)
      throw new Error("Approved shell identity changed.");
  }

  private deadline(descriptor: PreparedCommand): number {
    // The supervisor checks an absolute wall deadline, so reserve the allowed post-sample drift too.
    return (
      Date.parse(descriptor.expiresAt) -
      descriptor.prepared.hostClockOffsetMs -
      descriptor.prepared.clockUncertaintyMs -
      CLOCK_DRIFT_TOLERANCE_MS
    );
  }

  private startExpired(descriptor: PreparedCommand): boolean {
    const clock = this.clocks.get(descriptor.executionId);
    return (
      this.now() >= this.deadline(descriptor) ||
      (!!clock &&
        this.monotonic() - clock.monotonic >= this.deadline(descriptor) - clock.wall)
    );
  }

  private async start(descriptor: PreparedCommand, approvedAt: string): Promise<void> {
    const record = this.options.journal.get(descriptor.executionId);
    if (!record) throw new Error("Unknown command preparation; never execute history.");
    const context = this.connection();
    if (record.hostId !== context.hostId || record.nodeId !== context.nodeId)
      throw new Error("Command enrollment identity mismatch.");
    if (record.descriptor.digest !== descriptor.digest)
      throw new Error("Approved descriptor mismatch.");
    if (record.launchIntent || terminalCommandExecutionStates.has(record.receipt.state)) {
      this.sendReceipt(record);
      return;
    }
    this.assertStart(record, descriptor, approvedAt);
    if (
      record.cancelRequested ||
      this.options.journal.cancellation(descriptor.executionId)
    ) {
      await this.cancel(
        descriptor.executionId,
        descriptor.attemptId,
        "Cancelled before launch.",
      );
      return;
    }
    if (this.active.size || this.unsettled)
      throw new Error("Node already owns an active or uncertain command.");
    const ticket = this.options.admission.enter(`command:${descriptor.executionId}`);
    const running: Running = { record, ticket, leases: [] };
    // Register before the first await; cancellation/maintenance sees pending admission.
    this.active.set(descriptor.executionId, running);
    try {
      await assertCommandStorage(this.options.journal.directory);
      record.admissionIntent = true;
      record.leasesReleased = false;
      this.options.journal.save(record);
      const target = await this.options.repositories.resolve(descriptor.prepared.cwd);
      if (
        target.cwd !== descriptor.prepared.cwd ||
        target.checkout.key !== descriptor.prepared.checkout.key ||
        target.repository.key !== descriptor.prepared.repository.key
      )
        throw new Error("Approved physical target changed.");
      await this.options.validateTarget?.(descriptor, target);
      running.leases = await this.options.repositories.acquire(
        [target],
        `command:${descriptor.executionId}`,
        "exclusive",
        true,
      );
      const locks = this.options.locks ?? new CheckoutLocks();
      locks.bindScope(target.checkout, target.git ? target.repository : undefined);
      if (target.git) {
        locks.bindScope(target.repository, target.repository);
        running.leases.push(
          locks.acquire(target.repository, {
            owner: `command:${descriptor.executionId}`,
            attempt: descriptor.attemptId,
            kind: "admin",
          }),
        );
      }
      running.leases.push(
        locks.acquire(target.checkout, {
          owner: `command:${descriptor.executionId}`,
          attempt: descriptor.attemptId,
          kind: "worker",
        }),
      );
      // The supervisor exclusively creates the attempt itself, not its namespace ancestors.
      await mkdir(dirname(this.attemptDirectory(record)), {
        recursive: true,
        mode: 0o700,
      });
      for (const lease of running.leases) await lease.revalidate();
      await this.options.validateTarget?.(descriptor, target);
      await assertCommandStorage(this.options.journal.directory);
      ticket.revalidate();
      this.assertStart(record, descriptor, approvedAt);
      if (this.options.journal.cancellation(descriptor.executionId))
        throw new Error("Cancelled during launch admission.");
      record.launchIntent = true;
      record.receipt = {
        ...record.receipt,
        state: "starting",
        ownership: "unknown",
        reason: "Durable launch intent; waiting for independent supervisor.",
      };
      this.options.journal.save(record);
      for (const lease of running.leases) lease.processPending();
      const child = await this.options.supervisor.prepare({
        executionId: descriptor.executionId,
        attemptId: descriptor.attemptId,
        directory: this.attemptDirectory(record),
        cwd: descriptor.prepared.cwd,
        command: descriptor.command,
        timeoutMs: descriptor.timeoutMs,
        startExpiresAt: this.deadline(descriptor),
        onOutput: (stream, bytes) => this.output(record, stream, bytes),
      });
      running.process = child;
      record.identity = child.identity as Record<string, unknown>;
      this.options.journal.save(record);
      running.settling = child.result
        .then((result) => this.finish(record, result))
        .finally(() => {
          delete running.process;
        })
        .catch((error: unknown) => {
          this.options.admission.quarantine(
            `Command outcome persistence failed: ${String(error)}`,
          );
        });
      await assertCommandStorage(this.options.journal.directory);
      ticket.revalidate();
      this.assertStart(record, descriptor, approvedAt);
      if (this.options.journal.cancellation(descriptor.executionId)) {
        record.cancelRequested = true;
        record.receipt.state = "cancelling";
        this.options.journal.save(record);
        await child.cancel();
      } else {
        // Synchronous durable release arbitration: cancellation cannot interleave this commit.
        record.released = true;
        record.receipt = {
          ...record.receipt,
          state: "running",
          ownership: "active",
          startedAt: this.iso(),
          reason: "",
        };
        this.options.journal.save(record);
        await child.release();
      }
      this.sendReceipt(record);
    } catch (error) {
      const settled = this.options.journal.get(descriptor.executionId);
      if (
        settled &&
        ["quiescent", "not_started"].includes(settled.receipt.ownership) &&
        terminalCommandExecutionStates.has(settled.receipt.state)
      ) {
        Object.assign(record, settled);
        if (!record.leasesReleased)
          this.release(record, settled.receipt.ownership === "quiescent");
        this.sendReceipt(record);
        return;
      }
      if (record.launchIntent) record.supervisionError ??= String(error).slice(0, 4000);
      if (running.process) {
        record.cancelRequested = true;
        this.options.journal.save(record);
        await running.process.cancel();
        await running.settling;
      } else if (record.launchIntent) {
        record.receipt = {
          ...record.receipt,
          state: "reconciliation_required",
          ownership: "unknown",
          reason: record.supervisionError ?? String(error).slice(0, 4000),
        };
        this.options.journal.save(record);
        for (const lease of running.leases)
          lease.requireReconciliation(record.receipt.reason);
        this.sendReceipt(record);
      } else {
        record.receipt = {
          ...record.receipt,
          state: this.options.journal.cancellation(descriptor.executionId)
            ? "cancelled"
            : "failed",
          ownership: "not_started",
          reason: String(error).slice(0, 4000),
          finalOutputSeq: 0,
          settledAt: this.iso(),
        };
        this.options.journal.save(record);
        this.release(record);
        this.sendReceipt(record);
      }
    }
  }

  private output(
    record: CommandJournalRecord,
    stream: "stdout" | "stderr",
    bytes: Buffer,
  ): void {
    for (let start = 0; start < bytes.length; start += OUTPUT_CHUNK_BYTES) {
      const event: CommandOutputEvent = {
        executionId: record.descriptor.executionId,
        attemptId: record.descriptor.attemptId,
        sequence: record.lastSequence + 1,
        stream,
        data: bytes.subarray(start, start + OUTPUT_CHUNK_BYTES).toString("base64"),
        at: this.iso(),
      };
      try {
        if (this.options.journal.output(record, event))
          this.replay(
            record,
            this.liveCursors.get(event.executionId) ?? record.acknowledgedSeq,
            false,
          );
      } catch (error) {
        this.options.admission.quarantine(
          `Command journal write failed: ${String(error)}`,
        );
        void this.active.get(record.descriptor.executionId)?.process?.cancel();
        return;
      }
    }
  }

  private async finish(
    record: CommandJournalRecord,
    result: CommandProcessResult,
  ): Promise<void> {
    const quiescent = result.ownership === "quiescent";
    if (quiescent) await this.recoverRetainedOutput(record, result);
    if (result.error) record.supervisionError = result.error.slice(0, 4000);
    const notStarted = quiescent && result.started === false;
    const outcomeKnown = result.outcomeKnown ?? result.exitCode !== null;
    const interrupted =
      !!result.interrupted ||
      result.descendantCleanupForced ||
      !outcomeKnown ||
      result.exitCode === null;
    const state = !quiescent
      ? "reconciliation_required"
      : notStarted
        ? result.reason === "start_expired" || result.timedOut
          ? "expired"
          : result.cancelled
            ? "cancelled"
            : "failed"
        : result.timedOut
          ? "timed_out"
          : result.cancelled
            ? "cancelled"
            : interrupted
              ? "interrupted"
              : result.exitCode === 0
                ? "succeeded"
                : "failed";
    if (
      (result.stdout &&
        result.stderr &&
        result.stdout.bytes + result.stderr.bytes > record.capturedBytes) ||
      result.outputComplete === false
    ) {
      const sequence = ++record.lastSequence;
      const last = record.receipt.gaps.at(-1);
      if (last && (last.to === sequence - 1 || record.receipt.gaps.length >= 128))
        last.to = sequence;
      else record.receipt.gaps.push({ from: sequence, to: sequence });
    }
    record.receipt = {
      ...record.receipt,
      state,
      ownership: notStarted ? "not_started" : result.ownership,
      exitCode: result.exitCode,
      outcomeKnown,
      reason: (result.error ? `${result.reason}: ${result.error}` : result.reason).slice(
        0,
        4000,
      ),
      descendantCleanupForced: result.descendantCleanupForced,
      finalOutputSeq: record.lastSequence,
      ...(quiescent ? { settledAt: this.iso() } : {}),
    };
    if (notStarted) delete record.receipt.startedAt;
    this.options.journal.save(record);
    if (quiescent) {
      if (this.active.has(record.descriptor.executionId)) this.release(record, true);
      else if (record.admissionIntent && !record.leasesReleased)
        await this.releaseRecovered(record);
      // Incomplete evidence does not prove that the native writers have finished.
      if (result.outputComplete !== false) {
        for (const name of ["stdout.bin", "stderr.bin"])
          await this.removeArtifact(join(this.attemptDirectory(record), name));
      }
    }
    this.sendReceipt(record);
  }

  private async recoverRetainedOutput(
    record: CommandJournalRecord,
    result: CommandProcessResult,
  ): Promise<void> {
    const missingCounters =
      result.reason === "receipt_missing" && result.outputComplete === false;
    if (!result.stdout && !result.stderr && !missingCounters) return;
    const journal = this.options.journal;
    const id = record.descriptor.executionId;
    if (
      journal.outputOffset(id, "stdout") + journal.outputOffset(id, "stderr") !==
      record.capturedBytes
    ) {
      throw new Error(
        "Native output offsets are incomplete; preserve the attempt for reconciliation.",
      );
    }
    let totalRetained = 0;
    for (const stream of ["stdout", "stderr"] as const) {
      let retained = result[stream]?.retainedBytes;
      const path = join(this.attemptDirectory(record), `${stream}.bin`);
      if (missingCounters) {
        try {
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error(
              "Retained native output is not a regular file; preserve the attempt.",
            );
          retained = metadata.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (retained === undefined) continue;
      totalRetained += retained;
      if (totalRetained > COMMAND_LIMITS.outputBytes)
        throw new Error(
          "Retained native output exceeds the capture bound; preserve the attempt.",
        );
      let offset = journal.outputOffset(id, stream);
      if (offset >= retained) continue;
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < retained)
        throw new Error(
          "Retained native output changed; preserve the attempt for reconciliation.",
        );
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(OUTPUT_CHUNK_BYTES);
        while (offset < retained) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, retained - offset),
            offset,
          );
          if (!bytesRead)
            throw new Error("Retained native output ended before its watermark.");
          this.output(record, stream, buffer.subarray(0, bytesRead));
          if (journal.outputOffset(id, stream) !== offset + bytesRead)
            throw new Error(
              "Native output could not be journaled; retain its original bytes.",
            );
          offset += bytesRead;
        }
      } finally {
        await file.close();
      }
    }
  }

  private async releaseRecovered(record: CommandJournalRecord): Promise<void> {
    const target = await this.options.repositories.resolve(
      record.descriptor.prepared.cwd,
    );
    if (
      target.checkout.key !== record.descriptor.prepared.checkout.key ||
      target.repository.key !== record.descriptor.prepared.repository.key
    ) {
      this.options.admission.quarantine(
        "Recovered command target identity changed; old locks remain quarantined.",
      );
      return;
    }
    const owner = `command:${record.descriptor.executionId}`;
    const locks = this.options.locks ?? new CheckoutLocks();
    locks.bindScope(target.checkout, target.git ? target.repository : undefined);
    locks.releaseRecoveredCommand(target.checkout, owner, record.descriptor.attemptId);
    if (target.git) {
      locks.bindScope(target.repository, target.repository);
      locks.releaseRecoveredCommand(
        target.repository,
        owner,
        record.descriptor.attemptId,
        true,
      );
    }
    this.options.repositories.releaseRecoveredCommand(target, owner);
    record.leasesReleased = true;
    this.options.journal.save(record);
  }

  private release(record: CommandJournalRecord, quiescent = false): void {
    const running = this.active.get(record.descriptor.executionId);
    if (!running) return;
    for (const lease of [...running.leases].reverse()) {
      if (quiescent) lease.processesQuiesced();
      lease.release();
    }
    running.ticket.release();
    this.active.delete(record.descriptor.executionId);
    record.leasesReleased = true;
    this.options.journal.save(record);
  }

  private attemptDirectory(record: CommandJournalRecord): string {
    return join(
      this.options.journal.directory,
      record.namespace,
      record.descriptor.executionId,
      record.descriptor.attemptId,
    );
  }

  private async cancel(id: string, attempt: string, reason: string): Promise<void> {
    const host = this.options.connection().hostId;
    const record = this.active.get(id)?.record ?? this.options.journal.get(id);
    if (record && (record.hostId !== host || record.descriptor.attemptId !== attempt))
      throw new Error("Command cancel identity mismatch.");
    this.options.journal.cancel(id, host, attempt);
    if (!record) return;
    if (terminalCommandExecutionStates.has(record.receipt.state)) {
      this.sendReceipt(record);
      return;
    }
    record.cancelRequested = true;
    record.receipt = {
      ...record.receipt,
      state: record.launchIntent ? "cancelling" : "cancelled",
      reason: record.supervisionError
        ? `${reason.slice(0, 1000)}\nSupervision: ${record.supervisionError.slice(0, 2900)}`
        : reason.slice(0, 4000),
      ...(!record.launchIntent
        ? { ownership: "not_started" as const, settledAt: this.iso(), finalOutputSeq: 0 }
        : {}),
    };
    this.options.journal.save(record);
    const running = this.active.get(id);
    if (running?.process) await running.process.cancel();
    this.sendReceipt(record);
  }

  private sendReceipt(record: CommandJournalRecord): void {
    if (
      this.options.connection().hostId !== record.hostId ||
      this.options.connection().nodeId !== record.nodeId
    )
      return;
    this.options.send({ type: "command_execution_update", receipt: record.receipt });
  }

  private replay(record: CommandJournalRecord, afterSeq: number, receipt = true): void {
    if (
      this.options.connection().hostId !== record.hostId ||
      this.options.connection().nodeId !== record.nodeId
    )
      return;
    let cursor = afterSeq;
    for (const event of this.options.journal.events(
      record.descriptor.executionId,
      cursor,
    )) {
      if (!this.options.send({ type: "command_execution_output", event })) break;
      cursor = event.sequence;
    }
    this.liveCursors.set(record.descriptor.executionId, cursor);
    if (receipt) this.sendReceipt(record);
  }

  inventory(): void {
    const context = this.connection();
    this.expirePrepared();
    const records = this.options.journal
      .all()
      .filter(
        (record) => record.hostId === context.hostId && record.nodeId === context.nodeId,
      );
    const unresolved = records.filter((record) => !record.terminalAck);
    for (let index = 0; index < Math.max(1, unresolved.length); index += 128)
      this.options.send({
        type: "command_execution_inventory",
        readiness: this.readiness,
        executions: unresolved.slice(index, index + 128).map((record) => record.receipt),
      });
    for (const record of unresolved) this.replay(record, record.acknowledgedSeq);
  }

  flush(): void {
    if (!this.options.connection().sealed || !this.options.connection().negotiated)
      return;
    for (const record of this.options.journal.all()) {
      if (record.hostId !== this.options.connection().hostId || record.terminalAck)
        continue;
      this.replay(
        record,
        this.liveCursors.get(record.descriptor.executionId) ?? record.acknowledgedSeq,
      );
    }
  }

  async recoverAll(): Promise<void> {
    this.expirePrepared();
    for (const record of this.options.journal.all()) await this.recover(record);
    await this.cleanupAcknowledgedArtifacts();
  }

  private async removeArtifact(path: string): Promise<boolean> {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw error;
      (this.options.warn ?? console.warn)(
        `Command artifact cleanup deferred (${code}) for ${path}: ${String(error)}`,
      );
      return false;
    }
  }

  private cleanupAcknowledgedArtifacts(): Promise<void> {
    if (this.artifactCleanup) return this.artifactCleanup;
    const pending = this.cleanArtifacts().finally(() => {
      this.artifactCleanup = undefined;
    });
    this.artifactCleanup = pending;
    return pending;
  }

  private async cleanArtifacts(): Promise<void> {
    for (const record of this.options.journal.all()) {
      const id = record.descriptor.executionId;
      if (
        !record.terminalAck ||
        !record.leasesReleased ||
        record.artifactCleanupComplete ||
        !["quiescent", "not_started"].includes(record.receipt.ownership) ||
        !record.receipt.settledAt ||
        this.now() - Date.parse(record.receipt.settledAt) < COMMAND_LIMITS.replayMs ||
        this.active.has(id) ||
        this.starting.has(id) ||
        this.recoveryReads.has(id)
      )
        continue;
      if (await this.removeArtifact(this.attemptDirectory(record))) {
        record.artifactCleanupComplete = true;
        this.options.journal.save(record);
      }
    }
  }

  private expirePrepared(): void {
    for (const record of this.options.journal.all()) {
      if (
        record.launchIntent ||
        record.admissionIntent ||
        terminalCommandExecutionStates.has(record.receipt.state) ||
        this.now() < this.deadline(record.descriptor)
      )
        continue;
      record.receipt = {
        ...record.receipt,
        state: "expired",
        ownership: "not_started",
        finalOutputSeq: 0,
        settledAt: this.iso(),
        reason: "Unstarted command authorization expired.",
      };
      this.options.journal.save(record);
    }
  }

  private recover(record: CommandJournalRecord): Promise<void> {
    const id = record.descriptor.executionId;
    const prior = this.recoveryReads.get(id);
    if (prior) return prior;
    const pending = this.recoverAttempt(record).finally(() =>
      this.recoveryReads.delete(id),
    );
    this.recoveryReads.set(id, pending);
    return pending;
  }

  private async recoverAttempt(record: CommandJournalRecord): Promise<void> {
    if (
      this.starting.has(record.descriptor.executionId) ||
      this.active.get(record.descriptor.executionId)?.process
    )
      return;
    if (!record.launchIntent) {
      if (record.admissionIntent && !record.leasesReleased) {
        await this.releaseRecovered(record);
        if (!terminalCommandExecutionStates.has(record.receipt.state)) {
          record.receipt = {
            ...record.receipt,
            state: "failed",
            ownership: "not_started",
            finalOutputSeq: record.lastSequence,
            settledAt: this.iso(),
            reason:
              "Node restarted before durable launch intent; no process was started.",
          };
          this.options.journal.save(record);
        }
      }
      return;
    }
    if (terminalCommandExecutionStates.has(record.receipt.state)) {
      if (
        ["quiescent", "not_started"].includes(record.receipt.ownership) &&
        !record.leasesReleased
      )
        await this.releaseRecovered(record);
      return;
    }
    const receipt = await this.options.supervisor.recover(
      this.attemptDirectory(record),
      record.identity,
      record.descriptor,
      (identity) => {
        record.identity = identity as Record<string, unknown>;
        this.options.journal.save(record);
      },
    );
    if (receipt) await this.finish(record, receipt);
    else {
      record.receipt = {
        ...record.receipt,
        state: "reconciliation_required",
        ownership: "unknown",
        reason: "No verified supervisor quiescence receipt. Never relaunch this attempt.",
      };
      this.options.journal.save(record);
    }
  }

  async cancelAll(reason: string): Promise<void> {
    for (const record of this.options.journal.all()) {
      if (
        record.hostId !== this.options.connection().hostId ||
        terminalCommandExecutionStates.has(record.receipt.state)
      )
        continue;
      await this.cancel(
        record.descriptor.executionId,
        record.descriptor.attemptId,
        reason,
      );
    }
    await Promise.allSettled(this.starting.values());
    const settled = await Promise.allSettled(
      [...this.active.values()]
        .map((running) => running.settling)
        .filter((entry) => entry !== undefined),
    );
    if (settled.some((entry) => entry.status === "rejected") || this.unsettled)
      throw new Error(
        "Command process ownership remains unknown; admission stays closed.",
      );
  }

  async restore(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    this.reason = "Node identity restored; explicit local reactivation is required.";
    await this.cancelAll("Node identity is being restored.");
    this.options.journal.rotateNamespace();
  }
}
