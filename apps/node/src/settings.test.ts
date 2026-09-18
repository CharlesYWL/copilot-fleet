import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  loadSettings,
  needsReconnect,
  settingsFromEnv,
  settingsOverridesFromEnv,
  createSettingsUpdater,
  saveSettings,
  EditableSettingsSchema,
} from "./settings.js";
import { configDirectory } from "./config.js";
import { configServerPort } from "./config-server.js";

describe("settingsFromEnv", () => {
  it("excludes rules and their revision from the generic editable form, including defaults", () => {
    const parsed = EditableSettingsSchema.parse({
      ...settingsFromEnv({}),
      commandPermissionRules: [],
      commandPermissionRevision: 42,
    });
    expect(parsed).not.toHaveProperty("commandPermissionRules");
    expect(parsed).not.toHaveProperty("commandPermissionRevision");
  });
  it("falls back to loopback and this machine's hostname", () => {
    const settings = settingsFromEnv({});
    expect(settings.hostUrl).toBe("http://127.0.0.1:8787");
    expect(settings.nodeName.length).toBeGreaterThan(0);
    expect(settings.maxSessions).toBe(DEFAULT_MAX_SESSIONS);
    expect(DEFAULT_MAX_SESSIONS).toBe(10);
    // The documented default, so a node without the variable does not deny
    // permissions long before the operator's .env says it should.
    expect(settings.permissionTimeoutMs).toBe(DEFAULT_PERMISSION_TIMEOUT_MS);
    // Otherwise a node inherits whatever per-model tier the app on that machine
    // happens to have been switched to, which is how two nodes end up running
    // the same session on different windows. See the note on the field.
    expect(settings.contextTier).toBe("long_context");
  });

  it("reads the fleet environment variables", () => {
    const settings = settingsFromEnv({
      FLEET_HOST_URL: "https://example.trycloudflare.com",
      FLEET_NODE_NAME: "WEILI-PC",
      FLEET_MAX_SESSIONS: "8",
      PERMISSION_TIMEOUT_MS: "60000",
      FLEET_CONTEXT_TIER: "default",
    });
    expect(settings.hostUrl).toBe("https://example.trycloudflare.com");
    expect(settings.nodeName).toBe("WEILI-PC");
    expect(settings.maxSessions).toBe(8);
    expect(settings.permissionTimeoutMs).toBe(60_000);
    expect(settings.contextTier).toBe("default");
  });

  it("refuses a context tier Copilot would reject on the command line", () => {
    // Failing here names the field. Passing it through would fail inside a
    // child process instead, as a session that never starts.
    expect(() => settingsFromEnv({ FLEET_CONTEXT_TIER: "enormous" })).toThrow();
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
    const root = resolve(`.fleet-settings-${randomUUID()}`);
    mkdirSync(root);
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

  it("ignores legacy opt-in and eligible roots instead of converting them into grants", async () => {
    writeStoredSettings({
      remoteCommandsEnabled: true,
      commandExecutionRoots: ["C:\\old"],
      commandIsolationConfirmed: true,
    });
    const settings = await loadSettings({});
    expect(settings).not.toHaveProperty("remoteCommandsEnabled");
    expect(settings.commandPermissionRules.map((rule) => rule.commandKey)).toEqual([
      "cd",
      "set-location",
    ]);
  });

  it("persists explicit builtin removal rather than restoring defaults on restart", async () => {
    isolatedConfigDirectory();
    await saveSettings({ ...settingsFromEnv({}), commandPermissionRules: [] });
    expect((await loadSettings({})).commandPermissionRules).toEqual([]);
  });
});

describe("serialized settings mutations", () => {
  it("merges concurrent permission, config and restore writes against the latest committed state", async () => {
    let current = settingsFromEnv({});
    const writes: (typeof current)[] = [];
    const update = createSettingsUpdater({
      get: () => current,
      set: (settings) => {
        current = settings;
      },
      save: async (settings) => {
        await Promise.resolve();
        writes.push(settings);
      },
    });
    await Promise.all([
      update((settings) => ({ ...settings, commandPermissionRules: [] })),
      update((settings) => ({ ...settings, nodeName: "renamed" })),
      update((settings) => ({ ...settings, hostUrl: "https://restored.example.com" })),
    ]);
    expect(writes).toHaveLength(3);
    expect(current).toMatchObject({
      commandPermissionRules: [],
      commandPermissionRevision: 1,
      nodeName: "renamed",
      hostUrl: "https://restored.example.com",
    });
  });

  it("does not publish failed writes and keeps the queue usable", async () => {
    let current = settingsFromEnv({});
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const update = createSettingsUpdater({
      get: () => current,
      set: (settings) => {
        current = settings;
      },
      save,
    });
    await expect(
      update((settings) => ({ ...settings, commandPermissionRules: [] })),
    ).rejects.toThrow("disk full");
    expect(current.commandPermissionRules).toHaveLength(2);
    expect(current.commandPermissionRevision).toBe(0);
    await update((settings) => ({ ...settings, nodeName: "after-failure" }));
    expect(current.nodeName).toBe("after-failure");
    expect(current.commandPermissionRules).toHaveLength(2);
    expect(current.commandPermissionRevision).toBe(0);
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
