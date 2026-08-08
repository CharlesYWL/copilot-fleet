import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  needsReconnect,
  settingsFromEnv,
} from "./settings.js";
import { configServerPort } from "./config-server.js";

describe("settingsFromEnv", () => {
  it("falls back to loopback and this machine's hostname", () => {
    const settings = settingsFromEnv({});
    expect(settings.hostUrl).toBe("http://127.0.0.1:8787");
    expect(settings.nodeName.length).toBeGreaterThan(0);
    expect(settings.maxSessions).toBe(4);
    // The documented default, so a node without the variable does not deny
    // permissions long before the operator's .env says it should.
    expect(settings.permissionTimeoutMs).toBe(DEFAULT_PERMISSION_TIMEOUT_MS);
  });

  it("reads the fleet environment variables", () => {
    const settings = settingsFromEnv({
      FLEET_HOST_URL: "https://example.trycloudflare.com",
      FLEET_NODE_NAME: "WEILI-PC",
      FLEET_MAX_SESSIONS: "8",
      PERMISSION_TIMEOUT_MS: "60000",
    });
    expect(settings.hostUrl).toBe("https://example.trycloudflare.com");
    expect(settings.nodeName).toBe("WEILI-PC");
    expect(settings.maxSessions).toBe(8);
    expect(settings.permissionTimeoutMs).toBe(60_000);
  });
});

describe("needsReconnect", () => {
  const base = settingsFromEnv({});

  it("reconnects when the host url rotates", () => {
    expect(needsReconnect(base, { ...base, hostUrl: "https://new.example.com" })).toBe(
      true,
    );
  });

  it("reconnects on identity and capacity changes the Host must learn about", () => {
    expect(needsReconnect(base, { ...base, nodeName: "renamed" })).toBe(true);
    expect(needsReconnect(base, { ...base, maxSessions: 9 })).toBe(true);
  });

  it("applies agent tuning in place, without dropping the socket", () => {
    expect(needsReconnect(base, { ...base, permissionTimeoutMs: 90_000 })).toBe(false);
    expect(needsReconnect(base, { ...base, copilotCommand: "/opt/copilot" })).toBe(
      false,
    );
  });
});

describe("configServerPort", () => {
  it("defaults next to the host port", () => {
    expect(configServerPort({})).toBe(8788);
  });

  it("accepts an override and ignores unusable values", () => {
    expect(configServerPort({ FLEET_NODE_CONFIG_PORT: "9100" })).toBe(9100);
    expect(configServerPort({ FLEET_NODE_CONFIG_PORT: "0" })).toBe(8788);
    expect(configServerPort({ FLEET_NODE_CONFIG_PORT: "not-a-port" })).toBe(8788);
  });
});
