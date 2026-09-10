import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DriAvailability,
  DriCapability,
  DriInvestigation,
  DriProviderDefinition,
} from "@fleet/protocol";
import { FleetService } from "../fleet-service.js";
import { FleetStore } from "../store.js";
import { driRoutes } from "../routes/dri.js";
import { DriCoordinator, type DriCoordinatorOptions } from "./coordinator.js";
import { fixtureProviders, type FixtureOptions } from "./fixtures.js";
import type { DriProviderDiscovery } from "./mcp.js";
import type { InvestigationProvider, ProviderContext } from "./providers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(options: DriCoordinatorOptions) {
  const app = Fastify({ logger: false });
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, app.log);
  const coordinator = new DriCoordinator(service, options);
  cleanups.push(async () => {
    await coordinator.shutdown();
    service.shutdown();
    store.close();
    await app.close();
  });
  const create = (icm: string) => coordinator.create({ icm, mode: "live" });
  return { app, coordinator, store, service, create };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function readers(version: string, options: FixtureOptions = {}) {
  const calls: ProviderContext[] = [];
  const providers: InvestigationProvider[] = fixtureProviders()
    .map((provider) => ({
      definition: {
        ...provider.definition,
        version,
        id: `test.${provider.definition.capabilities[0]}`,
      },
      async read(context: ProviderContext) {
        calls.push(context);
        await options.delay?.(context);
        return provider.read(context);
      },
    }))
    .filter(
      (provider) => !options.unavailable?.includes(provider.definition.capabilities[0]!),
    );
  return { calls, providers };
}

const versions = (coordinator: DriCoordinator, investigation: DriInvestigation) =>
  coordinator
    .registry(investigation)
    .list()
    .map((provider) => provider.version);
const failures: DriProviderDiscovery = {
  providers: [],
  issues: {
    "incident.read": { state: "access_denied", reason: "A-only incident access failure" },
    "har.analyze": { state: "access_denied", reason: "A-only HAR access failure" },
  },
};
type Head = {
  investigation: DriInvestigation;
  providers: DriProviderDefinition[];
  availability: DriAvailability;
};

