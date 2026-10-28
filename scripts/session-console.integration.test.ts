import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostToNodeMessageSchema,
  NodeCommandSchema,
  SESSION_CONSOLE_CAPABILITY,
  type ConsoleRequest,
  type ConsoleResponse,
  type NodeCommand,
} from "@fleet/protocol";
import { FleetStore } from "../apps/host/src/store.js";
import { FleetService, type NodeLink } from "../apps/host/src/fleet-service.js";
import { OrchestratorEngine } from "../apps/host/src/orchestrator/engine.js";
import { notificationAttemptKey } from "../apps/host/src/notifications/service.js";
import { HOST_IDENTITY_ID_SETTING } from "../apps/host/src/auth/host-identity.js";
import { MockAgentFactory } from "../apps/node/src/agents.js";
import { CommandRouter } from "../apps/node/src/router.js";
import { SessionJournal } from "../apps/node/src/session-journal.js";
import { SessionFileReader } from "../apps/node/src/session-files.js";
import {
  NodeSessionConsole,
  LIVE_EVENT_WINDOW_BATCHES,
  LIVE_EVENT_WINDOW_BYTES,
} from "../apps/node/src/session-console.js";
import { startConfigServer } from "../apps/node/src/config-server.js";
import { settingsFromEnv } from "../apps/node/src/settings.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(enable = true, journalBatchMs = 2) {
  const directory = mkdtempSync(join(tmpdir(), "fleet-console-"));
  const work = join(directory, "work");
  mkdirSync(work);
  const app = Fastify();
  const store = new FleetStore(":memory:");
  store.setSetting(HOST_IDENTITY_ID_SETTING, "host-test");
  const service = new FleetService(store, app.log);
  const { node } = store.registerNode({
    name: "test-node",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp", SESSION_CONSOLE_CAPABILITY],
    maxSessions: 8,
  });
  const workspace = store.createWorkspace("work", "");
  const placement = store.createPlacement(workspace.id, node.id, work);
  const factory = new MockAgentFactory();
  const starts = vi.spyOn(factory, "start");
  const errors: string[] = [];
  const requests: { request: ConsoleRequest; blocked: boolean }[] = [];
  const commands: NodeCommand[] = [];
  let online = true;
  let suppressEvents = false;
  let dropActionReply = false;
  let holdReplays = false;
  const droppedIds = new Set<string>();
  const heldIds = new Set<string>();
  const heldResponses: ConsoleResponse[] = [];
  let controller: NodeSessionConsole;
  let journal: SessionJournal;
  let router: CommandRouter;
  const link: NodeLink = {
    OPEN: 1,
    readyState: 1,
    close: () => {},
    send(raw) {
      if (!online) return;
      const frame = HostToNodeMessageSchema.parse(JSON.parse(raw));
      if (frame.type === "session_console_response") {
        if (heldIds.has(frame.response.requestId)) heldResponses.push(frame.response);
        else if (!droppedIds.has(frame.response.requestId))
          controller.response(frame.response);
      } else if (frame.type === "session_console_grant") controller.grant(frame.grant);
      else if (frame.type === "session_console_update") controller.update(frame.message);
      else if (frame.type === "session_console_queue") {
        void controller
          .queueAction(frame.sessionId, frame.messageId, frame.action)
          .catch((error: unknown) => errors.push(String(error)));
      } else if (frame.type === "command") {
        commands.push(frame.command);
        void controller.hostCommand(frame.command, frame.consoleEpoch).then((result) => {
          if (!result.ok) errors.push(result.error || "Command failed");
        });
      }
    },
  };
  const makeNode = () => {
    journal = new SessionJournal(join(directory, "history"), {
      secure: false,
      batchMs: journalBatchMs,
      onEvents: (events) => controller.committed(events),
      onFailure: (error) => errors.push(String(error)),
    });
    router = new CommandRouter(
      factory,
      8,
      (event) => {
        if (suppressEvents) return;
        if (!controller.capture(event) && online) service.handleEvent(event);
      },
      async (path) => path,
    );
    controller = new NodeSessionConsole({
      journal,
      router,
      files: new SessionFileReader({
        liveRoots: (id) => router.sessionRoots(id),
        protectedRoots: [join(directory, "history")],
      }),
      hostId: () => "host-test",
      nodeId: () => node.id,
      onError: (message) => errors.push(message),
      send(message) {
        if (!online) return false;
        if (message.type === "session_console_request") {
          requests.push({
            request: message.request,
            blocked: service.console.blocked(node.id),
          });
          if (dropActionReply && message.request.kind === "action")
            droppedIds.add(message.requestId);
          if (holdReplays && message.request.kind === "replay")
            heldIds.add(message.requestId);
          void service.console.handle(node.id, message.requestId, message.request);
        }
        return true;
      },
    });
  };
  makeNode();
  service.attachNode(node.id, link);
  store.setNodeOnline(node.id, true, 0);
  const connect = async () => {
    online = true;
    service.attachNode(node.id, link);
    store.setNodeOnline(node.id, true, router.activeSessionIds.length);
    service.console.attach(node.id, link, router.activeSessionIds, router.busySessionIds);
    await controller.connected(true);
  };
  if (enable) await connect();
  const disconnect = () => {
    online = false;
    controller.disconnected();
    service.disconnectNode(node.id, "Test connection lost");
  };
  const create = async (lead = false) => {
    const result = service.createAndStartSession({
      placement,
      prompt: "Initial work",
      yolo: false,
      ...(lead ? { runRole: "lead" as const } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    // A fresh agent starting takes longer than vi.waitFor's 1s while the rest
    // of the suite runs in parallel.
    await vi.waitFor(
      () => expect(store.getSession(result.session.id)?.state).toBe("idle"),
      { timeout: 10_000 },
    );
    return result.session.id;
  };
  const settled = async (id: string) => {
    await vi.waitFor(
      () => {
        const entry = journal.get(id);
        expect(errors).toEqual([]);
        expect(
          entry?.session.state,
          JSON.stringify({
            host: store.getSession(id)?.state,
            high: entry?.highWater,
            ack: entry?.acknowledgedSequence,
          }),
        ).toBe("idle");
        if (online) expect(entry?.acknowledgedSequence).toBe(entry?.highWater);
      },
      { timeout: 5_000 },
    );
  };
  const prompt = (id: string, text: string, operationId = randomUUID()) =>
    controller.route(
      "POST",
      `/api/fleet-sessions/${id}/prompt`,
      JSON.stringify({ prompt: text, operationId, attachments: [] }),
    );
  cleanup.push(async () => {
    online = false;
    controller.close();
    await router.stopAll();
    await journal.flush();
    journal.close();
    service.shutdown();
    store.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    app,
    store,
    service,
    node,
    link,
    starts,
    requests,
    commands,
    errors,
    workspace,
    placement,
    create,
    connect,
    disconnect,
    settled,
    prompt,
    get controller() {
      return controller;
    },
    get journal() {
      return journal;
    },
    get router() {
      return router;
    },
    get online() {
      return online;
    },
    dropActionReply: () => {
      dropActionReply = true;
    },
    holdReplayReplies: () => {
      holdReplays = true;
    },
    releaseReplayReplies: (reverse = false) => {
      holdReplays = false;
      heldIds.clear();
      const replies = heldResponses.splice(0);
      if (reverse) replies.reverse();
      for (const reply of replies) controller.response(reply);
    },
    restart: async () => {
      disconnect();
      suppressEvents = true;
      await router.stopAll();
      controller.close();
      journal.close();
      makeNode();
      suppressEvents = false;
    },
  };
}

describe("shared online and offline Node session control", () => {
  it.each(["online", "reconnect"])(
    "keeps control receipts ahead of their events across bounded %s batches",
    async (mode) => {
      const f = await fixture();
      const id = await f.create();
      await f.settled(id);
      if (mode === "reconnect") f.disconnect();
      const premature: string[] = [];
      f.service.onSessionEvent((event) => {
        if (typeof event.payload.control !== "string") return;
        if (
          !f.store.sessionConsole
            .localOperations(id)
            .some((operation) => operation.id === event.payload.control)
        )
          premature.push(event.eventId);
      });
      for (let index = 0; index < 110; index++) {
        const operationId = randomUUID();
        f.journal.acceptOperation({
          id: operationId,
          sessionId: id,
          action: "prompt",
          payload: {
            action: "prompt",
            operationId,
            prompt: `Synthetic local turn ${index}`,
            attachments: [],
          },
        });
        f.journal.append({
          eventId: randomUUID(),
          sessionId: id,
          sequence: f.journal.highWater(id) + 1,
          type: "agent_text",
          payload: { text: `turn ${index}`, control: operationId },
          createdAt: new Date().toISOString(),
        });
        f.journal.settleOperation(operationId, "settled");
      }
      if (mode === "online") f.controller.grant(f.store.sessionConsole.get(id)!);
      await f.journal.flush();
      if (mode === "reconnect") await f.connect();
      else await f.controller.prepareIdentityMove();
      await f.settled(id);
      expect(f.store.sessionConsole.localOperations(id)).toHaveLength(110);
      expect(premature).toEqual([]);
    },
  );
  it("clears 'local control ahead of Host' when the Node resynchronizes without reconnecting", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    const operationId = randomUUID();
    f.journal.acceptOperation({
      id: operationId,
      sessionId: id,
      action: "prompt",
      payload: {
        action: "prompt",
        operationId,
        prompt: "Typed on the Node",
        attachments: [],
      },
    });
    f.journal.settleOperation(operationId, "settled");
    const hostEpoch = () => f.store.sessionConsole.get(id)!.controlEpoch;
    const fromHost = (): NodeCommand => ({
      type: "prompt",
      sessionId: id,
      commandId: randomUUID(),
      prompt: "Typed in the Host",
      attachments: [],
    });

    const refused = await f.controller.hostCommand(fromHost(), hostEpoch());
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("ahead of the Host");

    // What `session_console_resync` runs on the Node.
    await f.controller.connected(true);
    await f.settled(id);

    expect(hostEpoch()).toBe(1);
    await expect(
      f.controller.hostCommand(fromHost(), hostEpoch()),
    ).resolves.toMatchObject({ ok: true });
  });
  it("publishes durable live output from multiple sessions without waiting for earlier ACKs", async () => {
    // Online delivery must flush the producer burst, not wait for the offline batching timer.
    const f = await fixture(true, 60_000);
    const first = await f.create();
    const second = await f.create();
    await f.settled(first);
    await f.settled(second);
    f.holdReplayReplies();
    const before = f.journal.get(first)!.acknowledgedSequence;
    const emit = (sessionId: string) => {
      const event = {
        eventId: randomUUID(),
        sessionId,
        sequence: f.journal.highWater(sessionId) + 1,
        type: "agent_text" as const,
        payload: { text: "Live output" },
        createdAt: new Date().toISOString(),
      };
      f.controller.capture(event);
      return event;
    };
    const a = emit(first);
    await vi.waitFor(() =>
      expect(f.store.listEvents(first).some((event) => event.eventId === a.eventId)).toBe(
        true,
      ),
    );
    const b = emit(second);
    const c = emit(first);
    await vi.waitFor(() => {
      expect(
        f.store.listEvents(second).some((event) => event.eventId === b.eventId),
      ).toBe(true);
      expect(f.store.listEvents(first).some((event) => event.eventId === c.eventId)).toBe(
        true,
      );
    });
    expect(f.journal.get(first)!.acknowledgedSequence).toBe(before);
    expect(f.journal.highWater(first)).toBeGreaterThan(before);
    f.releaseReplayReplies(true);
    await f.settled(first);
    await f.settled(second);
  });

  it("bounds the live window while retaining excess output in the durable journal", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.holdReplayReplies();
    const from = f.requests.length;
    const before = f.journal.highWater(id);
    for (let index = 0; index < LIVE_EVENT_WINDOW_BATCHES + 10; index++) {
      f.controller.capture({
        eventId: randomUUID(),
        sessionId: id,
        sequence: before + index + 1,
        type: "agent_text",
        payload: { text: "Window pressure" },
        createdAt: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await f.journal.flush();
    expect(
      f.requests.slice(from).filter((entry) => entry.request.kind === "replay"),
    ).toHaveLength(LIVE_EVENT_WINDOW_BATCHES);
    expect(f.journal.highWater(id)).toBe(before + LIVE_EVENT_WINDOW_BATCHES + 10);
    expect(f.journal.get(id)!.acknowledgedSequence).toBe(before);
    f.releaseReplayReplies();
    await f.settled(id);
    expect(f.store.maxEventSequence(id)).toBe(f.journal.highWater(id));
  });

  it("bounds live bytes before the batch-count limit and drains the durable remainder", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.holdReplayReplies();
    const from = f.requests.length;
    const before = f.journal.highWater(id);
    for (let index = 0; index < 12; index++) {
      f.controller.capture({
        eventId: randomUUID(),
        sessionId: id,
        sequence: before + index + 1,
        type: "agent_text",
        payload: { text: "x".repeat(1024 * 1024) },
        createdAt: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const requests = f.requests
      .slice(from)
      .filter((entry) => entry.request.kind === "replay");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThan(12);
    expect(
      requests.reduce(
        (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.request)),
        0,
      ),
    ).toBeLessThanOrEqual(LIVE_EVENT_WINDOW_BYTES);
    expect(f.journal.highWater(id)).toBe(before + 12);
    expect(f.journal.get(id)!.acknowledgedSequence).toBe(before);
    f.releaseReplayReplies();
    await f.settled(id);
    expect(f.store.maxEventSequence(id)).toBe(before + 12);
  });

  it("recovers unacknowledged live frames after disconnect and ignores old replies", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.holdReplayReplies();
    const eventId = randomUUID();
    f.controller.capture({
      eventId,
      sessionId: id,
      sequence: f.journal.highWater(id) + 1,
      type: "agent_text",
      payload: { text: "Stored before ACK was lost" },
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() =>
      expect(f.store.listEvents(id).some((event) => event.eventId === eventId)).toBe(
        true,
      ),
    );
    f.disconnect();
    f.releaseReplayReplies(true);
    await f.connect();
    await f.settled(id);
    expect(
      f.store.listEvents(id).filter((event) => event.eventId === eventId),
    ).toHaveLength(1);
  });

  it("fences subsequent pipelined frames after a grant mismatch without acknowledging them", async () => {
    const f = await fixture();
    const first = await f.create();
    const second = await f.create();
    await f.settled(first);
    await f.settled(second);
    f.holdReplayReplies();
    const before = f.store.maxEventSequence(second);
    f.store.sessionConsole.grant(
      "host-test",
      { ...f.store.getSession(first)!, placementId: "changed" },
      f.store.maxEventSequence(first),
    );
    f.controller.capture({
      eventId: randomUUID(),
      sessionId: first,
      sequence: f.journal.highWater(first) + 1,
      type: "agent_text",
      payload: { text: "Conflicting grant" },
      createdAt: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.controller.capture({
      eventId: randomUUID(),
      sessionId: second,
      sequence: before + 1,
      type: "agent_text",
      payload: { text: "Must remain local until reconciliation" },
      createdAt: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.service.console.blocked(f.node.id)).toBe(true);
    expect(f.store.maxEventSequence(second)).toBe(before);
    expect(f.journal.highWater(second)).toBe(before + 1);
    expect(f.journal.get(second)!.acknowledgedSequence).toBe(before);
  });

  it("does not make one session's retirement wait for another session's live ACK", async () => {
    const f = await fixture();
    const first = await f.create();
    const second = await f.create();
    await f.settled(first);
    await f.settled(second);
    f.holdReplayReplies();
    f.controller.capture({
      eventId: randomUUID(),
      sessionId: second,
      sequence: f.journal.highWater(second) + 1,
      type: "agent_text",
      payload: { text: "Other session still streaming" },
      createdAt: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const route = vi.spyOn(f.router, "route").mockImplementation(async (command) => ({
      commandId: command.commandId,
      ok: true,
    }));
    const result = await f.controller.hostCommand(
      NodeCommandSchema.parse({
        type: "delete_session",
        commandId: randomUUID(),
        sessionId: first,
        agentSessionId: f.journal.get(first)!.session.agentSessionId,
        inactiveBefore: new Date().toISOString(),
        retentionDays: 30,
      }),
      0,
    );
    expect(result.ok).toBe(true);
    expect(f.journal.has(first)).toBe(false);
    route.mockRestore();
    f.releaseReplayReplies();
    await f.settled(second);
  });
  it.skipIf(process.env.FLEET_CONSOLE_BROWSER_SMOKE !== "1")(
    "runs the built Node chat in a real browser against the session bridge",
    async () => {
      const f = await fixture();
      const id = await f.create();
      await f.settled(id);
      const discovery = vi.fn(async () => ({ sessions: [] }));
      const unsupported = async (): Promise<never> => {
        throw new Error("Not used by this browser scenario");
      };
      const server = startConfigServer({
        sessionConsole: f.controller,
        port: 0,
        getSettings: () => settingsFromEnv({}),
        getStatus: () => ({
          nodeId: f.node.id,
          version: "test",
          connected: f.online,
          activeSessions: f.router.activeSessionIds.length,
          mockAgent: true,
        }),
        getCredentials: () => undefined,
        applySettings: unsupported,
        applyBackup: unsupported,
        log: () => {},
        sessionDiscovery: { list: discovery, get: () => undefined, preview: unsupported },
        fleet: {
          listWorkspaces: async () => [f.workspace],
          listOwnPlacements: async () => [f.placement],
          listOwnSessions: async () => f.store.listSessions(),
          createWorkspace: unsupported,
          updateWorkspace: unsupported,
          createOwnPlacement: unsupported,
          updateOwnPlacementPath: unsupported,
          createOwnSession: unsupported,
          adoptOwnSession: unsupported,
        },
      });
      await once(server, "listening");
      cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing console listener");
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.FLEET_E2E_BROWSER
          ? { executablePath: process.env.FLEET_E2E_BROWSER }
          : { channel: "msedge" }),
      });
      cleanup.push(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      expect(discovery).not.toHaveBeenCalled();
      await page
        .getByText("Initial work", { exact: true })
        .first()
        .click({ timeout: 5_000 });
      const chat = page.frameLocator("iframe").first();
      const transcript = chat.locator('[aria-label="Chat transcript"]');
      await transcript.waitFor();
      const send = async (text: string) => {
        await chat.locator("textarea").fill(text);
        await chat.getByRole("button", { name: /^Send/ }).last().click();
        await vi.waitFor(
          async () => expect(await transcript.innerText()).toContain(text),
          { timeout: 10_000 },
        );
      };
      await send("Browser online follow-up");
      await f.settled(id);
      f.disconnect();
      await vi.waitFor(async () =>
        expect(await chat.locator("textarea").isEnabled()).toBe(true),
      );
      await send("Browser offline follow-up");
      await f.settled(id);
      expect(
        f.store
          .listEvents(id)
          .some((event) =>
            String(event.payload.text).includes("Browser offline follow-up"),
          ),
      ).toBe(false);
      await f.connect();
      await f.settled(id);
      await vi.waitFor(async () =>
        expect(await transcript.innerText()).toContain("Browser offline follow-up"),
      );
      expect(
        f.store
          .listEvents(id)
          .some((event) =>
            String(event.payload.text).includes("Browser offline follow-up"),
          ),
      ).toBe(true);
      expect(f.starts).toHaveBeenCalledTimes(1);
      expect(discovery).not.toHaveBeenCalled();
      expect(pageErrors).toEqual([]);
      if (process.env.FLEET_CONSOLE_SCREENSHOT)
        await page.screenshot({
          path: process.env.FLEET_CONSOLE_SCREENSHOT,
          fullPage: true,
        });
    },
    60_000,
  );
  it("opens the original worker and submits through Host without another process", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    expect((await f.controller.view(id)).session.id).toBe(id);
    expect(await f.prompt(id, "Follow up from Node")).toMatchObject({ status: 202 });
    await vi.waitFor(() =>
      expect(
        f.store
          .listEvents(id)
          .some((event) => String(event.payload.text).includes("Follow up from Node")),
      ).toBe(true),
    );
    await f.settled(id);
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect((await f.controller.transcript(id)).blocks).toEqual(
      (await f.service.transcripts.page(id)).blocks,
    );
  });

  it("opens locally after disconnection, executes queued turns, and imports history once", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    const before = f.store.listEvents(id).length;
    f.disconnect();
    expect((await f.controller.view(id)).offlineAllowed).toBe(true);
    expect(await f.prompt(id, "Offline first")).toMatchObject({ status: 202 });
    expect(await f.prompt(id, "Offline second")).toMatchObject({ status: 202 });
    await vi.waitFor(() =>
      expect(
        f.journal
          .operations(id)
          .filter((operation) => operation.origin === "local")
          .every((operation) => operation.state === "settled"),
      ).toBe(true),
    );
    await f.journal.flush();
    expect(f.store.listEvents(id)).toHaveLength(before);
    expect(
      (await f.controller.transcript(id)).blocks.some((block) =>
        block.text.includes("Offline second"),
      ),
    ).toBe(true);
    await f.connect();
    await f.settled(id);
    const userEvents = f.store
      .listEvents(id)
      .filter(
        (event) =>
          event.type === "system" &&
          String(event.payload.text).startsWith("User: Offline"),
      );
    expect(userEvents).toHaveLength(2);
    expect(f.starts).toHaveBeenCalledTimes(1);
    f.disconnect();
    await f.connect();
    await f.settled(id);
    expect(
      f.store
        .listEvents(id)
        .filter(
          (event) =>
            event.type === "system" &&
            String(event.payload.text).startsWith("User: Offline"),
        ),
    ).toHaveLength(2);
  });

  it("settles the dispatched task before importing a local follow-up and keeps live worker status current", async () => {
    const f = await fixture();
    const leadId = await f.create(true);
    const run = f.store.createRun({
      workspaceId: f.workspace.id,
      name: "UI task",
      objective: "Original task",
    });
    f.store.updateRun(run.id, { state: "running", leadSessionId: leadId });
    const worker = f.store.createSession(f.placement, "Original task", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    const step = f.store.upsertRunStep(run.id, {
      stepKey: "original",
      title: "Original task",
      prompt: "Original task",
      category: "implement",
      placementId: f.placement.id,
    });
    const activeStep = f.store.updateRunStep(step.id, {
      state: "running",
      sessionId: worker.id,
      attempts: 1,
    })!;
    f.store.transitionSession(worker.id, "starting");
    f.store.setSessionDispatchAttempt(worker.id, {
      commandId: randomUUID(),
      eventSeqFrom: 0,
      attempt: notificationAttemptKey(worker, {
        step: activeStep,
        run: f.store.getRun(run.id),
      }),
    });
    const engine = new OrchestratorEngine(f.service);
    f.service.onSessionEvent((event) => engine.handleSessionEvent(event));
    f.service.console.observe(f.store.getSession(worker.id)!);
    await f.controller.hostCommand(
      NodeCommandSchema.parse({
        type: "start_session",
        sessionId: worker.id,
        commandId: randomUUID(),
        localPath: f.placement.localPath,
        prompt: "Original task",
        yolo: false,
      }),
      0,
    );
    f.disconnect();
    await f.prompt(worker.id, "Manual UI check");
    await vi.waitFor(() =>
      expect(
        f.journal
          .operations(worker.id)
          .filter((operation) => operation.origin === "local")
          .every((operation) => operation.state === "settled"),
      ).toBe(true),
    );
    await f.connect();
    await f.settled(worker.id);
    expect(f.store.getRunStep(step.id)).toMatchObject({ state: "succeeded" });
    expect(f.store.getRunStep(step.id)!.output).toContain("Original task");
    expect(f.store.getRunStep(step.id)!.output).not.toContain("Manual UI check");
    expect(f.store.getSessionDispatchAttempt(worker.id)?.attempt).toBe(
      `session:${worker.id}`,
    );
    expect(f.store.getSession(worker.id)?.state).toBe("idle");
  });

  it("never converts a lost online acknowledgement into a new offline prompt", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.dropActionReply();
    const operationId = randomUUID();
    const submitted = f.prompt(id, "Only once", operationId);
    await vi.waitFor(() =>
      expect(
        f.store
          .listEvents(id)
          .some((event) => String(event.payload.text).includes("Only once")),
      ).toBe(true),
    );
    f.disconnect();
    expect(await submitted).toMatchObject({ status: 503 });
    await f.settled(id);
    expect(await f.prompt(id, "Only once", operationId)).toMatchObject({ status: 409 });
    expect(
      f.journal.operations(id).find((operation) => operation.id === operationId),
    ).toMatchObject({ origin: "host", state: "uncertain" });
  });

  it("marks a locally admitted turn uncertain when it ends without a completion receipt", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.disconnect();
    const route = vi.spyOn(f.router, "route").mockImplementation(async (command) => ({
      commandId: command.commandId,
      ok: true,
    }));
    const operationId = randomUUID();
    await f.prompt(id, "Unconfirmed native result", operationId);
    f.journal.append({
      eventId: randomUUID(),
      sessionId: id,
      sequence: 1,
      type: "state",
      payload: { state: "idle", activity: "Native request failed" },
      createdAt: new Date().toISOString(),
    });
    await f.journal.flush();
    await vi.waitFor(() =>
      expect(
        f.journal.operations(id).find((operation) => operation.id === operationId)?.state,
      ).toBe("uncertain"),
    );
    expect(await f.prompt(id, "Unconfirmed native result", operationId)).toMatchObject({
      status: 409,
    });
    expect(route).toHaveBeenCalledTimes(1);
    route.mockRestore();
  });

  it("shares local queued messages and Host queue controls after reconnect", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.disconnect();
    const busy = vi.spyOn(f.router, "busySessionIds", "get").mockReturnValue([id]);
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await f.prompt(id, "Cancel this queued prompt", first);
    await f.prompt(id, "Send second", second);
    await f.prompt(id, "Send third first", third);
    await f.connect();
    expect(
      f.service.messages.list(id).filter((message) => message.id.startsWith("node:")),
    ).toHaveLength(3);
    expect((await f.controller.view(id)).messages).toHaveLength(3);
    f.service.messages.act(id, `node:${first}`, "cancel");
    await vi.waitFor(() =>
      expect(
        f.service.messages.list(id).filter((message) => message.id.startsWith("node:")),
      ).toHaveLength(2),
    );
    busy.mockRestore();
    f.service.messages.act(id, `node:${third}`, "send-now");
    await vi.waitFor(() =>
      expect(
        f.journal
          .operations(id)
          .filter((operation) => [second, third].includes(operation.id))
          .every((operation) => operation.state === "settled"),
      ).toBe(true),
    );
    await f.settled(id);
    const sent = f.store
      .listEvents(id)
      .filter(
        (event) =>
          event.type === "system" && String(event.payload.text).startsWith("User: Send"),
      );
    expect(sent).toHaveLength(2);
    expect(String(sent[0]!.payload.text)).toContain("Send third first");
    expect(String(sent[1]!.payload.text)).toContain("Send second");
  });

  it("holds reconnect work through a backlog larger than one replay batch", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.disconnect();
    for (let index = 0; index < 4_501; index++)
      f.journal.append({
        eventId: randomUUID(),
        sessionId: id,
        sequence: index + 1,
        type: "agent_text",
        payload: { text: ` ${index}` },
        createdAt: new Date().toISOString(),
      });

    await f.journal.flush();
    const from = f.requests.length;
    const reconnect = vi.spyOn(f.service.commands, "reconnect");
    await f.connect();
    await f.settled(id);
    const replay = f.requests
      .slice(from)
      .filter((entry) => entry.request.kind === "replay");
    expect(replay.length).toBeGreaterThan(2);
    expect(replay.every((entry) => entry.blocked)).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(f.service.console.blocked(f.node.id)).toBe(false);
    const events = f.store.listEvents(id);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  });

  it("replays an individual tool-sized event larger than the normal batch budget", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.disconnect();
    const event = f.journal.append({
      eventId: randomUUID(),
      sessionId: id,
      sequence: 1,
      type: "agent_text",
      payload: { text: "large-output ".repeat(180_000) },
      createdAt: new Date().toISOString(),
    });
    await f.journal.flush();
    await f.connect();
    await f.settled(id);
    expect(f.store.listEvents(id).find((item) => item.eventId === event.eventId)).toEqual(
      event,
    );
  });

  it("continues above the local high-water after a Node restart and Host auto-resume", async () => {
    const f = await fixture();
    const id = await f.create();
    await f.settled(id);
    f.disconnect();
    await f.prompt(id, "Before restart");
    await f.settled(id);
    await f.journal.flush();
    const highWater = f.journal.highWater(id);
    await f.restart();
    await f.connect();
    await vi.waitFor(() => {
      expect(f.errors).toEqual([]);
      expect(
        f.starts,
        JSON.stringify({
          state: f.store.getSession(id)?.state,
          blocked: f.service.console.blocked(f.node.id),
        }),
      ).toHaveBeenCalledTimes(2);
    });
    await f.settled(id);
    expect(f.journal.highWater(id)).toBeGreaterThan(highWater);
    expect(
      f.store
        .listEvents(id)
        .filter(
          (event) =>
            event.type === "system" &&
            String(event.payload.text).startsWith("User: Before restart"),
        ),
    ).toHaveLength(1);
  });

  it("grants an already-running session at first compatible reconnect", async () => {
    const f = await fixture(false);
    const id = await f.create();
    expect(f.journal.has(id)).toBe(false);
    await f.connect();
    expect(f.journal.has(id)).toBe(true);
    f.disconnect();
    expect(await f.prompt(id, "After upgrade")).toMatchObject({ status: 202 });
    await f.settled(id);
    expect(f.starts).toHaveBeenCalledTimes(1);
  });

  it("quarantines deleted inactive sessions without blocking history recovery or orchestrator resume", async () => {
    const f = await fixture();
    const deletedId = await f.create();
    const workerId = await f.create();
    const leadId = await f.create(true);
    await f.settled(deletedId);
    await f.settled(workerId);
    for (const sessionId of [deletedId, leadId])
      await f.router.route({ type: "stop", sessionId, commandId: randomUUID() });
    await vi.waitFor(() =>
      expect(f.journal.get(deletedId)!.acknowledgedSequence).toBe(
        f.journal.highWater(deletedId),
      ),
    );
    f.disconnect();
    const retained = f.journal.append({
      eventId: randomUUID(),
      sessionId: deletedId,
      sequence: f.journal.highWater(deletedId) + 1,
      type: "agent_text",
      payload: { text: "Retained history from a deleted session" },
      createdAt: new Date().toISOString(),
    });
    const operation = f.journal.acceptOperation({
      id: randomUUID(),
      sessionId: deletedId,
      action: "prompt",
      payload: { prompt: "Must never execute" },
      queued: true,
    }).operation;
    const recovered = f.journal.append({
      eventId: randomUUID(),
      sessionId: workerId,
      sequence: f.journal.highWater(workerId) + 1,
      type: "agent_text",
      payload: { text: "Recover the existing worker normally" },
      createdAt: new Date().toISOString(),
    });
    f.store.deleteSession(deletedId);
    const from = f.requests.length;
    await f.connect();
    expect(f.controller.readyForHostWork).toBe(true);
    expect(f.service.nodeWorkBlocked(f.node.id)).toBeUndefined();
    expect(f.store.listEvents(workerId)).toContainEqual(recovered);
    expect(
      f.requests.slice(from).filter((entry) => entry.request.kind === "replay"),
    ).toEqual([expect.objectContaining({ blocked: true })]);
    expect(f.journal.events(deletedId, 0)).toContainEqual(retained);
    expect(f.journal.get(deletedId)!.acknowledgedSequence).toBeLessThan(
      retained.sequence,
    );
    expect(f.journal.operations(deletedId)).toContainEqual(operation);
    expect(await f.controller.view(deletedId)).toMatchObject({
      status: "conflict",
      offlineAllowed: false,
      detail: expect.stringContaining("retained"),
    });
    expect(JSON.stringify(await f.controller.transcript(deletedId))).toContain(
      "Retained history from a deleted session",
    );
    expect(await f.prompt(deletedId, "Do not replay this")).toMatchObject({
      status: 409,
    });
    await expect(
      f.controller.queueAction(deletedId, operation.id, "send-now"),
    ).rejects.toThrow(/retained/);
    expect(f.errors).toEqual([expect.stringContaining(deletedId)]);
    expect(f.service.resumeSession(leadId)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.store.getSession(leadId)?.state).toBe("idle"));
    expect(f.starts).toHaveBeenCalledTimes(4);
    f.disconnect();
    await f.connect();
    expect(f.controller.readyForHostWork).toBe(true);
    expect(f.journal.operations(deletedId)).toContainEqual(operation);
  });

  it.each(["missing live session", "foreign history"] as const)(
    "keeps the synchronization barrier for %s",
    async (condition) => {
      const f = await fixture();
      const other = f.store.registerNode({
        name: "other",
        os: "win32",
        arch: "x64",
        version: "test",
        capabilities: [],
        maxSessions: 1,
      }).node;
      const placement = f.store.createPlacement(f.workspace.id, other.id, "C:\\other");
      const foreign = f.store.createSession(placement, "Other node", false);
      const sent = vi.spyOn(f.link, "send");
      f.service.console.attach(f.node.id, f.link, [], []);
      await f.service.console.handle(f.node.id, randomUUID(), {
        kind: "initialize",
        activeSessionIds: condition === "missing live session" ? ["missing"] : [],
        busySessionIds: [],
        sessions:
          condition === "foreign history"
            ? [{ sessionId: foreign.id, grantId: randomUUID() }]
            : [],
      });
      expect(JSON.parse(sent.mock.calls.at(-1)![0])).toMatchObject({
        type: "session_console_response",
        response: { ok: false, status: 404 },
      });
      expect(f.service.console.blocked(f.node.id)).toBe(true);
    },
  );

  it("rejects local approvals, permission-policy configuration and offline leads", async () => {
    const f = await fixture();
    const id = await f.create();
    const leadId = await f.create(true);
    await f.controller.view(leadId);
    const decide = (path: string, body: unknown) =>
      f.controller.route(
        "POST",
        `/api/fleet-sessions/${id}/${path}`,
        JSON.stringify(body),
      );
    expect(
      await decide("permission", { requestId: "permission", outcome: "allow_once" }),
    ).toMatchObject({ status: 400 });
    expect(await decide("config", { configId: "mode", value: "yolo" })).toMatchObject({
      status: 400,
    });
    f.disconnect();
    expect(await f.prompt(leadId, "Offline lead prompt")).toMatchObject({ status: 409 });
  });

  it("hardens local HTTP controls without mistaking forged browser headers for an approval", async () => {
    const f = await fixture();
    const id = await f.create();
    const server = startConfigServer({
      sessionConsole: f.controller,
      port: 0,
      getSettings: () => settingsFromEnv({}),
      getStatus: () => ({
        nodeId: f.node.id,
        version: "test",
        connected: true,
        activeSessions: 1,
        mockAgent: true,
      }),
      getCredentials: () => undefined,
      applySettings: async () => {},
      applyBackup: async () => {},
      log: () => {},
    });
    await once(server, "listening");
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing console listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, browserHeaders = false) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(browserHeaders ? { Origin: origin, "Sec-Fetch-Site": "same-origin" } : {}),
        },
      });
    expect(
      (
        await post(`/api/fleet-sessions/${id}/prompt`, {
          prompt: "missing origin",
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    for (const forged of [false, true]) {
      expect(
        (
          await post(
            `/api/fleet-sessions/${id}/permission`,
            {
              requestId: "unapproved",
              outcome: "allow_once",
              operationId: randomUUID(),
            },
            forged,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await post(
          `/api/fleet-sessions/${id}/prompt`,
          {
            prompt: "Local programs can use chat, never approvals",
            operationId: randomUUID(),
            attachments: [],
          },
          true,
        )
      ).status,
    ).toBe(202);
    expect(f.commands.some((command) => command.type === "permission_response")).toBe(
      false,
    );
    expect((await post("/api/config", { padding: "x".repeat(65_000) })).status).toBe(413);
    const frame = await fetch(`${origin}/session-console/index.html`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    const other = f.store.registerNode({
      name: "other",
      os: "linux",
      arch: "x64",
      version: "test",
      capabilities: [],
      maxSessions: 1,
    }).node;
    const otherPlace = f.store.createPlacement(
      f.store.listWorkspaces().find((workspace) => workspace.name === "work")!.id,
      other.id,
      "/other",
    );
    const otherSession = f.store.createSession(otherPlace, "private", false);
    expect((await fetch(`${origin}/api/fleet-sessions/${otherSession.id}`)).status).toBe(
      404,
    );
  });
});
