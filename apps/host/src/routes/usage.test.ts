import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { usageRoutes } from "./usage.js";
import type { FleetAuth } from "../auth/service.js";
import { UsageBackfillConflict } from "../usage-backfill.js";
const auth = {
  noAuthEnabled: () => true,
  noAuthEndpointAllowed: () => true,
  audit: vi.fn(),
} as unknown as FleetAuth;

describe("usage reporting routes", () => {
  it("previews and applies only server-selected credits after validating the request", async () => {
    const app = Fastify();
    const preview = vi.fn(() => ({ previewId: "a".repeat(64) }));
    const apply = vi.fn(() => ({
      importedConversations: 1,
      aiCredits: 100,
      backupFile: "usage-backfill-test.db",
    }));
    await app.register(usageRoutes, {
      store: { usageBackfill: { preview, apply } } as never,
      auth,
    });
    try {
      expect((await app.inject("/api/usage/backfill")).statusCode).toBe(200);
      expect(preview).toHaveBeenCalledTimes(1);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/usage/backfill",
            payload: { previewId: "a".repeat(64), aiCredits: 999 },
          })
        ).statusCode,
      ).toBe(400);
      expect(apply).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/usage/backfill",
            payload: { previewId: "a".repeat(64) },
          })
        ).statusCode,
      ).toBe(200);
      expect(apply).toHaveBeenCalledWith("a".repeat(64));
      apply.mockImplementationOnce(() => {
        throw new UsageBackfillConflict();
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/usage/backfill",
            payload: { previewId: "a".repeat(64) },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("rejects non-administrators before previewing or importing", async () => {
    const app = Fastify();
    const preview = vi.fn();
    const apply = vi.fn();
    await app.register(usageRoutes, {
      store: { usageBackfill: { preview, apply } } as never,
      auth: { noAuthEnabled: () => false } as FleetAuth,
    });
    try {
      expect((await app.inject("/api/usage/backfill")).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/usage/backfill",
            payload: { previewId: "a".repeat(64) },
          })
        ).statusCode,
      ).toBe(403);
      expect(preview).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("validates ranges before querying and forwards valid filters", async () => {
    const app = Fastify();
    const report = vi.fn(() => ({ rows: [] }));
    await app.register(usageRoutes, { store: { usage: { report } } as never, auth });
    const invalid = await app.inject("/api/usage?timeZone=invalid&from=bad");
    expect(invalid.statusCode).toBe(400);
    expect(report).not.toHaveBeenCalled();
    const valid = await app.inject("/api/usage?groupBy=machine&backend=hermes");
    expect(valid.statusCode).toBe(200);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: "machine", backend: "hermes", timeZone: "UTC" }),
    );
    await app.close();
  });
});
