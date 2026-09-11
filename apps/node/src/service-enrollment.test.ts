import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MUTUAL_AUTH_PROTOCOL, SESSION_RETENTION_CAPABILITY } from "@fleet/protocol";
import { createIdentityKeyPair } from "@fleet/protocol/node-auth";
import {
  configDirectory,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./config.js";
import { type EnsuredCredentials } from "./enrollment.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { prepareNodeService, serviceRuntimeArgs } from "./service-enrollment.js";
import { loadSettings } from "./settings.js";

vi.mock("dotenv", () => ({ config: vi.fn() }));
const previous = { ...process.env };
let directory = "";
const grant = "grant-1.only-for-initial-setup";
const hostUrl = "https://fleet.example.com";
const nodeArgs = [
  `--url=${hostUrl}`,
  "--host-id=host-1",
  `--host-fingerprint=${"a".repeat(64)}`,
  `--enrollment-grant=${grant}`,
  "--name=worker",
  "--max-sessions=3",
];
const keyed = (): Credentials => {
  const { publicKey, privateKey } = createIdentityKeyPair();
  return {
    authProtocol: MUTUAL_AUTH_PROTOCOL,
    nodeId: "node-1",
    name: "worker",
    hostUrl,
    publicKey,
    privateKey,
    host: {
      hostId: "host-1",
      publicKey: createIdentityKeyPair().publicKey,
      fingerprint: "a".repeat(64),
    },
  };
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fleet-service-enroll-"));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("FLEET_")) delete process.env[name];
  }
  process.env.FLEET_NODE_CONFIG_DIR = join(directory, "identity");
});
afterEach(async () => {
  process.env = { ...previous };
  await rm(directory, { recursive: true, force: true });
});

describe("service runtime arguments", () => {
  it("keeps only restart-safe tunnel and port flags, not grants or saved settings", () => {
    expect(
      serviceRuntimeArgs([
        ...nodeArgs,
        "--token",
        "legacy-secret",
        "--copilot-command",
        "C:\\Tools\\copilot.exe",
        "--devtunnel",
        "tunnel-1",
        "--config-port=9890",
      ]),
    ).toEqual(["--devtunnel=tunnel-1", "--config-port=9890"]);
  });
  it.each([
    ["--unknown=value"],
    ["--devtunnel"],
    ["--config-port=0"],
    ["--config-port=65536"],
    ["--devtunnel="],
  ])("rejects invalid Node arguments %j", (...args) => {
    expect(() => serviceRuntimeArgs(args)).toThrow();
  });
});

