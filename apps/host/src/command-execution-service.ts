import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND_ADMISSION_VERSION,
  COMMAND_EXECUTION_CAPABILITY,
  COMMAND_PERMISSIONS_CAPABILITY,
  COMMAND_LIMITS,
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  CommandDecisionSchema,
  CommandExecutionNodeMessageSchema,
  CommandExecutionSchema,
  CommandPreparationSchema,
  GetCommandExecutionSchema,
  RunCommandSchema,
  commandDigestPayload,
  terminalCommandExecutionStates,
  terminalRunStates,
  terminalSessionStates,
  type CommandDecision,
  type CommandApprovalScope,
  type CommandExecution,
  type CommandExecutionHostMessage,
  type CommandExecutionNodeMessage,
  type CommandReadiness,
  type CommandReceipt,
  type FleetSession,
  type LeadPromptDelivery,
  type LeadPromptReceipt,
  type PromptAttachment,
  type NodeReady,
  type RunCommand,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";
import {
  CommandConflict,
  mergeCommandGaps,
  type PromptRecord,
} from "./command-execution-store.js";
import { HOST_IDENTITY_ID_SETTING } from "./auth/host-identity.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const activeStates = new Set([
  "starting",
  "running",
  "cancelling",
  "reconciliation_required",
]);
const normalizedPath = (path: string) =>
  path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const insidePath = (path: string, root: string) =>
  normalizedPath(path) === normalizedPath(root) ||
  normalizedPath(path).startsWith(`${normalizedPath(root)}\\`);

/** Durable dispatch arbitration; reusable command/path permissions belong to Nodes. */
export class CommandExecutionService {
  private readonly peers = new Map<
    string,
    {
      link: SealedNodeLink;
      commandProtocol: boolean;
      capabilities: string[];
      readiness?: CommandReadiness | undefined;
      sentRevocations: Set<string>;
    }
  >();
  private readonly observations = new Set<string>();
  private readonly preparationMeasurements = new Map<
    string,
    { sentWall: number; sentMonotonic: number; link: SealedNodeLink }
  >();
  private lastSweep = 0;
  constructor(private readonly service: FleetService) {}
  private get store() {
    return this.service.store;
  }
  private get records() {
    return this.store.commands;
  }

  list(input: Parameters<typeof this.records.list>[0] = {}) {
    return this.records.list(input);
  }
  get(id: string) {
    return this.records.get(id);
  }

  reconcileNotifications(): void {
    for (const execution of this.records.list({ limit: 10_000 }))
      this.service.notifications.syncCommandExecution(execution);
  }

  nodeReady(
    nodeId: string,
    inventory: Pick<NodeReady, "capabilities" | "commandExecution">,
  ): {
    commandExecutions: boolean;
    commandPermissions: boolean;
    durableLeadDelivery: boolean;
  } {
    const link = this.service.nodeSocket(nodeId);
    if (!(link instanceof SealedNodeLink)) {
      this.peers.delete(nodeId);
      return {
        commandExecutions: false,
        commandPermissions: false,
        durableLeadDelivery: false,
      };
    }
    this.peers.set(nodeId, {
      link,
      commandProtocol: inventory.commandExecution !== undefined,
      capabilities: [...inventory.capabilities],
      readiness: inventory.commandExecution,
      sentRevocations: new Set(),
    });
    return {
      commandExecutions: this.commandProtocol(nodeId),
      commandPermissions: this.capable(nodeId, COMMAND_PERMISSIONS_CAPABILITY),
      durableLeadDelivery: this.capable(nodeId, DURABLE_LEAD_DELIVERY_CAPABILITY),
    };
  }

  private capable(nodeId: string, capability: string): boolean {
    const link = this.service.nodeSocket(nodeId);
    const peer = this.peers.get(nodeId);
    return (
      link instanceof SealedNodeLink &&
      link.readyState === link.OPEN &&
      peer?.link === link &&
      peer.capabilities.includes(capability)
    );
  }

  /** Recovery remains available when local opt-out or uncertainty closes start admission. */
  private commandProtocol(nodeId: string): boolean {
    const link = this.service.nodeSocket(nodeId);
    const peer = this.peers.get(nodeId);
    return (
      link instanceof SealedNodeLink &&
      link.readyState === link.OPEN &&
      peer?.link === link &&
      peer.commandProtocol
    );
  }

  durableLead(leadId: string): boolean {
    const lead = this.store.getSession(leadId);
    return !!lead && this.capable(lead.nodeId, DURABLE_LEAD_DELIVERY_CAPABILITY);
  }

  private lead(leadId: string): FleetSession {
    const lead = this.store.getSession(leadId);
    if (
      !lead ||
      lead.runRole !== "lead" ||
      terminalSessionStates.has(lead.state) ||
      lead.cleanupRequested ||
      lead.stopRequested ||
      this.store.getSessionTransitionIntent(lead.id) === "stop" ||
      (lead.runId &&
        terminalRunStates.has(this.store.getRun(lead.runId)?.state ?? "cancelled"))
    )
      throw new CommandConflict("lead_not_live");
    return lead;
  }

  private assertReadiness(nodeId: string, shell: RunCommand["shell"]): void {
    const readiness = this.peers.get(nodeId)?.readiness;
    const permissions = this.capable(nodeId, COMMAND_PERMISSIONS_CAPABILITY);
    if (
      !this.capable(nodeId, COMMAND_EXECUTION_CAPABILITY) ||
      (!permissions && !readiness?.enabled) ||
      !readiness?.supported ||
      readiness.admissionVersion !== COMMAND_ADMISSION_VERSION ||
      !readiness.shells.includes(shell)
    )
      throw new CommandConflict(
        "unsupported_command_target",
        readiness?.reason ||
          (permissions
            ? "The target requires a supported supervisor and ready shell on a sealed command-capable Node."
            : "The target requires an opted-in, ready Node on a sealed command-capable connection. Upgrade the Node for Host permission prompts and reusable scopes."),
      );
  }

  private assertReusablePermission(execution: CommandExecution): void {
    if (!this.capable(execution.nodeId, COMMAND_PERMISSIONS_CAPABILITY))
      throw new CommandConflict(
        "command_permission_upgrade_required",
        "This Node supports Once only. Upgrade it for session and always permissions.",
      );
    const prepared = execution.descriptor?.prepared;
    const permission = prepared?.permission;
    if (
      !permission?.reusable ||
      !permission.commandKey?.trim() ||
      normalizedPath(permission.path) !== normalizedPath(prepared!.cwd)
    )
      throw new CommandConflict("command_permission_not_reusable");
  }

