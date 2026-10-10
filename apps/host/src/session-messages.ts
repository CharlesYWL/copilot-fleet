import { createHash, randomUUID } from "node:crypto";
import {
  errorMessage,
  eventPayload,
  parseFleetControl,
  type PendingSessionMessage,
  type PromptAttachment,
  type SessionEvent,
  type SessionActor,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";
import type { QueuedSessionMessage } from "./store.js";
import { CommandConflict } from "./command-execution-store.js";

type PromptInput = {
  prompt: string;
  attachments: PromptAttachment[];
  operationId?: string | undefined;
  handback?: "ongoing" | "after_turn" | undefined;
};

/** Host-owned operator queue, alongside the existing workflow-owned lead deliveries. */
export class SessionMessages {
  constructor(private readonly service: FleetService) {
    for (const message of this.store.queuedMessages()) {
      if (
        message.state === "sending" &&
        !this.store.commands.promptByKey(message.sessionId, message.deliveryKey)
      )
        this.store.saveQueuedMessage({
          ...message,
          state: "failed",
          error:
            "The Host restarted before delivery was confirmed. Review the transcript before sending again.",
        });
    }
  }

  private get store() {
    return this.service.store;
  }

  submit(
    sessionId: string,
    input: PromptInput,
    operatorId?: string,
    actor?: SessionActor,
  ) {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false as const, status: 404, error: "Session not found" };
    if (this.service.console?.blocked(session.nodeId))
      return { ok: false as const, status: 409, error: "Node history is synchronizing" };
    if (
      session.state === "idle" &&
      this.store.queuedMessages(sessionId).length === 0 &&
      (this.store.prMaintenance.manualRecord(sessionId) ||
        this.store.prMaintenance.hasManualHistory(sessionId))
    )
      return this.service.promptSession(sessionId, input, operatorId, undefined, actor);
    const id = input.operationId ?? randomUUID();
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          sessionId,
          input.prompt,
          input.attachments,
          input.handback,
          operatorId,
          ...(actor ? [actor] : []),
        ]),
      )
      .digest("hex");
    const previous = this.store.queuedMessage(id);
    if (previous) {
      if (previous.digest !== digest)
        throw new CommandConflict(
          "message_conflict",
          "This request key already identifies another message.",
        );
      return { ok: true as const };
    }
    const link = this.service.nodeSocket(session.nodeId);
    if (!link || link.readyState !== link.OPEN)
      return { ok: false as const, status: 503, error: "Node is offline" };
    if (
      session.stopRequested ||
      session.cleanupRequested ||
      !["idle", "running", "starting", "cancelling"].includes(session.state)
    )
      return {
        ok: false as const,
        status: 409,
        error: "This session cannot accept messages.",
      };
    if (
      input.handback === "after_turn" &&
      (!operatorId ||
        actor?.kind === "node_console" ||
        !this.store.prMaintenance.manualRecord(sessionId))
    )
      return {
        ok: false as const,
        status: 409,
        error:
          "One-turn handback requires an authenticated operator and retained maintenance worker.",
      };
    const pending = this.store.queuedMessages();
    if (
      pending.filter((message) => message.sessionId === sessionId).length >= 100 ||
      Buffer.byteLength(JSON.stringify([...pending, input])) > 128 * 1024 * 1024
    )
      throw new CommandConflict(
        "message_queue_full",
        "The message queue is full. Cancel queued messages before adding more.",
      );
    this.store.saveQueuedMessage({
      id,
      sessionId,
      prompt: input.prompt,
      attachments: input.attachments,
      operatorId,
      actor,
      handback: input.handback,
      digest,
      createdAt: new Date().toISOString(),
      state: "pending",
      priority: 0,
      afterSequence: 0,
      error: "",
      deliveryKey: `operator-queue:${id}`,
    });
    this.pump(sessionId);
    const failed = this.store.queuedMessage(id);
    if (failed?.state === "failed")
      return { ok: false as const, status: 409, error: failed.error };
    return { ok: true as const };
  }

  list(sessionId: string): PendingSessionMessage[] {
    const session = this.store.getSession(sessionId);
    const canSend =
      !!session &&
      !session.stopRequested &&
      !session.cleanupRequested &&
      ["idle", "running"].includes(session.state);
    const operators = this.store.queuedMessages(sessionId);
    const result: PendingSessionMessage[] = operators.flatMap((message) => {
      const delivery = this.store.commands.promptByKey(sessionId, message.deliveryKey);
      if (delivery && ["accepted", "settled"].includes(delivery.state)) return [];
      const waiting = delivery && ["pending", "rejected_busy"].includes(delivery.state);
      const editable = message.state !== "sending" || !!waiting;
      return [
        {
          id: message.id,
          prompt: message.prompt,
          createdAt: message.createdAt,
          source: "operator" as const,
          state: waiting ? "pending" : message.state,
          attachments: message.attachments.map(({ name }) => ({ name })),
          canCancel: editable,
          canSendNow: canSend && editable,
          detail: message.error || (!editable ? "Waiting for delivery confirmation" : ""),
        },
      ];
    });
    for (const operation of this.store.sessionConsole.localOperations(sessionId)) {
      if (!["queued", "accepted", "uncertain"].includes(operation.state)) continue;
      const payload = operation.payload;
      result.push({
        id: `node:${operation.id}`,
        prompt:
          payload &&
          typeof payload === "object" &&
          "prompt" in payload &&
          typeof payload.prompt === "string"
            ? payload.prompt
            : operation.action,
        createdAt: operation.createdAt,
        source: "operator",
        state:
          operation.state === "queued"
            ? "pending"
            : operation.state === "uncertain"
              ? "failed"
              : "sending",
        attachments: [],
        canCancel:
          operation.state === "queued" &&
          this.service.console.enabled(session!.nodeId) &&
          !this.service.console.blocked(session!.nodeId),
        canSendNow:
          operation.state === "queued" &&
          canSend &&
          this.service.console.enabled(session!.nodeId) &&
          !this.service.console.blocked(session!.nodeId),
        detail: operation.error || "Queued on Node",
      });
    }
    const ownedKeys = new Set(operators.map((message) => message.deliveryKey));
    for (const record of this.store.commands.prompts(sessionId)) {
      if (ownedKeys.has(record.key) || record.state === "accepted") continue;
      result.push({
        id: `delivery:${record.delivery.deliveryId}`,
        prompt: record.delivery.prompt,
        createdAt: record.createdAt,
        source: parseFleetControl(record.delivery.prompt) ? "fleet" : "operator",
        state: record.state,
        attachments: (record.delivery.attachments ?? []).map(({ name }) => ({ name })),
        canCancel:
          ["pending", "rejected_busy"].includes(record.state) &&
          !record.executions.length &&
          !this.store.localAgent.byDelivery(record.delivery.deliveryId),
        canSendNow:
          canSend &&
          ["pending", "rejected_busy"].includes(record.state) &&
          this.store.localAgent.admits(record),
        detail: "Workflow message",
      });
    }
    for (const run of this.store.listRuns()) {
      if (run.leadSessionId !== sessionId || !run.pendingPrompt) continue;
      const protectedBrief = this.store.localAgent.waitingBriefOwed(run.id);
      result.push({
        id: `run:${run.id}:${createHash("sha256").update(run.pendingPrompt).digest("hex").slice(0, 32)}`,
        prompt: run.pendingPrompt,
        createdAt: run.updatedAt,
        source: "fleet",
        state: "pending",
        attachments: [],
        canCancel: !protectedBrief,
        canSendNow: canSend && !protectedBrief,
        detail: protectedBrief
          ? "Managed by the local-agent request"
          : `Task: ${run.name}`,
      });
    }
    return result;
  }

  act(sessionId: string, id: string, action: "cancel" | "send-now"): void {
    const message = this.list(sessionId).find((item) => item.id === id);
    if (!message)
      throw new CommandConflict(
        "message_changed",
        "This message has already been delivered or changed. Refresh the queue.",
      );
    if (!(action === "cancel" ? message.canCancel : message.canSendNow))
      throw new CommandConflict(
        "message_locked",
        "This message is already being delivered or is managed by its workflow.",
      );
    if (id.startsWith("node:")) {
      this.service.console.controlQueue(sessionId, id.slice("node:".length), action);
      return;
    }
    const session = this.store.getSession(sessionId)!;
    if (action === "send-now" && !this.service.nodeSocket(session.nodeId))
      throw new CommandConflict(
        "node_offline",
        "Reconnect the Node before sending this message.",
      );

    this.store.writeAtomically(() => {
      if (id.startsWith("run:")) {
        const run = this.store.getRun(id.split(":")[1]!)!;
        if (action === "send-now") {
          // Use the scheduler's receipt boundary, not a second copy of an owed brief.
          if (!this.service.commands.durableLead(sessionId))
            throw new CommandConflict(
              "durable_lead_delivery_required",
              "Reconnect or upgrade the Node before sending this workflow message now.",
            );
          if (
            !this.store.recordRunPromptDelivery(
              run.id,
              sessionId,
              run.pendingPrompt,
              new Date().toISOString(),
            )
          )
            throw new CommandConflict("message_changed");
          const record = this.service.commands.queueLeadPrompt(
            sessionId,
            run.pendingPrompt,
          );
          this.store.commands.prioritizePrompt(record.delivery.deliveryId);
        } else {
          this.store.updateRun(run.id, { pendingPrompt: "" });
        }
      } else if (id.startsWith("delivery:")) {
        const record = this.store.commands.prompt(id.slice("delivery:".length))!;
        if (action === "cancel")
          this.store.commands.updatePrompt({ ...record, state: "orphaned" });
        else this.store.commands.prioritizePrompt(record.delivery.deliveryId);
      } else {
        const record = this.store.queuedMessage(id)!;
        const delivery = this.store.commands.promptByKey(sessionId, record.deliveryKey);
        if (action === "cancel") {
          if (delivery && ["pending", "rejected_busy"].includes(delivery.state))
            this.store.commands.updatePrompt({ ...delivery, state: "orphaned" });
          this.retire(record, "cancelled");
        } else if (record.state === "sending" && delivery) {
          this.store.commands.prioritizePrompt(delivery.delivery.deliveryId);
        } else
          this.store.saveQueuedMessage({
            ...record,
            state: "pending",
            priority: Date.now(),
            error: "",
            deliveryKey:
              record.state === "failed"
                ? `operator-queue:${randomUUID()}`
                : record.deliveryKey,
          });
        if (id.startsWith("run:"))
          this.service.publishRun(this.store.getRun(id.split(":")[1]!)!);
      }
    });
    if (action === "send-now") {
      if (session.state === "running") {
        this.service.publishSession(this.service.beginSessionCancellation(sessionId));
        const sent = this.service.dispatch(
          session.nodeId,
          { type: "cancel", sessionId },
          undefined,
          undefined,
          undefined,
          { preservePendingPrompts: true },
        );
        if (!sent.sent)
          throw new CommandConflict(
            "node_offline",
            "The Node disconnected. The message remains queued.",
          );
      } else {
        this.pump(sessionId);
        this.service.commands.pumpLead(sessionId);
      }
    }
  }

  private retire(message: QueuedSessionMessage, state: "delivered" | "cancelled") {
    this.store.saveQueuedMessage({
      ...message,
      state,
      prompt: "",
      attachments: [],
      error: "",
    });
  }

  handleEvent(event: SessionEvent): void {
    if (!["state", "system", "turn_complete", "error"].includes(event.type)) return;
    for (const message of this.store.queuedMessages(event.sessionId, "sending")) {
      if (event.sequence <= message.afterSequence) continue;
      // Durable lead delivery has its own receipt; never infer it from unrelated events.
      if (this.store.commands.promptByKey(event.sessionId, message.deliveryKey)) continue;
      if (
        eventPayload(event, "state")?.state === "running" ||
        eventPayload(event, "system")?.text?.startsWith("User: ") ||
        event.type === "turn_complete"
      )
        this.retire(message, "delivered");
      else if (event.type === "error")
        this.store.saveQueuedMessage({
          ...message,
          state: "failed",
          error: eventPayload(event, "error")?.message || "Message delivery failed.",
        });
    }
    // The next engine tick delivers only after lifecycle and worker settlement finish.
  }

  tick(leadsOnly = false): void {
    for (const id of this.store.queuedMessageSessionIds())
      if (!leadsOnly || this.store.getSession(id)?.runRole === "lead") this.pump(id);
  }

  pump(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    const messages = this.store.queuedMessages(
      sessionId,
      session?.state === "idle" ? undefined : "sending",
    );
    const inFlight = messages.find((message) => message.state === "sending");
    if (inFlight) {
      const delivery = this.store.commands.promptByKey(sessionId, inFlight.deliveryKey);
      if (delivery && ["accepted", "settled"].includes(delivery.state))
        this.retire(inFlight, "delivered");
      else if (delivery && ["rejected", "orphaned"].includes(delivery.state))
        this.store.saveQueuedMessage({
          ...inFlight,
          state: "failed",
          error:
            "Delivery was interrupted or rejected. Review the transcript before retrying.",
        });
      else if (
        !delivery &&
        ["offline", "failed", "stopped", "completed"].includes(
          this.store.getSession(sessionId)?.state ?? "offline",
        )
      )
        this.store.saveQueuedMessage({
          ...inFlight,
          state: "failed",
          error:
            "Delivery could not be confirmed. Review the transcript before retrying.",
        });
      return;
    }
    const message = messages[0];
    if (
      !message ||
      message.state !== "pending" ||
      !session ||
      session.state !== "idle" ||
      session.stopRequested ||
      session.cleanupRequested ||
      !this.service.nodeSocket(session.nodeId) ||
      this.service.console?.blocked(session.nodeId) ||
      this.service.console?.reserved(sessionId)
    )
      return;
    if (session.runRole === "lead" && this.store.commands.reserved(sessionId)) return;
    this.store.saveQueuedMessage({
      ...message,
      state: "sending",
      afterSequence: this.store.maxEventSequence(sessionId),
    });
    try {
      const result = this.service.promptSession(
        sessionId,
        {
          prompt: message.prompt,
          attachments: message.attachments,
          operationId: message.id,
          handback: message.handback,
        },
        message.operatorId,
        message.deliveryKey,
        message.actor,
      );
      if (!result.ok) throw new Error(result.error);
      if (!this.store.commands.promptByKey(sessionId, message.deliveryKey))
        this.service.publishSession(this.service.beginQueuedPrompt(sessionId));
    } catch (error) {
      this.store.saveQueuedMessage({
        ...message,
        state: "failed",
        error: errorMessage(error),
      });
    }
  }
}
