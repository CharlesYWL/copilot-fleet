import { createHash } from "node:crypto";
import type {
  CreateNotification,
  CommandExecution,
  FleetSession,
  MarkAllNotificationsReadResponse,
  Notification,
  PrMaintenanceRegistration,
  PrMaintenanceProposal,
  Run,
  RunNoteMetadata,
  RunRole,
  RunStep,
  SessionState,
} from "@fleet/protocol";
import {
  prMaintenanceProviderLabel,
  prMaintenanceUrl,
  terminalCommandExecutionStates,
} from "@fleet/protocol";
import type {
  AdvanceRunToReviewWrite,
  FleetStore,
  InsertNotificationResult,
  NotificationListInput,
  NotificationPage,
} from "../store.js";
import {
  resolveLifecyclePreference,
  stableNotificationAgentId,
  type LifecyclePreferenceResolution,
} from "./policy.js";

export type NotificationPublisher = {
  notificationUpsert: (notification: Notification) => void;
  notificationUnreadCount: (unreadCount: number) => void;
  runUpsert: (run: Run) => void;
};

export type NotificationAttemptContext = {
  run?: Run | undefined;
  step?: RunStep | undefined;
};

export type EffectiveSessionNotificationPreference = LifecyclePreferenceResolution & {
  sessionId: string;
  agentId: string;
  runRole: RunRole;
};

export type NotificationMutation = {
  notification: Notification;
  changed: boolean;
};

type EventIdentity = {
  eventId: string;
  sequence: number;
  createdAt: string;
};

type AgentLifecycleInput = {
  kind: "agent_completion" | "agent_failure";
  session: FleetSession;
  transition: EventIdentity & {
    from: SessionState;
    to: SessionState;
    source: "session_event" | "fatal_command_result" | "reconciliation";
  };
  turnComplete?: Pick<EventIdentity, "eventId" | "sequence"> | undefined;
  context?: NotificationAttemptContext | undefined;
};

type PermissionInput = {
  session: FleetSession;
  requestId?: string | undefined;
  event: EventIdentity;
  context?: NotificationAttemptContext | undefined;
};

type ReviewReason = "completed" | "blocked";