  private target(
    leadId: string,
    request: RunCommand,
  ): { nodeId: string; path: string; taskId?: string } {
    let taskId = request.taskId;
    let nodeId: string;
    let path: string;
    if ("placementId" in request.target) {
      const placement = this.store.getPlacement(request.target.placementId);
      if (!placement) throw new CommandConflict("target_not_found");
      nodeId = placement.nodeId;
      path = placement.localPath;
      if (
        [
          ...this.store.listManagedWorktrees(),
          ...this.store.listDerivedWorkspaces(),
        ].some((tree) => tree.nodeId === nodeId && insidePath(path, tree.path))
      )
        throw new CommandConflict(
          "managed_binding_required",
          "Use the exact managed worktree ID and generation; placement aliases cannot bypass ownership.",
        );
      if (
        taskId &&
        this.store.getRun(taskId)?.workspaceBinding?.effectiveMode === "managed"
      )
        throw new CommandConflict(
          "managed_target_not_mutable",
          "Managed tasks cannot substitute their source placement.",
        );
    } else {
      const tree = this.store.getAnyManagedWorkspace(request.target.worktreeId);
      if (!tree || tree.generation !== request.target.generation)
        throw new CommandConflict("target_generation_conflict");
      if (taskId && tree.runId !== taskId)
        throw new CommandConflict("task_owner_conflict");
      taskId = tree.runId;
      nodeId = tree.nodeId;
      path = tree.path;
      const run = this.store.getRun(taskId);
      const trees = [
        ...this.store.listManagedWorktrees(),
        ...this.store.listDerivedWorkspaces(),
      ].filter((entry) => entry.runId === taskId);
      const steps = this.store.listRunSteps(taskId);
      if (
        !run ||
        !["running", "planning", "awaiting_lead"].includes(run.state) ||
        run.workspaceBinding?.initialization !== "ready" ||
        run.workspaceBinding.aggregationState !== "not_started" ||
        !["ready", "active"].includes(tree.state) ||
        !tree.checkout ||
        tree.abandonedAt ||
        tree.orphanedAt ||
        trees.some(
          (entry) =>
            entry.resultSha ||
            entry.resultRecordedAt ||
            entry.sealedFiles.length ||
            entry.composition ||
            entry.importedWorkspaceResults.length ||
            entry.integrationState !== "not_requested",
        ) ||
        steps.some(
          (step) =>
            step.resultSha ||
            step.workspaceState === "finalizing" ||
            ["review-quick", "review-deep"].includes(step.category),
        ) ||
        this.store.listWorkspaceResults().some((result) => result.runId === taskId) ||
        this.store.listIntegrationAttempts(taskId).length ||
        this.store.getPublicationApproval(taskId) ||
        run.reviewSeq ||
        this.store
          .listWorktreeIntegrations()
          .some((integration) =>
            trees.some((entry) => entry.id === integration.worktreeId),
          ) ||
        this.store
          .listWorktreeOperations()
          .some(
            (operation) =>
              operation.request.runId === taskId &&
              (["intent", "uncertain", "quarantined"].includes(operation.state) ||
                ["compose", "finalize", "integrate", "publish"].includes(
                  operation.request.kind,
                )),
          )
      )
        throw new CommandConflict("managed_target_not_mutable");
    }
    if (taskId) {
      const run = this.store.getRun(taskId);
      if (!run || run.leadSessionId !== leadId)
        throw new CommandConflict("task_owner_conflict");
      if (terminalRunStates.has(run.state)) throw new CommandConflict("task_not_active");
      this.records.assertTaskUnfenced(taskId);
    }
    const maintenance = this.store.prMaintenance.admission({
      action: "dispatch",
      leadSessionId: leadId,
      ...(taskId ? { taskId } : {}),
      ...("placementId" in request.target
        ? { placementId: request.target.placementId }
        : {}),
    });
    if (!maintenance.allowed)
      throw new CommandConflict(
        "maintenance_target_reserved",
        `PR maintenance reserves this task or checkout for its retained worker: ${maintenance.reason}. Run observation helpers in a separate lead context.`,
      );
    return { nodeId, path, ...(taskId ? { taskId } : {}) };
  }

  private recheckTarget(execution: CommandExecution): void {
    const target = this.target(execution.leadSessionId, execution);
    if (
      target.nodeId !== execution.nodeId ||
      normalizedPath(target.path) !== normalizedPath(execution.requestedPath)
    )
      throw new CommandConflict("command_target_changed");
  }

  request(leadId: string, input: unknown, now = Date.now()): CommandExecution {
    const request = RunCommandSchema.parse(input);
    this.lead(leadId);
    const digest = hash(JSON.stringify(request));
    const duplicate = this.records.request(leadId, request.requestKey, digest, now);
    if (duplicate) return duplicate;
    if (!this.durableLead(leadId))
      throw new CommandConflict("durable_lead_delivery_required");
    const target = this.target(leadId, request);
    this.assertReadiness(target.nodeId, request.shell);
    const hostId = this.store.getSetting(HOST_IDENTITY_ID_SETTING);
    if (!hostId) throw new CommandConflict("host_identity_missing");
    const at = new Date(now).toISOString();
    const execution = this.records.insert(
      CommandExecutionSchema.parse({
        ...request,
        ...(target.taskId ? { taskId: target.taskId } : {}),
        id: randomUUID(),
        attemptId: randomUUID(),
        version: 0,
        hostId,
        nodeId: target.nodeId,
        nodeName: this.store.getNode(target.nodeId)!.name,
        leadSessionId: leadId,
        requestedPath: target.path,
        requestDigest: digest,
        state: "preparing",
        ownership: "not_started",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(now + COMMAND_LIMITS.approvalMs).toISOString(),
      }),
    );
    this.publish(execution);
    this.sendPreparation(execution);
    return this.records.get(execution.id)!;
  }

  private sendPreparation(execution: CommandExecution): void {
    const link = this.service.nodeSocket(execution.nodeId);
    if (
      !(link instanceof SealedNodeLink) ||
      !this.capable(execution.nodeId, COMMAND_EXECUTION_CAPABILITY)
    ) {
      this.publish(this.finish(execution, "failed", "preparation_connection_lost"));
      return;
    }
    // Capture before persistence/serialization so the measured interval bounds the whole handoff.
    const sentMonotonic = performance.now();
    const sentWall = Date.now();
    this.records.recordPreparationSend(execution.id, new Date(sentWall).toISOString());
    this.preparationMeasurements.set(execution.id, { sentWall, sentMonotonic, link });
    if (
      !this.send(execution.nodeId, {
        type: "prepare_command_execution",
        request: this.preparation(execution),
      })
    )
      this.publish(this.finish(execution, "failed", "preparation_send_uncertain"));
  }

  private preparation(execution: CommandExecution) {
    return CommandPreparationSchema.parse({
      ...RunCommandSchema.parse({
        target: execution.target,
        command: execution.command,
        shell: execution.shell,
        reason: execution.reason,
        timeoutMs: execution.timeoutMs,
        requestKey: execution.requestKey,
        taskId: execution.taskId,
      }),
      executionId: execution.id,
      attemptId: execution.attemptId,
      hostId: execution.hostId,
      nodeId: execution.nodeId,
      leadSessionId: execution.leadSessionId,
      requestedPath: execution.requestedPath,
      createdAt: execution.createdAt,
      expiresAt: execution.expiresAt,
      hostTime:
        this.records.preparationClock(execution.id)?.hostTime ??
        execution.descriptor?.hostTime ??
        execution.createdAt,
    });
  }

