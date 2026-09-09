import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { DriAvailabilitySchema } from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { DriCoordinator } from "./coordinator.js";

describe("shipped DRI availability contract", () => {
  it("does not advertise a CLI live-provider installation path", async () => {
    const store = new FleetStore(":memory:");
    const service = new FleetService(store, {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as FastifyBaseLogger);
    const coordinator = new DriCoordinator(service);
    try {
      expect(coordinator.availability()).toEqual({
        fixtureEnabled: false,
        liveRegistration: "embedding_only",
        liveProvidersConfigured: false,
      });
      const item = coordinator.create({ icm: "42", mode: "live" });
      await coordinator.execute(item.id);
      expect(store.dri.require(item.id).status).toBe("blocked");
      expect(store.dri.invocationCount(item.id)).toBe(0);
      expect(() => coordinator.create({ icm: "42", mode: "fixture" })).toThrow(
        /disabled/,
      );
      expect(
        DriAvailabilitySchema.safeParse({
          fixtureEnabled: true,
          liveRegistration: "runtime_modules",
          liveProvidersConfigured: true,
        }).success,
      ).toBe(false);
    } finally {
      await coordinator.shutdown();
      service.shutdown();
      store.close();
    }
  });
  it("documents embedding-only live adapters and operator-authorized proposal receipts", () => {
    const guide = readFileSync(
      join(process.cwd(), "docs", "DRI_INVESTIGATION.md"),
      "utf8",
    );
    expect(guide).toContain("Production CLI live adapters are not shipped");
    expect(guide).toContain("not an operator configuration path");
    expect(guide).toContain(
      "caller authorization is the independently authenticated operator",
    );
    expect(guide).toContain("not a caller credential");
  });
});