type DeferredPublications = {
  unreadChanged: boolean;
  notifications: Map<string, Notification>;
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

const NOTIFICATION_TEXT_LIMIT = 200;

const boundedLabel = (value: string): string => value.slice(0, NOTIFICATION_TEXT_LIMIT);

const titledLabel = (prefix: string, value: string): string =>
  `${prefix}${value.slice(0, NOTIFICATION_TEXT_LIMIT - prefix.length)}`;

export const notificationAttemptKeyForStep = (run: Run, step: RunStep): string =>
  `${run.id}:${step.id}:${step.attempts}`;

export const notificationAttemptKey = (
  session: FleetSession,
  context: NotificationAttemptContext | undefined,
): string =>
  context?.step
    ? context.run
      ? notificationAttemptKeyForStep(context.run, context.step)
      : `${context.step.runId}:${context.step.id}:${context.step.attempts}`
    : `session:${session.id}`;

const roleLabel = (runRole: RunRole): string => {
  switch (runRole) {
    case "lead":
      return "Lead orchestrator";
    case "worker":
      return "Worker agent";
    case "reviewer":
      return "Reviewer agent";
    default:
      return "Agent";
  }
};

const sessionLabel = (session: FleetSession): string =>
  boundedLabel(`${session.workspaceName} on ${session.nodeName}`);

const agentLabel = (session: FleetSession): string =>
  boundedLabel(session.name.trim() || `${session.workspaceName} on ${session.nodeName}`);

const subjectForAgent = (session: FleetSession) => ({
  type: "agent" as const,
  id: session.id,
  label: agentLabel(session),
  parentId: session.id,
  parentLabel: roleLabel(session.runRole),
});

const subjectForStep = (run: Run, step: RunStep) => ({
  type: "run_step" as const,
  id: step.id,
  label: boundedLabel(step.title),
  parentId: run.id,
  parentLabel: boundedLabel(run.name),
});

/**
 * Owns durable notification writes and their browser publications.
 *
 * Callers supply only typed event identity and copied labels; raw prompts,
 * permission text, transcript output, and failure details never cross this API.
 */
export class NotificationService {
  private deferredPublications: DeferredPublications | undefined;

  constructor(
    private readonly store: FleetStore,
    private readonly publisher: NotificationPublisher,
  ) {}

  /**
   * Holds notification publication until the authoritative writes commit.
   *
   * The callback may use ordinary FleetStore and NotificationService methods.
   * Browser publication happens only after the outer commit, after the caller's
   * authoritative publication.
   */
  commitAtomically<T>(write: () => T, afterCommit?: (result: T) => void): T {
    if (this.deferredPublications) {
      throw new Error("Nested notification transactions are not supported");
    }
    const publications: DeferredPublications = {
      unreadChanged: false,
      notifications: new Map(),
    };
    this.deferredPublications = publications;

    let result: T;
    try {
      result = this.store.writeAtomically(write);
    } catch (error) {
      this.deferredPublications = undefined;
      throw error;
    }
    this.deferredPublications = undefined;

    try {
      afterCommit?.(result);
    } finally {
      this.publishDeferred(publications);
    }
    return result;
  }

  list(input: NotificationListInput = {}): NotificationPage {
    return this.store.listNotifications(input);
  }

  /** A durable phase receipt prevents replay from resurrecting pruned notifications. */
  syncCommandExecution(
    execution: Pick<
      CommandExecution,
      | "id"
      | "leadSessionId"
      | "nodeId"
      | "nodeName"
      | "taskId"
      | "state"
      | "createdAt"
      | "updatedAt"
      | "settledAt"
      | "ownership"
      | "outcomeKnown"
      | "exitCode"
      | "descendantCleanupForced"
    >,
  ): void {
    const phase = this.store.commands.notificationPhase(execution.id);
    const awaiting = execution.state === "awaiting_approval";
    const terminal = terminalCommandExecutionStates.has(execution.state);
    if (phase === "completion") {
      const approval = this.store.getNotificationBySourceKey(
        `command_approval:${execution.id}`,
      );
      if (!awaiting && approval?.status === "active") this.resolve(approval.id);
      return;
    }
    if (
      (awaiting && phase === "approval") ||
      (!awaiting && !terminal && phase !== "approval")
    )
      return;
    this.commitAtomically(() => {
      const approvalKey = `command_approval:${execution.id}`;
      if (!awaiting) {
        const approval = this.store.getNotificationBySourceKey(approvalKey);
        if (approval) this.resolve(approval.id);
      }
      if (awaiting || terminal) {
        const kind = awaiting ? "command_approval" : "command_completion";
        this.insert({
          sourceKey: `${kind}:${execution.id}`,
          category: awaiting ? "permission" : "orchestration",
          kind,
          severity:
            awaiting ||
            execution.state === "interrupted" ||
            execution.state === "timed_out"
              ? "warning"
              : execution.state === "failed"
                ? "error"
                : "info",
          title: titledLabel(
            awaiting ? "Command approval: " : `Command ${execution.state}: `,
            execution.nodeName,
          ),
          body: awaiting
            ? "Review the complete command, Node-verified path, and reusable permission scope before allowing or denying it."
            : "The command request has settled. Open the execution to inspect the outcome, retained output, and delivery status.",
          subject: {
            type: "command_execution",
            id: execution.id,
            label: titledLabel("Command on ", execution.nodeName),
            parentId: execution.leadSessionId,
            parentLabel: "Lead orchestrator",
          },
          navigation: { type: "command_execution", executionId: execution.id },
          data: {
            executionId: execution.id,
            nodeId: execution.nodeId,
            leadSessionId: execution.leadSessionId,
            state: execution.state,
            ...(execution.taskId ? { taskId: execution.taskId } : {}),
            ...(terminal
              ? {
                  ownership: execution.ownership,
                  outcomeKnown: execution.outcomeKnown,
                  exitCode: execution.exitCode,
                  descendantCleanupForced: execution.descendantCleanupForced,
                }
              : {}),
          },
          createdAt: awaiting
            ? execution.updatedAt
            : (execution.settledAt ?? execution.updatedAt),
        });
      }
      this.store.commands.recordNotificationPhase(
        execution.id,
        awaiting ? "approval" : terminal ? "completion" : "closed",
      );
    });
  }

  effectivePreference(session: FleetSession): EffectiveSessionNotificationPreference {
    const agentId = stableNotificationAgentId(session);
    const current = this.store.getNotificationPreference(session.id, agentId);
    const fallback =
      !current && agentId !== session.id
        ? this.store.getNotificationPreference(session.id, session.id)
        : undefined;
    const resolution = resolveLifecyclePreference({
      explicitOverride: (current ?? fallback)?.lifecycleEnabled,
      runRole: session.runRole,
      applicationDefault: this.store.getDefaultNotificationLifecycleEnabled(),
    });
    return {
      ...resolution,
      sessionId: session.id,
      agentId,
      runRole: session.runRole,
    };
  }

  updatePreference(
    session: FleetSession,
    lifecycleEnabled: boolean,
  ): EffectiveSessionNotificationPreference {
    const agentId = stableNotificationAgentId(session);
    this.store.updateNotificationPreference(session.id, agentId, lifecycleEnabled);
    if (agentId !== session.id) {
      this.store.deleteNotificationPreference(session.id, session.id);
    }
    return this.effectivePreference(session);
  }

  resetPreference(session: FleetSession): EffectiveSessionNotificationPreference {
    const agentId = stableNotificationAgentId(session);
    this.store.deleteNotificationPreference(session.id, agentId);
    if (agentId !== session.id) {
      this.store.deleteNotificationPreference(session.id, session.id);
    }
    return this.effectivePreference(session);
  }

  createAgentLifecycle(input: AgentLifecycleInput): InsertNotificationResult | undefined {
    if (!this.effectivePreference(input.session).lifecycleEnabled) return undefined;
    const context = input.context;
    const run = context?.run;
    const step = context?.step;
    const attempt = notificationAttemptKey(input.session, context);
    const sourceKey =
      input.kind === "agent_completion" && input.turnComplete
        ? [
            input.kind,
            input.session.id,
            attempt,
            input.turnComplete.sequence,
            digest(input.turnComplete.eventId),
          ].join(":")
        : [
            input.kind,
            input.session.id,
            attempt,
            input.transition.source,
            `${input.transition.from}-${input.transition.to}`,
            input.transition.sequence,
            digest(input.transition.eventId),
          ].join(":");
    const completed = input.kind === "agent_completion";
    const agentName = agentLabel(input.session);
    return this.insert({
      sourceKey,
      category: "agent_lifecycle",
      kind: input.kind,
      severity: completed ? "info" : "error",
      title: completed
        ? titledLabel("", `${agentName} completed a turn`)
        : titledLabel("", `${agentName} session failed`),
      body: completed
        ? "The agent finished a turn and is ready for follow-up."
        : "The agent session ended unexpectedly.",
      subject: run && step ? subjectForStep(run, step) : subjectForAgent(input.session),
      navigation:
        run && step
          ? {
              type: "run_step",
              sessionId: input.session.id,
              runId: run.id,
              stepId: step.id,
            }
          : { type: "session", sessionId: input.session.id },
      data: {
        sessionId: input.session.id,
        runRole: input.session.runRole,
        attempt,
        transition: `${input.transition.from}->${input.transition.to}`,
        transitionSource: input.transition.source,
        sequence: input.transition.sequence,
        eventIdentity: digest(input.transition.eventId),
        ...(run && step
          ? { runId: run.id, stepId: step.id, attempts: step.attempts }
          : {}),
      },
      createdAt: input.transition.createdAt,
    });
  }

  createPermissionRequest(input: PermissionInput): InsertNotificationResult {
    const attempt = notificationAttemptKey(input.session, input.context);
    const requestIdentity = input.requestId || input.event.eventId;
    const sourceKey = this.permissionSourceKey(
      input.session.id,
      attempt,
      requestIdentity,
    );
    return this.insert({
      sourceKey,
      category: "permission",
      kind: "permission_request",
      severity: "warning",
      title: "Permission requested",
      body: "An agent is waiting for a permission decision.",
      subject: {
        type: "permission_request",
        id: digest(requestIdentity),
        label: "Permission request",
        parentId: input.session.id,
        parentLabel: sessionLabel(input.session),
      },
      navigation: {
        type: "permission_request",
        sessionId: input.session.id,
      },
      data: {
        sessionId: input.session.id,
        attempt,
        requestIdentity: digest(requestIdentity),
        sequence: input.event.sequence,
        ...(input.context?.run && input.context.step
          ? {
              runId: input.context.run.id,
              stepId: input.context.step.id,
              attempts: input.context.step.attempts,
            }
          : {}),
      },
      createdAt: input.event.createdAt,
    });
  }

  resolvePermissionRequest(input: PermissionInput): NotificationMutation | undefined {
    const attempt = notificationAttemptKey(input.session, input.context);
    const requestIdentity = input.requestId || input.event.eventId;
    const exact = this.store.getNotificationBySourceKey(
      this.permissionSourceKey(input.session.id, attempt, requestIdentity),
    );
    const fallback =
      exact ??
      (!input.requestId
        ? this.store.findActivePermissionRequest(input.session.id, attempt)
        : undefined);
    return fallback ? this.resolve(fallback.id) : undefined;
  }

  resolveSessionPermissionRequests(sessionId: string): number {
    const notifications = this.store.resolveActivePermissionRequestsForSession(sessionId);
    if (notifications.length === 0) return 0;
    if (this.deferredPublications) {
      for (const notification of notifications) this.defer(notification, true);
    } else {
      for (const notification of notifications) {
        this.publisher.notificationUpsert(notification);
      }
      this.publisher.notificationUnreadCount(this.store.notificationUnreadCount());
    }
    return notifications.length;
  }

  requestRunReview(input: {
    runId: string;
    note: string;
    reason: ReviewReason;
    metadata?: RunNoteMetadata | undefined;
    operationalMaintenance?: AdvanceRunToReviewWrite["operationalMaintenance"];
  }): Run | undefined {
    const advanced = this.store.advanceRunToReview(input.runId, {
      note: input.note,
      metadata: input.metadata ?? {
        kind: input.reason === "completed" ? "review" : "blocked",
        source: "system",
        summary:
          input.reason === "completed"
            ? "Task ready for review"
            : "Task needs a decision",
      },
      notification: (run) => this.reviewNotification(run, input.reason),
      operationalMaintenance: input.operationalMaintenance,
    });
    if (!advanced) return undefined;
    this.publisher.runUpsert(advanced.run);
    if (advanced.notification.created) {
      this.publisher.notificationUpsert(advanced.notification.notification);
      this.publisher.notificationUnreadCount(this.store.notificationUnreadCount());
    }
    return advanced.run;
  }

  private reviewNotification(run: Run, reason: ReviewReason): CreateNotification {
    return {
      sourceKey: `review:${run.id}:${run.reviewSeq}`,
      category: "orchestration",
      kind: "orchestration_needs_review",
      severity: reason === "completed" ? "info" : "warning",
      title: titledLabel("Task needs review: ", run.name),
      body:
        reason === "completed"
          ? "The orchestrator reports that this task is complete and ready for approval."
          : "The orchestrator is blocked and needs a human decision before work can continue.",
      subject: {
        type: "run",
        id: run.id,
        label: boundedLabel(run.name),
      },
      navigation: { type: "run", runId: run.id },
      data: {
        runId: run.id,
        reviewSeq: run.reviewSeq,
        reason,
      },
    };
  }

  resolveRunReview(run: Run): NotificationMutation | undefined {
    if (run.reviewSeq < 1) return undefined;
    const notification = this.store.getNotificationBySourceKey(
      `review:${run.id}:${run.reviewSeq}`,
    );
    return notification ? this.resolve(notification.id) : undefined;
  }

  createPrMaintenanceAttention(
    record: PrMaintenanceRegistration,
    reason: "paused" | "ready" | "long_pause",
  ): InsertNotificationResult {
    const identity =
      reason === "ready"
        ? record.readyFingerprint
        : reason === "long_pause"
          ? record.renewedAt
          : record.pauseReason;
    return this.insert({
      sourceKey: `pr-maintenance:${record.id}:${record.authorization.id}:${reason}:${digest(identity ?? "")}`,
      category: "orchestration",
      kind: "pr_maintenance_attention",
      severity: reason === "ready" ? "info" : "warning",
      title:
        reason === "ready"
          ? "PR is ready for human merge"
          : reason === "long_pause"
            ? "Resume or release PR maintenance"
            : "PR maintenance paused",
      body:
        reason === "ready"
          ? "Current feedback, checks and reviews permit readiness. Fleet will not merge the PR."
          : reason === "long_pause"
            ? "Maintenance has been paused for 30 days. Continuity remains protected until an operator releases settled work."
            : `Maintenance is waiting: ${record.pauseReason}. Open the task for its checkpoint and bounded recovery actions.`,
      subject: {
        type: "run",
        id: record.taskId,
        label: `${prMaintenanceProviderLabel(record.identity)} PR #${record.identity.prNumber}`,
      },
      navigation: { type: "run", runId: record.taskId },
      data: { recordId: record.id, reason, prUrl: prMaintenanceUrl(record.identity) },
    });
  }

  createPrMaintenanceProposal(proposal: PrMaintenanceProposal): InsertNotificationResult {
    const { taskId, identity } = proposal.registration;
    return this.insert({
      sourceKey: `pr-maintenance-proposal:${proposal.id}:${proposal.version}`,
      category: "orchestration",
      kind: "pr_maintenance_attention",
      severity: "info",
      title: "PR maintenance needs your authorization",
      body: `Review the proposed maintenance for ${prMaintenanceProviderLabel(identity)} ${identity.repository} #${identity.prNumber}. Nothing is enabled until you authorize its exact scope.`,
      subject: {
        type: "run",
        id: taskId,
        label: this.store.getRun(taskId)?.name ?? "Task",
      },
      navigation: { type: "run", runId: taskId },
      data: {
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        reason: "authorization",
        prUrl: prMaintenanceUrl(identity),
      },
    });
  }

  resolvePrMaintenanceProposal(proposal: PrMaintenanceProposal): void {
    const notification = this.store.getNotificationBySourceKey(
      `pr-maintenance-proposal:${proposal.id}:${proposal.version}`,
    );
    if (notification) this.resolve(notification.id);
  }

  createOrchestrationStepFailure(run: Run, step: RunStep): InsertNotificationResult {
    return this.insert({
      sourceKey: `orchestration_step_failure:${run.id}:${step.id}:${step.attempts}`,
      category: "orchestration",
      kind: "orchestration_step_failure",
      severity: "error",
      title: titledLabel("Step failed: ", step.title),
      body: `An orchestration step failed during attempt ${step.attempts}.`,
      subject: subjectForStep(run, step),
      navigation: {
        type: "run_step",
        runId: run.id,
        stepId: step.id,
        ...(step.sessionId ? { sessionId: step.sessionId } : {}),
      },
      data: {
        runId: run.id,
        stepId: step.id,
        attempts: step.attempts,
      },
    });
  }

  createWorktreeAttention(
    runId: string,
    identity: string,
    reason: "creation" | "conflict" | "reconciliation" | "integration",
    code = "",
    context: { phase?: string; targetRef?: string } = {},
  ): InsertNotificationResult {
    const run = this.store.getRun(runId);
    const sourceKey = `managed_worktree_attention:${runId}:${identity}:${reason}`;
    const input: CreateNotification = {
      sourceKey,
      category: "orchestration",
      kind: "managed_worktree_attention",
      severity: reason === "creation" ? "error" : "warning",
      title:
        reason === "creation"
          ? titledLabel("Workspace setup failed: ", run?.name ?? "Task")
          : reason === "integration"
            ? titledLabel("Integration needs attention: ", run?.name ?? "Task")
            : "Managed task needs attention",
      body:
        reason === "creation"
          ? code === "node_unavailable"
            ? "The repository’s Node disconnected. Open the task and retry workspace setup after it reconnects."
            : code === "unsupported_hooks"
              ? "The repository has active Git hooks. Open the task to review details and continue explicitly."
              : "Preparing the isolated workspace failed. Open the task for a safe retry and actionable details."
          : reason === "conflict"
            ? "Merge conflicts require an explicit resolution or abort. Open the task for recovery controls."
            : reason === "integration"
              ? `Automatic integration${context.targetRef ? ` into ${context.targetRef}` : ""} stopped safely${context.phase ? ` during ${context.phase}` : ""}. Open the task to review the reason and retry.`
              : "Workspace ownership needs reconciliation. Open the task; no automatic overwrite or deletion was attempted.",
      subject: { type: "run", id: runId, label: run?.name ?? "Managed task" },
      navigation: { type: "run", runId },
      data: { runId, reason, ...context, ...(code ? { code } : {}) },
      createdAt: new Date().toISOString(),
    };
    const existing = this.store.getNotificationBySourceKey(sourceKey);
    if (existing) {
      const notification = this.store.updateNotification(existing.id, {
        severity: input.severity,
        title: input.title,
        body: input.body,
        subject: input.subject,
        navigation: input.navigation,
        data: input.data,
      });
      if (notification) this.publishOrDefer(notification, false);
      return { notification: notification ?? existing, created: false };
    }
    return this.insert(input);
  }

  resolveWorktreeAttention(
    runId: string,
    identity: string,
    reason: "creation" | "conflict" | "reconciliation" | "integration",
  ): NotificationMutation | undefined {
    const notification = this.store.getNotificationBySourceKey(
      `managed_worktree_attention:${runId}:${identity}:${reason}`,
    );
    return notification ? this.resolve(notification.id) : undefined;
  }

  markRead(id: string): NotificationMutation | undefined {
    const before = this.store.getNotification(id);
    if (!before) return undefined;
    if (before.readAt) return { notification: before, changed: false };
    return this.mutate(
      () => this.store.markNotificationRead(id),
      before.status !== "dismissed",
    );
  }

  markAllRead(): MarkAllNotificationsReadResponse {
    const result = this.store.markAllNotificationsRead();
    if (this.deferredPublications) {
      for (const notification of result.notifications) {
        this.defer(notification, true);
      }
      return result;
    }
    for (const notification of result.notifications) {
      this.publisher.notificationUpsert(notification);
    }
    if (result.updated > 0) {
      this.publisher.notificationUnreadCount(result.unreadCount);
    }
    return result;
  }

  dismissAll(): MarkAllNotificationsReadResponse {
    const result = this.store.dismissAllNotifications();
    if (this.deferredPublications) {
      for (const notification of result.notifications) {
        this.defer(notification, true);
      }
      return result;
    }
    for (const notification of result.notifications) {
      this.publisher.notificationUpsert(notification);
    }
    if (result.updated > 0) {
      this.publisher.notificationUnreadCount(result.unreadCount);
    }
    return result;
  }

  dismiss(id: string): NotificationMutation | undefined {
    const before = this.store.getNotification(id);
    if (!before) return undefined;
    if (before.status === "dismissed" && before.dismissedAt) {
      return { notification: before, changed: false };
    }
    return this.mutate(
      () => this.store.dismissNotification(id),
      before.readAt === null && before.status !== "dismissed",
    );
  }

  resolve(id: string): NotificationMutation | undefined {
    const before = this.store.getNotification(id);
    if (!before) return undefined;
    if (before.resolvedAt && before.readAt) {
      return { notification: before, changed: false };
    }
    return this.mutate(
      () => this.store.resolveNotification(id),
      before.readAt === null && before.status !== "dismissed",
    );
  }

  private permissionSourceKey(
    sessionId: string,
    attempt: string,
    requestIdentity: string,
  ): string {
    return `permission_request:${sessionId}:${attempt}:${digest(requestIdentity)}`;
  }

  private insert(input: CreateNotification): InsertNotificationResult {
    const result = this.store.insertNotification(input);
    if (!result.created) return result;
    this.publishOrDefer(result.notification, true);
    return result;
  }

  private mutate(
    write: () => Notification | undefined,
    unreadChanged: boolean,
  ): NotificationMutation | undefined {
    const notification = write();
    if (!notification) return undefined;
    this.publishOrDefer(notification, unreadChanged);
    return { notification, changed: true };
  }

  private publishOrDefer(notification: Notification, unreadChanged: boolean): void {
    if (this.deferredPublications) {
      this.defer(notification, unreadChanged);
      return;
    }
    this.publisher.notificationUpsert(notification);
    if (unreadChanged) {
      this.publisher.notificationUnreadCount(this.store.notificationUnreadCount());
    }
  }

  private defer(notification: Notification, unreadChanged = false): void {
    const publications = this.deferredPublications;
    if (!publications) return;
    publications.notifications.set(notification.id, notification);
    publications.unreadChanged ||= unreadChanged;
  }

  private publishDeferred(publications: DeferredPublications): void {
    for (const notification of publications.notifications.values()) {
      this.publisher.notificationUpsert(notification);
    }
    if (publications.unreadChanged) {
      this.publisher.notificationUnreadCount(this.store.notificationUnreadCount());
    }
  }
}