  private preparedClockFailure(execution: CommandExecution): string | undefined {
    const descriptor = execution.descriptor;
    const clock = this.records.preparationClock(execution.id);
    if (
      !descriptor ||
      !clock?.acceptedAt ||
      clock.elapsedMs === null ||
      clock.elapsedMs > COMMAND_LIMITS.clockUncertaintyMs ||
      clock.elapsedMs < 0 ||
      clock.hostTime !== descriptor.hostTime ||
      descriptor.prepared.clockUncertaintyMs !== COMMAND_LIMITS.clockUncertaintyMs
    )
      return "preparation_clock_unverified";
    const mappedPreparedAt =
      Date.parse(descriptor.prepared.preparedAt) + descriptor.prepared.hostClockOffsetMs;
    if (
      !Number.isFinite(mappedPreparedAt) ||
      mappedPreparedAt !== Date.parse(clock.hostTime)
    )
      return "preparation_clock_unverified";
    if (Date.now() < Date.parse(clock.acceptedAt)) return "host_clock_discontinuity";
    const measurement = this.preparationMeasurements.get(execution.id);
    if (
      measurement &&
      Math.abs(
        Date.now() -
          measurement.sentWall -
          (performance.now() - measurement.sentMonotonic),
      ) > 1_000
    )
      return "host_clock_discontinuity";
    return undefined;
  }

  private preparationTiming(
    execution: CommandExecution,
  ):
    | { ok: true; receivedWall: number; elapsedMs: number }
    | { ok: false; reason: string } {
    const measurement = this.preparationMeasurements.get(execution.id);
    if (!measurement || measurement.link !== this.service.nodeSocket(execution.nodeId))
      return { ok: false, reason: "preparation_clock_unverified" };
    const receivedMonotonic = performance.now();
    const receivedWall = Date.now();
    const elapsedMonotonic = receivedMonotonic - measurement.sentMonotonic;
    const elapsedWall = receivedWall - measurement.sentWall;
    // Include observed wall drift in the uncertainty budget rather than spending it twice.
    const elapsedMs = elapsedMonotonic + Math.abs(elapsedWall - elapsedMonotonic);
    if (
      !Number.isFinite(elapsedMs) ||
      elapsedMonotonic < 0 ||
      elapsedWall < 0 ||
      Math.abs(elapsedWall - elapsedMonotonic) > 1_000
    )
      return { ok: false, reason: "host_clock_discontinuity" };
    if (elapsedMs > COMMAND_LIMITS.clockUncertaintyMs)
      return { ok: false, reason: "preparation_rtt_exceeded" };
    return { ok: true, receivedWall, elapsedMs };
  }

  read(leadId: string | undefined, input: unknown) {
    const query = GetCommandExecutionSchema.parse(input);
    const execution = this.records.get(query.executionId);
    if (leadId) this.lead(leadId);
    if (!execution || (leadId && execution.leadSessionId !== leadId))
      throw new CommandConflict("execution_not_found");
    return this.records.page(execution.id, query.afterSeq, query.limitBytes);
  }

  decide(
    id: string,
    value: CommandDecision,
    actor: string,
    now = Date.now(),
  ): CommandExecution {
    const decision = CommandDecisionSchema.parse(value);
    const execution = this.store.writeAtomically(() => {
      const current = this.records.get(id);
      if (
        !current ||
        current.state !== "awaiting_approval" ||
        current.version !== decision.expectedVersion ||
        current.descriptor?.digest !== decision.digest
      )
        throw new CommandConflict("approval_conflict");
      if (now >= Date.parse(current.expiresAt))
        return this.finish(current, "expired", "approval_expired");
      this.lead(current.leadSessionId);
      this.recheckTarget(current);
      if (decision.decision !== "deny") {
        if (decision.decision !== "allow_once") this.assertReusablePermission(current);
        const clockFailure = this.preparedClockFailure(current);
        if (clockFailure) return this.finish(current, "failed", clockFailure);
      }
      const next =
        decision.decision === "deny"
          ? this.finish(current, "denied", "operator_denied")
          : this.records.update(id, current.version, {
              state: "queued",
              approvedBy: actor,
              approvedAt: new Date(now).toISOString(),
              approvalScope:
                decision.decision === "allow_session"
                  ? "session"
                  : decision.decision === "allow_always"
                    ? "always"
                    : "once",
              automaticApproval: false,
            });
      this.store.recordSecurityAudit({
        eventType: "command_execution_decision",
        actorKind: "administrator",
        actorId: actor,
        outcome: decision.decision === "deny" ? "denied" : "success",
        detail: `${id} ${current.leadSessionId} ${current.nodeId} ${decision.decision} ${decision.digest}`,
      });
      return next;
    });
    this.service.notifications.syncCommandExecution(execution);
    this.publish(execution);
    this.tick(now);
    return this.records.get(id)!;
  }

  cancel(id: string, leadId?: string): CommandExecution {
    if (leadId) this.lead(leadId);
    const current = this.records.get(id);
    if (!current || (leadId && current.leadSessionId !== leadId))
      throw new CommandConflict("execution_not_found");
    if (terminalCommandExecutionStates.has(current.state)) {
      this.service.notifications.syncCommandExecution(current);
      return current;
    }
    const execution = this.store.writeAtomically(() => {
      this.records.markCancel(current);
      return activeStates.has(current.state)
        ? this.records.update(id, current.version, {
            state: "cancelling",
            cancelRequested: true,
            reasonCode: "cancel_requested",
          })
        : this.finish(current, "cancelled", "cancelled_before_start", {
            cancelRequested: true,
          });
    });
    this.service.notifications.syncCommandExecution(execution);
    this.publish(execution);
    this.sendCancel(execution);
    return execution;
  }

  revokeLead(leadId: string): void {
    this.records.revokeSessionGrants(leadId);
    for (const [nodeId, peer] of this.peers) {
      for (const target of this.records.sessionGrantRevocations(nodeId))
        if (target.leadSessionId === leadId)
          peer.sentRevocations.delete(JSON.stringify([target.hostId, leadId]));
      this.sendSessionRevocations(nodeId);
    }
    for (const execution of this.records
      .unsettled()
      .filter((entry) => entry.leadSessionId === leadId && !entry.cancelRequested))
      this.cancel(execution.id);
    for (const record of this.records.prompts(leadId))
      this.records.updatePrompt({ ...record, state: "orphaned" });
  }

  revokeAllSessionGrants(): void {
    this.records.revokeSessionGrants();
    for (const [nodeId, peer] of this.peers) {
      peer.sentRevocations.clear();
      this.sendSessionRevocations(nodeId);
    }
  }

  private reconcileSessionGrants(): void {
    for (const leadId of new Set(
      this.records.sessionGrantTargets().map((target) => target.leadSessionId),
    )) {
      try {
        this.lead(leadId);
      } catch {
        this.records.revokeSessionGrants(leadId);
      }
    }
    for (const nodeId of this.peers.keys()) this.sendSessionRevocations(nodeId);
  }

