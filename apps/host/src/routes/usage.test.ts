import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { usageRoutes } from "./usage.js";

describe("usage reporting routes", () => {
  it("validates ranges before querying and forwards valid filters", async () => {
    const app = Fastify();
    const report = vi.fn(() => ({ rows: [] }));
    await app.register(usageRoutes, { store: { usage: { report } } as never });
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