describe("one-command service enrollment", () => {
  it("authenticates the actual task context before enrolling and saves only durable state", async () => {
    const identity = keyed();
    const events: string[] = [];
    const verifyContext = vi.fn(async () => {
      events.push("auth");
    });
    const enroll = vi.fn(async (): Promise<EnsuredCredentials> => {
      events.push("enroll");
      return { credentials: identity, persist: true };
    });
    const prepared = await prepareNodeService(
      [...nodeArgs, "--copilot-command=C:\\Tools\\copilot.exe", "--config-port=9890"],
      { verifyContext, enroll },
    );
    expect(events).toEqual(["auth", "enroll"]);
    expect(verifyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeName: "worker",
        maxSessions: 3,
        copilotCommand: "C:\\Tools\\copilot.exe",
      }),
    );
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ FLEET_ENROLLMENT_GRANT: grant }),
        machine: expect.objectContaining({
          capabilities: expect.arrayContaining([SESSION_RETENTION_CAPABILITY]),
        }),
      }),
    );
    expect(await loadCredentials()).toEqual(identity);
    expect(await loadSettings()).toMatchObject({
      nodeName: "worker",
      maxSessions: 3,
      hostUrl,
    });
    expect(prepared).toEqual({ nodeId: "node-1", runtimeArgs: ["--config-port=9890"] });
    const files = await Promise.all(
      ["node.json", "settings.json"].map((name) =>
        readFile(join(configDirectory(), name), "utf8"),
      ),
    );
    expect(files.join("")).not.toContain(grant);
    expect(existsSync(join(configDirectory(), "node.lock"))).toBe(false);
  });

  it("accepts the existing legacy enrollment-token option without persisting it as an argument", async () => {
    const enroll = vi.fn(async (): Promise<EnsuredCredentials> => ({
      persist: true,
      credentials: {
        authProtocol: "legacy-secret",
        hostUrl,
        name: "worker",
        nodeId: "legacy-node",
        secret: "new-node-secret",
      },
    }));
    const prepared = await prepareNodeService(
      [`--url=${hostUrl}`, "--token=legacy-fleet-token"],
      {
        verifyContext: async () => {},
        enroll,
      },
    );
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ FLEET_ENROLLMENT_TOKEN: "legacy-fleet-token" }),
      }),
    );
    expect(prepared).toEqual({ nodeId: "legacy-node", runtimeArgs: [] });
    expect(await readFile(join(configDirectory(), "node.json"), "utf8")).not.toContain(
      "legacy-fleet-token",
    );
  });

  it("does not enroll over a Node that acquires the instance lock", async () => {
    const active = acquireInstanceLock(configDirectory());
    if (!active.ok) throw new Error("fixture lock failed");
    const enroll = vi.fn();
    try {
      await expect(
        prepareNodeService(nodeArgs, { verifyContext: async () => {}, enroll }),
      ).rejects.toThrow("already running");
      expect(enroll).not.toHaveBeenCalled();
    } finally {
      active.release();
    }
  });

  it("opens the private tunnel during enrollment and retains only its ID for later starts", async () => {
    const stop = vi.fn();
    const connectTunnel = vi.fn(async () => ({
      url: "http://127.0.0.1:49152",
      stop,
      recycle: vi.fn(),
      rebuildNow: vi.fn(),
    }));
    const enroll = vi.fn(async (): Promise<EnsuredCredentials> => ({
      credentials: keyed(),
      persist: true,
    }));
    const result = await prepareNodeService([...nodeArgs, "--devtunnel=tunnel-1"], {
      verifyContext: async () => {},
      enroll,
      connectTunnel,
    });
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ hostUrl: "http://127.0.0.1:49152" }),
      }),
    );
    expect(result.runtimeArgs).toEqual(["--devtunnel=tunnel-1"]);
    expect(stop).toHaveBeenCalledOnce();
    expect(existsSync(join(configDirectory(), "node.lock"))).toBe(false);
  });

  it("preserves an existing identity and discards stale enrollment environment with --existing-node", async () => {
    const identity = keyed();
    await saveCredentials(identity);
    process.env.FLEET_ENROLLMENT_GRANT = "expired-grant";
    process.env.FLEET_HOST_ID = "old-host";
    process.env.FLEET_HOST_FINGERPRINT = "b".repeat(64);
    const result = await prepareNodeService([], {
      existingNode: true,
      verifyContext: async () => {},
    });
    expect(result.nodeId).toBe(identity.nodeId);
    expect(await loadCredentials()).toEqual(identity);
  });

  it("reuses an already enrolled key when the same Connect command is repeated", async () => {
    const identity = keyed();
    await saveCredentials(identity);
    const result = await prepareNodeService(nodeArgs, { verifyContext: async () => {} });
    expect(result.nodeId).toBe(identity.nodeId);
    expect(await loadCredentials()).toEqual(identity);
  });

  it.each([
    { args: [], existingNode: false },
    { args: [], existingNode: true },
    { args: ["--enrollment-grant=incomplete"], existingNode: false },
    { args: nodeArgs, existingNode: true },
    { args: [...nodeArgs, "--mock-agent"], existingNode: false },
  ])(
    "rejects invalid setup before auth/enrollment: %j",
    async ({ args, existingNode }) => {
      const verifyContext = vi.fn(async () => {});
      const enroll = vi.fn();
      await expect(
        prepareNodeService(args, { existingNode, verifyContext, enroll }),
      ).rejects.toThrow();
      expect(verifyContext).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
      expect(await loadCredentials()).toBeUndefined();
    },
  );

  it("does not consume an enrollment grant when the task auth probe fails", async () => {
    const enroll = vi.fn();
    await expect(
      prepareNodeService(nodeArgs, {
        verifyContext: async () => {
          throw new Error("Sign in to Copilot.");
        },
        enroll,
      }),
    ).rejects.toThrow("Sign in to Copilot");
    expect(enroll).not.toHaveBeenCalled();
    expect(await loadCredentials()).toBeUndefined();
  });

  it("redacts enrollment errors, tears down the temporary tunnel and releases the lock", async () => {
    const stop = vi.fn();
    await expect(
      prepareNodeService([...nodeArgs, "--devtunnel=tunnel-1"], {
        verifyContext: async () => {},
        connectTunnel: async () => ({
          url: "http://127.0.0.1:49152",
          stop,
          recycle: vi.fn(),
          rebuildNow: vi.fn(),
        }),
        enroll: async () => {
          throw new Error(`Server rejected ${grant}`);
        },
      }),
    ).rejects.toThrow("Server rejected [redacted]");
    expect(stop).toHaveBeenCalledOnce();
    expect(existsSync(join(configDirectory(), "node.lock"))).toBe(false);
    expect(await loadCredentials()).toBeUndefined();
  });
});