describe("investigation-scoped provider discovery", () => {
  it.each([
    ["incident.read", "empty"],
    ["incident.read", "throw"],
    ["incident.read", "invalid"],
    ["telemetry.query", "empty"],
    ["telemetry.query", "throw"],
    ["telemetry.query", "invalid"],
  ] as const)(
    "keeps B's %s reader and readiness when A discovery is %s",
    async (capability, failure) => {
      const entered = gate(),
        resume = gate();
      let held = false;
      const b = readers("B.1", {
        delay: async (context) => {
          if (!held && context.query.capability === capability) {
            held = true;
            entered.release();
            await resume.promise;
          }
        },
      });
      const discovery = vi
        .fn<NonNullable<DriCoordinatorOptions["discoverProviders"]>>()
        .mockResolvedValueOnce({ providers: b.providers, issues: {} });
      if (failure === "throw")
        discovery.mockRejectedValueOnce(new Error("Synthetic discovery failure"));
      else if (failure === "invalid")
        discovery.mockResolvedValueOnce({
          providers: [
            {
              ...b.providers[0]!,
              definition: { ...b.providers[0]!.definition, tools: ["update_incident"] },
            },
          ],
          issues: {},
        });
      else discovery.mockResolvedValueOnce(failures);
      const fixtureRead = vi.fn<InvestigationProvider["read"]>();
      const fixtures = fixtureProviders().map((provider) => ({
        definition: provider.definition,
        read: fixtureRead,
      }));
      const { app, coordinator, store, service, create } = harness({
        discoverProviders: discovery,
        fixtures,
        allowFixtures: true,
      });
      await app.register(driRoutes, { service, coordinator });
      const itemB = create("42");
      const runningB = coordinator.execute(itemB.id);
      try {
        await entered.promise;
        const before = store.dri.require(itemB.id);
        expect(versions(coordinator, before)).toEqual(Array(6).fill("B.1"));
        const itemA = create("43");
        await coordinator.execute(itemA.id);
        const a = store.dri.require(itemA.id);
        expect(a).toMatchObject({
          mode: "live",
          status: failure === "invalid" ? "failed" : "blocked",
        });
        expect(store.dri.invocationCount(a.id)).toBe(0);
        for (let read = 0; read < 3; read++) {
          const [responseB, responseA] = await Promise.all([
            app.inject({ url: `/api/dri/${itemB.id}` }),
            app.inject({ url: `/api/dri/${itemA.id}` }),
          ]);
          expect(responseB.statusCode).toBe(200);
          expect(responseA.statusCode).toBe(200);
          const headB = responseB.json<Head>(),
            headA = responseA.json<Head>();
          expect(headB.providers.map((provider) => provider.version)).toEqual(
            Array(6).fill("B.1"),
          );
          expect(headB.investigation.readiness).toEqual(before.readiness);
          expect(headB.availability.liveProvidersConfigured).toBe(true);
          expect(headA.providers).toHaveLength(0);
          expect(headA.availability.liveProvidersConfigured).toBe(false);
          expect(versions(coordinator, store.dri.require(itemB.id))).toEqual(
            Array(6).fill("B.1"),
          );
          expect(coordinator.registry(a).list()).toHaveLength(0);
          expect(store.dri.require(itemB.id).readiness).toEqual(before.readiness);
          expect(
            coordinator.availability(store.dri.require(itemB.id)).liveProvidersConfigured,
          ).toBe(true);
          expect(coordinator.availability(a).liveProvidersConfigured).toBe(false);
        }
        expect(itemA.readiness.every((entry) => entry.state === "unavailable")).toBe(
          true,
        );
        resume.release();
        await runningB;
        const completed = store.dri.require(itemB.id);
        expect(completed.status).toBe("awaiting_review");
        expect(completed.readiness.every((entry) => entry.state === "ready")).toBe(true);
        expect(
          store.dri
            .all(itemB.id, "evidence")
            .every((entry) => entry.provenance.sourceVersion === "B.1"),
        ).toBe(true);
        expect(b.calls.every((context) => context.investigation.id === itemB.id)).toBe(
          true,
        );
        expect(
          b.calls.some((context) => context.query.capability === "similar.search"),
        ).toBe(true);
        expect(coordinator.registry(completed).list()).toHaveLength(0);
        expect(coordinator.availability(completed).liveProvidersConfigured).toBe(true);
        expect(coordinator.live.list()).toHaveLength(0);
        expect(fixtureRead).not.toHaveBeenCalled();
      } finally {
        resume.release();
        await runningB;
      }
    },
  );

  it.each([
    ["A", "B"],
    ["B", "A"],
  ] as const)(
    "isolates different provider sets, issues and identical provider IDs: %s then %s",
    async (first, second) => {
      const entered = { A: gate(), B: gate() };
      const resume = { A: gate(), B: gate() };
      const absent: Record<"A" | "B", DriCapability> = {
        A: "har.analyze",
        B: "telemetry.query",
      };
      const sets = Object.fromEntries(
        (["A", "B"] as const).map((name) => [
          name,
          readers(`${name}.1`, {
            unavailable: [absent[name]],
            delay: async (context) => {
              if (context.query.capability === "incident.read" && !context.cursor) {
                entered[name].release();
                await resume[name].promise;
              }
            },
          }),
        ]),
      );
      const aIssues: DriProviderDiscovery["issues"] = {
        "har.analyze": { state: "access_denied", reason: "A-only HAR access failure" },
      };
      const bIssues: DriProviderDiscovery["issues"] = {
        "telemetry.query": {
          state: "incompatible",
          reason: "B-only telemetry schema failure",
        },
      };
      const issues = { A: aIssues, B: bIssues };
      const discovery = vi
        .fn<NonNullable<DriCoordinatorOptions["discoverProviders"]>>()
        .mockResolvedValueOnce({
          providers: sets[first]!.providers,
          issues: issues[first],
        })
        .mockResolvedValueOnce({
          providers: sets[second]!.providers,
          issues: issues[second],
        });
      const { coordinator, store, create } = harness({ discoverProviders: discovery });
      const items = { A: create("42"), B: create("43") };
      const runningFirst = coordinator.execute(items[first].id);
      await entered[first].promise;
      const runningSecond = coordinator.execute(items[second].id);
      try {
        await entered[second].promise;
        for (const name of [first, second]) {
          expect(versions(coordinator, store.dri.require(items[name].id))).toEqual(
            Array(5).fill(`${name}.1`),
          );
          expect(
            store.dri
              .require(items[name].id)
              .readiness.find((entry) => entry.capability === absent[name]),
          ).toMatchObject(issues[name][absent[name]]!);
        }
        // A later discovery may reuse and mutate its result object; accepted snapshots must not alias it.
        aIssues["har.analyze"]!.reason = "Changed after discovery";
        resume[first].release();
        await runningFirst;
        expect(versions(coordinator, store.dri.require(items[second].id))).toEqual(
          Array(5).fill(`${second}.1`),
        );
        resume[second].release();
        await runningSecond;
        for (const name of [first, second]) {
          const current = store.dri.require(items[name].id);
          expect(current.status).toBe("partial");
          const missing = current.readiness.find(
            (entry) => entry.capability === absent[name],
          )!;
          expect(missing.reason).toBe(
            name === "A"
              ? "A-only HAR access failure"
              : "B-only telemetry schema failure",
          );
          expect(
            current.readiness.filter((entry) => entry.state !== "ready"),
          ).toHaveLength(1);
          expect(
            store.dri
              .all(current.id, "evidence")
              .filter((entry) => entry.type !== "limitation")
              .every((entry) => entry.provenance.sourceVersion === `${name}.1`),
          ).toBe(true);
          expect(
            sets[name]!.calls.every((context) => context.investigation.id === current.id),
          ).toBe(true);
          expect(coordinator.registry(current).list()).toHaveLength(0);
        }
      } finally {
        resume.A.release();
        resume.B.release();
        await Promise.all([runningFirst, runningSecond]);
      }
    },
  );

  it("keeps static embedding providers and fixture issues independent from discovered overlays", async () => {
    const entered = gate(),
      resume = gate();
    const base = readers("static");
    const staticProviders = base.providers.filter((provider) =>
      provider.definition.capabilities.includes("incident.read"),
    );
    const working = readers("B.1", {
      unavailable: ["incident.read"],
      delay: async (context) => {
        if (context.query.capability === "telemetry.query") {
          entered.release();
          await resume.promise;
        }
      },
    });
    const discovery = vi
      .fn<NonNullable<DriCoordinatorOptions["discoverProviders"]>>()
      .mockResolvedValueOnce({ providers: working.providers, issues: {} })
      .mockResolvedValueOnce(failures);
    const { coordinator, store, create } = harness({
      liveProviders: staticProviders,
      discoverProviders: discovery,
      fixtures: fixtureProviders({ unavailable: ["har.analyze"] }),
      allowFixtures: true,
    });
    staticProviders.length = 0;
    const itemB = create("42");
    const runningB = coordinator.execute(itemB.id);
    try {
      await entered.promise;
      const itemA = create("43");
      await coordinator.execute(itemA.id);
      expect(store.dri.require(itemA.id).status).toBe("partial");
      const demo = coordinator.create({ icm: "44", mode: "fixture" });
      await coordinator.execute(demo.id);
      expect(
        store.dri
          .require(demo.id)
          .readiness.find((entry) => entry.capability === "har.analyze"),
      ).toMatchObject({
        state: "unavailable",
        reason: "No configured read-only provider for har.analyze.",
      });
      resume.release();
      await runningB;
      expect(store.dri.require(itemB.id).status).toBe("awaiting_review");
      expect(coordinator.live.list().map((provider) => provider.version)).toEqual([
        "static",
      ]);
      expect(base.calls.map((context) => context.investigation.id)).toEqual([
        itemB.id,
        itemB.id,
        itemA.id,
        itemA.id,
      ]);
      expect(discovery).toHaveBeenCalledTimes(2);
    } finally {
      resume.release();
      await runningB;
    }
  });

  it("rediscovers on immediate Stop/Resume and does not let old completion clear a newer generation", async () => {
    const oldEntered = gate(),
      newEntered = gate(),
      oldRelease = gate(),
      newRelease = gate();
    const old = readers("old", {
      delay: async (context) => {
        if (context.query.capability === "telemetry.query") {
          oldEntered.release();
          await oldRelease.promise;
        }
      },
    });
    const next = readers("new", {
      delay: async (context) => {
        if (context.query.capability === "telemetry.query") {
          newEntered.release();
          await newRelease.promise;
        }
      },
    });
    const discovery = vi
      .fn<NonNullable<DriCoordinatorOptions["discoverProviders"]>>()
      .mockResolvedValueOnce({ providers: old.providers, issues: {} })
      .mockResolvedValueOnce({ providers: next.providers, issues: {} });
    const { coordinator, store, create } = harness({ discoverProviders: discovery });
    const item = create("42");
    const running = coordinator.execute(item.id);
    try {
      await oldEntered.promise;
      const previous = store.dri.require(item.id);
      coordinator.stop(item.id, previous.revision);
      coordinator.resume(item.id, store.dri.require(item.id).revision);
      const retry = coordinator.execute(item.id);
      const replay = coordinator.execute(item.id);
      await newEntered.promise;
      const current = store.dri.require(item.id);
      expect(current.generation).toBeGreaterThan(previous.generation);
      expect(versions(coordinator, current)).toEqual(Array(6).fill("new"));
      expect(coordinator.registry(previous).list()).toHaveLength(0);
      oldRelease.release();
      await running;
      expect(versions(coordinator, store.dri.require(item.id))).toEqual(
        Array(6).fill("new"),
      );
      newRelease.release();
      await Promise.all([retry, replay]);
      expect(discovery).toHaveBeenCalledTimes(2);
      expect(
        next.calls.some((context) => context.query.capability === "incident.read"),
      ).toBe(false);
      expect(store.dri.require(item.id).status).toBe("awaiting_review");
      expect(
        store.dri
          .all(item.id, "evidence")
          .filter((entry) => entry.type === "telemetry")
          .every((entry) => entry.provenance.sourceVersion === "new"),
      ).toBe(true);
      expect(coordinator.registry(store.dri.require(item.id)).list()).toHaveLength(0);
    } finally {
      oldRelease.release();
      newRelease.release();
      await coordinator.shutdown();
      await running;
    }
  });

  it("retains readiness but reacquires live providers after a coordinator restart", async () => {
    const entered = gate(),
      resume = gate();
    const initial = readers("before", {
      delay: async (context) => {
        if (context.query.capability === "telemetry.query") {
          entered.release();
          await resume.promise;
        }
      },
    });
    const { coordinator, store, service, create } = harness({
      discoverProviders: async () => ({ providers: initial.providers, issues: {} }),
    });
    const item = create("42");
    const running = coordinator.execute(item.id);
    let restarted: DriCoordinator | undefined;
    try {
      await entered.promise;
      const readiness = store.dri.require(item.id).readiness;
      await coordinator.shutdown();
      await running;
      const after = readers("after");
      const discover = vi.fn(async () => ({ providers: after.providers, issues: {} }));
      restarted = new DriCoordinator(service, { discoverProviders: discover });
      restarted.recover();
      const stopped = store.dri.require(item.id);
      expect(stopped.status).toBe("stopped");
      expect(stopped.readiness).toEqual(readiness);
      expect(restarted.registry(stopped).list()).toHaveLength(0);
      restarted.resume(item.id, stopped.revision);
      await restarted.execute(item.id);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(
        after.calls.some((context) => context.query.capability === "incident.read"),
      ).toBe(false);
      expect(store.dri.require(item.id).status).toBe("awaiting_review");
      expect(
        store.dri
          .all(item.id, "evidence")
          .filter((entry) => entry.type === "telemetry")
          .every((entry) => entry.provenance.sourceVersion === "after"),
      ).toBe(true);
    } finally {
      resume.release();
      await restarted?.shutdown();
    }
  });
});
