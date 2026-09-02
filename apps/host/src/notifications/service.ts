import { createHash } from "node:crypto";
import type {
  CreateNotification,
  FleetSession,
  MarkAllNotificationsReadResponse,
  Notification,
  Run,
  RunRole,
  RunStep,
  SessionState,
} from "@fleet/protocol";
import type {
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

const subjectForAgent = (session: FleetSession) => ({
  type: "agent" as const,
  id: session.id,
  label: roleLabel(session.runRole),
  parentId: session.id,
  parentLabel: sessionLabel(session),
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
    return this.insert({
      sourceKey,
      category: "agent_lifecycle",
      kind: input.kind,
      severity: completed ? "info" : "error",
      title: completed ? "Agent turn completed" : "Agent session failed",
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
  }): Run | undefined {
    const advanced = this.store.advanceRunToReview(input.runId, {
      note: input.note,
      notification: (run) => this.reviewNotification(run, input.reason),
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
