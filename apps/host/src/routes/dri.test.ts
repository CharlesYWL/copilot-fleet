import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DriInvestigation,
  DriPage,
  DriQuery,
  DriRecord,
  DriReport,
} from "@fleet/protocol";
import { buildServer } from "../server.js";

describe("authenticated DRI Host integration", () => {
  let app: FastifyInstance;
  let cookie = "",
    csrfToken = "";
  const request = (options: InjectOptions) =>
    app.inject({
      ...options,
      headers: { cookie, "x-csrf-token": csrfToken, ...options.headers },
    });
  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      operatorPassword: "synthetic-dri-test-password",
      dri: { allowFixtures: true },
      announceClaimCode: () => {},
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "synthetic-dri-test-password" },
    });
    cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
    csrfToken = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json<{
      csrfToken: string;
    }>().csrfToken;
  });
  afterEach(async () => {
    await app.close();
  });

  const create = async (mode = "fixture") => {
    const response = await request({
      method: "POST",
      url: "/api/dri",
      payload: { icm: "42", mode },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<DriInvestigation>();
  };
  const settled = async (id: string) => {
    let investigation!: DriInvestigation;
    await vi.waitFor(async () => {
      const response = await request({ url: `/api/dri/${id}` });
      expect(response.statusCode).toBe(200);
      investigation = response.json<{ investigation: DriInvestigation }>().investigation;
      expect(
        ["awaiting_review", "partial", "blocked", "failed"].includes(
          investigation.status,
        ),
      ).toBe(true);
    });
    return investigation;
  };
  it("requires administrator authentication, CSRF and a revision for mutations", async () => {
    expect((await app.inject({ url: "/api/dri" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/dri",
          headers: { cookie },
          payload: { icm: "42" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request({
          method: "POST",
          url: "/api/dri",
          payload: { icm: "https://untrusted.invalid/42" },
        })
      ).statusCode,
    ).toBe(400);
    const investigation = await create();
    expect(
      (await request({ method: "POST", url: `/api/dri/${investigation.id}/stop` }))
        .statusCode,
    ).toBe(428);
    expect(
      (
        await request({
          method: "POST",
          url: `/api/dri/${investigation.id}/stop`,
          headers: { "if-match": '"0"' },
        })
      ).statusCode,
    ).toBe(412);
  });
  it("runs the paginated fixture, serves sanitized pages/reports and uses Run review", async () => {
    const created = await create();
    const investigation = await settled(created.id);
    expect(investigation.status).toBe("awaiting_review");
    expect(investigation.profile.profileId).toBe("dms");
    const page = (await request({ url: `/api/dri/${created.id}/evidence?limit=2` })).json<
      DriPage<DriRecord>
    >();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const next = (
      await request({
        url: `/api/dri/${created.id}/evidence?limit=2&cursor=${page.nextCursor}&revision=${page.revision}&generation=${page.generation}`,
      })
    ).json<DriPage<DriRecord>>();
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    const queries = (await request({ url: `/api/dri/${created.id}/queries` })).json<
      DriPage<DriQuery>
    >();
    expect(
      queries.items.find((query) => query.capability === "telemetry.query")!.state,
    ).toBe("succeeded");
    const reports = (await request({ url: `/api/dri/${created.id}/reports` })).json<
      DriPage<DriReport>
    >();
    const rendered = await request({
      url: `/api/dri/${created.id}/reports/${reports.items[0]!.id}`,
    });
    expect(rendered.json<{ markdown: string }>().markdown).toContain(
      "Root-cause assessment",
    );
    const evidenceId = reports.items[0]!.evidenceIds[0]!;
    expect(
      (await request({ url: `/api/dri/${created.id}/evidence/${evidenceId}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await request({ url: `/api/dri/by-run/${created.runId}` })
      ).json<DriInvestigation>().id,
    ).toBe(created.id);
    const snapshot = await request({ url: "/api/snapshot" });
    expect(snapshot.body).not.toContain("synthetic-only");
    expect(snapshot.body).not.toContain("causalChain");
    expect(
      (
        await request({
          method: "POST",
          url: `/api/runs/${created.runId}/plan`,
          payload: { steps: [] },
        })
      ).statusCode,
    ).toBe(409);
    const completed = await request({
      method: "POST",
      url: `/api/dri/${created.id}/complete`,
      headers: { "if-match": `"${investigation.revision}"` },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<DriInvestigation>().status).toBe("completed");
  });
  it("leaves unconfigured live providers blocked without any incident mutation", async () => {
    const created = await create("live");
    const investigation = await settled(created.id);
    expect(investigation.status).toBe("blocked");
    const queries = (await request({ url: `/api/dri/${created.id}/queries` })).json<
      DriPage<DriQuery>
    >();
    expect(queries.items).toEqual([]);
    expect(
      (
        await request({
          method: "POST",
          url: `/api/dri/${created.id}/fixture/execute`,
          headers: { "if-match": `"${investigation.revision}"` },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("corrects profiles and couples ordinary Run archive to DRI stop", async () => {
    const created = await create();
    const investigation = await settled(created.id);
    const correction = await request({
      method: "PATCH",
      url: `/api/dri/${created.id}/profile`,
      headers: { "if-match": `"${investigation.revision}"` },
      payload: { profile: "generic" },
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json<DriInvestigation>().profile.method).toBe("correction");
    expect(correction.json<DriInvestigation>().status).toBe("stopped");
    const resumed = await request({
      method: "POST",
      url: `/api/dri/${created.id}/resume`,
      headers: { "if-match": `"${correction.json<DriInvestigation>().revision}"` },
    });
    expect(resumed.statusCode).toBe(200);
    await settled(created.id);
    await request({ method: "POST", url: `/api/runs/${created.runId}/archive` });
    expect(
      (await request({ url: `/api/dri/${created.id}` })).json<{
        investigation: DriInvestigation;
      }>().investigation.status,
    ).toBe("stopped");
  });
});
