import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeCommand, PendingSessionMessage, SessionEvent } from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { sessionRoutes } from "./sessions.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(lead = false) {
  const directory = mkdtempSync(join(tmpdir(), "fleet-message-queue-"));
  const file = join(directory, "host.db");
  const store = new FleetStore(file);
  const app = Fastify();
  const service = new FleetService(store, app.log);
  const { node } = store.registerNode({
    name: "Node",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 3,
  });
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const session = store.createSession(placement, "initial", false, "Session", {
    runRole: lead ? "lead" : "",
  });
  store.transitionSession(session.id, "starting");
  store.transitionSession(session.id, "running");
  const sent: NodeCommand[] = [];
  service.attachNode(node.id, {
    OPEN: 1,
    readyState: 1,
    close: () => {},
    send: (raw: string) => {
      const frame = JSON.parse(raw) as { type: string; command: NodeCommand };
      if (frame.type === "command") sent.push(frame.command);
    },
  });
  store.setNodeOnline(node.id, true, 0);
  await app.register(sessionRoutes, { service });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    service.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const submit = (prompt: string, operationId = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: {
        prompt,
        operationId,
        attachments: [{ name: "note.txt", mimeType: "text/plain", data: "aGk=" }],
      },
    });
  const list = async () => {
    const response = await app.inject(`/api/sessions/${session.id}/messages`);
    expect(response.statusCode).toBe(200);
    return response.json<PendingSessionMessage[]>();
  };
  const action = (id: string, action: string) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${encodeURIComponent(id)}/${action}`,
    });
  const event = (
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
    sessionId = session.id,
  ) => {
    service.handleEvent({
      eventId: randomUUID(),
      sessionId,
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  };
  return {
    app,
    store,
    service,
    session,
    sent,
    submit,
    list,
    action,
    event,
    file,
    node,
    placement,
  };
}

describe("session message queue", () => {
  it("offers reconcile on a message the Node refused until its history is reconciled", async () => {
    const f = await setup();
    await f.submit("Needs the Node to catch up");
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    const prompt = f.sent.find((command) => command.type === "prompt")!;
    expect(prompt).toBeDefined();

    f.service.markQueuedRefusal(f.session.id, prompt.commandId!, "console_resync");

    const [refused] = await f.list();
    expect(refused).toMatchObject({ state: "failed", recovery: "console_resync" });
    expect(refused!.detail).toContain("reconciled");
    // Send now is the retry the Reconcile button performs, and it clears the flag.
    expect((await f.action(refused!.id, "send-now")).statusCode).toBe(202);
    expect((await f.list())[0]).not.toHaveProperty("recovery");
  });

  it("leaves a refusal without a recovery, or for another command, as it was", async () => {
    const f = await setup();
    await f.submit("Delivered normally");
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    const prompt = f.sent.find((command) => command.type === "prompt")!;

    f.service.markQueuedRefusal(f.session.id, prompt.commandId!, undefined);
    f.service.markQueuedRefusal(f.session.id, "some-other-command", "console_resync");

    expect((await f.list())[0]).toMatchObject({ state: "sending" });
    expect((await f.list())[0]).not.toHaveProperty("recovery");
  });

  it("preserves pre-console operator idempotency digests across upgrades", async () => {
    const f = await setup();
    const id = randomUUID();
    expect((await f.submit("Existing queued input", id)).statusCode).toBe(202);
    const message = f.store.queuedMessage(id)!;
    const legacyDigest = createHash("sha256")
      .update(
        JSON.stringify([
          message.sessionId,
          message.prompt,
          message.attachments,
          message.handback,
          message.operatorId,
        ]),
      )
      .digest("hex");
    expect(message.digest).toBe(legacyDigest);
    expect((await f.submit("Existing queued input", id)).statusCode).toBe(202);
    expect(f.store.queuedMessages(f.session.id)).toHaveLength(1);
  });
  it("does not read queued attachment payloads for streamed agent text", async () => {
    const f = await setup();
    await f.submit("Wait while streaming");
    const readQueue = vi.spyOn(f.store, "queuedMessages");
    f.event(1, "agent_text", { text: "Streaming..." });
    expect(readQueue).not.toHaveBeenCalled();
    f.service.messages.tick();
    expect(readQueue).toHaveBeenCalledWith(f.session.id, "sending");
  });

  it("settles a worker's original step before dispatching its queued follow-up", async () => {
    const f = await setup(true);
    const run = f.store.createRun({
      workspaceId: f.session.workspaceId,
      name: "Task",
      objective: "Work",
    });
    f.store.updateRun(run.id, { state: "running", leadSessionId: f.session.id });
    const worker = f.store.createSession(f.placement, "original", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    f.store.transitionSession(worker.id, "starting");
    f.store.transitionSession(worker.id, "running");
    const step = f.store.upsertRunStep(run.id, {
      stepKey: "work",
      title: "Work",
      prompt: "original",
      category: "implement",
      placementId: f.placement.id,
    });
    f.store.updateRunStep(step.id, {
      state: "running",
      sessionId: worker.id,
    });
    const engine = new OrchestratorEngine(f.service);
    f.service.onSessionEvent((event) => engine.handleSessionEvent(event));
    f.service.messages.submit(worker.id, { prompt: "Next task", attachments: [] });
    f.event(1, "turn_complete", { stopReason: "end_turn" }, worker.id);
    expect(f.store.getSessionTurnCompletion(worker.id)).toBeDefined();
    expect(f.store.getRun(run.id)!.state).toBe("running");
    f.event(2, "state", { state: "idle" }, worker.id);
    expect(f.store.getRunStep(step.id)!.state).toBe("succeeded");
    expect(
      f.sent.filter(
        (command) => command.type === "prompt" && command.sessionId === worker.id,
      ),
    ).toMatchObject([{ prompt: "Next task" }]);
  });

  it("lets an operator withdraw a lead message while its durable delivery is still pending", async () => {
    const f = await setup(true);
    vi.spyOn(f.service.commands, "durableLead").mockReturnValue(true);
    vi.spyOn(f.service.commands, "pumpLead").mockImplementation(() => {});
    await f.submit("Not yet delivered");
    const message = (await f.list())[0]!;
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    expect((await f.list())[0]).toMatchObject({ state: "pending", canCancel: true });
    expect((await f.action(message.id, "cancel")).statusCode).toBe(202);
    expect(await f.list()).toEqual([]);
    expect(f.store.commands.prompts(f.session.id)).toEqual([]);
  });

  it("uses a new delivery identity for an explicit retry after a lead delivery was rejected", async () => {
    const f = await setup(true);
    vi.spyOn(f.service.commands, "durableLead").mockReturnValue(true);
    vi.spyOn(f.service.commands, "pumpLead").mockImplementation(() => {});
    await f.submit("Retry explicitly");
    const message = (await f.list())[0]!;
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    const previous = f.store.commands.prompts(f.session.id)[0]!;
    f.store.commands.updatePrompt({ ...previous, state: "rejected" });
    f.service.messages.tick();
    expect((await f.list())[0]!.state).toBe("failed");
    expect((await f.action(message.id, "send-now")).statusCode).toBe(202);
    expect(f.store.commands.prompts(f.session.id)[0]!.delivery.deliveryId).not.toBe(
      previous.delivery.deliveryId,
    );
  });

  it("queues while busy, returns safe previews, and delivers FIFO once the agent is idle", async () => {
    const f = await setup();
    expect((await f.submit("First")).statusCode).toBe(202);
    expect((await f.submit("Second")).statusCode).toBe(202);
    const messages = await f.list();
    expect(messages.map((message) => message.prompt)).toEqual(["First", "Second"]);
    expect(messages[0]!.attachments).toEqual([{ name: "note.txt" }]);
    expect(f.sent).toHaveLength(0);
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    f.service.messages.tick();
    expect(f.sent.filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      type: "prompt",
      prompt: "First",
      attachments: [{ data: "aGk=" }],
    });
    f.event(2, "state", { state: "running" });
    f.event(3, "turn_complete", { stopReason: "end_turn" });
    f.event(4, "state", { state: "idle" });
    f.service.messages.tick();
    expect(
      f.sent
        .filter((command) => command.type === "prompt")
        .map((command) => command.prompt),
    ).toEqual(["First", "Second"]);
  });

  it("deduplicates retries and remembers cancellation without reviving the message", async () => {
    const f = await setup();
    const key = randomUUID();
    await f.submit("Once", key);
    await f.submit("Once", key);
    expect(await f.list()).toHaveLength(1);
    expect((await f.submit("Different", key)).statusCode).toBe(409);
    expect((await f.action(key, "cancel")).statusCode).toBe(202);
    await f.submit("Once", key);
    expect(await f.list()).toEqual([]);
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    expect(f.sent).toHaveLength(0);
  });

  it("send now interrupts first, preserves other messages, and prioritizes only the chosen one", async () => {
    const f = await setup();
    await f.submit("First");
    await f.submit("Send this now");
    const messages = await f.list();
    expect((await f.action(messages[1]!.id, "send-now")).statusCode).toBe(202);
    expect(f.sent.map((command) => command.type)).toEqual(["cancel"]);
    expect(f.store.getSession(f.session.id)!.state).toBe("cancelling");
    f.service.messages.tick();
    expect(f.sent).toHaveLength(1);
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    expect(f.sent[1]).toMatchObject({ type: "prompt", prompt: "Send this now" });
    expect((await f.list()).map((message) => message.prompt)).toContain("First");
  });

  it("survives reopening the Host database, including attachments", async () => {
    const f = await setup();
    await f.submit("Saved on the Host");
    const reopened = new FleetStore(f.file);
    try {
      expect(reopened.queuedMessages(f.session.id)[0]).toMatchObject({
        prompt: "Saved on the Host",
        attachments: [{ name: "note.txt", data: "aGk=" }],
      });
    } finally {
      reopened.close();
    }
  });

  it("keeps a delivery failure visible and never loops on it", async () => {
    const f = await setup();
    await f.submit("Keep me");
    f.event(1, "state", { state: "idle" });
    const send = vi
      .spyOn(f.service, "promptSession")
      .mockReturnValue({ ok: false, status: 503, error: "Node disconnected" });
    f.service.messages.tick();
    f.service.messages.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await f.list()).toMatchObject([
      { state: "failed", detail: "Node disconnected", canCancel: true },
    ]);
  });

  it("refuses queueing into stopped sessions and does not dispatch while Stop is pending", async () => {
    const f = await setup();
    await f.submit("Wait");
    f.store.setSessionControls(f.session.id, { stopRequested: true });
    expect((await f.submit("Not accepted")).statusCode).toBe(409);
    f.event(1, "state", { state: "idle" });
    f.service.messages.tick();
    expect(f.sent.filter((command) => command.type === "prompt")).toHaveLength(0);
    expect((await f.list())[0]!.canSendNow).toBe(false);
  });

  it("shows owed workflow messages, cancels only the reviewed version, and protects receipt-bound results", async () => {
    const f = await setup(true);
    const run = f.store.createRun({
      workspaceId: f.session.workspaceId,
      name: "Task",
      objective: "Work",
    });
    f.store.updateRun(run.id, {
      leadSessionId: f.session.id,
      pendingPrompt: "<fleet-task-transfer>Moved</fleet-task-transfer>",
    });
    const [message] = await f.list();
    expect(message).toMatchObject({ source: "fleet", canCancel: true });
    f.store.updateRun(run.id, { pendingPrompt: "A different brief" });
    expect((await f.action(message!.id, "cancel")).statusCode).toBe(409);
    const current = (await f.list())[0]!;
    expect((await f.action(current.id, "cancel")).statusCode).toBe(202);
    expect(f.store.getRun(run.id)!.pendingPrompt).toBe("");
    const protectedResult = f.store.commands.enqueuePrompt({
      key: randomUUID(),
      nodeId: f.node.id,
      executions: [randomUUID()],
      delivery: { sessionId: f.session.id, prompt: "Command completion" },
    });
    expect((await f.list())[0]).toMatchObject({ canCancel: false });
    expect(
      (await f.action(`delivery:${protectedResult.delivery.deliveryId}`, "cancel"))
        .statusCode,
    ).toBe(409);
  });

  it("preserves unsent lead deliveries on send-now interruption and orders the selected delivery first", async () => {
    const f = await setup(true);
    const enqueue = (prompt: string) =>
      f.store.commands.enqueuePrompt({
        key: randomUUID(),
        nodeId: f.node.id,
        executions: [],
        delivery: { sessionId: f.session.id, prompt },
      });
    const first = enqueue("First");
    const selected = enqueue("Now");
    expect(
      (await f.action(`delivery:${selected.delivery.deliveryId}`, "send-now")).statusCode,
    ).toBe(202);
    expect(
      f.store.commands.prompts(f.session.id).map((record) => record.delivery.prompt),
    ).toEqual(["Now", "First"]);
    expect(f.store.commands.prompt(first.delivery.deliveryId)!.state).toBe("pending");
    expect(f.sent[0]!.type).toBe("cancel");
  });
});
