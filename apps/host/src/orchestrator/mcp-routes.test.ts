import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FleetSession } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
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
