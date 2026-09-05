import { describe, expect, it } from "vitest";
import { requiredPrincipal } from "./guard-rules.js";

/**
 * The literal open-path set could not express a parameterized route, so a path
 * like `/api/auth/device/poll/<flowId>` either had to be left unguarded or
 * spelled out per id. These rules are method plus regex, and each one names the
 * principal it expects, so "open" is never a synonym for "unauthenticated".
 */
describe("requiredPrincipal", () => {
  it("lets anyone ask whether this Host is alive and who it thinks they are", () => {
    expect(requiredPrincipal("GET", "/api/health")).toBe("anonymous");
    expect(requiredPrincipal("GET", "/api/auth/status")).toBe("anonymous");
  });

  it("names the bootstrap principal for the claim-bound configuration routes", () => {
    expect(requiredPrincipal("POST", "/api/auth/bootstrap")).toBe("anonymous");
    expect(requiredPrincipal("POST", "/api/auth/configure")).toBe("bootstrap");
  });

  it("routes a login start and callback to the transaction principal", () => {
    expect(requiredPrincipal("POST", "/api/auth/code/start")).toBe("anonymous");
    expect(requiredPrincipal("GET", "/api/auth/entra/callback")).toBe("transaction");
    expect(requiredPrincipal("POST", "/api/auth/device/start")).toBe("anonymous");
    // The parameterized poll route is the one the literal list could not name.
    expect(requiredPrincipal("POST", "/api/auth/device/poll/abc-123")).toBe(
      "transaction",
    );
  });

  it("keeps the legacy password login open and everything after it closed", () => {
    expect(requiredPrincipal("POST", "/api/auth/login")).toBe("anonymous");
    expect(requiredPrincipal("POST", "/api/auth/logout")).toBe("operator");
    expect(requiredPrincipal("GET", "/api/auth/csrf")).toBe("operator");
  });

  it("gives the node gateway, enrollment and MCP their own principals", () => {
    expect(requiredPrincipal("GET", "/ws/node")).toBe("node-protocol");
    expect(requiredPrincipal("POST", "/api/nodes/register")).toBe("enrollment");
    expect(requiredPrincipal("POST", "/mcp")).toBe("lead");
  });

  it("requires an operator for everything else under /api and /ws", () => {
    for (const [method, path] of [
      ["GET", "/api/snapshot"],
      ["GET", "/api/auth/administrators"],
      ["POST", "/api/auth/administrator-invitations"],
      ["POST", "/api/auth/administrator-invitations/abc/approve"],
      ["DELETE", "/api/auth/administrators/abc"],
      ["POST", "/api/auth/password/disable"],
      ["GET", "/api/security/audit"],
      ["GET", "/ws/browser"],
      ["GET", "/api/enrollment"],
    ] as const) {
      expect(requiredPrincipal(method, path), path).toBe("operator");
    }
  });

  it("does not let a prefix or a method mismatch open a route", () => {
    // A GET to the bootstrap path is not the bootstrap route.
    expect(requiredPrincipal("GET", "/api/auth/bootstrap")).toBe("operator");
    // Nor is a longer path that merely starts with an open one.
    expect(requiredPrincipal("GET", "/api/health/secrets")).toBe("operator");
    expect(requiredPrincipal("POST", "/api/auth/login/../snapshot")).toBe("operator");
    expect(requiredPrincipal("GET", "/api/auth/statuses")).toBe("operator");
  });

  it("matches case-insensitively on the method only", () => {
    expect(requiredPrincipal("get", "/api/health")).toBe("anonymous");
    expect(requiredPrincipal("GET", "/API/HEALTH")).toBe("operator");
  });
});
