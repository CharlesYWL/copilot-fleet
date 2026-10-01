import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import {
  HostToNodeMessageSchema,
  ORCHESTRATOR_STOP_REASON,
  SESSION_RETENTION_CAPABILITY,
  SESSION_RETENTION_DAY_MS,
  type FleetSession,
  type NodeCommand,
  type RunRole,
  type SessionState,
} from "@fleet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetService, type NodeLink } from "./fleet-service.js";
import { resolveSessionRetentionDays } from "./config.js";
import { sessionRoutes } from "./routes/sessions.js";
import { orchestratorRoutes } from "./routes/orchestrators.js";
import { OrchestratorEngine } from "./orchestrator/engine.js";
import { buildServer } from "./server.js";
import {
  SESSION_CLEANUP_ACK_TIMEOUT_MS,
  SESSION_RETENTION_SWEEP_INTERVAL_MS,
  startSessionRetentionMonitor,
} from "./session-retention.js";
import { FleetStore } from "./store.js";

const START = Date.parse("2026-08-01T00:00:00.000Z");
const EXPIRES = START + 30 * SESSION_RETENTION_DAY_MS;
const stores = new Set<FleetStore>();
const directories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "fleet-session-retention-"));
  directories.push(directory);
  return join(directory, "fleet.db");
}

function setup(options: { days?: number; path?: string; capabilities?: string[] } = {}) {
  const store = new FleetStore(options.path ?? ":memory:");
  stores.add(store);
  const log = Fastify({ logger: false }).log;
  const warn = vi.spyOn(log, "warn");
  const service = new FleetService(store, log, "", options.days);
  const commands: NodeCommand[] = [];
  const link: NodeLink = {
    OPEN: 1,
    readyState: 1,
    close() {},
    send(raw) {
      const message = HostToNodeMessageSchema.parse(JSON.parse(raw));
      if (message.type === "command") commands.push(message.command);
    },
  };
  const { node } = store.registerNode({
    name: "node",
    os: "win32",
    arch: "x64",
    version: "0.4.0",
    capabilities: options.capabilities ?? [
      "copilot-acp",
      "host-yolo",
      SESSION_RETENTION_CAPABILITY,
    ],
    maxSessions: 10,
  });
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  service.attachNode(node.id, link);
  store.setNodeOnline(node.id, true);
  service.reconcile(node.id, []);

  const create = (
    state: SessionState = "stopped",
    runRole: RunRole = "",
    runId = "",
  ): FleetSession => {
    const session = store.createSession(placement, "work", false, "", {
      runRole,
      runId,
    });
    store.appendEvent({
      eventId: `${session.id}-agent`,
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: `copilot-${session.id}` },
      createdAt: new Date().toISOString(),
    });
    if (state !== "queued") {
      store.transitionSession(session.id, "starting");
      if (state !== "starting") {
        store.transitionSession(session.id, "running");
        if (state !== "running") store.transitionSession(session.id, state);
      }
    }
    return store.getSession(session.id)!;
  };

  const cleanupCommands = () =>
    commands.filter(
      (command): command is Extract<NodeCommand, { type: "delete_session" }> =>
        command.type === "delete_session",
    );
  const finish = (ok = true) => {
    const command = cleanupCommands().at(-1);
    if (!command) throw new Error("Expected a cleanup command");
    service.sessionRetention.handleResult(node.id, {
      type: "session_cleanup_result",
      commandId: command.commandId,
      sessionId: command.sessionId,
      ok,
      ...(ok ? {} : { error: "Copilot session has recent activity" }),
    });
    return command;
  };
  return {
    store,
    service,
    node,
    workspace,
    placement,
    create,
    commands,
    cleanupCommands,
    finish,
    link,
    warn,
  };
}

