import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { CHATS_WORKSPACE_ID } from "@fleet/protocol";
import { buildServer } from "./server.js";

const OPERATOR_PASSWORD = "test-password";

/**
 * Route-level coverage.
 *
 * Every rule below used to live inside one 800-line closure with no way in
 * from a test, so the only thing ever asserted about the Host was its handful
 * of exported pure functions.
 */
describe("host routes", () => {
  let app: FastifyInstance;
  let cookie = "";

  /**
   * Every route below now sits behind the operator session, so the suite
   * signs in once per test and speaks as that operator. Unauthenticated
   * behaviour is asserted separately, in request-guard.test.ts.
   */
  const inject = async (options: InjectOptions) =>
    app.inject({ ...options, headers: { ...options.headers, cookie } });

  const enroll = async (name: string, capabilities = ["copilot-acp", "host-yolo"]) => {
    const response = await inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name,
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities,
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    return response.json() as { nodeId: string; secret: string };
  };

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: OPERATOR_PASSWORD,
    });
    app.log.level = "silent";
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: OPERATOR_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports health and an empty snapshot", async () => {
    const health = await inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const snapshot = await inject({ method: "GET", url: "/api/snapshot" });
    expect(snapshot.json()).toMatchObject({
      nodes: [],
      // Never empty: Chats is seeded when the database is opened, so a Host
      // with nothing enrolled still offers somewhere to ask a question.
      workspaces: [{ id: CHATS_WORKSPACE_ID, kind: "chats" }],
      placements: [],
      sessions: [],
    });
    // Whatever commit the suite runs from, the snapshot has to carry one, or
    // the browser has nothing to compare a node's revision against.
    expect(snapshot.json()).toHaveProperty("hostRevision");
  });

  it("serves a log endpoint the browser can read the Host's problems from", async () => {
    // The Host logs to a terminal that, on an unattended fleet, nobody is
    // watching. This is how the operator sees it without one.
    const response = await inject({ method: "GET", url: "/api/logs" });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().entries)).toBe(true);
  });

  it("refuses enrollment with the wrong token", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "intruder",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: [],
        maxSessions: 1,
        enrollmentToken: "not-the-token",
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("issues a secret once and reclaims the node on re-enrollment", async () => {
    const first = await enroll("weili-pc");
    const second = await enroll("weili-pc");
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.secret).not.toBe(first.secret);

    const nodes = await inject({ method: "GET", url: "/api/nodes" });
    expect(nodes.json()).toHaveLength(1);
    // The secret must never travel back out over a listing route.
    expect(JSON.stringify(nodes.json())).not.toContain(second.secret);
  });

  it("rejects a duplicate workspace name", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("answers 404 for unknown ids instead of throwing", async () => {
    const routes = [
      { method: "PATCH" as const, url: "/api/nodes/missing", payload: { name: "x" } },
      {
        method: "PATCH" as const,
        url: "/api/workspaces/missing",
        payload: { name: "x", description: "" },
      },
      {
        method: "PATCH" as const,
        url: "/api/placements/missing",
        payload: { localPath: "/tmp" },
      },
      { method: "GET" as const, url: "/api/sessions/missing/events" },
      { method: "PATCH" as const, url: "/api/sessions/missing", payload: { name: "x" } },
      { method: "DELETE" as const, url: "/api/sessions/missing" },
    ];
    for (const route of routes) {
      const response = await inject(route);
      expect(response.statusCode, route.url).toBe(404);
    }
  });

  it("maps schema violations to 400", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { description: "no name" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a session on an offline node", async () => {
    const { nodeId } = await enroll("offline-node");
    const workspace = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    const placement = await inject({
      method: "POST",
      url: "/api/placements",
      payload: {
        workspaceId: (workspace.json() as { id: string }).id,
        nodeId,
        localPath: "/tmp/fleet",
      },
    });
    const response = await inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        placementId: (placement.json() as { id: string }).id,
        prompt: "hello",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Node is offline" });
  });

  it("refuses a placement for an unknown node", async () => {
    const workspace = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    const response = await inject({
      method: "POST",
      url: "/api/placements",
      payload: {
        workspaceId: (workspace.json() as { id: string }).id,
        nodeId: "missing",
        localPath: "/tmp/fleet",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("round-trips the session defaults", async () => {
    // Auto-resume is on when unset; YOLO is not, because handing every new
    // session a permission-free agent is the operator's decision to make.
    const read = async () =>
      (await inject({ method: "GET", url: "/api/defaults" })).json();
    expect(await read()).toEqual({
      yolo: false,
      autoResume: true,
      model: "",
      reasoningEffort: "",
    });

    await inject({ method: "POST", url: "/api/defaults", payload: { yolo: true } });
    // A client that knows about one setting must not reset the other simply by
    // not mentioning it.
    expect(await read()).toEqual({
      yolo: true,
      autoResume: true,
      model: "",
      reasoningEffort: "",
    });

    await inject({
      method: "POST",
      url: "/api/defaults",
      payload: { autoResume: false },
    });
    expect(await read()).toEqual({
      yolo: true,
      autoResume: false,
      model: "",
      reasoningEffort: "",
    });

    // The model and effort a new session starts on travel the same way, and
    // empty is a real answer: it means the fleet has no opinion and each
    // machine keeps whatever Copilot picked.
    await inject({
      method: "POST",
      url: "/api/defaults",
      payload: { model: "claude-opus-5", reasoningEffort: "xhigh" },
    });
    expect(await read()).toEqual({
      yolo: true,
      autoResume: false,
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
    });

    // Clearing one is a choice, not an omission, so it has to be honoured.
    await inject({ method: "POST", url: "/api/defaults", payload: { model: "" } });
    expect(await read()).toMatchObject({ model: "", reasoningEffort: "xhigh" });
  });

  it("serves the enrollment command inputs", async () => {
    const response = await inject({ method: "GET", url: "/api/enrollment" });
    expect(response.json()).toMatchObject({ enrollmentToken: "test-token" });
    expect((response.json() as { hostUrl: string }).hostUrl).toMatch(/^http/);
  });

  it("exports and replaces the fleet from a Host archive", async () => {
    const enrolled = await enroll("box");
    const created = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "repo", description: "" },
    });
    expect(created.statusCode).toBe(201);

    const exported = await inject({ method: "GET", url: "/api/backup" });
    expect(exported.statusCode).toBe(200);
    const backup = exported.json() as {
      kind: string;
      enrollmentToken: string;
      publicUrl?: string;
    };
    expect(backup.kind).toBe("copilot-fleet-host");
    expect(backup.enrollmentToken).toBe("test-token");
    expect(backup.publicUrl).toBeUndefined();

    backup.enrollmentToken = "restored-token";
    const imported = await inject({
      method: "POST",
      url: "/api/backup",
      payload: backup,
    });
    expect(imported.statusCode).toBe(200);

    const snapshot = (await inject({ method: "GET", url: "/api/snapshot" })).json() as {
      nodes: { id: string }[];
      workspaces: { name: string }[];
    };
    expect(snapshot.nodes.map((node) => node.id)).toContain(enrolled.nodeId);
    expect(snapshot.workspaces.map((workspace) => workspace.name)).toContain("repo");
    expect(
      (await inject({ method: "GET", url: "/api/enrollment" })).json(),
    ).toMatchObject({
      enrollmentToken: "restored-token",
    });
  });

  it("refuses a Node identity file on the Host import endpoint", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/backup",
      payload: {
        kind: "copilot-fleet-node",
        version: 1,
        exportedAt: new Date().toISOString(),
        credentials: {
          hostUrl: "https://fleet.example.com",
          nodeId: "n1",
          secret: "s",
          name: "box",
        },
        settings: {
          hostUrl: "https://fleet.example.com",
          nodeName: "box",
          maxSessions: 4,
          copilotCommand: "",
          permissionTimeoutMs: 30_000,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("node's config page"),
    });
  });

  it("keeps unknown API paths as JSON 404s", async () => {
    const response = await inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
  });

  /**
   * The reserved workspace, over the wire.
   *
   * The store refuses these too, but the routes are where an operator's browser
   * actually asks — and one of them used to report every failure as a name
   * collision, which would send them looking for a workspace that is not there.
   */
  it("gives an enrolled node a Chats checkout at its home directory", async () => {
    const register = await inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "box",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: ["copilot-acp"],
        maxSessions: 1,
        homeDir: "/home/box",
        enrollmentToken: "test-token",
      },
    });
    const { nodeId } = register.json() as { nodeId: string };

    const placements = await inject({ method: "GET", url: "/api/placements" });
    expect(placements.json()).toMatchObject([
      {
        workspaceId: CHATS_WORKSPACE_ID,
        workspaceName: "Chats",
        nodeId,
        localPath: "/home/box",
      },
    ]);
  });

  it("refuses to rename, delete, or place into Chats", async () => {
    const { nodeId } = await enroll("box");

    const renamed = await inject({
      method: "PATCH",
      url: `/api/workspaces/${CHATS_WORKSPACE_ID}`,
      payload: { name: "Notes", description: "" },
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json()).toMatchObject({
      error: expect.stringContaining("built in"),
    });

    const deleted = await inject({
      method: "DELETE",
      url: `/api/workspaces/${CHATS_WORKSPACE_ID}`,
    });
    expect(deleted.statusCode).toBe(409);

    const placed = await inject({
      method: "POST",
      url: "/api/placements",
      payload: { workspaceId: CHATS_WORKSPACE_ID, nodeId, localPath: "/tmp" },
    });
    expect(placed.statusCode).toBe(409);
    expect(placed.json()).toMatchObject({
      error: expect.stringContaining("built in"),
    });
  });
});

