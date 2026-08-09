import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  loadSettings,
  needsReconnect,
  settingsFromEnv,
  settingsOverridesFromEnv,
} from "./settings.js";
import { configDirectory } from "./config.js";
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

describe("settingsOverridesFromEnv", () => {
  it("stays empty when nothing was specified", () => {
    expect(settingsOverridesFromEnv({})).toEqual({});
  });

  it("carries only the fields it was given, and none of the defaults", () => {
    // Defaulting the rest here would silently reset the settings an operator
    // saved from the config page every time one flag is passed.
    expect(
      settingsOverridesFromEnv({ FLEET_HOST_URL: "https://one.example.com" }),
    ).toEqual({ hostUrl: "https://one.example.com" });
    expect(settingsOverridesFromEnv({ FLEET_MAX_SESSIONS: "8" })).toEqual({
      maxSessions: 8,
    });
    expect(settingsOverridesFromEnv({ FLEET_COPILOT_COMMAND: "" })).toEqual({
      copilotCommand: "",
    });
  });
});

describe("loadSettings", () => {
  const directories: string[] = [];
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousAppData = process.env.APPDATA;

  function isolatedConfigDirectory(): string {
    const root = mkdtempSync(join(tmpdir(), "fleet-settings-"));
    directories.push(root);
    process.env.XDG_CONFIG_HOME = root;
    process.env.APPDATA = root;
    const directory = configDirectory();
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  function writeStoredSettings(values: Record<string, unknown>): void {
    writeFileSync(
      join(isolatedConfigDirectory(), "settings.json"),
      JSON.stringify(values),
    );
  }

  afterEach(() => {
    process.env.XDG_CONFIG_HOME = previousXdg;
    process.env.APPDATA = previousAppData;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    if (previousAppData === undefined) delete process.env.APPDATA;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers the stored file over the environment", async () => {
    writeStoredSettings({ hostUrl: "https://stored.example.com", maxSessions: 2 });
    const settings = await loadSettings({
      FLEET_HOST_URL: "https://from-env.example.com",
      FLEET_MAX_SESSIONS: "6",
    });
    expect(settings.hostUrl).toBe("https://stored.example.com");
    expect(settings.maxSessions).toBe(2);
  });

  it("lets command-line overrides beat the stored file", async () => {
    // The whole point of a flag: repointing one run at a different Host must
    // not require editing settings.json on the machine first.
    writeStoredSettings({ hostUrl: "https://stored.example.com", maxSessions: 2 });
    const settings = await loadSettings(
      { FLEET_HOST_URL: "https://from-env.example.com" },
      { hostUrl: "https://from-flag.example.com" },
    );
    expect(settings.hostUrl).toBe("https://from-flag.example.com");
    expect(settings.maxSessions).toBe(2);
  });

  it("applies overrides on a machine that has never been configured", async () => {
    isolatedConfigDirectory();
    const settings = await loadSettings({}, { nodeName: "from-flag", maxSessions: 9 });
    expect(settings.nodeName).toBe("from-flag");
    expect(settings.maxSessions).toBe(9);
    expect(settings.hostUrl).toBe("http://127.0.0.1:8787");
  });

  it("rejects an override the settings schema cannot accept", async () => {
    isolatedConfigDirectory();
    await expect(loadSettings({}, { maxSessions: Number("many") })).rejects.toThrow();
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
    expect(needsReconnect(base, { ...base, copilotCommand: "/opt/copilot" })).toBe(false);
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