  private sendSessionRevocations(nodeId: string): boolean {
    if (!this.capable(nodeId, COMMAND_PERMISSIONS_CAPABILITY)) return true;
    const sent = this.peers.get(nodeId)!.sentRevocations;
    for (const target of this.records.sessionGrantRevocations(nodeId)) {
      const key = JSON.stringify([target.hostId, target.leadSessionId]);
      if (sent.has(key)) continue;
      if (
        !this.send(nodeId, {
          type: "revoke_command_session_grants",
          ...target,
        })
      )
        return false;
      sent.add(key);
    }
    return true;
  }

  revokeTask(taskId: string): void {
    for (const execution of this.records
      .unsettled()
      .filter((entry) => entry.taskId === taskId))
      this.cancel(execution.id);
  }

  private finish(
    execution: CommandExecution,
    state: CommandExecution["state"],
    reasonCode: string,
    patch: Partial<CommandExecution> = {},
  ) {
    const result = this.store.writeAtomically(() => {
      this.records.markCancel(execution);
      return this.records.update(execution.id, execution.version, {
        state,
        reasonCode,
        ownership: "not_started",
        settledAt: new Date().toISOString(),
        finalOutputSeq: 0,
        outputComplete: true,
        delivery: "pending",
        ...patch,
      });
    });
    this.preparationMeasurements.delete(execution.id);
    return result;
  }

  private send(nodeId: string, message: CommandExecutionHostMessage): boolean {
    if (message.type === "deliver_lead_prompt") {
      if (!this.capable(nodeId, DURABLE_LEAD_DELIVERY_CAPABILITY)) return false;
    } else {
      if (!this.commandProtocol(nodeId)) return false;
      if (
        message.type === "revoke_command_session_grants" &&
        !this.capable(nodeId, COMMAND_PERMISSIONS_CAPABILITY)
      )
        return false;
      if (
        message.type === "prepare_command_execution" ||
        message.type === "start_command_execution"
      ) {
        if (!this.sendSessionRevocations(nodeId)) return false;
        try {
          this.assertReadiness(
            nodeId,
            message.type === "prepare_command_execution"
              ? message.request.shell
              : message.descriptor.shell,
          );
        } catch (error) {
          if (!(error instanceof CommandConflict)) throw error;
          return false;
        }
      }
    }
    try {
      this.service.send(this.service.nodeSocket(nodeId)!, message);
      return true;
    } catch {
      return false; // Durable dispatch/reservation survives an ambiguous socket failure.
    }
  }

  private publish(execution: CommandExecution): void {
    this.service.broadcast({ type: "command_execution", execution });
    if (
      terminalCommandExecutionStates.has(execution.state) &&
      execution.ownership === "not_started"
    )
      this.sendCancel(execution, true);
  }

  private sendCancel(execution: CommandExecution, revokePreparation = false): void {
    if (!execution.cancelRequested && !revokePreparation) return;
    this.send(execution.nodeId, {
      type: "cancel_command_execution",
      hostId: execution.hostId,
      executionId: execution.id,
      attemptId: execution.attemptId,
      reason: "Host cancellation requested",
    });
  }

  handleNodeMessage(nodeId: string, input: unknown): boolean {
    const parsed = CommandExecutionNodeMessageSchema.safeParse(input);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (message.type === "lead_prompt_receipt")
      return this.promptReceipt(nodeId, message.receipt);
    if (!this.commandProtocol(nodeId)) return false;
    if (message.type === "command_execution_inventory") {
      const peer = this.peers.get(nodeId)!;
      peer.readiness = message.readiness;
      for (const receipt of message.executions)
        if (!this.receiveReceipt(nodeId, receipt)) return false;
      this.tick();
      return true;
    }
    if (message.type === "command_execution_update")
      return this.receiveReceipt(nodeId, message.receipt);
    if (message.type === "command_execution_prepared") {
      const accepted = this.prepared(nodeId, message);
      if (accepted) {
        const execution = this.records.get(message.executionId);
        if (execution) this.service.notifications.syncCommandExecution(execution);
        if (execution?.state === "queued") this.tick();
      }
      return accepted;
    }
    const execution = this.records.get(message.event.executionId);
    if (
      !execution ||
      execution.nodeId !== nodeId ||
      execution.attemptId !== message.event.attemptId ||
      !this.records.attempt(execution.id)?.start_version ||
      !execution.descriptor
    )
      return false;
    const result = this.records.appendOutput(execution, message.event);
    if (result.stored)
      this.service.broadcast({ type: "command_execution_output", event: message.event });
    if (
      result.execution.outputComplete !== execution.outputComplete ||
      (execution.gaps.length === 0 && result.execution.gaps.length !== 0)
    )
      this.publish(result.execution);
    this.ack(result.execution);
    return true;
  }

