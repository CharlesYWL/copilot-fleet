import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  buildServer,
  resolveDatabasePath,
  resolveEnrollmentHostUrl,
  resolveLegacyEnrollmentToken,
  resolvePublicHostUrl,
  yoloUnsupportedReason,
} from "./server.js";

describe("resolveDatabasePath", () => {
  const root = resolve("repo", "apps", "host");
  const dataPath = (fileName: string) => resolve(root, "data", fileName);

  it("keeps every entry point on one file regardless of cwd", () => {
    // The dev script runs the Host from apps/host and other entry points run
    // from the repo root; a cwd-relative path split these into two databases,
    // and the empty one rejected every Node's credentials.
    expect(resolveDatabasePath("./apps/host/data/fleet.db", root)).toBe(
      dataPath("fleet.db"),
    );
    expect(resolveDatabasePath(undefined, root)).toBe(dataPath("fleet.db"));
  });

  it("still honours an explicit absolute path", () => {
    expect(resolveDatabasePath("/var/lib/fleet/custom.db", root)).toBe(
      "/var/lib/fleet/custom.db",
    );
  });

  it("keeps a relative file name chosen by the operator", () => {
    expect(resolveDatabasePath("./staging.db", root)).toBe(dataPath("staging.db"));
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
  const generate = () => "minted";

  /*
   * The absence of a token used to stop a production Host from booting. It no
   * longer does: a fresh install enrols machines with one-time grants, so
   * demanding a fleet-wide secret would be demanding a credential that
   * authorises nothing anybody wanted.
   */
  it("lets a fresh production Host start with no token at all", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: undefined,
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toBeUndefined();
  });

  describe("built-in Microsoft sign-in", () => {
    it("preconfigures the local Host without asking for tenant or client IDs", async () => {
      const app = await buildServer({
        databasePath: ":memory:",
        operatorPassword: "test-password",
        useBuiltInEntra: true,
        announceClaimCode: () => {},
      });
      try {
        const status = await app.inject({
          method: "GET",
          url: "/api/auth/status",
          headers: { host: "localhost:8787" },
        });
        expect(status.json()).toMatchObject({
          state: "legacy-password",
          entraConfigured: true,
          passwordEnabled: true,
        });
      } finally {
        await app.close();
      }
    });
  });

  it("still rejects the shipped placeholder in production", () => {
    expect(() =>
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "change-me",
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toThrow(/ENROLLMENT_TOKEN/);
  });

  it("allows an explicit non-default production token", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "production-secret",
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toBe("production-secret");
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "change-me",
        legacyNodes: 0,
        nodeEnv: "test",
        generate,
      }),
    ).toBe("change-me");
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
