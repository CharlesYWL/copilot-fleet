import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FleetSession } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { FleetStore } from "../store.js";
import { fleet } from "./fleet-harness.js";
import { LeadTokens } from "./lead-tokens.js";
import { MCP_PATH, mcpRoutes } from "./mcp-routes.js";

const settings = () => {
  const values = new Map<string, string>();
  return {
    getSetting: (key: string) => values.get(key),
    setSetting: (key: string, value: string) => void values.set(key, value),
  };
};

const session = (over: Partial<FleetSession> = {}) =>
  ({
    id: "lead-1",
    state: "idle",
    runRole: "lead",
    runId: "run-1",
    ...over,
  }) as FleetSession;

/** The parts of an advertised JSON Schema property these tests care about. */
type JsonSchemaField = { maxLength?: number; minLength?: number; description?: string };

describe("mcp endpoint", () => {
  const store = settings();
  let sessions: Map<string, FleetSession>;
  let app: FastifyInstance;

  /** Stands the endpoint up again over the same settings, as a restart does. */
  const boot = async () => {
    if (app) await app.close();
    app = Fastify();
    app.log.level = "silent";
    const service = {
      store: { getSession: (id: string) => sessions.get(id) },
    } as unknown as FleetService;
    await app.register(mcpRoutes, { service, tokens: new LeadTokens(store) });
    await app.ready();
  };

  const list = (token: string) =>
    app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        // Both, because the transport offers either and refuses a caller that
        // will not take the streaming one.
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

  beforeEach(async () => {
    sessions = new Map([["lead-1", session()]]);
    await boot();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the fleet tools to a live orchestrator", async () => {
    const token = new LeadTokens(store).mint("lead-1");

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    const names = (
      response.json() as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    expect(names).toContain("fleet_start_work");
  });

  it("still lists them to an orchestrator that outlived a Host restart", async () => {
    // The reported symptom: an orchestrator its Node keeps alive never settles,
    // so nothing resumes it and nothing hands it a replacement token. It kept
    // asking with the one it had, and a Host that only remembered tokens in
    // memory answered 401 to every call — once per file save, under watch mode.
    const token = new LeadTokens(store).mint("lead-1");

    await boot();

    expect((await list(token)).statusCode).toBe(200);
  });

  it("refuses a token once its orchestrator has been stopped", async () => {
    // Revocation is now the state of the session rather than a list of tokens.
    const token = new LeadTokens(store).mint("lead-1");
    sessions.set("lead-1", session({ state: "stopped" }));

    expect((await list(token)).statusCode).toBe(401);
  });

  it("refuses a token for a session that is no longer an orchestrator", async () => {
    const token = new LeadTokens(store).mint("lead-1");
    sessions.set("lead-1", session({ runRole: "worker" }));

    expect((await list(token)).statusCode).toBe(401);
  });

  it("refuses a token for a session the Host has never heard of", async () => {
    const token = new LeadTokens(store).mint("ghost");

    expect((await list(token)).statusCode).toBe(401);
  });

  it.each([
    ["forged", "flt_bogus.bogus"],
    ["missing", ""],
  ])("refuses a %s token", async (_label, token) => {
    expect((await list(token)).statusCode).toBe(401);
  });
});

/*
 * The unit tests call the tools directly with an already-parsed object, so they
 * cannot catch a tool whose advertised schema and whose handler disagree — a
 * model would follow the advertisement and be rejected by the parse. These go
 * over the wire instead: what a caller is told, and what happens when it obeys.
 */
describe("orchestrator tools over the wire", () => {
  let app: FastifyInstance;
  let store: FleetStore;
  let token: string;

  const rpc = async (method: string, params?: unknown) => {
    const response = await app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    return response.json() as {
      result?: {
        tools?: {
          name: string;
          inputSchema: { properties?: Record<string, JsonSchemaField> };
        }[];
        content?: { text: string }[];
        isError?: boolean;
      };
      error?: { message: string };
    };
  };

  const call = async (name: string, args: unknown) => {
    const out = await rpc("tools/call", { name, arguments: args });
    return {
      // A schema rejection comes back as a JSON-RPC error rather than a tool
      // result, so both count as "the caller did not get away with it".
      refused: Boolean(out.error) || Boolean(out.result?.isError),
      text:
        out.error?.message ?? (out.result?.content ?? []).map((c) => c.text).join("\n"),
    };
  };

  const criteria = [
    {
      id: "logout-invalidates",
      scenario: "reusing a token after logout returns 401",
      expectedEvidence: "the auth suite's logout test passes",
    },
  ];

  beforeEach(async () => {
    const world = fleet();
    store = world.store;
    app = Fastify();
    app.log.level = "silent";
    const tokens = new LeadTokens(settings());
    token = tokens.mint(world.leadId);
    await app.register(mcpRoutes, { service: world.service, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const task = () => store.listRuns().find((run) => run.name === "Ship it");

  const plan = (over: Record<string, unknown> = {}) =>
    call("fleet_plan_task", {
      task: "Ship it",
      objective: "make the change",
      phases: ["Only"],
      successCriteria: criteria,
      stopWhen: "the auth suite is green",
      ...over,
    });

  it("tells a caller that planning needs a definition of done", async () => {
    const listed = await rpc("tools/list");
    const planTool = listed.result!.tools!.find((t) => t.name === "fleet_plan_task")!;

    expect(Object.keys(planTool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["successCriteria", "stopWhen"]),
    );
  });

  it("refuses to open a task with no criteria at all", async () => {
    const result = await plan({ successCriteria: [] });

    expect(result.refused).toBe(true);
    expect(task()).toBeUndefined();
  });

  it("refuses a criterion too vague to check", async () => {
    // "auth works" is the failure this whole mechanism exists to prevent, so
    // the schema rejects it rather than trusting the model to be specific.
    const result = await plan({
      successCriteria: [{ id: "x", scenario: "works", expectedEvidence: "it does" }],
    });

    expect(result.refused).toBe(true);
    expect(task()).toBeUndefined();
  });

  it("keeps the definition of done a caller sent over the wire", async () => {
    const result = await plan();

    expect(result.refused).toBe(false);
    expect(task()!.successCriteria[0]!.id).toBe("logout-invalidates");
    expect(task()!.stopWhen).toBe("the auth suite is green");
    // The reply repeats the contract, because the turn that plans a task is
    // usually not the turn that has to satisfy it.
    expect(result.text).toContain("logout-invalidates");
  });

  const settleWork = async () => {
    await call("fleet_start_work", {
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: "Ship it",
    });
    for (const step of store.listRunSteps(task()!.id)) {
      store.updateRunStep(step.id, { state: "succeeded" });
    }
  };

  it("will not spend a machine on work with no way to check it", async () => {
    // The cheapest moment to catch an uncheckable brief is before a session
    // starts, not after a worker has confidently reported success.
    await plan();
    const result = await call("fleet_start_work", {
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      task: "Ship it",
    });

    expect(result.refused).toBe(true);
    expect(store.listRunSteps(task()!.id)).toHaveLength(0);
  });

  it("composes the worker's brief from a dispatch that came over the wire", async () => {
    await plan();
    await settleWork();

    const step = store.listRunSteps(task()!.id)[0]!;
    expect(step.prompt).toContain("DELIVERABLE");
    expect(step.prompt).toContain("a list of what is in there");
    expect(step.prompt).not.toContain("undefined");
  });

  it("will not hand over a task whose criteria were not met", async () => {
    await plan();
    await settleWork();

    const result = await call("fleet_submit_task", {
      task: "Ship it",
      summary: "Here it is.",
      criteria: [
        { id: "logout-invalidates", outcome: "unmet", evidence: "the test still fails" },
      ],
    });

    expect(result.refused).toBe(true);
    expect(task()!.state).not.toBe("awaiting_human");
  });

  it("hands over a task once its criteria are met", async () => {
    await plan();
    await settleWork();

    const result = await call("fleet_submit_task", {
      task: "Ship it",
      summary: "Here it is.",
      criteria: [
        {
          id: "logout-invalidates",
          outcome: "met",
          evidence: "ran the auth suite; the logout test passed",
        },
      ],
    });

    expect(result.refused).toBe(false);
    expect(task()!.state).toBe("awaiting_human");
  });

  it.each(["fleet_close_task", "fleet_reopen_task", "fleet_discard_task"])(
    "offers %s, so a task has an ending other than done",
    async (name) => {
      const listed = await rpc("tools/list");
      const tool = listed.result!.tools!.find((entry) => entry.name === name)!;

      expect(tool).toBeTruthy();
      // Every one of them writes to the record, so every one asks why.
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["task", "reason"]),
      );
    },
  );

  it("closes a task over the wire, stopping its workers and keeping its record", async () => {
    await plan();
    await call("fleet_start_work", {
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: "Ship it",
    });

    const result = await call("fleet_close_task", {
      task: "Ship it",
      reason: "The person withdrew this; the feature is being cut instead.",
    });

    expect(result.refused).toBe(false);
    expect(task()!.state).toBe("cancelled");
    expect(store.listRunSteps(task()!.id)).toHaveLength(1);
    expect(store.listSessions().some((s) => s.runId === task()!.id)).toBe(false);
  });

  it("refuses a closing with no reason, before anything is stopped", async () => {
    // The schema, not the handler: a caller that obeys the advertisement must
    // not be able to end a task and leave the record saying nothing.
    await plan();

    const result = await call("fleet_close_task", { task: "Ship it" });

    expect(result.refused).toBe(true);
    expect(task()!.state).not.toBe("cancelled");
  });

  it("reopens a task it had already handed over", async () => {
    await plan();
    await settleWork();
    await call("fleet_submit_task", {
      task: "Ship it",
      summary: "Here it is.",
      criteria: [
        {
          id: "logout-invalidates",
          outcome: "met",
          evidence: "ran the auth suite; the logout test passed",
        },
      ],
    });
    expect(task()!.state).toBe("awaiting_human");

    const result = await call("fleet_reopen_task", {
      task: "Ship it",
      reason: "The reviewer found the same bug in the other tab, so this is not done.",
    });

    expect(result.refused).toBe(false);
    expect(task()!.state).toBe("running");
    expect(task()!.successCriteria).toHaveLength(1);
  });

  it("discards a task that never dispatched anything", async () => {
    await plan();
    const id = task()!.id;

    const result = await call("fleet_discard_task", {
      task: "Ship it",
      reason: "Opened this twice by mistake; the other one is identical.",
    });

    expect(result.refused).toBe(false);
    expect(store.getRun(id)).toBeUndefined();
  });
});

/*
 * The limits used to be invisible. Every constraint lived on the handler's
 * schema and every description lived on the advertised one, so a caller was
 * told what `context` was for, told to repeat everything decided elsewhere in
 * it, and not told there was a ceiling — until a dispatch it believed it had
 * made came back rejected by a number it had never seen.
 *
 * The ceilings are gone now rather than merely visible, because refusing a
 * brief for saying too much costs more than the long brief did. What is left is
 * an asymmetry these pin down: the minimums still refuse a brief with no way to
 * check it, and nothing refuses one for length.
 */
describe("the limits a caller is held to", () => {
  let app: FastifyInstance;
  let store: FleetStore;
  let token: string;

  beforeEach(async () => {
    const world = fleet();
    store = world.store;
    app = Fastify();
    app.log.level = "silent";
    const tokens = new LeadTokens(settings());
    token = tokens.mint(world.leadId);
    await app.register(mcpRoutes, { service: world.service, tokens });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const rpc = async (method: string, params?: unknown) => {
    const response = await app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    return response.json() as {
      result?: {
        tools?: {
          name: string;
          inputSchema: { properties?: Record<string, JsonSchemaField> };
        }[];
        content?: { text: string }[];
        isError?: boolean;
      };
      error?: { message: string };
    };
  };

  const advertised = async (tool: string) => {
    const listed = await rpc("tools/list");
    return listed.result!.tools!.find((t) => t.name === tool)!.inputSchema.properties!;
  };

  const dispatch = async (over: Record<string, unknown>) => {
    await rpc("tools/call", {
      name: "fleet_plan_task",
      arguments: {
        task: "Ship it",
        objective: "make the change",
        phases: ["Only"],
        successCriteria: [
          {
            id: "logout-invalidates",
            scenario: "reusing a token after logout returns 401",
            expectedEvidence: "the auth suite's logout test passes",
          },
        ],
        stopWhen: "the auth suite is green",
      },
    });
    const out = await rpc("tools/call", {
      name: "fleet_start_work",
      arguments: {
        category: "explore",
        title: "look",
        deliverable: "a list of what is in there",
        scope: "the whole checkout, read-only",
        verify: "list the directory and say what you saw",
        task: "Ship it",
        ...over,
      },
    });
    return {
      refused: Boolean(out.error) || Boolean(out.result?.isError),
      text:
        out.error?.message ?? (out.result?.content ?? []).map((c) => c.text).join("\n"),
    };
  };

  const started = () =>
    store.listRuns().flatMap((run) => store.listRunSteps(run.id)).length;

  it("puts no ceiling on the fields that carry the brief", async () => {
    const properties = await advertised("fleet_start_work");

    for (const field of ["deliverable", "scope", "verify", "context"]) {
      expect(properties[field]?.maxLength).toBeUndefined();
    }
  });

  it("still says what each of those fields must at least contain", async () => {
    // Dropping the ceilings is not the same as dropping the contract. The floor
    // is the half that does the work: it is what refuses a brief nobody could
    // check, before a machine is spent on it.
    const properties = await advertised("fleet_start_work");

    for (const field of ["deliverable", "scope", "verify"]) {
      expect(properties[field]?.minLength).toBeGreaterThan(0);
    }
  });

  it("dispatches a context far past the ceiling it used to have", async () => {
    // 6000 was the reported failure and 12000 replaced it; neither is a limit
    // now, so the number here is chosen to be well clear of both.
    const result = await dispatch({ context: "x".repeat(200_000) });

    expect(result.refused).toBe(false);
    expect(started()).toBe(1);
  });

  it("gives the worker the whole context, rather than a clipped one", async () => {
    // Accepting a long brief and quietly truncating it would be the same bug
    // wearing a friendlier face: the worker would never learn what it was not
    // told, and would have no way to notice.
    const context = `decided offline: ${"y".repeat(80_000)} ...and finally, use the v2 client.`;

    await dispatch({ context });

    const step = store.listRunSteps(store.listRuns()[0]!.id)[0]!;
    expect(step.prompt).toContain(context);
    expect(step.prompt).not.toContain("elided");
  });

  it("carries a brief larger than the transport used to allow", async () => {
    // Fastify defaults to a 1 MB body, and hitting it is the worst refusal
    // available: a bare 413 that never reaches the MCP layer, so the caller is
    // told nothing about which tool failed or that its worker never started.
    const result = await dispatch({ context: "x".repeat(2_000_000) });

    expect(result.refused).toBe(false);
    expect(started()).toBe(1);
  });

  it("keeps the floors that the other tools depend on", async () => {
    const properties = await advertised("fleet_plan_task");

    expect(properties.stopWhen?.minLength).toBeGreaterThan(0);
    expect(properties.objective?.minLength).toBeGreaterThan(0);
    expect(properties.objective?.maxLength).toBeUndefined();
  });
});