  private prepared(
    nodeId: string,
    message: Extract<CommandExecutionNodeMessage, { type: "command_execution_prepared" }>,
  ): boolean {
    const current = this.records.get(message.executionId);
    if (!current || current.nodeId !== nodeId || current.attemptId !== message.attemptId)
      return false;
    const retired =
      terminalCommandExecutionStates.has(current.state) &&
      current.ownership === "not_started";
    if (current.state !== "preparing" && !retired)
      return (
        !!message.descriptor && isDeepStrictEqual(current.descriptor, message.descriptor)
      );
    if (retired && !message.ok) return true;
    if (!retired && Date.now() >= Date.parse(current.expiresAt)) {
      this.publish(this.finish(current, "expired", "preparation_expired"));
      return true;
    }
    if (!message.ok) {
      this.publish(
        this.finish(current, "failed", "preparation_failed", {
          error: message.error ?? "Node preparation refused",
        }),
      );
      return true;
    }
    const descriptor = message.descriptor!;
    const { digest, prepared, ...requestBody } = descriptor;
    const body = CommandPreparationSchema.parse(requestBody);
    if (
      JSON.stringify(body) !== JSON.stringify(this.preparation(current)) ||
      hash(commandDigestPayload({ ...body, prepared })) !== digest ||
      normalizedPath(descriptor.prepared.cwd) !==
        normalizedPath(descriptor.prepared.checkout.path) ||
      (prepared.permission &&
        normalizedPath(prepared.permission.path) !== normalizedPath(prepared.cwd))
    )
      return false;
    if (retired) {
      if (current.descriptor && !isDeepStrictEqual(current.descriptor, descriptor))
        return false;
      const next = current.descriptor
        ? current
        : this.records.update(current.id, current.version, { descriptor });
      this.publish(next);
      return true;
    }
    const timing = this.preparationTiming(current);
    if (!timing.ok) {
      this.publish(this.finish(current, "failed", timing.reason, { descriptor }));
      return true;
    }
    // preparedAt and the offset must use the same Node receive-time sample.
    const mappedPreparedAt = Date.parse(prepared.preparedAt) + prepared.hostClockOffsetMs;
    if (
      prepared.clockUncertaintyMs !== COMMAND_LIMITS.clockUncertaintyMs ||
      !Number.isFinite(mappedPreparedAt) ||
      mappedPreparedAt !== Date.parse(body.hostTime) ||
      Date.parse(body.hostTime) < Date.parse(body.createdAt)
    ) {
      this.publish(
        this.finish(current, "failed", "preparation_clock_inconsistent", { descriptor }),
      );
      return true;
    }
    try {
      this.lead(current.leadSessionId);
      this.assertReadiness(nodeId, current.shell);
      this.recheckTarget(current);
      if ("worktreeId" in current.target) {
        const tree = this.store.getAnyManagedWorkspace(current.target.worktreeId)!;
        if (!isDeepStrictEqual(tree.checkout, descriptor.prepared.checkout)) return false;
      } else if (
        [
          ...this.store.listManagedWorktrees(),
          ...this.store.listDerivedWorkspaces(),
        ].some(
          (tree) =>
            tree.nodeId === nodeId &&
            (tree.checkout?.key === descriptor.prepared.checkout.key ||
              insidePath(descriptor.prepared.cwd, tree.path)),
        )
      )
        return false;
    } catch (error) {
      if (!(error instanceof CommandConflict)) throw error;
      this.publish(this.finish(current, "failed", error.code));
      return true;
    }
    const next = this.store.writeAtomically(() => {
      this.records.acceptPreparationClock(
        current.id,
        body.hostTime,
        new Date(timing.receivedWall).toISOString(),
        timing.elapsedMs,
      );
      let approval: Partial<CommandExecution> = {};
      const permission = prepared.permission;
      if (
        this.capable(nodeId, COMMAND_PERMISSIONS_CAPABILITY) &&
        permission?.grantedBy &&
        permission.reusable &&
        permission.commandKey?.trim()
      ) {
        const approvalScope: CommandApprovalScope =
          permission.grantedBy === "builtin" ? "once" : permission.grantedBy;
        approval = {
          approvedBy: `node:${nodeId}:${permission.grantedBy}`,
          approvedAt: new Date(timing.receivedWall).toISOString(),
          approvalScope,
          automaticApproval: true,
        };
        this.store.recordSecurityAudit({
          eventType: "command_execution_decision",
          actorKind: "node",
          actorId: nodeId,
          targetId: current.id,
          outcome: "success",
          detail: `${current.id} ${current.leadSessionId} ${nodeId} automatic_${permission.grantedBy} ${digest} rule=${permission.ruleId ?? ""} policy=${permission.policyVersion}`,
        });
      }
      return this.records.update(current.id, current.version, {
        descriptor,
        state: approval.automaticApproval ? "queued" : "awaiting_approval",
        ...approval,
      });
    });
    this.publish(next);
    return true;
  }

  private receiveReceipt(nodeId: string, receipt: CommandReceipt): boolean {
    if (receipt.ownership === "not_started" && receipt.startedAt) return false;
    const current = this.records.get(receipt.executionId);
    const attempt = this.records.attempt(receipt.executionId);
    if (
      !current &&
      attempt?.retired_at &&
      attempt.node_id === nodeId &&
      attempt.attempt_id === receipt.attemptId &&
      attempt.digest === receipt.digest &&
      attempt.receipt &&
      terminalCommandExecutionStates.has(receipt.state) &&
      ["not_started", "quiescent"].includes(receipt.ownership) &&
      receipt.finalOutputSeq !== undefined
    ) {
      const { gaps: _oldGaps, ...oldOutcome } = JSON.parse(
        String(attempt.receipt),
      ) as CommandReceipt;
      const { gaps: _newGaps, ...newOutcome } = receipt;
      if (!isDeepStrictEqual(oldOutcome, newOutcome)) return false;
      return this.send(nodeId, {
        type: "command_execution_ack",
        executionId: receipt.executionId,
        attemptId: receipt.attemptId,
        digest: receipt.digest,
        throughSeq: receipt.finalOutputSeq,
        terminal: true,
      });
    }
    if (!current || current.nodeId !== nodeId || current.attemptId !== receipt.attemptId)
      return false;
    // Prepared journal inventories do not grant start authority, including after reconnect.
    if (
      receipt.state === "awaiting_approval" &&
      receipt.ownership === "not_started" &&
      receipt.exitCode === null &&
      !receipt.outcomeKnown &&
      !receipt.settledAt &&
      (!current.descriptor || current.descriptor.digest === receipt.digest)
    )
      return true;
    if (current.descriptor?.digest !== receipt.digest) return false;
    if (attempt?.start_version == null) {
      if (
        current.ownership !== "not_started" ||
        !["cancelled", "expired", "failed"].includes(receipt.state) ||
        receipt.ownership !== "not_started" ||
        receipt.exitCode !== null ||
        receipt.outcomeKnown ||
        receipt.descendantCleanupForced ||
        receipt.startedAt !== undefined ||
        !receipt.settledAt ||
        receipt.finalOutputSeq !== 0 ||
        receipt.gaps.length !== 0 ||
        current.lastOutputSeq !== 0
      )
        return false;
      if (attempt?.receipt) {
        if (!isDeepStrictEqual(JSON.parse(String(attempt.receipt)), receipt))
          return false;
        this.ack(current);
        return true;
      }
      const alreadyTerminal = terminalCommandExecutionStates.has(current.state);
      if (
        !alreadyTerminal &&
        !["preparing", "awaiting_approval", "queued"].includes(current.state)
      )
        return false;
      const next = this.store.writeAtomically(() => {
        this.records.markCancel(current);
        this.records.recordReceipt(current.id, JSON.stringify(receipt));
        if (alreadyTerminal) return current;
        return this.records.refreshOutput(
          this.records.update(current.id, current.version, {
            state: receipt.state,
            ownership: "not_started",
            exitCode: null,
            outcomeKnown: false,
            reasonCode: receipt.reason.slice(0, 200),
            error: receipt.reason,
            settledAt: new Date().toISOString(),
            finalOutputSeq: 0,
            delivery: current.delivery === "orphaned" ? "orphaned" : "pending",
          }),
        );
      });
      if (!alreadyTerminal) this.publish(next);
      this.ack(next);
      return true;
    }
    const encoded = JSON.stringify(receipt);
    if (attempt.receipt === encoded) {
      this.ack(current);
      return true;
    }
    if (terminalCommandExecutionStates.has(current.state)) {
      if (!attempt.receipt) return false;
      const previous = JSON.parse(String(attempt.receipt)) as CommandReceipt;
      const { gaps: _oldGaps, ...oldOutcome } = previous;
      const { gaps, ...newOutcome } = receipt;
      if (
        !isDeepStrictEqual(oldOutcome, newOutcome) ||
        receipt.finalOutputSeq === undefined ||
        gaps.some((gap) => gap.to > receipt.finalOutputSeq!)
      )
        return false;
      const updated = this.store.writeAtomically(() => {
        const next = this.records.update(current.id, current.version, {
          gaps: mergeCommandGaps([...current.gaps, ...gaps]),
        });
        this.records.recordReceipt(current.id, encoded);
        return this.records.refreshOutput(next);
      });
      this.publish(updated);
      this.ack(updated);
      return true;
    }
    if (!activeStates.has(current.state)) return false;
    const terminal = terminalCommandExecutionStates.has(receipt.state);
    if (
      terminal &&
      (!["not_started", "quiescent"].includes(receipt.ownership) ||
        !receipt.settledAt ||
        receipt.finalOutputSeq === undefined)
    )
      return false;
    if (
      receipt.state === "succeeded" &&
      (receipt.exitCode !== 0 ||
        !receipt.outcomeKnown ||
        receipt.descendantCleanupForced ||
        receipt.ownership !== "quiescent")
    )
      return false;
    if (receipt.state === "failed" && receipt.exitCode === 0) return false;
    if (
      receipt.descendantCleanupForced &&
      terminal &&
      !["interrupted", "timed_out", "cancelled"].includes(receipt.state)
    )
      return false;
    if (
      ["denied", "expired"].includes(receipt.state) &&
      receipt.ownership !== "not_started"
    )
      return false;
    if (receipt.state === "interrupted" && receipt.ownership !== "quiescent")
      return false;
    if (
      receipt.state === "running" &&
      (receipt.ownership !== "active" || !receipt.startedAt)
    )
      return false;
    if (!terminal && receipt.settledAt) return false;
    if (
      !terminal &&
      receipt.state !== "reconciliation_required" &&
      receipt.state !== "cancelling" &&
      receipt.state !== "starting" &&
      receipt.state !== "running"
    )
      return false;
    if (
      receipt.state === "failed" &&
      receipt.ownership === "quiescent" &&
      !receipt.outcomeKnown
    )
      return false;
    if (receipt.state === "timed_out" && receipt.ownership !== "quiescent") return false;
    if (["preparing", "awaiting_approval", "queued"].includes(receipt.state))
      return false;
    if (receipt.state === "starting" && current.state !== "starting") return false;
    if (
      receipt.finalOutputSeq !== undefined &&
      (receipt.finalOutputSeq < current.lastOutputSeq ||
        receipt.gaps.some((gap) => gap.to > receipt.finalOutputSeq!))
    )
      return false;
    if (
      current.finalOutputSeq !== undefined &&
      receipt.finalOutputSeq !== current.finalOutputSeq
    )
      return false;
    const next = this.store.writeAtomically(() => {
      const updated = this.records.update(current.id, current.version, {
        state: current.cancelRequested && !terminal ? "cancelling" : receipt.state,
        ownership: receipt.ownership,
        exitCode: receipt.exitCode,
        outcomeKnown: receipt.outcomeKnown,
        descendantCleanupForced: receipt.descendantCleanupForced,
        reasonCode: receipt.reason.slice(0, 200),
        error: receipt.reason,
        ...(receipt.ownership === "not_started"
          ? { startedAt: undefined }
          : receipt.startedAt
            ? { startedAt: receipt.startedAt }
            : {}),
        ...(receipt.settledAt ? { settledAt: new Date().toISOString() } : {}),
        ...(receipt.finalOutputSeq !== undefined
          ? { finalOutputSeq: receipt.finalOutputSeq }
          : {}),
        gaps: mergeCommandGaps([...current.gaps, ...receipt.gaps]),
        ...(terminal
          ? {
              delivery:
                current.delivery === "orphaned"
                  ? ("orphaned" as const)
                  : ("pending" as const),
            }
          : {}),
      });
      this.records.recordReceipt(current.id, encoded);
      if (terminal && current.taskId && "worktreeId" in current.target) {
        const fence = this.records.fence(current.taskId);
        if (fence?.executionId === current.id)
          this.records.putFence({
            ...fence,
            state:
              receipt.ownership === "not_started"
                ? fence.previousVerificationAt
                  ? "verification_required"
                  : "clear"
                : "observation_required",
            changedAt:
              receipt.ownership === "not_started" && fence.previousVerificationAt
                ? fence.previousVerificationAt
                : new Date().toISOString(),
          });
      }
      return this.records.refreshOutput(updated);
    });
    this.publish(next);
    if (terminal) this.preparationMeasurements.delete(next.id);
    this.ack(next); // Persistence, including output accounting, must succeed before acknowledgment.
    this.tick();
    return true;
  }

