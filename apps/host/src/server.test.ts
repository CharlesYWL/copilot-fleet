import { describe, expect, it } from "vitest";
import {
  resolveDatabasePath,
  resolveEnrollmentHostUrl,
  resolveEnrollmentToken,
  resolvePublicHostUrl,
  yoloUnsupportedReason,
} from "./server.js";

describe("resolveDatabasePath", () => {
  const root = "/repo/apps/host";

  it("keeps every entry point on one file regardless of cwd", () => {
    // The dev script runs the Host from apps/host and other entry points run
    // from the repo root; a cwd-relative path split these into two databases,
    // and the empty one rejected every Node's credentials.
    expect(resolveDatabasePath("./apps/host/data/fleet.db", root)).toBe(
      "/repo/apps/host/data/fleet.db",
    );
    expect(resolveDatabasePath(undefined, root)).toBe("/repo/apps/host/data/fleet.db");
  });

  it("still honours an explicit absolute path", () => {
    expect(resolveDatabasePath("/var/lib/fleet/custom.db", root)).toBe(
      "/var/lib/fleet/custom.db",
    );
  });

  it("keeps a relative file name chosen by the operator", () => {
    expect(resolveDatabasePath("./staging.db", root)).toBe(
      "/repo/apps/host/data/staging.db",
    );
  });
});

describe("yolo capability guard", () => {
  const node = (capabilities: string[]) => ({ name: "WEILI-PC", capabilities });

  it("allows yolo on a node that reports the capability", () => {
    expect(
      yoloUnsupportedReason(node(["copilot-acp", "host-yolo"]), true),
    ).toBeUndefined();
  });

  it("refuses yolo on an older node instead of downgrading silently", () => {
    const reason = yoloUnsupportedReason(node(["copilot-acp"]), true);
    expect(reason).toMatch(/WEILI-PC/);
    expect(reason).toMatch(/YOLO/);
  });

  it("leaves non-yolo sessions alone on older nodes", () => {
    expect(yoloUnsupportedReason(node(["copilot-acp"]), false)).toBeUndefined();
  });
});

describe("production enrollment token", () => {
  it("rejects missing and default production tokens", () => {
    expect(() => resolveEnrollmentToken(undefined, "production")).toThrow(
      /ENROLLMENT_TOKEN/,
    );
    expect(() => resolveEnrollmentToken("change-me", "production")).toThrow(
      /ENROLLMENT_TOKEN/,
    );
  });

  it("allows an explicit non-default production token", () => {
    expect(resolveEnrollmentToken("production-secret", "production")).toBe(
      "production-secret",
    );
    expect(resolveEnrollmentToken(undefined, "test")).toBe("change-me");
  });
});

describe("public host url", () => {
  it("prefers the configured public url without a trailing slash", () => {
    expect(resolvePublicHostUrl("https://fleet.example.com/", "0.0.0.0", "8787")).toBe(
      "https://fleet.example.com",
    );
  });

  it("falls back to loopback because wildcard binds are not dialable", () => {
    expect(resolvePublicHostUrl(undefined, "0.0.0.0", "8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(resolvePublicHostUrl(undefined, "::", "9000")).toBe("http://127.0.0.1:9000");
  });

  it("keeps a concrete bind address", () => {
    expect(resolvePublicHostUrl(undefined, "192.168.1.5", "8787")).toBe(
      "http://192.168.1.5:8787",
    );
  });
});

describe("enrollment host url", () => {
  it("prefers the live tunnel url over the fallback", () => {
    expect(
      resolveEnrollmentHostUrl("https://abc.trycloudflare.com/", "http://127.0.0.1:8787"),
    ).toBe("https://abc.trycloudflare.com");
  });

  it("uses the fallback when the tunnel is down", () => {
    expect(resolveEnrollmentHostUrl(undefined, "http://192.168.1.5:8787")).toBe(
      "http://192.168.1.5:8787",
    );
  });
});
