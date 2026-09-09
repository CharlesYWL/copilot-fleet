import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { DriInvestigation, DriPage, DriRecord } from "@fleet/protocol";
import { buildServer } from "../../../src/server.js";
import { fixtureProviders } from "../../../src/dri/fixtures.js";
import { useDri } from "./useDri";
import { forgetCsrfToken } from "../lib/auth";

describe("DRI hook with real authenticated Host routes and SQLite writes", () => {
  let app: FastifyInstance;
  let id = "",
    cookie = "",
    csrf = "";
  let releaseProvider!: () => void;
  let releasePage!: () => void;
  let delayedPage: Promise<void> | undefined;
  let advancingHeads = false;
  const calls: { url: string; status: number }[] = [];
  const request = (input: InjectOptions) =>
    app.inject({
      ...input,
      headers: { cookie, "x-csrf-token": csrf, ...input.headers },
    });
  const head = async () =>
    (await request({ url: `/api/dri/${id}` })).json<{ investigation: DriInvestigation }>()
      .investigation;
  const advance = async () => {
    const current = await head();
    const reply = await request({
      method: "PATCH",
      url: `/api/dri/${id}/retention`,
      headers: { "if-match": `"${current.revision}"` },
      payload: { legalHold: !current.legalHold },
    });
    expect(reply.statusCode).toBe(200);
  };
  beforeEach(async () => {
    calls.length = 0;
    advancingHeads = false;
    delayedPage = undefined;
    let firstHeadAdvanced!: () => void;
    const advanced = new Promise<void>((resolve) => {
      firstHeadAdvanced = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    releasePage = () => {};
    const providers = fixtureProviders({
      delay: async (context) => {
        if (context.query.capability === "telemetry.query") await gate;
      },
    }).map((provider) => ({
      ...provider,
      async read(context: Parameters<typeof provider.read>[0]) {
        const page = await provider.read(context);
        if (context.query.capability === "har.analyze") {
          page.evidence = Array.from({ length: 40 }, (_, index) => ({
            ...page.evidence[1]!,
            finding: `Synthetic bounded request ${index}: upstream unavailable`,
          }));
        }
        return page;
      },
    }));
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "synthetic-hook-token",
      operatorPassword: "synthetic-hook-password",
      useBuiltInEntra: false,
      announceClaimCode: () => {},
      dri: { allowFixtures: true, fixtures: providers },
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "synthetic-hook-password" },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    csrf = (await request({ url: "/api/auth/csrf" })).json<{ csrfToken: string }>()
      .csrfToken;
    const created = await request({
      method: "POST",
      url: "/api/dri",
      payload: { icm: "42", mode: "fixture" },
    });
    expect(created.statusCode).toBe(201);
    id = created.json<DriInvestigation>().id;
    await vi.waitFor(async () => {
      const page = (await request({ url: `/api/dri/${id}/evidence` })).json<
        DriPage<DriRecord>
      >();
      expect(page.items.length).toBe(25);
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const isHead = url === `/api/dri/${id}`;
      if (!isHead && /\/(evidence|queries)\?/.test(url)) await advanced;
      if (delayedPage && /\/(evidence|queries)\?/.test(url)) await delayedPage;
      const reply = await request({ method: (init?.method ?? "GET") as "GET", url });
      if (isHead) {
        if (advancingHeads) await advance();
        firstHeadAdvanced();
      }
      calls.push({ url, status: reply.statusCode });
      return new Response(reply.statusCode === 204 ? null : reply.body, {
        status: reply.statusCode,
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(async () => {
    releasePage();
    releaseProvider();
    await app.close();
    forgetCsrfToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each(["evidence", "queries"] as const)(
    "keeps %s visible when the head advances before collection hydration",
    async (collection) => {
      advancingHeads = true;
      const hook = renderHook(() => useDri(id, collection));
      await waitFor(() =>
        expect(hook.result.current.page?.items.length).toBeGreaterThan(0),
      );
      expect(hook.result.current.error).toBe("");
      expect(hook.result.current.page!.revision).toBeGreaterThan(
        hook.result.current.detail!.investigation.revision,
      );
      expect(
        calls
          .filter((call) => call.url.includes(`/${collection}?`))
          .every((call) => !call.url.includes("revision=") && call.status === 200),
      ).toBe(true);
      hook.unmount();
    },
  );
  it("restarts a real 412 continuation once, replacing rather than duplicating rows", async () => {
    const hook = renderHook(() => useDri(id, "evidence"));
    await waitFor(() =>
      expect(hook.result.current.page?.nextCursor).toBeTypeOf("number"),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const before = hook.result.current.page!;
    expect(before.items.length).toBe(25);
    await advance();
    act(() => hook.result.current.next());
    await waitFor(() => expect(calls.some((call) => call.status === 412)).toBe(true));
    await waitFor(() =>
      expect(hook.result.current.page!.revision).toBeGreaterThan(before.revision),
    );
    expect(hook.result.current.atStart).toBe(true);
    expect(hook.result.current.error).toBe("");
    const rows = hook.result.current.page!.items;
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(
      calls.filter((call) => call.url.includes("/evidence?")).map((call) => call.status),
    ).toEqual([200, 412, 200]);
    hook.unmount();
  });
  it("coalesces continuous change hints without aborting hydration or blanking visible rows", async () => {
    const hook = renderHook(() => useDri(id, "evidence"));
    await waitFor(() => expect(hook.result.current.page?.items.length).toBe(25));
    delayedPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    for (let index = 0; index < 20; index++) {
      await advance();
      act(() =>
        window.dispatchEvent(
          new CustomEvent("fleet:dri-changed", {
            detail: { investigationId: id, revision: 1000 + index },
          }),
        ),
      );
      expect(hook.result.current.page?.items.length).toBe(25);
    }
    delayedPage = undefined;
    await act(async () => {
      releasePage();
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.page?.items.length).toBe(25);
    expect(
      calls.filter((call) => call.url.includes("/evidence?")).length,
    ).toBeLessThanOrEqual(3);
    hook.unmount();
  });
});