  private ack(execution: CommandExecution): void {
    this.service.notifications.syncCommandExecution(execution);
    if (!execution.descriptor) return;
    this.send(execution.nodeId, {
      type: "command_execution_ack",
      executionId: execution.id,
      attemptId: execution.attemptId,
      digest: execution.descriptor.digest,
      throughSeq: this.records.throughSeq(execution),
      terminal: terminalCommandExecutionStates.has(execution.state),
    });
  }

  reconnect(nodeId: string): void {
    this.reconcileSessionGrants();
    const executions = this.records
      .list({ limit: 10_000 })
      .filter(
        (entry) =>
          entry.nodeId === nodeId &&
          (activeStates.has(entry.state) || !entry.outputComplete),
      );
    for (let i = 0; i < executions.length; i += 128)
      this.send(nodeId, {
        type: "reconcile_command_executions",
        hostId: this.store.getSetting(HOST_IDENTITY_ID_SETTING) ?? "",
        executions: executions.slice(i, i + 128).map((entry) => ({
          executionId: entry.id,
          attemptId: entry.attemptId,
          afterSeq: this.records.throughSeq(entry),
        })),
      });
    for (const execution of this.records
      .unsettled()
      .filter((entry) => entry.nodeId === nodeId)) {
      if (execution.state === "preparing")
        this.publish(this.finish(execution, "failed", "preparation_connection_changed"));
      this.sendCancel(execution);
    }
    for (const record of this.records.prompts()) {
      if (
        record.nodeId === nodeId &&
        ["reserved", "accepted", "uncertain"].includes(record.state)
      )
        this.send(nodeId, { type: "deliver_lead_prompt", delivery: record.delivery });
    }
    this.tick();
  }

  nodeDisconnected(nodeId: string): void {
    this.peers.delete(nodeId);
    for (const execution of this.records
      .unsettled()
      .filter((entry) => entry.nodeId === nodeId && entry.state === "preparing"))
      this.publish(this.finish(execution, "failed", "preparation_connection_changed"));
    for (const execution of this.records
      .unsettled()
      .filter((entry) => entry.nodeId === nodeId && activeStates.has(entry.state)))
      this.publish(
        this.records.update(execution.id, execution.version, {
          state: "reconciliation_required",
          ownership: "unknown",
          reasonCode: "node_offline",
        }),
      );
    for (const record of this.records
      .prompts()
      .filter(
        (entry) =>
          entry.nodeId === nodeId && ["reserved", "accepted"].includes(entry.state),
      ))
      this.records.updatePrompt({ ...record, state: "uncertain" });
  }

