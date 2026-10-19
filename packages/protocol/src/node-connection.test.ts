import { describe, expect, it } from "vitest";
import { NodeReadySchema, NodeSchema } from "./index.js";

const inventory = {
  os: "win32",
  arch: "x64",
  version: "0.9.0",
  capabilities: [],
  maxSessions: 1,
};

describe("optional authenticated Node connection metadata", () => {
  it("preserves the reported transport and safe canonical origin", () => {
    for (const connection of [
      { provider: "corp-direct", hostUrl: "https://10.0.5.136:8787" },
      { provider: "devtunnel" },
      { provider: "direct", hostUrl: "https://fleet.example.com" },
      { provider: "ngrok", hostUrl: "https://fleet.ngrok.app" },
    ]) {
      expect(
        NodeReadySchema.parse({ type: "ready", ...inventory, connection }),
      ).toMatchObject({ connection });
      expect(
        NodeSchema.parse({
          ...inventory,
          id: "n1",
          name: "Node",
          activeSessions: 0,
          online: true,
          lastHeartbeat: "2026-10-19T20:00:00.000Z",
          connection,
        }),
      ).toMatchObject({ connection });
    }
  });

  it("accepts inventory from older Nodes without connection metadata", () => {
    expect(NodeReadySchema.safeParse({ type: "ready", ...inventory }).success).toBe(true);
  });

  it("rejects unknown providers and URL credentials, paths or query secrets", () => {
    for (const connection of [
      { provider: "unknown-provider" },
      { provider: "direct", hostUrl: "https://user:secret@fleet.example.com" },
      { provider: "direct", hostUrl: "https://fleet.example.com/?token=secret" },
      { provider: "direct", hostUrl: "https://fleet.example.com/mcp" },
      { provider: "direct", hostUrl: "not-a-url" },
      { provider: "direct", hostUrl: "file:///C:/private" },
    ]) {
      expect(
        NodeReadySchema.safeParse({ type: "ready", ...inventory, connection }).success,
      ).toBe(false);
    }
  });
});