describe("run routes", () => {
  let app: FastifyInstance;
  let cookie = "";

  const inject = async (options: InjectOptions) =>
    app.inject({ ...options, headers: { ...options.headers, cookie } });

  const workspaceWithPlacement = async () => {
    const register = await inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "node",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: ["copilot-acp", "host-yolo"],
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    const { nodeId } = register.json() as { nodeId: string };
    const workspace = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "repo", description: "" },
    });
    const workspaceId = (workspace.json() as { id: string }).id;
    await inject({
      method: "POST",
      url: "/api/placements",
      payload: { workspaceId, nodeId, localPath: "/src/repo" },
    });
    return { workspaceId, nodeId };
  };

  const createRun = async (workspaceId: string) => {
    const response = await inject({
      method: "POST",
      url: "/api/runs",
      payload: { workspaceId, name: "audit", objective: "audit then fix" },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; state: string };
  };

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: OPERATOR_PASSWORD,
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: OPERATOR_PASSWORD },
    });
    cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a run that waits for a human before anything runs", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    expect(run.state).toBe("awaiting_approval");

    const listed = await inject({ method: "GET", url: "/api/runs" });
    const body = listed.json() as { runs: unknown[]; stepsByRunId: Record<string, []> };
    expect(body.runs).toHaveLength(1);
    expect(body.stepsByRunId[run.id]).toEqual([]);
  });

  it("refuses a plan whose steps depend on each other and names the cycle", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    const response = await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: {
        steps: [
          { stepKey: "a", title: "A", prompt: "a", dependsOn: ["b"] },
          { stepKey: "b", title: "B", prompt: "b", dependsOn: ["a"] },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; cycle: string[] };
    expect(body.cycle.sort()).toEqual(["a", "b"]);
    expect(body.error).toContain("cycle");
  });

  it("refuses a plan that depends on a step nobody submitted", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    const response = await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: {
        steps: [{ stepKey: "fix", title: "Fix", prompt: "fix", dependsOn: ["audit"] }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("audit");
  });

  it("dispatches the first step on approval and owns the session it creates", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: {
        steps: [
          { stepKey: "audit", title: "Audit", prompt: "audit it", category: "explore" },
          {
            stepKey: "fix",
            title: "Fix",
            prompt: "fix it",
            category: "implement",
            dependsOn: ["audit"],
          },
        ],
      },
    });

    const approved = await inject({ method: "POST", url: `/api/runs/${run.id}/approve` });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as {
      run: { state: string; placementId: string };
      steps: { stepKey: string; state: string; sessionId: string }[];
    };
    expect(body.run.state).toBe("running");

    const audit = body.steps.find((step) => step.stepKey === "audit")!;
    // No node is connected, so the command cannot be delivered and the step
    // goes back in the queue rather than being blamed for it.
    expect(["starting", "pending"]).toContain(audit.state);
    // The dependent step must not have moved either way.
    expect(body.steps.find((step) => step.stepKey === "fix")?.state).toBe("pending");
  });

  it("cancels a run once and stays cancelled", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: { steps: [{ stepKey: "audit", title: "Audit", prompt: "audit" }] },
    });
    const cancelled = await inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    const body = cancelled.json() as {
      run: { state: string };
      steps: { state: string }[];
    };
    expect(body.run.state).toBe("cancelled");
    expect(body.steps[0]?.state).toBe("cancelled");

    const again = await inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { run: { state: string } }).run.state).toBe("cancelled");
  });

  it("will not plan a run that was already approved", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({ method: "POST", url: `/api/runs/${run.id}/approve` });
    const response = await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: { steps: [{ stepKey: "late", title: "Late", prompt: "late" }] },
    });
    expect(response.statusCode).toBe(409);
  });

  it("deletes a run and forgets its steps", async () => {
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: { steps: [{ stepKey: "audit", title: "Audit", prompt: "audit" }] },
    });
    const removed = await inject({ method: "DELETE", url: `/api/runs/${run.id}` });
    expect(removed.statusCode).toBe(204);
    const missing = await inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it("archives a task: the record stays, the sessions go", async () => {
    /*
     * The two halves people expect from different words. Deleting would take
     * what the task learned with it; cancelling alone leaves its workers in the
     * tree with nothing to do. Archiving ends the work and clears the machinery
     * while keeping the account of it.
     */
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: { steps: [{ stepKey: "audit", title: "Audit", prompt: "audit" }] },
    });

    const archived = await inject({ method: "POST", url: `/api/runs/${run.id}/archive` });
    expect(archived.statusCode).toBe(200);

    const after = await inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(after.statusCode).toBe(200);
    const body = after.json() as { run: { state: string }; steps: unknown[] };
    expect(body.run.state).toBe("cancelled");
    // The plan is the record; losing it would make archiving a delete.
    expect(body.steps).toHaveLength(1);

    const snapshot = (await inject({ method: "GET", url: "/api/snapshot" })).json() as {
      sessions: { runId: string }[];
    };
    expect(snapshot.sessions.filter((session) => session.runId === run.id)).toHaveLength(
      0,
    );
  });

  it("archives an already finished task, which is when it matters most", async () => {
    // A completed task's workers are exactly the ones sitting idle in the tree.
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);

    const first = await inject({ method: "POST", url: `/api/runs/${run.id}/archive` });
    expect(first.statusCode).toBe(200);

    // And again, because a person may archive what is already archived.
    const again = await inject({ method: "POST", url: `/api/runs/${run.id}/archive` });
    expect(again.statusCode).toBe(200);
  });

  it("does not relabel a task that already ended on its own", async () => {
    /*
     * Archiving is about clearing the machinery away, not about the verdict. A
     * task that finished stays finished — calling it cancelled because someone
     * tidied up afterwards would rewrite what happened.
     */
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);
    await inject({
      method: "POST",
      url: `/api/runs/${run.id}/plan`,
      payload: { steps: [{ stepKey: "audit", title: "Audit", prompt: "audit" }] },
    });
    await inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });

    await inject({ method: "POST", url: `/api/runs/${run.id}/archive` });

    const after = (
      await inject({ method: "GET", url: `/api/runs/${run.id}` })
    ).json() as {
      run: { state: string; failureReason: string };
    };
    expect(after.run.state).toBe("cancelled");
    // The reason it ended is the earlier one, not "archived".
    expect(after.run.failureReason).toContain("Cancelled by an operator");
  });

  it("refuses to archive a task that does not exist", async () => {
    const missing = await inject({ method: "POST", url: "/api/runs/nope/archive" });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a review of a task nobody handed over", async () => {
    // The person is asked once, at the end. Answering a task that is still
    // being worked on would be a decision nobody was waiting for.
    const { workspaceId } = await workspaceWithPlacement();
    const run = await createRun(workspaceId);

    const response = await inject({
      method: "POST",
      url: `/api/runs/${run.id}/review`,
      payload: { approved: true },
    });

    expect(response.statusCode).toBe(409);
  });
});