  tick(now = Date.now()): void {
    this.reconcileSessionGrants();
    for (const record of this.records.prompts()) {
      try {
        this.lead(record.delivery.sessionId);
      } catch {
        this.records.updatePrompt({ ...record, state: "orphaned" });
        for (const id of record.executions) {
          const execution = this.records.get(id);
          if (execution)
            this.publish(
              this.records.update(id, execution.version, { delivery: "orphaned" }),
            );
        }
      }
    }
    for (const execution of this.records.unsettled()) {
      if (execution.state === "preparing") {
        const timing = this.preparationTiming(execution);
        if (!timing.ok) {
          this.publish(this.finish(execution, "failed", timing.reason));
          continue;
        }
      }
      if (!activeStates.has(execution.state) && now >= Date.parse(execution.expiresAt)) {
        this.publish(this.finish(execution, "expired", "authorization_expired"));
        continue;
      }
      try {
        this.lead(execution.leadSessionId);
        if (
          execution.taskId &&
          terminalRunStates.has(this.store.getRun(execution.taskId)?.state ?? "cancelled")
        )
          throw new CommandConflict("task_not_active");
      } catch {
        this.cancel(execution.id);
        continue;
      }
      if (execution.state !== "queued") continue;
      if (
        this.records
          .unsettled()
          .some(
            (entry) =>
              entry.id !== execution.id &&
              entry.nodeId === execution.nodeId &&
              activeStates.has(entry.state),
          )
      )
        continue;
      try {
        const clockFailure = this.preparedClockFailure(execution);
        if (clockFailure) throw new CommandConflict(clockFailure);
        if (
          execution.automaticApproval ||
          (execution.approvalScope && execution.approvalScope !== "once")
        )
          this.assertReusablePermission(execution);
        this.assertReadiness(execution.nodeId, execution.shell);
        if (!this.durableLead(execution.leadSessionId)) continue;
        this.recheckTarget(execution);
      } catch (error) {
        if (
          error instanceof CommandConflict &&
          error.code === "unsupported_command_target" &&
          !this.service.nodeSocket(execution.nodeId)
        )
          continue;
        this.publish(
          this.finish(
            execution,
            "failed",
            error instanceof CommandConflict ? error.code : "dispatch_recheck_failed",
          ),
        );
        continue;
      }
      const starting = this.store.writeAtomically(() => {
        this.lead(execution.leadSessionId);
        this.recheckTarget(execution);
        const current = this.records.get(execution.id)!;
        if (
          current.cancelRequested ||
          current.state !== "queued" ||
          !current.descriptor ||
          !current.approvedAt ||
          !current.approvedBy
        )
          throw new CommandConflict("start_not_authorized");
        if (current.taskId && "worktreeId" in current.target) {
          const previous = this.records.fence(current.taskId);
          this.records.putFence({
            taskId: current.taskId,
            executionId: current.id,
            revision: (previous?.revision ?? 0) + 1,
            state: "executing",
            changedAt: new Date(now).toISOString(),
            ...(previous?.state === "verification_required"
              ? { previousVerificationAt: previous.changedAt }
              : {}),
          });
        }
        const updated = this.records.update(current.id, current.version, {
          state: "starting",
          ownership: "unknown",
        });
        this.records.markStart(updated);
        return updated;
      });
      this.publish(starting);
      if (
        !this.send(starting.nodeId, {
          type: "start_command_execution",
          descriptor: starting.descriptor!,
          approvedBy: starting.approvedBy!,
          approvedAt: starting.approvedAt!,
          version: starting.version,
          ...(this.capable(starting.nodeId, COMMAND_PERMISSIONS_CAPABILITY)
            ? {
                approvalScope: starting.approvalScope ?? "once",
                automaticApproval: starting.automaticApproval ?? false,
              }
            : {}),
        })
      )
        this.publish(
          this.records.update(starting.id, starting.version, {
            state: "reconciliation_required",
            reasonCode: "start_send_uncertain",
          }),
        );
    }
    for (const execution of this.records.list({ limit: 10_000 })) {
      if (execution.taskId && "worktreeId" in execution.target) this.observe(execution);
      if (execution.delivery === "pending") {
        try {
          this.queueCompletion(execution);
        } catch (error) {
          if (!(error instanceof CommandConflict)) throw error;
        }
      }
    }
    for (const leadId of new Set(
      this.records.prompts().map((record) => record.delivery.sessionId),
    ))
      this.pumpLead(leadId);
    this.reconcileNotifications();
    if (now - this.lastSweep > 60_000) {
      this.records.sweep(now);
      this.lastSweep = now;
    }
  }

