import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

describe("Vite development proxy", () => {
  it("preserves browser headers for HTTP and WebSocket proxy requests", async () => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    );
    for (const path of ["/api", "/ws"]) {
      const proxy = loaded?.config.server?.proxy?.[path];
      expect(proxy).toMatchObject({ changeOrigin: false });
      expect(proxy).not.toHaveProperty("rewriteWsOrigin", true);
    }
    expect(loaded?.config.server?.proxy?.["/ws"]).toMatchObject({ ws: true });
  });
});
