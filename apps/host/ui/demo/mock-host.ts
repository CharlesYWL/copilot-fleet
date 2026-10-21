/**
 * An in-browser stand-in for the Fleet Host.
 *
 * The real UI talks to a Host over `fetch("/api/...")` and one WebSocket at
 * `/ws/browser`. This module installs replacements for both before the app
 * loads, keeps a small fleet in memory, and plays scripted agent turns so a
 * visitor can drive every screen without a server.
 */
import {
  TranscriptProjector,
  isTranscriptEvent,
  type BrowserMessage,
  type FleetSession,
  type Notification,
  type Run,
  type RunNote,
  type RunStep,
  type SessionEvent,
  type Snapshot,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";
import {
  HOST_REVISION,
  ago,
  configOptions,
  seedEvents,
  seedNodes,
  seedNotes,
  seedNotifications,
  seedPlacements,
  seedRuns,
  seedSessions,
  seedSteps,
  seedWorkspaces,
  COMMANDS,
} from "./seed";
import {
  chunk,
  firstTurn,
  orchestratorPlan,
  orchestratorWrapUp,
  replyTo,
  workerTurn,
  type Beat,
} from "./scripts";

type Projection = {
  generation: string;
  revision: number;
  projector: TranscriptProjector;
};

type JsonBody = Record<string, unknown>;

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const id = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fleet's state and the agents acting on it. */
class DemoHost {
  nodes = seedNodes();
  workspaces = seedWorkspaces();
  placements = seedPlacements();
  sessions = seedSessions();
  runs = seedRuns();
  steps = seedSteps();
  notes = seedNotes();
  notifications = seedNotifications();
  events = new Map<string, SessionEvent[]>();
  projections = new Map<string, Projection>();
  sequences = new Map<string, number>();
  /** Permissions waiting on the visitor, and the turn each one resumes. */
  waiting = new Map<string, { sessionId: string; rest: Beat[]; toolCallId: string }>();
  busy = new Set<string>();
  sockets = new Set<DemoSocket>();
  defaults = {
    yolo: false,
    autoResume: true,
    contextTier: "long_context",
    agencyMode: false,
    managedWorktreesEnabled: true,
    notificationLifecycleEnabled: true,
    model: "",
    reasoningEffort: "",
    orchestratorModels: { copilot: "claude-opus-4.5", hermes: "" },
    orchestratorReasoningEffort: "high",
    orchestratorAgent: null as unknown,
    orchestratorHeartbeatSchedule: "0 9-18 * * 1-5; 0 */2 * * *",
  };
  tunnels = new Map<string, { enabled: boolean; status: string; url?: string }>([
    [
      "devtunnel",
      { enabled: true, status: "on", url: "https://x7k2m9-8787.usw2.devtunnels.ms" },
    ],
  ]);

  constructor() {
    for (const session of this.sessions) {
      const minutes = (Date.now() - Date.parse(session.createdAt)) / 60_000;
      const events = seedEvents(session.id, minutes);
      this.events.set(session.id, events);
      this.sequences.set(session.id, events.length + 1);
      const last = [...events].reverse().find((event) => event.type === "agent_text");
      if (last) session.lastText = String(last.payload.text ?? "").slice(-400);
      for (const event of events) {
        if (event.type === "permission") {
          this.waiting.set(String(event.payload.requestId), {
            sessionId: session.id,
            toolCallId: String(event.payload.toolCallId),
            rest: [
              {
                kind: "tool",
                title: "npm uninstall better-sqlite3",
                toolKind: "execute",
                detail: "removed 1 package",
                ms: 900,
              },
              {
                kind: "tool",
                title: "Run tests",
                toolKind: "execute",
                detail: "npm test -w @fleet/host",
                ms: 1800,
              },
              {
                kind: "text",
                text: "Migration done. `better-sqlite3` is gone, the store uses `node:sqlite`, and all **412 host tests** pass. The native build step is no longer needed on any Node.",
              },
            ],
          });
        }
      }
    }
    this.startBackgroundLife();
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(): Snapshot {
    const permissionEvents = [...this.events.values()]
      .flat()
      .filter(
        (event) => event.type === "permission" || event.type === "permission_result",
      );
    return {
      nodes: this.nodes.map((node) => ({
        ...node,
        lastHeartbeat: nowIso(),
        activeSessions: this.sessions.filter(
          (session) =>
            session.nodeId === node.id &&
            ["running", "idle", "starting"].includes(session.state),
        ).length,
      })),
      workspaces: this.workspaces,
      placements: this.placements.map((placement) => ({
        ...placement,
        workspaceName: this.workspaces.find((w) => w.id === placement.workspaceId)?.name,
        nodeName: this.nodes.find((n) => n.id === placement.nodeId)?.name,
      })),
      sessions: this.sessions,
      runs: this.runs,
      notifications: this.notifications.filter((n) => n.status !== "dismissed"),
      notificationUnreadCount: this.unread(),
      hostRevision: HOST_REVISION,
      hostUpdate: { launch: "dev", restartCommand: "npm run dev", unavailableReason: "" },
      commandExecutions: [],
      prMaintenanceApprovals: [],
      prMaintenanceTasks: [],
      workerResumeRequests: [],
      permissionEvents,
    };
  }

  unread(): number {
    return this.notifications.filter((n) => n.status !== "dismissed" && n.readAt === null)
      .length;
  }

  broadcast(message: BrowserMessage): void {
    const frame = JSON.stringify(message);
    for (const socket of this.sockets) socket.deliver(frame);
  }

  // -------------------------------------------------------------- transcript

  projection(sessionId: string): Projection {
    let projection = this.projections.get(sessionId);
    if (projection) return projection;
    const projector = new TranscriptProjector();
    for (const event of this.events.get(sessionId) ?? []) {
      if (isTranscriptEvent(event)) projector.apply(event);
    }
    projection = { generation: id("gen"), revision: 0, projector };
    this.projections.set(sessionId, projection);
    return projection;
  }

  page(sessionId: string, before?: number, limit = 200): TranscriptPage {
    const { generation, revision, projector } = this.projection(sessionId);
    const total = projector.blocks.length;
    const newest = before === undefined;
    const end = newest ? total : Math.min(Math.max(before, 0), total);
    let start = Math.max(0, end - limit);
    if (start < Math.floor(limit / 4)) start = 0;
    const last = (this.events.get(sessionId) ?? []).at(-1);
    return {
      generation,
      revision,
      total,
      start,
      blocks: projector.blocks.slice(start, end),
      ...(newest ? { prompts: projector.prompts.slice() } : {}),
      ...(newest && last
        ? {
            activity: {
              eventId: last.eventId,
              sequence: last.sequence,
              createdAt: last.createdAt,
            },
          }
        : {}),
    };
  }

  /** Stores one event, advances its projection, and tells every browser. */
  emit(sessionId: string, type: SessionEvent["type"], payload: JsonBody): SessionEvent {
    const sequence = this.sequences.get(sessionId) ?? 1;
    this.sequences.set(sessionId, sequence + 1);
    const event: SessionEvent = {
      eventId: id("ev"),
      sessionId,
      sequence,
      type,
      payload,
      createdAt: nowIso(),
    };
    const list = this.events.get(sessionId) ?? [];
    list.push(event);
    this.events.set(sessionId, list);
    let transcript: TranscriptUpdate | undefined;
    if (isTranscriptEvent(event)) {
      const projection = this.projection(sessionId);
      const change = projection.projector.apply(event);
      if (change) {
        projection.revision += 1;
        transcript = {
          generation: projection.generation,
          revision: projection.revision,
          change,
        };
      }
    }
    this.broadcast({ type: "event", event, ...(transcript ? { transcript } : {}) });
    return event;
  }

  // ---------------------------------------------------------------- sessions

  session(sessionId: string): FleetSession | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }

  patchSession(
    sessionId: string,
    patch: Partial<FleetSession>,
  ): FleetSession | undefined {
    const session = this.session(sessionId);
    if (!session) return undefined;
    Object.assign(session, patch, { updatedAt: nowIso(), lastActivityAt: nowIso() });
    this.broadcast({ type: "session", session: { ...session } });
    return session;
  }

  createSession(input: {
    placementId: string;
    prompt: string;
    name?: string;
    yolo?: boolean;
    runId?: string;
    runRole?: FleetSession["runRole"];
    readOnly?: boolean;
  }): FleetSession | undefined {
    const placement = this.placements.find((entry) => entry.id === input.placementId);
    if (!placement) return undefined;
    const workspace = this.workspaces.find(
      (entry) => entry.id === placement.workspaceId,
    )!;
    const node = this.nodes.find((entry) => entry.id === placement.nodeId)!;
    const session: FleetSession = {
      id: id("s"),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      placementId: placement.id,
      nodeId: node.id,
      nodeName: node.name,
      state: "starting",
      name: input.name ?? "",
      initialPrompt: input.prompt,
      currentActivity: "Starting Copilot",
      lastText: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
      agentSessionId: id("acp"),
      agentParams: { kind: "copilot" },
      yolo: input.yolo ?? this.defaults.yolo,
      commands: COMMANDS,
      configOptions: configOptions(),
      usage: { aiCredits: 0 },
      runId: input.runId ?? "",
      runRole: input.runRole ?? "",
      favorite: false,
      readOnly: input.readOnly ?? false,
    };
    this.sessions.unshift(session);
    this.events.set(session.id, []);
    this.sequences.set(session.id, 1);
    this.broadcast({ type: "session", session: { ...session } });
    return session;
  }

  /** Records the prompt, then plays the agent's answer to it. */
  async prompt(sessionId: string, text: string, beats: Beat[]): Promise<void> {
    const session = this.session(sessionId);
    if (!session) return;
    this.emit(sessionId, "system", { text: `User: ${text}` });
    await this.play(sessionId, beats);
  }

  async play(sessionId: string, beats: Beat[]): Promise<void> {
    if (!this.session(sessionId)) return;
    this.busy.add(sessionId);
    this.patchSession(sessionId, { state: "running", currentActivity: "Thinking" });
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index]!;
      const session = this.session(sessionId);
      if (!session || session.state !== "running") {
        this.busy.delete(sessionId);
        return;
      }
      if (beat.kind === "pause") {
        await sleep(beat.ms);
      } else if (beat.kind === "thought" || beat.kind === "text") {
        const type = beat.kind === "thought" ? "agent_thought" : "agent_text";
        this.patchSession(sessionId, {
          currentActivity: beat.kind === "thought" ? "Thinking" : "Writing",
        });
        for (const piece of chunk(beat.text)) {
          if (this.session(sessionId)?.state !== "running") break;
          this.emit(sessionId, type, { text: piece });
          await sleep(35 + Math.random() * 40);
        }
        if (beat.kind === "text") {
          this.patchSession(sessionId, { lastText: beat.text.slice(-400) });
        }
        await sleep(250);
      } else if (beat.kind === "tool") {
        const toolCallId = id("tool");
        this.patchSession(sessionId, { currentActivity: beat.title });
        this.emit(sessionId, "tool", {
          toolCallId,
          title: beat.title,
          kind: beat.toolKind,
          detail: beat.detail,
          status: "in_progress",
        });
        await sleep(beat.ms ?? 900);
        this.emit(sessionId, "tool", {
          toolCallId,
          status: "completed",
          ...(beat.response ? { response: beat.response } : {}),
        });
        await sleep(200);
      } else if (beat.kind === "permission") {
        if (session.yolo) {
          beats.splice(index + 1, 0, {
            kind: "tool",
            title: beat.title,
            toolKind: beat.toolKind,
            detail: beat.detail,
            ms: 1000,
          });
          continue;
        }
        const requestId = id("perm");
        const toolCallId = id("tool");
        this.emit(sessionId, "tool", {
          toolCallId,
          title: beat.title,
          kind: beat.toolKind,
          detail: beat.detail,
          status: "pending",
        });
        this.emit(sessionId, "permission", {
          requestId,
          title: beat.title,
          toolCallId,
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        });
        this.patchSession(sessionId, { currentActivity: "Waiting for permission" });
        this.notify({
          kind: "permission_request",
          category: "permission",
          severity: "warning",
          title: `${session.name || session.initialPrompt.slice(0, 40)} is waiting for permission`,
          body: beat.title,
          subject: { type: "session", id: sessionId, label: session.name || "Session" },
          navigation: { type: "session", sessionId },
        });
        this.waiting.set(requestId, {
          sessionId,
          toolCallId,
          rest: beats.slice(index + 1),
        });
        this.busy.delete(sessionId);
        return;
      }
    }
    this.finishTurn(sessionId);
  }

  finishTurn(sessionId: string): void {
    this.busy.delete(sessionId);
    const session = this.session(sessionId);
    if (!session || session.state !== "running") return;
    this.emit(sessionId, "turn_complete", { stopReason: "end_turn" });
    const credits =
      (session.usage?.aiCredits ?? 0) + 1 + Math.round(Math.random() * 4) / 4;
    const percentage = Math.min(95, (session.usage?.context?.percentage ?? 8) + 4);
    this.patchSession(sessionId, {
      state: "idle",
      currentActivity: "",
      usage: {
        aiCredits: credits,
        context: {
          model:
            session.configOptions.find((o) => o.id === "model")?.currentValue ??
            "claude-sonnet-4.5",
          usedTokens: Math.round((percentage / 100) * 200_000),
          tokenLimit: 200_000,
          percentage,
          updatedAt: nowIso(),
          estimated: false,
          source: "acp",
        },
      },
    });
    if (session.runRole === "") {
      this.notify({
        kind: "agent_completion",
        category: "agent_lifecycle",
        severity: "info",
        title: `${session.name || session.initialPrompt.slice(0, 40)} finished its turn`,
        body: `On ${session.nodeName}.`,
        subject: { type: "session", id: sessionId, label: session.name || "Session" },
        navigation: { type: "session", sessionId },
      });
    }
  }

  answerPermission(sessionId: string, requestId: string, outcome: string): void {
    const pending = this.waiting.get(requestId);
    this.waiting.delete(requestId);
    this.emit(sessionId, "permission_result", { requestId, outcome });
    for (const notification of this.notifications) {
      if (
        notification.kind === "permission_request" &&
        notification.subject.id === sessionId &&
        notification.status === "active"
      ) {
        notification.status = "resolved";
        notification.resolvedAt = nowIso();
        notification.updatedAt = nowIso();
        this.broadcast({
          type: "notification_upsert",
          notification: { ...notification },
        });
      }
    }
    this.broadcast({ type: "notification_unread_count", unreadCount: this.unread() });
    if (!pending) return;
    this.emit(sessionId, "tool", {
      toolCallId: pending.toolCallId,
      status: outcome === "deny" ? "failed" : "completed",
    });
    const rest: Beat[] =
      outcome === "deny"
        ? [
            {
              kind: "text",
              text: "Understood, I won't run that. I'll leave the change staged so you can review it, and stop here.",
            },
          ]
        : pending.rest;
    void this.play(sessionId, rest);
  }

  notify(
    input: Pick<
      Notification,
      "kind" | "category" | "severity" | "title" | "body" | "subject" | "navigation"
    >,
  ): void {
    const notification: Notification = {
      id: id("n"),
      sourceKey: id("src"),
      status: "active",
      data: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      readAt: null,
      dismissedAt: null,
      resolvedAt: null,
      ...input,
    };
    this.notifications.unshift(notification);
    this.broadcast({ type: "notification_upsert", notification });
    this.broadcast({ type: "notification_unread_count", unreadCount: this.unread() });
  }

  // -------------------------------------------------------------- orchestration

  publishRun(run: Run): void {
    run.updatedAt = nowIso();
    this.broadcast({ type: "run", run: { ...run }, notes: this.notes[run.id] ?? [] });
    this.broadcast({ type: "run_steps", runId: run.id, steps: this.steps[run.id] ?? [] });
  }

  addNote(runId: string, note: Omit<RunNote, "id" | "runId" | "createdAt">): void {
    const list = this.notes[runId] ?? [];
    list.push({ ...note, id: id("note"), runId, createdAt: nowIso() });
    this.notes[runId] = list;
  }

  /** A task from creation through planning, parallel workers and review. */
  async driveTask(run: Run): Promise<void> {
    const leadId = run.leadSessionId;
    const workspace = this.workspaces.find((entry) => entry.id === run.workspaceId)!;
    await this.prompt(
      leadId,
      `<fleet-task id="${run.id}" name="${run.name}" workspace="${workspace.name}">\n${run.objective}\n</fleet-task>`,
      [],
    );
    await this.play(leadId, orchestratorPlan(run.name));
    run.state = "running";
    run.phases = ["Investigate", "Implement", "Review"];
    run.phaseIndex = 0;
    run.successCriteria = [
      {
        id: "behaviour-covered",
        scenario: `A focused test reproduces the problem described in "${run.name}" and passes after the change.`,
        expectedEvidence: "npm test -- <focused suite> exits 0 with the new test listed",
        essential: true,
      },
      {
        id: "no-regression",
        scenario:
          "The full test suite for the workspace passes unchanged after the change.",
        expectedEvidence: "npm test exits 0",
        essential: true,
      },
      {
        id: "reviewed",
        scenario: "A reviewer read the diff and found no correctness or security issues.",
        expectedEvidence: "Reviewer step output with an explicit approval",
        essential: false,
      },
    ];
    run.stopWhen = "Both essential criteria have passing evidence.";
    this.addNote(run.id, {
      phaseIndex: 0,
      summary: "Planned in three phases with three success criteria",
      kind: "decision",
      source: "orchestrator",
      body: "Investigate → Implement → Review. Workers dispatched in parallel where possible.",
    });

    const placements = this.placements.filter((p) => p.workspaceId === run.workspaceId);
    const pick = (index: number) => placements[index % placements.length]!;
    const titles = ["Investigate the current behaviour", "Implement the fix"];
    const workers = titles.map((title, index) => {
      const placement = pick(index);
      const worker = this.createSession({
        placementId: placement.id,
        prompt: title,
        name: title,
        yolo: true,
        runId: run.id,
        runRole: "worker",
        readOnly: index === 0,
      })!;
      const step: RunStep = {
        id: id("step"),
        runId: run.id,
        stepKey: index === 0 ? "investigate" : "implement",
        title,
        prompt: title,
        category: index === 0 ? "read" : "write",
        dependsOn: [],
        state: "running",
        sessionId: worker.id,
        placementId: placement.id,
        output: "",
        eventSeqFrom: 0,
        attempts: 1,
        phaseIndex: index,
        dispatchedAt: nowIso(),
        position: index,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      return { worker, step };
    });
    this.steps[run.id] = workers.map((entry) => entry.step);
    run.placementId = workers[0]!.step.placementId;
    this.publishRun(run);

    await Promise.all(
      workers.map(async ({ worker, step }, index) => {
        await sleep(index * 1200);
        await this.prompt(worker.id, step.prompt, workerTurn(step.title));
        step.state = "succeeded";
        step.output = `${step.title}: done, tests pass.`;
        step.updatedAt = nowIso();
        run.settleSeq += 1;
        this.publishRun(run);
      }),
    );

    run.phaseIndex = 2;
    run.state = "awaiting_lead";
    this.publishRun(run);
    await this.prompt(
      leadId,
      `<fleet-wake task="${run.name}" phase="Implement" (2/3) wakes=1/12>\nJust finished:\n${workers
        .map(({ step }) => `- ${step.title} (${step.stepKey}): succeeded`)
        .join("\n")}\n</fleet-wake>`,
      [],
    );
    await this.play(leadId, orchestratorWrapUp(run.name));
    run.state = "awaiting_human";
    run.reviewSeq += 1;
    this.addNote(run.id, {
      phaseIndex: 2,
      summary: "All criteria met — ready for sign-off",
      kind: "review",
      source: "orchestrator",
      body: "Both workers settled cleanly and every essential criterion has passing evidence.",
    });
    this.publishRun(run);
    this.notify({
      kind: "orchestration_needs_review",
      category: "orchestration",
      severity: "warning",
      title: `${run.name} needs your review`,
      body: "All success criteria are met. Approve the task or send it back with a note.",
      subject: { type: "run", id: run.id, label: run.name },
      navigation: { type: "run", runId: run.id },
    });
  }

  // ------------------------------------------------------------ ambient life

  /** Keeps the seeded running sessions moving so the wall never looks frozen. */
  startBackgroundLife(): void {
    setTimeout(() => {
      const auth = this.session("s-auth");
      if (auth?.state === "running") {
        const tool = (this.events.get("s-auth") ?? []).find(
          (event) => event.type === "tool" && event.payload.status === "in_progress",
        );
        void (async () => {
          await sleep(2500);
          if (tool)
            this.emit("s-auth", "tool", {
              toolCallId: tool.payload.toolCallId,
              status: "completed",
            });
          await this.play("s-auth", [
            {
              kind: "text",
              text: "All **27 auth tests** pass, including the new `serialises concurrent refreshes across tabs`. I also opened two tabs against the local server and forced simultaneous refreshes 50 times: zero logouts.\n\nReady for review whenever you are.",
            },
          ]);
        })();
      }
      const implement = this.session("s-worker-implement");
      if (implement?.state === "running") {
        const tool = (this.events.get("s-worker-implement") ?? []).find(
          (event) => event.type === "tool" && event.payload.status === "in_progress",
        );
        void (async () => {
          await sleep(6000);
          if (tool)
            this.emit("s-worker-implement", "tool", {
              toolCallId: tool.payload.toolCallId,
              status: "completed",
            });
          await this.play(
            "s-worker-implement",
            workerTurn("Implement jittered backoff").slice(3),
          );
          const run = this.runs.find((entry) => entry.id === "run-retry");
          const step = this.steps["run-retry"]?.find(
            (entry) => entry.stepKey === "implement",
          );
          if (run && step) {
            step.state = "succeeded";
            step.output =
              "Full-jitter exponential backoff, capped at 30s. 18/18 tests pass.";
            step.updatedAt = nowIso();
            delete step.admission;
            run.phaseIndex = 2;
            run.settleSeq += 1;
            this.publishRun(run);
          }
        })();
      }
    }, 4000);

    setInterval(() => {
      for (const node of this.nodes) {
        const cpu = node.health?.cpu;
        if (cpu)
          cpu.usagePercent = Math.max(
            4,
            Math.min(96, cpu.usagePercent + (Math.random() - 0.5) * 12),
          );
        if (cpu) cpu.sampledAt = nowIso();
        node.lastHeartbeat = nowIso();
        this.broadcast({ type: "node", node: { ...node } });
      }
    }, 5000);
  }

  // ------------------------------------------------------------------- HTTP

  async handle(method: string, url: URL, body: JsonBody): Promise<Response> {
    const path = url.pathname.replace(/^.*?(\/api\/)/, "/api/");
    const parts = path.split("/").filter(Boolean).slice(1);
    const [resource, first, second, third] = parts;

    if (resource === "auth") return this.auth(first, method);
    if (path === "/api/health") return json(200, { ok: true, version: "0.10.0-demo" });
    if (path === "/api/snapshot") return json(200, this.snapshot());
    if (path === "/api/runs" && method === "GET")
      return json(200, {
        runs: this.runs,
        stepsByRunId: this.steps,
        notesByRunId: this.notes,
      });
    if (resource === "sessions")
      return this.sessionsRoute(method, first, second, body, url);
    if (resource === "runs") return this.runsRoute(method, first, second, third, body);
    if (resource === "orchestrators")
      return this.orchestratorsRoute(method, first, second, body);
    if (resource === "notifications")
      return this.notificationsRoute(method, first, second, body);
    if (resource === "workspaces" || resource === "placements" || resource === "nodes")
      return this.catalogRoute(resource, method, first, second, body);
    if (resource === "defaults") {
      if (method === "POST") Object.assign(this.defaults, body);
      return json(200, this.defaultsView());
    }
    if (resource === "tunnel") return this.tunnelRoute(method, body);
    if (resource === "usage") return json(200, this.usage(url));
    if (path === "/api/enrollment") return json(200, this.enrollment());
    if (path === "/api/enrollment-grants") return json(201, this.grant());
    if (resource === "worker-model-routing") return json(200, this.routing());
    if (resource === "host-mcp") return json(200, this.hostMcp());
    if (resource === "local-agent") return json(200, this.localAgent(first));
    if (path === "/api/logs") return json(200, { entries: this.logs() });
    if (resource === "host" && first === "update") {
      if (method === "POST")
        return json(409, { error: "Updates are disabled in this demo." });
      return json(200, this.snapshot().hostUpdate);
    }
    if (resource === "command-executions") return json(200, { executions: [] });
    if (resource === "worktrees") {
      const workspaceId = url.searchParams.get("workspaceId") ?? "";
      return json(200, {
        managedWorktreesEnabled: true,
        placements: this.placements
          .filter((p) => p.workspaceId === workspaceId)
          .map((p) => ({
            placementId: p.id,
            supported: p.nodeId !== "node-build",
            online: true,
          })),
      });
    }
    if (resource === "backup")
      return json(200, { kind: "copilot-fleet-host", demo: true });
    if (resource === "security") return json(200, { events: [] });
    return json(404, { error: `The demo Host does not implement ${method} ${path}` });
  }

  auth(action: string | undefined, method: string): Response {
    if (action === "status")
      return json(200, {
        state: "no-auth",
        authenticated: false,
        passwordEnabled: false,
        entraConfigured: false,
        deviceFlowEnabled: false,
        claimCodeRequired: false,
        canSignIn: true,
        codeLogin: { available: false, localForwardRequired: false },
      });
    if (action === "csrf") return json(200, { csrfToken: "demo" });
    if (action === "administrators")
      return json(200, { currentAdministratorId: "", administrators: [], pending: [] });
    if (method === "POST")
      return json(409, {
        error: "Sign-in is turned off in this demo, so there is nothing to change.",
      });
    return json(404, { error: "Not available in the demo" });
  }

  async sessionsRoute(
    method: string,
    sessionId: string | undefined,
    action: string | undefined,
    body: JsonBody,
    url: URL,
  ): Promise<Response> {
    if (!sessionId) {
      if (method === "GET") return json(200, this.sessions);
      if (method === "DELETE") {
        const before = this.sessions.length;
        this.sessions = this.sessions.filter(
          (s) => !["stopped", "completed", "failed"].includes(s.state),
        );
        this.broadcast({ type: "snapshot", data: this.snapshot() });
        return json(200, { removed: before - this.sessions.length });
      }
      const session = this.createSession({
        placementId: String(body.placementId),
        prompt: String(body.prompt),
        name: String(body.name ?? ""),
        yolo: Boolean(body.yolo),
      });
      if (!session) return json(404, { error: "Placement not found" });
      void (async () => {
        await sleep(600);
        await this.prompt(
          session.id,
          session.initialPrompt,
          firstTurn(session.initialPrompt),
        );
      })();
      return json(202, session);
    }
    if (sessionId === "reorder") {
      const order = (body.sessionIds as string[]) ?? [];
      this.sessions.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      this.broadcast({ type: "snapshot", data: this.snapshot() });
      return json(200, { ok: true });
    }
    if (sessionId === "stop") {
      for (const target of (body.sessionIds as string[]) ?? []) this.stop(target);
      return json(202, { ok: true });
    }
    const session = this.session(sessionId);
    if (!session) return json(404, { error: "Session not found" });
    if (action === "transcript") {
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(
        200,
        this.page(sessionId, before === null ? undefined : Number(before), limit),
      );
    }
    if (action === "messages") return json(200, []);
    if (!action && method === "PATCH")
      return json(200, this.patchSession(sessionId, { name: String(body.name ?? "") }));
    if (!action && method === "DELETE") {
      this.sessions = this.sessions.filter((s) => s.id !== sessionId);
      this.broadcast({ type: "snapshot", data: this.snapshot() });
      return json(204);
    }
    if (action === "favorite")
      return json(
        200,
        this.patchSession(sessionId, { favorite: Boolean(body.favorite) }),
      );
    if (action === "prompt") {
      if (this.busy.has(sessionId))
        return json(409, {
          error: "The agent is mid-turn. Wait for it to finish, then send again.",
        });
      const text = String(body.prompt ?? "");
      const beats = session.runRole === "lead" ? orchestratorReply(text) : replyTo(text);
      void this.prompt(sessionId, text, beats);
      if (session.runRole === "lead" && !session.name)
        this.patchSession(sessionId, { name: text.slice(0, 50) });
      return json(202, { ok: true });
    }
    if (action === "permission") {
      this.answerPermission(sessionId, String(body.requestId), String(body.outcome));
      return json(202, { ok: true });
    }
    if (action === "config") {
      const configId = String(body.configId);
      const options = session.configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: String(body.value) } : option,
      );
      this.patchSession(sessionId, { configOptions: options });
      return json(202, { ok: true });
    }
    if (action === "cancel") {
      this.patchSession(sessionId, { state: "idle", currentActivity: "" });
      this.emit(sessionId, "turn_complete", { stopReason: "cancelled" });
      this.busy.delete(sessionId);
      return json(202, { ok: true });
    }
    if (action === "stop") {
      this.stop(sessionId);
      return json(202, { ok: true });
    }
    if (action === "resume") {
      this.patchSession(sessionId, {
        state: "idle",
        stopRequested: false,
        currentActivity: "",
      });
      this.emit(sessionId, "system", { text: "Session resumed on " + session.nodeName });
      return json(202, { ok: true });
    }
    return json(404, { error: "Not available in the demo" });
  }

  stop(sessionId: string): void {
    this.busy.delete(sessionId);
    this.patchSession(sessionId, { state: "stopped", currentActivity: "" });
    this.emit(sessionId, "state", { state: "stopped", activity: "Stopped by operator" });
  }

  runsRoute(
    method: string,
    runId: string | undefined,
    action: string | undefined,
    _third: string | undefined,
    body: JsonBody,
  ): Response {
    const run = this.runs.find((entry) => entry.id === runId);
    if (!run) return json(404, { error: "Task not found" });
    if (action === "pr-maintenance") {
      return json(200, {
        records: [],
        canAuthorize: false,
        unsupportedReason:
          "PR maintenance needs a GitHub-connected Host; it is not part of this demo.",
      });
    }
    if (action === "worktree")
      return json(409, { error: "Managed worktrees are not simulated in this demo." });
    if (action === "review") {
      if (body.approved) {
        run.state = "completed";
        this.addNote(run.id, {
          phaseIndex: run.phaseIndex,
          summary: "Approved by a person",
          kind: "decision",
          source: "operator",
          body: "The operator signed off on the result.",
        });
      } else {
        run.state = "running";
        this.addNote(run.id, {
          phaseIndex: run.phaseIndex,
          summary: "Sent back with guidance",
          kind: "decision",
          source: "operator",
          body: String(body.note ?? ""),
        });
        void this.prompt(
          run.leadSessionId,
          `<fleet-review task="${run.name}" verdict="changes requested">\n${String(body.note ?? "")}\n</fleet-review>`,
          [
            {
              kind: "thought",
              text: "The reviewer wants changes. I'll brief a worker with their note verbatim.",
            },
            {
              kind: "tool",
              title: "fleet_dispatch",
              toolKind: "execute",
              detail: "follow-up → devbox-west",
              ms: 700,
            },
            {
              kind: "text",
              text: `Got it. I've sent **${run.name}** back to a worker with your note and will hand it back once the criteria are met again.`,
            },
          ],
        );
      }
      this.resolveReview(run.id);
      this.publishRun(run);
      return json(200, { run, steps: this.steps[run.id] ?? [] });
    }
    if (action === "archive") {
      if (!["completed", "failed", "cancelled"].includes(run.state))
        run.state = "cancelled";
      this.publishRun(run);
      return json(200, { run, steps: this.steps[run.id] ?? [] });
    }
    if (action === "reopen") {
      run.state = "running";
      this.publishRun(run);
      return json(200, { run, steps: this.steps[run.id] ?? [] });
    }
    if (method === "DELETE") {
      this.runs = this.runs.filter((entry) => entry.id !== run.id);
      this.broadcast({ type: "snapshot", data: this.snapshot() });
      return json(204);
    }
    return json(200, {
      run,
      steps: this.steps[run.id] ?? [],
      notes: this.notes[run.id] ?? [],
    });
  }

  resolveReview(runId: string): void {
    for (const notification of this.notifications) {
      if (
        notification.kind === "orchestration_needs_review" &&
        notification.subject.id === runId
      ) {
        notification.status = "resolved";
        notification.resolvedAt = nowIso();
        notification.updatedAt = nowIso();
        this.broadcast({
          type: "notification_upsert",
          notification: { ...notification },
        });
      }
    }
    this.broadcast({ type: "notification_unread_count", unreadCount: this.unread() });
  }

  orchestratorsRoute(
    method: string,
    sessionId: string | undefined,
    action: string | undefined,
    body: JsonBody,
  ): Response {
    if (!sessionId && method === "GET") {
      return json(200, {
        orchestrators: this.sessions
          .filter((s) => s.runRole === "lead")
          .map((session) => {
            const runs = this.runs.filter((run) => run.leadSessionId === session.id);
            return {
              session,
              run: runs[0],
              runs,
              steps: runs.flatMap((run) => this.steps[run.id] ?? []),
              notes: runs.flatMap((run) => this.notes[run.id] ?? []),
            };
          }),
      });
    }
    if (!sessionId) {
      const placement =
        this.placements.find((p) => p.workspaceId === body.workspaceId) ??
        this.placements[0]!;
      const lead = this.createSession({
        placementId: placement.id,
        prompt:
          "You are the Fleet orchestrator. Plan tasks, write success criteria, and dispatch workers.",
        name: String(body.name ?? ""),
        yolo: true,
        runRole: "lead",
        readOnly: true,
      })!;
      void this.play(lead.id, [
        { kind: "pause", ms: 600 },
        {
          kind: "text",
          text: `Ready. I can see **${this.nodes.length} online Nodes**. Create a task and I'll plan it, write success criteria, and dispatch workers.`,
        },
      ]);
      return json(201, { session: lead });
    }
    if (sessionId === "cleanup") return json(200, { ok: true });
    if (action === "runs") {
      const workspace = this.workspaces.find((entry) => entry.id === body.workspaceId);
      if (!workspace) return json(404, { error: "Workspace not found" });
      const run: Run = {
        ...seedRuns()[0]!,
        id: id("run"),
        workspaceId: workspace.id,
        name: String(body.name),
        objective: String(body.objective),
        state: "planning",
        leadSessionId: sessionId,
        placementId: "",
        phases: [],
        phaseIndex: 0,
        successCriteria: [],
        stopWhen: "",
        settleSeq: 0,
        wakeSeq: 0,
        reviewSeq: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.runs.unshift(run);
      this.steps[run.id] = [];
      this.notes[run.id] = [];
      this.publishRun(run);
      void this.driveTask(run);
      return json(201, { run });
    }
    if (action === "stop") {
      this.stop(sessionId);
      return json(202, { ok: true });
    }
    if (action === "resume" || action === "restore") {
      this.patchSession(sessionId, { state: "idle", dismissed: false });
      return json(200, { ok: true, blockedRuns: [] });
    }
    if (action === "agents") {
      for (const target of (body.sessionIds as string[]) ?? []) this.stop(target);
      return json(202, { ok: true });
    }
    if (action === "transfer")
      return json(200, { transferred: body.runIds ?? [], failed: [] });
    if (method === "DELETE") {
      this.patchSession(sessionId, { dismissed: true });
      return json(204);
    }
    return json(404, { error: "Not available in the demo" });
  }

  notificationsRoute(
    method: string,
    first: string | undefined,
    second: string | undefined,
    body: JsonBody,
  ): Response {
    const active = () => this.notifications.filter((n) => n.status !== "dismissed");
    if (first === "preferences") {
      const session = this.session(second ?? "");
      return json(200, {
        sessionId: second,
        agentId: session?.agentSessionId ?? "",
        runRole: session?.runRole ?? "",
        lifecycleEnabled: method === "PUT" ? Boolean(body.lifecycleEnabled) : true,
        source: method === "PUT" ? "explicit" : "application",
        explicitOverride: method === "PUT" ? Boolean(body.lifecycleEnabled) : null,
        roleDefault: null,
        applicationDefault: true,
      });
    }
    if (first === "read-all" || first === "dismiss-all") {
      const changed = active().filter((n) =>
        first === "read-all" ? n.readAt === null : true,
      );
      for (const notification of changed) {
        if (first === "read-all") notification.readAt = nowIso();
        else {
          notification.status = "dismissed";
          notification.dismissedAt = nowIso();
        }
        notification.updatedAt = nowIso();
      }
      return json(200, {
        updated: changed.length,
        notifications: changed,
        unreadCount: this.unread(),
      });
    }
    const notification = this.notifications.find((n) => n.id === first);
    if (!notification) return json(200, { notifications: active() });
    if (second === "read") notification.readAt = nowIso();
    if (second === "dismiss") {
      notification.status = "dismissed";
      notification.dismissedAt = nowIso();
    }
    notification.updatedAt = nowIso();
    return json(200, { notification, unreadCount: this.unread() });
  }

  catalogRoute(
    resource: string,
    method: string,
    first: string | undefined,
    _second: string | undefined,
    body: JsonBody,
  ): Response {
    const catalog = () =>
      this.broadcast({
        type: "catalog",
        workspaces: this.workspaces,
        placements: this.snapshot().placements,
      });
    if (resource === "workspaces") {
      if (first === "reorder") {
        const order = (body.workspaceIds as string[]) ?? [];
        this.workspaces.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      } else if (!first && method === "POST") {
        this.workspaces.push({
          id: id("ws"),
          name: String(body.name),
          description: String(body.description ?? ""),
          createdAt: nowIso(),
          kind: "project",
        });
      } else if (first && method === "PATCH") {
        const workspace = this.workspaces.find((w) => w.id === first);
        if (workspace)
          Object.assign(workspace, { name: body.name, description: body.description });
      } else if (first && method === "DELETE") {
        this.workspaces = this.workspaces.filter((w) => w.id !== first);
        this.placements = this.placements.filter((p) => p.workspaceId !== first);
      }
      catalog();
      return json(200, this.workspaces);
    }
    if (resource === "placements") {
      if (first === "reorder") {
        const order = (body.placementIds as string[]) ?? [];
        this.placements.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      } else if (!first && method === "POST") {
        this.placements.push({
          id: id("pl"),
          workspaceId: String(body.workspaceId),
          nodeId: String(body.nodeId),
          localPath: String(body.localPath),
        });
      } else if (first && method === "PATCH") {
        const placement = this.placements.find((p) => p.id === first);
        if (placement) Object.assign(placement, body);
      } else if (first && method === "DELETE") {
        this.placements = this.placements.filter((p) => p.id !== first);
      }
      catalog();
      return json(200, this.placements);
    }
    if (first === "update" || _second === "update")
      return json(409, { error: "Node updates are disabled in this demo." });
    if (_second === "console-resync") return json(202, { ok: true });
    const node = this.nodes.find((n) => n.id === first);
    if (node && method === "PATCH") {
      node.name = String(body.name);
      this.broadcast({ type: "node", node: { ...node } });
      return json(200, node);
    }
    if (node && method === "DELETE")
      return json(409, { error: "The demo keeps its machines." });
    if (first === "mutual-authentication")
      return json(409, { error: "Not available in the demo." });
    return json(200, this.nodes);
  }

  defaultsView() {
    return {
      ...this.defaults,
      managedWorktreesRevision: 1,
      managedWorktreePolicy: {
        retentionDays: 7,
        maxPerRepository: 8,
        maxPerNode: 32,
        freeSpaceFloorBytes: 1_073_741_824,
        byteBudget: 10_737_418_240,
        cleanupIgnoredOnly: false,
      },
      agencyModeAvailable: false,
      orchestratorHeartbeatTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      orchestratorHeartbeatUpcoming: [1, 2, 3].map((hours) =>
        new Date(Date.now() + hours * 3_600_000).toISOString(),
      ),
    };
  }

  tunnelRoute(method: string, body: JsonBody): Response {
    if (method === "POST") {
      const provider = String(body.provider ?? "devtunnel");
      const enabled = Boolean(body.enabled);
      this.tunnels.set(provider, {
        enabled,
        status: enabled ? "on" : "off",
        ...(enabled ? { url: `https://demo-${provider}.example.net` } : {}),
      });
    }
    return json(200, this.tunnel());
  }

  tunnel() {
    const provider = (
      id: string,
      label: string,
      binary: string,
      access: string,
      eligible: boolean,
      caveat?: string,
    ) => ({
      id,
      label,
      binary,
      binaryPresent: true,
      installHint: `Install ${binary}`,
      setupSteps: [
        `Install the ${label} CLI.`,
        "Switch this on; the Host runs it against its own port.",
      ],
      externalScheme: "https",
      access,
      controlPlaneEligible: eligible,
      ...(caveat ? { caveat } : {}),
    });
    const ids = ["cloudflare", "tailscale", "ngrok", "bore", "devtunnel", "corp-direct"];
    return {
      primary: "devtunnel",
      publicUrl: this.tunnels.get("devtunnel")?.url ?? "http://localhost:8787",
      providers: [
        provider(
          "cloudflare",
          "Cloudflare",
          "cloudflared",
          "public",
          false,
          "Quick tunnel URLs change on every restart.",
        ),
        provider("tailscale", "Tailscale Funnel", "tailscale", "public", false),
        provider(
          "ngrok",
          "ngrok",
          "ngrok",
          "public",
          false,
          "Free ngrok domains change on every restart.",
        ),
        provider(
          "bore",
          "bore",
          "bore",
          "public",
          false,
          "bore relays plain TCP, so traffic is not encrypted in transit.",
        ),
        provider(
          "devtunnel",
          "Dev Tunnels",
          "devtunnel",
          "creator-private",
          true,
          "Private by default: the URL prompts for a Microsoft login.",
        ),
      ],
      tunnels: ids.map((provider) => {
        const state = this.tunnels.get(provider);
        return {
          provider,
          enabled: state?.enabled ?? false,
          status: state?.status ?? "off",
          ...(state?.url ? { url: state.url } : {}),
          error: null,
          external: false,
          ...(provider === "devtunnel" ? { tunnelId: "fleet-demo.usw2" } : {}),
        };
      }),
      tunnelId: "fleet-demo.usw2",
      policy: {
        kind: "open",
        allowedProviders: ["cloudflare", "tailscale", "ngrok", "devtunnel"],
      },
    };
  }

  enrollment() {
    return {
      hostUrl: this.tunnels.get("devtunnel")?.url ?? "http://localhost:8787",
      hostId: "8f1c2d4e-demo-4b7a-9c11-0a2b3c4d5e6f",
      hostFingerprint: "c58cd40774994ecef0e74e45eee5efd53782012e543c3398f0bc7db564f9664b",
      hostPublicKey: "MCowBQYDK2VwAyEAS/wcIxhhNriAdbkJsaaA3hPvV/juv33BtzpDCW294KY=",
      connections: [
        {
          provider: "devtunnel",
          label: "Dev Tunnels",
          hostUrl:
            this.tunnels.get("devtunnel")?.url ??
            "https://x7k2m9-8787.usw2.devtunnels.ms",
          tunnelId: "fleet-demo.usw2",
        },
        {
          provider: "direct",
          label: "Configured Host URL",
          hostUrl: "http://localhost:8787",
        },
      ],
      nodeAuthentication: { total: 3, mutualAuth: 2, legacy: 1 },
      mutualAuthenticationRequired: false,
    };
  }

  grant() {
    const grantId = id("grant");
    return {
      id: grantId,
      grant: `${grantId}.demo-secret-not-real`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      command: {
        provider: "devtunnel",
        hostUrl: "https://x7k2m9-8787.usw2.devtunnels.ms",
        hostId: "8f1c2d4e-demo-4b7a-9c11-0a2b3c4d5e6f",
        hostFingerprint:
          "c58cd40774994ecef0e74e45eee5efd53782012e543c3398f0bc7db564f9664b",
        enrollmentGrant: `${grantId}.demo-secret-not-real`,
        tunnelId: "fleet-demo.usw2",
      },
    };
  }

  routing() {
    return {
      revision: 0,
      mode: "off",
      minProbability: 0.5,
      timeoutMs: 5000,
      providers: [],
      profiles: [],
      suspended: false,
      proposals: [],
    };
  }

  hostMcp() {
    const digest = "a".repeat(64);
    return {
      revision: "b".repeat(64),
      suspended: false,
      servers: [
        {
          name: "github",
          transport: "http",
          sourceDigest: digest,
          enabled: true,
          allNodes: true,
          toolCount: 42,
          readOnly: false,
        },
        {
          name: "ado",
          transport: "stdio",
          sourceDigest: digest,
          enabled: true,
          allNodes: false,
          toolCount: 31,
          readOnly: false,
        },
        {
          name: "context7",
          transport: "http",
          sourceDigest: digest,
          enabled: false,
          allNodes: false,
          toolCount: 2,
          readOnly: true,
        },
        {
          name: "playwright",
          transport: "stdio",
          sourceDigest: digest,
          enabled: false,
          allNodes: false,
          toolCount: 21,
          readOnly: false,
        },
      ],
    };
  }

  localAgent(first: string | undefined) {
    if (first === "requests") return { requests: [] };
    return {
      config: {
        enabled: false,
        port: 8786,
        allowedLeadSessionIds: [],
        allowedWorkspaceIds: [],
        revision: 0,
      },
      status: { state: "disabled" },
      hostPort: 8787,
      defaultPort: 8786,
      choices: {
        orchestrators: this.sessions
          .filter((s) => s.runRole === "lead")
          .map((s) => ({
            id: s.id,
            name: s.name || "Orchestrator",
            state: s.state,
            nodeName: s.nodeName,
          })),
        workspaces: this.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
        })),
      },
    };
  }

  logs() {
    const lines: [string, string][] = [
      ["info", "Server listening at http://127.0.0.1:8787"],
      [
        "info",
        "Dev tunnel fleet-demo.usw2 is up at https://x7k2m9-8787.usw2.devtunnels.ms",
      ],
      ["info", "Node charles-laptop connected (mutual-auth-v1)"],
      ["info", "Node devbox-west connected via devtunnel (mutual-auth-v1)"],
      [
        "warn",
        "Node build-01 connected with a legacy shared secret; enroll it again to upgrade",
      ],
      ["info", "Orchestrator s-lead woke for task run-retry (1/12)"],
    ];
    return lines.map(([level, message], index) => ({
      at: ago(30 - index * 4),
      level,
      message,
    }));
  }

  usage(url: URL) {
    const groupBy = url.searchParams.get("groupBy") ?? "day";
    const amounts = (credits: number, tokens: number) => ({
      aiCredits: credits,
      totalTokens: tokens,
      inputTokens: Math.round(tokens * 0.82),
      outputTokens: Math.round(tokens * 0.12),
      cacheReadTokens: Math.round(tokens * 0.41),
      cacheWriteTokens: Math.round(tokens * 0.05),
      reasoningTokens: Math.round(tokens * 0.06),
    });
    const day = (offset: number) => {
      const date = new Date(Date.now() - offset * 86_400_000);
      return date.toISOString().slice(0, 10);
    };
    let rows;
    if (groupBy === "machine") {
      rows = this.nodes.map((node, index) => ({
        key: node.id,
        label: node.name,
        sessions: [6, 11, 9][index]!,
        ...amounts(
          [22.5, 41.75, 30.25][index]!,
          [1_840_000, 3_420_000, 2_610_000][index]!,
        ),
      }));
    } else if (groupBy === "task") {
      rows = this.runs.map((run, index) => ({
        key: run.id,
        label: run.name,
        sessions: [4, 5][index] ?? 2,
        ...amounts([14.5, 21.25][index] ?? 6, [1_120_000, 1_730_000][index] ?? 400_000),
      }));
    } else if (groupBy === "session") {
      rows = this.sessions.map((session) => ({
        key: session.id,
        label: session.name || session.initialPrompt.slice(0, 40),
        sessions: 1,
        backend: "copilot" as const,
        role: session.runRole || "standalone",
        ...amounts(
          session.usage?.aiCredits ?? 1,
          Math.round((session.usage?.aiCredits ?? 1) * 82_000),
        ),
      }));
    } else {
      const credits = [
        4.5, 9.25, 12.75, 7.5, 15.25, 18.0, 11.5, 6.25, 13.75, 16.5, 9.0, 14.25, 19.5,
        17.75,
      ];
      rows = credits.map((value, index) => ({
        key: day(credits.length - 1 - index),
        label: day(credits.length - 1 - index),
        sessions: Math.round(value / 2) + 1,
        ...amounts(value, Math.round(value * 81_500)),
      }));
    }
    const totals = rows.reduce(
      (sum, row) => {
        for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += row[key];
        return sum;
      },
      amounts(0, 0),
    );
    return {
      totals,
      rows,
      coverage: {
        sessions: 26,
        creditSessions: 26,
        tokenSessions: 26,
        openingAiCredits: 0,
        openingTokens: 0,
        unallocatedAiCredits: 0,
        unallocatedTokens: 0,
        regressions: 0,
        lastReportedAt: nowIso(),
      },
      machines: this.nodes.map((node) => ({ id: node.id, name: node.name })),
      tasks: this.runs.map((run) => ({ id: run.id, name: run.name })),
      generatedAt: nowIso(),
    };
  }
}