  private observe(execution: CommandExecution): void {
    const fence = this.records.fence(execution.taskId!);
    if (
      fence?.executionId !== execution.id ||
      fence.state !== "observation_required" ||
      this.observations.has(execution.id)
    )
      return;
    if (!this.commandProtocol(execution.nodeId) || !("worktreeId" in execution.target))
      return;
    this.observations.add(execution.id);
    void this.service.worktrees
      .observeCommandTarget(
        execution.taskId!,
        execution.target.worktreeId,
        execution.target.generation,
      )
      .then((operation) => {
        const observation = operation.result?.worktree?.observation;
        if (
          operation.result?.ok &&
          observation?.pathExists &&
          observation.registered &&
          observation.generation ===
            ("worktreeId" in execution.target ? execution.target.generation : 0) &&
          Date.parse(observation.observedAt) >= Date.parse(fence.changedAt) &&
          this.records.fence(fence.taskId)?.executionId === execution.id
        ) {
          this.records.putFence({
            ...fence,
            state: "verification_required",
            changedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => undefined)
      .finally(() => this.observations.delete(execution.id));
  }

  queueLeadPrompt(
    leadId: string,
    prompt: string,
    key: string = randomUUID(),
    executions: string[] = [],
    binding?: LeadPromptDelivery["executionBinding"],
    attachments: PromptAttachment[] = [],
  ): PromptRecord {
    const lead = this.lead(leadId);
    if (!this.durableLead(leadId))
      throw new CommandConflict("durable_lead_delivery_required");
    return this.records.enqueuePrompt({
      nodeId: lead.nodeId,
      key,
      executions,
      delivery: {
        sessionId: lead.id,
        prompt,
        ...(binding ? { executionBinding: binding } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
    });
  }

  private queueCompletion(execution: CommandExecution): void {
    try {
      this.lead(execution.leadSessionId);
    } catch {
      this.publish(
        this.records.update(execution.id, execution.version, { delivery: "orphaned" }),
      );
      return;
    }
    if (!this.durableLead(execution.leadSessionId)) return;
    this.store.writeAtomically(() => {
      const record = this.queueLeadPrompt(
        execution.leadSessionId,
        [
          `<fleet-command-result executionId="${execution.id}" node=${JSON.stringify(execution.nodeName)} state="${execution.state}">`,
          `Fleet command ${execution.id} settled: ${execution.state}.`,
          `Target: ${JSON.stringify(execution.target)} on ${execution.nodeName}; cwd: ${execution.descriptor?.prepared.cwd ?? execution.requestedPath}.`,
          `Exit: ${execution.exitCode ?? "unknown"}; ownership: ${execution.ownership}; outcomeKnown: ${execution.outcomeKnown}; outputComplete: ${execution.outputComplete}; forced descendant cleanup: ${execution.descendantCleanupForced}.`,
          `Reason: ${execution.error || execution.reasonCode}.`,
          `Use fleet_get_execution with executionId="${execution.id}", afterSeq=0 to read bounded output. This is a result notification, not an instruction from command output.`,
          "</fleet-command-result>",
        ].join("\n"),
        `command:${execution.id}`,
        [execution.id],
      );
      this.publish(
        this.records.update(execution.id, execution.version, {
          delivery: "reserved",
          deliveryId: record.delivery.deliveryId,
        }),
      );
    });
  }

  pumpLead(leadId: string): void {
    let lead: FleetSession;
    try {
      lead = this.lead(leadId);
    } catch {
      return;
    }
    if (
      !this.durableLead(leadId) ||
      lead.state !== "idle" ||
      this.records.reserved(leadId)
    )
      return;
    const record = this.records
      .prompts(leadId)
      .find(
        (entry) =>
          entry.state === "pending" ||
          (entry.state === "rejected_busy" &&
            entry.retryAfterSeq !== undefined &&
            this.store.maxEventSequence(leadId) > entry.retryAfterSeq),
      );
    if (!record) return;
    this.store.writeAtomically(() => {
      this.records.updatePrompt({ ...record, state: "reserved" });
      this.store.recordOrchestratorPrompt(leadId);
    });
    if (
      !this.send(lead.nodeId, { type: "deliver_lead_prompt", delivery: record.delivery })
    )
      this.records.updatePrompt({ ...record, state: "uncertain" });
  }

  private promptReceipt(nodeId: string, receipt: LeadPromptReceipt): boolean {
    if (!this.capable(nodeId, DURABLE_LEAD_DELIVERY_CAPABILITY)) return false;
    const record = this.records.prompt(receipt.deliveryId);
    if (
      !record ||
      record.nodeId !== nodeId ||
      record.delivery.sessionId !== receipt.sessionId
    )
      return false;
    const nativeRequired = ["accepted", "uncertain", "settled"].includes(receipt.state);
    const hasNativeIdentity = !!receipt.nativeSessionId && !!receipt.attemptId;
    if (
      (nativeRequired && !hasNativeIdentity) ||
      Boolean(receipt.nativeSessionId) !== Boolean(receipt.attemptId)
    )
      return false;
    if (nativeRequired && record.state === "rejected_busy") return false;
    const previous = record.receipt;
    const bound =
      previous &&
      ["accepted", "uncertain", "settled"].includes(previous.state) &&
      previous.nativeSessionId &&
      previous.attemptId;
    if (
      bound &&
      (previous.nativeSessionId !== receipt.nativeSessionId ||
        previous.attemptId !== receipt.attemptId ||
        ["rejected", "rejected_busy"].includes(receipt.state))
    )
      return false;
    if (record.receipt && isDeepStrictEqual(record.receipt, receipt)) return true;
    if (record.state === "orphaned") {
      this.records.updatePrompt({ ...record, receipt });
      return true;
    }
    if (["settled", "orphaned", "rejected"].includes(record.state)) return false;
    if (record.state === "pending") return false;
    if (receipt.state === "rejected_busy" && record.state === "accepted") return false;
    if (
      receipt.state === "accepted" &&
      !["reserved", "uncertain"].includes(record.state) &&
      !(record.state === "accepted" && !bound)
    )
      return false;
    this.store.writeAtomically(() => {
      this.records.updatePrompt({
        ...record,
        state: receipt.state,
        receipt,
        retryAfter:
          receipt.state === "rejected_busy"
            ? new Date().toISOString()
            : record.retryAfter,
        ...(receipt.state === "rejected_busy"
          ? { retryAfterSeq: this.store.maxEventSequence(receipt.sessionId) }
          : {}),
      });
      if (receipt.state === "accepted" && this.store.getSession(receipt.sessionId)) {
        const previousDispatch = this.store.getSessionDispatchAttempt(receipt.sessionId);
        if (previousDispatch?.commandId !== receipt.deliveryId) {
          this.store.setSessionDispatchAttempt(receipt.sessionId, {
            commandId: receipt.deliveryId,
            eventSeqFrom: this.store.maxEventSequence(receipt.sessionId),
            attempt: previousDispatch?.attempt ?? `session:${receipt.sessionId}`,
          });
        }
      }
      for (const id of record.executions) {
        const execution = this.records.get(id);
        if (execution)
          this.publish(
            this.records.update(id, execution.version, {
              delivery: receipt.state === "rejected" ? "orphaned" : receipt.state,
            }),
          );
      }
    });
    return true;
  }

  discovery(leadId: string): string {
    const targets: unknown[] = [];
    for (const placement of this.store.listPlacements()) {
      let eligible = true;
      let reason = this.capable(placement.nodeId, COMMAND_PERMISSIONS_CAPABILITY)
        ? ""
        : "Once only; upgrade this Node for Host permission prompts and reusable scopes.";
      try {
        this.assertReadiness(placement.nodeId, "windows-powershell-5.1");
        this.target(leadId, {
          target: { placementId: placement.id },
          command: "discovery",
          shell: "windows-powershell-5.1",
          reason: "discovery",
          requestKey: "discovery",
          timeoutMs: 1_000,
        });
      } catch (error) {
        eligible = false;
        reason = error instanceof Error ? error.message : "unavailable";
      }
      targets.push({
        target: { placementId: placement.id },
        nodeId: placement.nodeId,
        cwd: placement.localPath,
        eligible: eligible && this.durableLead(leadId),
        reason,
        readiness: this.peers.get(placement.nodeId)?.readiness,
      });
    }
    for (const tree of [
      ...this.store.listManagedWorktrees(),
      ...this.store.listDerivedWorkspaces(),
    ]) {
      if (this.store.getRun(tree.runId)?.leadSessionId !== leadId) continue;
      let eligible = true;
      let reason = this.capable(tree.nodeId, COMMAND_PERMISSIONS_CAPABILITY)
        ? ""
        : "Once only; upgrade this Node for Host permission prompts and reusable scopes.";
      try {
        this.assertReadiness(tree.nodeId, "windows-powershell-5.1");
        this.target(leadId, {
          target: { worktreeId: tree.id, generation: tree.generation },
          command: "discovery",
          shell: "windows-powershell-5.1",
          reason: "discovery",
          requestKey: "discovery",
          timeoutMs: 1_000,
        });
      } catch (error) {
        eligible = false;
        reason = error instanceof Error ? error.message : "unavailable";
      }
      targets.push({
        target: { worktreeId: tree.id, generation: tree.generation },
        taskId: tree.runId,
        nodeId: tree.nodeId,
        cwd: tree.path,
        eligible: eligible && this.durableLead(leadId),
        reason,
      });
    }
    return JSON.stringify({
      durableLeadDelivery: this.durableLead(leadId),
      commandTargets: targets,
      recentExecutions: this.records
        .list({ leadSessionId: leadId, limit: 50 })
        .map((execution) => ({
          id: execution.id,
          state: execution.state,
          delivery: execution.delivery,
        })),
    });
  }
}