describe("inactive session retention", () => {
  it("does not expire Hermes history through the Copilot-native retention path", () => {
    const { service, create } = setup();
    const lead = create("stopped", "lead");
    const now = Date.now() + 31 * 86_400_000;
    expect(service.sessionRetention.shouldExpire(lead, now)).toBe(true);
    expect(
      service.sessionRetention.shouldExpire(
        {
          ...lead,
          agentParams: { kind: "hermes", profile: "fleet-orchestrator" },
        },
        now,
      ),
    ).toBe(false);
  });

  it.each(["", "lead", "worker"] as const)(
    "deletes role '%s' only at the inclusive 30-day boundary and after Node confirmation",
    (role) => {
      const { store, service, create, cleanupCommands, finish } = setup();
      const session = create("stopped", role);
      store.updateNotificationPreference(session.id, "copilot", false);
      vi.setSystemTime(EXPIRES - 1);
      expect(service.sessionRetention.sweep()).toBe(0);
      vi.setSystemTime(EXPIRES);
      expect(service.sessionRetention.sweep()).toBe(1);
      expect(cleanupCommands()[0]).toMatchObject({
        sessionId: session.id,
        agentSessionId: session.agentSessionId,
        retentionDays: 30,
        inactiveBefore: new Date(START).toISOString(),
      });
      expect(store.getSession(session.id)?.cleanupRequested).toBe(true);
      expect(store.listEvents(session.id)).toHaveLength(1);

      finish();

      expect(store.getSession(session.id)).toBeUndefined();
      expect(store.listEvents(session.id)).toEqual([]);
      expect(store.getNotificationPreference(session.id, "copilot")).toBeUndefined();
      expect(store.listSessionCleanupRequests()).toEqual([]);
    },
  );

  it("expires an idle orchestrator, but never running, queued, starting or cancelling work", () => {
    const { store, service, create, cleanupCommands, finish } = setup();
    const kept = ["running", "queued", "starting", "cancelling"].map((state) =>
      create(state as SessionState),
    );
    const idle = create("idle", "lead");
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    expect(cleanupCommands().map((command) => command.sessionId)).toEqual([idle.id]);
    finish();
    expect(
      store
        .listSessions()
        .map((session) => session.id)
        .sort(),
    ).toEqual(kept.map((session) => session.id).sort());
  });

  it("keeps favorites, recent and future activity, and unknown timestamps", () => {
    const { store, service, create } = setup();
    const favorite = create();
    store.setSessionFavorite(favorite.id, true);
    const recent = create();
    const future = create();
    vi.setSystemTime(EXPIRES);
    store.touchSessionActivity(recent.id);
    store.touchSessionActivity(
      future.id,
      new Date(EXPIRES + SESSION_RETENTION_DAY_MS).toISOString(),
    );
    expect(service.sessionRetention.sweep()).toBe(0);
    expect(
      service.sessionRetention.shouldExpire({ ...recent, lastActivityAt: "unknown" }),
    ).toBe(false);
  });

  it("requires a reconciled, online Node rather than treating an outage as inactivity", () => {
    const { service, store, node, create, cleanupCommands, link } = setup();
    const session = create("idle");
    service.disconnectNode(node.id, "Disconnected");
    vi.setSystemTime(EXPIRES);
    expect(service.sessionRetention.sweep()).toBe(0);
    service.attachNode(node.id, link);
    store.setNodeOnline(node.id, true);
    expect(service.sessionRetention.sweep()).toBe(0);
    service.recordPresence(node.id, [session.id], [session.id], false);
    expect(cleanupCommands()).toEqual([]);
    service.reconcile(node.id, [session.id], [session.id]);
    expect(store.getSession(session.id)?.state).toBe("running");
    expect(cleanupCommands()).toEqual([]);
  });

  it("does not renew activity on restart, reconnect or inventory and history replay", () => {
    const { service, store, node, create } = setup();
    const session = create("idle", "lead");
    vi.setSystemTime(EXPIRES);
    store.resetConnectivity();
    store.reconcileOfflineSessions(node.id, [session.id]);
    store.setNodeOnline(node.id, true);
    for (const [index, type] of ["commands", "config", "agent_text"].entries()) {
      store.appendEvent({
        eventId: `replay-${index}`,
        sessionId: session.id,
        sequence: index + 2,
        type: type as "commands" | "config" | "agent_text",
        payload:
          type === "agent_text"
            ? { text: "An old answer", historyReplay: true }
            : { options: [], commands: [] },
        createdAt: new Date().toISOString(),
      });
    }
    expect(store.getSession(session.id)?.lastActivityAt).toBe(
      new Date(START).toISOString(),
    );
    expect(service.sessionRetention.sweep()).toBe(1);
  });

  it("uses receipt time for fresh work, not a Node's old clock", () => {
    const { store, service, create } = setup();
    const session = create("idle");
    vi.setSystemTime(EXPIRES);
    store.appendEvent({
      eventId: "fresh-but-backdated",
      sessionId: session.id,
      sequence: 2,
      type: "agent_text",
      payload: { text: "Still working" },
      createdAt: new Date(START).toISOString(),
    });
    expect(store.getSession(session.id)?.lastActivityAt).toBe(
      new Date(EXPIRES).toISOString(),
    );
    expect(service.sessionRetention.sweep()).toBe(0);
  });

  it("counts a prompt before output arrives and opening a conversation as activity", async () => {
    const { store, service, node, create } = setup();
    const prompted = create("idle");
    const viewed = create();
    vi.setSystemTime(EXPIRES);
    service.dispatch(node.id, {
      type: "prompt",
      sessionId: prompted.id,
      prompt: "Continue",
      attachments: [],
    });
    const app = Fastify();
    await app.register(sessionRoutes, { service });
    try {
      expect((await app.inject(`/api/sessions/${viewed.id}/events`)).statusCode).toBe(
        200,
      );
      expect(service.sessionRetention.sweep()).toBe(0);
      for (const id of [prompted.id, viewed.id]) {
        expect(store.getSession(id)?.lastActivityAt).toBe(
          new Date(EXPIRES).toISOString(),
        );
      }
    } finally {
      await app.close();
    }
  });

  it("defers unsupported Nodes without sending an unknown frame or deleting Host history", () => {
    const { store, service, create, cleanupCommands, warn } = setup({
      capabilities: ["copilot-acp"],
    });
    const session = create();
    vi.setSystemTime(EXPIRES);
    expect(service.sessionRetention.sweep()).toBe(0);
    expect(cleanupCommands()).toEqual([]);
    expect(store.getSession(session.id)?.cleanupRequested).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("update this Node"),
    );
  });

  it("supports disabling retention and a longer period without a shorter-than-30-day policy", () => {
    const disabled = setup({ days: 0 });
    disabled.create("idle", "lead");
    const longer = setup({ days: 60 });
    longer.create();
    vi.setSystemTime(EXPIRES);
    expect(disabled.service.sessionRetention.sweep()).toBe(0);
    expect(longer.service.sessionRetention.sweep()).toBe(0);
    vi.setSystemTime(START + 60 * SESSION_RETENTION_DAY_MS);
    expect(disabled.service.sessionRetention.sweep()).toBe(0);
    expect(longer.service.sessionRetention.sweep()).toBe(1);
  });

  it("keeps a failed cleanup resumable, backs off, and uses a new command id on retry", () => {
    const { store, service, create, cleanupCommands, finish } = setup();
    const session = create();
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    const first = finish(false);
    expect(store.getSession(session.id)?.cleanupRequested).toBe(false);
    expect(store.listEvents(session.id)).toHaveLength(1);
    expect(service.sessionRetention.sweep()).toBe(0);
    vi.setSystemTime(EXPIRES + SESSION_RETENTION_SWEEP_INTERVAL_MS);
    expect(service.sessionRetention.sweep()).toBe(1);
    expect(cleanupCommands().at(-1)?.commandId).not.toBe(first.commandId);
    finish();
    expect(store.getSession(session.id)).toBeUndefined();
  });

  it("retries a lost acknowledgement idempotently and rejects foreign or stale results", () => {
    const { store, service, node, create, cleanupCommands, finish } = setup();
    const session = create();
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    const first = cleanupCommands()[0]!;
    vi.setSystemTime(EXPIRES + SESSION_CLEANUP_ACK_TIMEOUT_MS);
    service.sessionRetention.sweep();
    expect(cleanupCommands().at(-1)?.commandId).toBe(first.commandId);
    const result = {
      type: "session_cleanup_result" as const,
      commandId: first.commandId,
      sessionId: first.sessionId,
      ok: true,
    };
    service.sessionRetention.handleResult("another-node", result);
    service.sessionRetention.handleResult(node.id, { ...result, commandId: "stale" });
    expect(store.getSession(session.id)?.cleanupRequested).toBe(true);
    finish();
    expect(() => service.sessionRetention.handleResult(node.id, result)).not.toThrow();
    expect(store.getSession(session.id)).toBeUndefined();
  });

  it("locks resumption, editing and bulk deletion while the Node is deleting", () => {
    const { store, service, node, workspace, placement, create } = setup();
    const session = create("idle");
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    const conflict = { statusCode: 409 };
    expect(() =>
      service.dispatch(node.id, {
        type: "prompt",
        sessionId: session.id,
        prompt: "Too late",
        attachments: [],
      }),
    ).toThrow(expect.objectContaining(conflict));
    expect(service.resumeSession(session.id)).toMatchObject({ ok: false, status: 409 });
    expect(() => store.renameSession(session.id, "Keep")).toThrow(
      expect.objectContaining(conflict),
    );
    expect(() => store.setSessionFavorite(session.id, true)).toThrow(
      expect.objectContaining(conflict),
    );
    expect(() => store.adoptSession(placement, session.agentSessionId, [])).toThrow(
      expect.objectContaining(conflict),
    );
    expect(() => store.deleteWorkspace(workspace.id)).toThrow(
      expect.objectContaining(conflict),
    );
    const backup = store.exportHostBackup({ enrollmentToken: "" });
    expect(() => service.importHostBackup(backup)).toThrow(
      expect.objectContaining(conflict),
    );
    expect(service.nodeSocket(node.id)).toBeDefined();
    expect(store.deleteEndedSessions()).toBe(0);
  });

  it.each(["running", "awaiting_human", "awaiting_approval"] as const)(
    "protects leads and workers belonging to a %s task",
    (state) => {
      const { store, service, workspace, create } = setup();
      const lead = create("idle", "lead");
      const run = store.createRun({
        workspaceId: workspace.id,
        name: "Task",
        objective: "Do",
      });
      store.updateRun(run.id, { leadSessionId: lead.id, state });
      create("stopped", "worker", run.id);
      vi.setSystemTime(EXPIRES);
      expect(service.sessionRetention.sweep()).toBe(0);
    },
  );

  it("keeps recent task history and protected workers with their orchestrator", () => {
    const { store, service, workspace, create } = setup();
    const lead = create("idle", "lead");
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "Task",
      objective: "Do",
    });
    store.updateRun(run.id, { leadSessionId: lead.id, state: "completed" });
    const worker = create("stopped", "worker", run.id);
    store.setSessionFavorite(worker.id, true);
    vi.setSystemTime(EXPIRES);
    expect(service.sessionRetention.sweep()).toBe(0);
    store.setSessionFavorite(worker.id, false);
    expect(service.sessionRetention.shouldExpire(store.getSession(lead.id)!)).toBe(false);
  });

  it("preserves terminal task outputs while clearing expired session references", () => {
    const { store, service, workspace, create, finish } = setup();
    const lead = create("stopped", "lead");
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "Task",
      objective: "Do",
    });
    store.updateRun(run.id, { leadSessionId: lead.id });
    const worker = create("stopped", "worker", run.id);
    const step = store.upsertRunStep(run.id, {
      stepKey: "one",
      title: "One",
      prompt: "Do",
    });
    store.updateRunStep(step.id, {
      state: "succeeded",
      sessionId: worker.id,
      output: "Completed work",
    });
    store.appendRunNote(run.id, 0, "Keep the result");
    store.setRunState(run.id, "completed");
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    expect(() => store.updateRun(run.id, { state: "running" })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(() =>
      store.upsertRunStep(run.id, { stepKey: "two", title: "Two", prompt: "Do more" }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => store.updateRunStep(step.id, { state: "pending" })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    finish();
    finish();
    expect(store.listSessions()).toEqual([]);
    expect(store.getRun(run.id)).toMatchObject({ state: "completed", leadSessionId: "" });
    expect(store.listRunSteps(run.id)[0]).toMatchObject({
      sessionId: "",
      output: "Completed work",
    });
    expect(store.listRunNotes(run.id).map((note) => note.body)).toEqual([
      "Completed work",
      "Keep the result",
    ]);
  });

  it("continues a durable pending deletion after restart, even with new cleanup disabled", () => {
    const path = temporaryDatabase();
    const first = setup({ path });
    const session = first.create();
    vi.setSystemTime(EXPIRES);
    first.service.sessionRetention.sweep();
    const command = first.cleanupCommands()[0]!;
    first.service.shutdown();
    first.store.close();
    stores.delete(first.store);

    const reopened = new FleetStore(path);
    stores.add(reopened);
    reopened.resetConnectivity();
    const service = new FleetService(reopened, Fastify({ logger: false }).log, "", 0);
    service.attachNode(first.node.id, first.link);
    reopened.setNodeOnline(first.node.id, true);
    service.reconcile(first.node.id, []);
    expect(first.cleanupCommands().at(-1)?.commandId).toBe(command.commandId);
    service.sessionRetention.handleResult(first.node.id, {
      type: "session_cleanup_result",
      sessionId: session.id,
      commandId: command.commandId,
      ok: true,
    });
    expect(reopened.getSession(session.id)).toBeUndefined();
  });

  it("does not auto-resume expired sessions on Node reconnection", () => {
    const { store, service, node, create, link, commands } = setup();
    const session = create("idle");
    service.disconnectNode(node.id, "Node lost");
    vi.setSystemTime(EXPIRES);
    service.attachNode(node.id, link);
    store.setNodeOnline(node.id, true);
    service.reconcile(node.id, []);
    expect(commands.map((command) => command.type)).toEqual(["delete_session"]);
    expect(store.getSession(session.id)?.cleanupRequested).toBe(true);
  });

  it("preserves inactivity during pre-expiry automatic recovery, but not an explicit Resume", () => {
    const { store, service, node, create, link, commands } = setup();
    const recovered = create("idle");
    const explicit = create("stopped");
    service.disconnectNode(node.id, "Node restarted");
    vi.setSystemTime(START + 29 * SESSION_RETENTION_DAY_MS);
    service.attachNode(node.id, link);
    store.setNodeOnline(node.id, true);
    service.reconcile(node.id, []);
    expect(commands.at(-1)).toMatchObject({
      type: "resume_session",
      sessionId: recovered.id,
      lastActivityAt: new Date(START).toISOString(),
    });
    expect(store.getSession(recovered.id)?.lastActivityAt).toBe(
      new Date(START).toISOString(),
    );
    store.transitionSession(recovered.id, "idle");
    expect(service.resumeSession(explicit.id).ok).toBe(true);
    expect(store.getSession(explicit.id)?.lastActivityAt).toBe(new Date().toISOString());
    vi.setSystemTime(EXPIRES);
    expect(service.sessionRetention.shouldExpire(store.getSession(recovered.id)!)).toBe(
      true,
    );
    expect(service.sessionRetention.shouldExpire(store.getSession(explicit.id)!)).toBe(
      false,
    );
  });

  it("refuses orchestrator Resume before changing a task whose worker is being deleted", async () => {
    const { store, service, workspace, create, commands, finish } = setup();
    const lead = create("stopped", "lead");
    store.setSessionFavorite(lead.id, true);
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "Stopped task",
      objective: "Continue existing context",
    });
    store.updateRun(run.id, {
      leadSessionId: lead.id,
      state: "cancelled",
      failureReason: ORCHESTRATOR_STOP_REASON,
    });
    const worker = create("stopped", "worker", run.id);
    const step = store.upsertRunStep(run.id, {
      stepKey: "work",
      title: "Work",
      prompt: "Do it",
    });
    store.updateRunStep(step.id, {
      state: "cancelled",
      stoppedByOrchestrator: true,
      sessionId: worker.id,
    });
    vi.setSystemTime(EXPIRES);
    service.sessionRetention.sweep();
    expect(store.getSession(worker.id)?.cleanupRequested).toBe(true);
    const app = Fastify();
    await app.register(orchestratorRoutes, {
      service,
      engine: new OrchestratorEngine(service),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/orchestrators/${lead.id}/resume`,
      });
      expect(response.statusCode).toBe(409);
      expect(store.getSession(lead.id)?.state).toBe("stopped");
      expect(store.getRun(run.id)?.state).toBe("cancelled");
      expect(store.getRunStep(step.id)?.state).toBe("cancelled");
      expect(commands.map((command) => command.type)).toEqual(["delete_session"]);
      expect(() =>
        store.resumeOrchestratorStoppedRun(run.id, ORCHESTRATOR_STOP_REASON),
      ).toThrow(expect.objectContaining({ statusCode: 409 }));
      finish();
      expect(store.getRun(run.id)?.state).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("migrates legacy activity conservatively and preserves it through backup/restore", () => {
    const path = temporaryDatabase();
    const original = setup({ path });
    const session = original.create();
    original.store.close();
    stores.delete(original.store);
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP INDEX idx_sessions_retention; ALTER TABLE sessions DROP COLUMN last_activity_at;",
    );
    legacy.close();
    vi.setSystemTime(EXPIRES);
    const reopened = new FleetStore(path);
    stores.add(reopened);
    expect(reopened.getSession(session.id)?.lastActivityAt).toBe(
      new Date(START).toISOString(),
    );
    const backup = reopened.exportHostBackup({ enrollmentToken: "" });
    const restored = new FleetStore(":memory:");
    stores.add(restored);
    restored.replaceHostBackup(backup);
    expect(restored.getSession(session.id)?.lastActivityAt).toBe(
      new Date(START).toISOString(),
    );
    expect(restored.getSession(session.id)?.cleanupRequested).toBe(false);
  });

  it("exposes a 409 for edits during deletion and disposes the server's maintenance timers", async () => {
    const path = temporaryDatabase();
    const initial = setup({ path });
    const session = initial.create("idle", "lead");
    vi.setSystemTime(EXPIRES);
    initial.service.sessionRetention.sweep();
    initial.service.shutdown();
    initial.store.close();
    stores.delete(initial.store);
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(EXPIRES);
    const app = await buildServer({
      databasePath: path,
      enrollmentToken: "test-retention-token",
      operatorPassword: "test-retention-password",
    });
    app.log.level = "silent";
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "test-retention-password" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const csrf = await app.inject({
        url: "/api/auth/csrf",
        headers: { cookie },
      });
      const headers = {
        cookie,
        "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken,
      };
      for (const [url, payload] of [
        [`/api/sessions/${session.id}/prompt`, { prompt: "Continue" }],
        [`/api/sessions/${session.id}/resume`, {}],
        [`/api/orchestrators/${session.id}/runs`, { name: "New task" }],
      ] as const) {
        const response = await app.inject({ method: "POST", url, payload, headers });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: expect.stringContaining("being deleted"),
        });
      }
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("session retention configuration and scheduling", () => {
  it.each([
    [undefined, 30],
    ["0", 0],
    ["30", 30],
    ["90", 90],
  ])("parses %s as %s days", (configured, expected) => {
    expect(resolveSessionRetentionDays(configured)).toBe(expected);
  });

  it.each(["", " ", "29", "-1", "30.5", "Infinity", "abc", "36501"])(
    "rejects unsafe configuration %s",
    (configured) => {
      expect(() => resolveSessionRetentionDays(configured)).toThrow(
        /FLEET_SESSION_RETENTION_DAYS/,
      );
    },
  );

  it("sweeps at startup and periodically, logging errors without abandoning future sweeps", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const failure = new Error("SQLite unavailable");
    const sweep = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(0);
    const log = Fastify({ logger: false }).log;
    const error = vi.spyOn(log, "error");
    const timer = startSessionRetentionMonitor({ sweep }, log, 100);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      { error: failure },
      "Failed periodic session retention sweep",
    );
    clearInterval(timer);
    expect(vi.getTimerCount()).toBe(0);
  });
});