/** The orchestrator's answer to a message typed straight into its conversation. */
const orchestratorReply = (text: string): Beat[] => [
  { kind: "thought", text: "Checking the board before answering." },
  {
    kind: "tool",
    title: "fleet_list_tasks",
    toolKind: "fetch",
    detail: "2 tasks · 1 awaiting review",
    ms: 700,
  },
  {
    kind: "text",
    text: `Here's where things stand:\n\n- **Stop client retry storms** is in *Implement* on devbox-west.\n- **Cut CI time under 10 minutes** is done and waiting for your sign-off.\n\nIf "${text.slice(0, 60)}" is new work, create a task from the board and I'll plan and dispatch it.`,
  },
];

/** A WebSocket the demo Host can talk through. */
class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly host: DemoHost,
  ) {
    super();
    setTimeout(() => {
      this.readyState = 1;
      host.sockets.add(this);
      this.fire("open", new Event("open"));
      this.deliver(JSON.stringify({ type: "snapshot", data: host.snapshot() }));
    }, 50);
  }

  deliver(data: string): void {
    if (this.readyState !== 1) return;
    this.fire("message", new MessageEvent("message", { data }));
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.host.sockets.delete(this);
    this.fire("close", new CloseEvent("close", { code: 1000 }));
  }

  private fire(type: "open" | "close" | "message" | "error", event: Event): void {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
  }
}

/** Replaces `fetch` and `WebSocket` for `/api` and `/ws` before the app starts. */
export const installDemoHost = (): void => {
  const host = new DemoHost();
  const nativeFetch = window.fetch.bind(window);
  const NativeSocket = window.WebSocket;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      window.location.href,
    );
    if (!url.pathname.includes("/api/")) return nativeFetch(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body: JsonBody = {};
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body) as JsonBody;
      } catch {
        body = {};
      }
    }
    await sleep(40 + Math.random() * 80);
    try {
      return await host.handle(method, url, body);
    } catch (error) {
      console.error("Demo Host failed", method, url.pathname, error);
      return json(500, { error: "The demo Host hit an error handling that request." });
    }
  };

  window.WebSocket = class extends EventTarget {
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const href = String(url);
      if (!href.includes("/ws/"))
        return new NativeSocket(url, protocols) as unknown as this;
      return new DemoSocket(href, host) as unknown as this;
    }
  } as unknown as typeof WebSocket;
};
