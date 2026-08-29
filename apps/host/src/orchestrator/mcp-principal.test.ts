import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FleetSession, Run } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { SecurityAuditInput } from "../store.js";
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
    nodeId: "node-1",
    ...over,
  }) as FleetSession;

const lead = { sessionId: "lead-1", runId: "run-1", nodeId: "node-1" };

const run = (over: Partial<Run> = {}) =>
  ({ id: "run-1", state: "running", ...over }) as Run;

/**
 * `/mcp` as a principal rather than an exception.
 *
 * The endpoint is reachable through whatever tunnel the Host is published on,
 * because a Node agent has to dial it, so what stands between the internet and
 * a fleet-wide command runner is entirely this: a signed claim set that still
 * describes a live lead. These assert each half of that separately, because a
 * check that only holds while the others do is a check that can be removed
 * without a test noticing.
 */
describe("mcp lead principal", () => {
  const store = settings();
  let sessions: Map<string, FleetSession>;
  let runs: Map<string, Run>;
  let audited: SecurityAuditInput[];
  let app: FastifyInstance;

  const boot = async () => {
    if (app) await app.close();
    app = Fastify();
    app.log.level = "silent";
    const service = {
      store: {
        getSession: (id: string) => sessions.get(id),
        getRun: (id: string) => runs.get(id),
      },
    } as unknown as FleetService;
    await app.register(mcpRoutes, {
      service,
      tokens: new LeadTokens(store),
      audit: (entry: SecurityAuditInput) => void audited.push(entry),
    });
    await app.ready();
  };

  const call = (token: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

  beforeEach(async () => {
    sessions = new Map([["lead-1", session()]]);
    runs = new Map([["run-1", run()]]);
    audited = [];
    await boot();
  });

  afterEach(async () => {
    await app.close();
  });

  it("admits a claim set that still describes the live lead", async () => {
    const token = new LeadTokens(store).mint(lead);

    expect((await call(token)).statusCode).toBe(200);
    expect(audited).toEqual([]);
  });

  it("keeps admitting it across a Host restart", async () => {
    // The signing key is persisted, so a restart is not a revocation. This is
    // the behaviour the claims must not cost: a lead its Node keeps alive is
    // never resumed and is never handed a replacement token.
    const token = new LeadTokens(store).mint(lead);

    await boot();

    expect((await call(token)).statusCode).toBe(200);
  });

  it("refuses a token whose run has moved on since it was minted", async () => {
    // The token said which run it was acting for. A session reassigned to
    // another run is not that authorisation any more.
    const token = new LeadTokens(store).mint(lead);
    sessions.set("lead-1", session({ runId: "run-2" }));

    expect((await call(token)).statusCode).toBe(401);
    expect(audited[0]).toMatchObject({ outcome: "denied" });
  });

  it("refuses a token whose node is no longer the one it named", async () => {
    // What a deleted Node leaves behind: the session is re-placed or emptied,
    // and a token minted against the old machine stops authorising anything.
    const token = new LeadTokens(store).mint(lead);
    sessions.set("lead-1", session({ nodeId: "" }));

    expect((await call(token)).statusCode).toBe(401);
  });

  it.each([
    ["stopped", "stopped"],
    ["completed", "completed"],
    ["failed", "failed"],
  ])("refuses a token once its lead is %s", async (_label, state) => {
    // Revocation is the state of the session: cancelling a run or stopping a
    // lead takes its tools away on the very next call.
    const token = new LeadTokens(store).mint(lead);
    sessions.set("lead-1", session({ state: state as FleetSession["state"] }));

    expect((await call(token)).statusCode).toBe(401);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["completed", "completed"],
    ["failed", "failed"],
  ])("refuses a token once its run is %s", async (_label, state) => {
    // Cancelling a task sends a stop to the machine and waits for it to be
    // confirmed. Reading the run rather than only the session is what closes
    // that window: an orchestrator whose task an operator has just cancelled
    // must not get one more turn of tools out of the delay.
    const token = new LeadTokens(store).mint(lead);
    runs.set("run-1", run({ state: state as Run["state"] }));

    expect((await call(token)).statusCode).toBe(401);
  });

  it("refuses a token for a session that is no longer a lead", async () => {
    const token = new LeadTokens(store).mint(lead);
    sessions.set("lead-1", session({ runRole: "worker" }));

    expect((await call(token)).statusCode).toBe(401);
  });

  it("refuses a request that carries a browser origin", async () => {
    // A browser must never be able to reach this at all, however good the
    // token is: `/mcp` is a machine principal, and an `Origin` header is the
    // one thing only a browser sends.
    const token = new LeadTokens(store).mint(lead);

    const refused = await call(token, { origin: "http://localhost:8787" });

    expect(refused.statusCode).toBe(403);
    expect(audited[0]).toMatchObject({ outcome: "denied" });
  });

  it("never authorises on an operator cookie", async () => {
    // Operator authority and orchestration authority are different principals.
    // A signed-in administrator's browser holding a live session cookie gets
    // nothing here without a lead token.
    const refused = await call("", { cookie: "fleet_operator=a-real-looking-session" });

    expect(refused.statusCode).toBe(401);
  });

  it("rejects an unauthenticated request before parsing its JSON body", async () => {
    const refused = await app.inject({
      method: "POST",
      url: MCP_PATH,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: "{",
    });

    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({
      error: "This token does not belong to a live orchestrator",
    });
  });

  it("audits a refusal without ever recording the bearer value", async () => {
    const token = new LeadTokens(store).mint(lead);
    sessions.delete("lead-1");

    await call(token);

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      eventType: "mcp_lead_token_rejected",
      actorKind: "lead",
      outcome: "denied",
    });
    // The whole entry, because a reason field is not the only way a token
    // ends up in a log an administrator can read.
    expect(JSON.stringify(audited[0])).not.toContain(token);
    expect((audited[0]?.detail ?? "").length).toBeLessThanOrEqual(120);
  });

  it("says nothing about which half of the check failed", async () => {
    // Telling a caller that the signature was fine but the session was not is
    // telling it which guesses are warm.
    const token = new LeadTokens(store).mint(lead);
    sessions.set("lead-1", session({ runId: "run-2" }));

    const mismatch = await call(token);
    const forged = await call("flt_bogus.bogus");

    expect(mismatch.body).toBe(forged.body);
  });
});
