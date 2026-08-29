import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MUTUAL_AUTH_PROTOCOL } from "@fleet/protocol";
import { createIdentityKeyPair } from "@fleet/protocol/node-auth";
import {
  configDirectory,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./config.js";

const previous = { ...process.env };
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fleet-node-config-"));
  process.env.APPDATA = directory;
  process.env.XDG_CONFIG_HOME = directory;
});

afterEach(async () => {
  process.env = { ...previous };
  await rm(directory, { recursive: true, force: true });
});

const legacy: Credentials = {
  hostUrl: "https://fleet.example.com",
  nodeId: "node-1",
  name: "alpha",
  authProtocol: "legacy-secret",
  secret: "s3cret",
};

const keyed = (): Credentials => {
  const keys = createIdentityKeyPair();
  return {
    hostUrl: "https://fleet.example.com",
    nodeId: "node-1",
    name: "alpha",
    authProtocol: MUTUAL_AUTH_PROTOCOL,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    host: {
      hostId: "host-1",
      publicKey: createIdentityKeyPair().publicKey,
      fingerprint: "a".repeat(64),
    },
  };
};

/**
 * A Node's credentials are the only copy of its identity, so the file has to
 * hold either kind without either being a special case the reader has to guess
 * at — and a key that the operating system lets another account read is a key
 * that machine no longer owns alone.
 */
describe("node credentials", () => {
  it("round-trips a key-based identity with the Host it pinned", async () => {
    const credentials = keyed();
    await saveCredentials(credentials);
    const loaded = await loadCredentials();

    expect(loaded).toEqual(credentials);
    expect(loaded?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    // Narrowing on the protocol is what makes the two shapes usable without a
    // cast: the key fields exist only on this branch of the union.
    if (loaded?.authProtocol !== MUTUAL_AUTH_PROTOCOL) throw new Error("wrong protocol");
    expect(loaded.privateKey).toBe(
      credentials.authProtocol === MUTUAL_AUTH_PROTOCOL ? credentials.privateKey : "",
    );
    expect(loaded.host.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("round-trips a legacy secret identity", async () => {
    await saveCredentials(legacy);
    const loaded = await loadCredentials();

    expect(loaded).toEqual(legacy);
    if (loaded?.authProtocol !== "legacy-secret") throw new Error("wrong protocol");
    expect(loaded.secret).toBe("s3cret");
  });

  it("reads a file written before the protocol was named", async () => {
    // A Node that upgrades in place has a `node.json` with no `authProtocol`
    // in it; refusing to read that would strand the machine the migration
    // exists for.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(configDirectory(), { recursive: true });
    await writeFile(
      join(configDirectory(), "node.json"),
      JSON.stringify({
        hostUrl: "https://fleet.example.com",
        nodeId: "node-1",
        secret: "s3cret",
        name: "alpha",
      }),
    );

    const loaded = await loadCredentials();
    expect(loaded?.authProtocol).toBe("legacy-secret");
    if (loaded?.authProtocol !== "legacy-secret") throw new Error("wrong protocol");
    expect(loaded.secret).toBe("s3cret");
  });

  it("refuses a key-based file that has lost its private half", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(configDirectory(), { recursive: true });
    await writeFile(
      join(configDirectory(), "node.json"),
      JSON.stringify({ ...keyed(), privateKey: "" }),
    );

    await expect(loadCredentials()).rejects.toThrow();
  });

  it("writes the file so only this account can read it", async () => {
    await saveCredentials(keyed());
    const path = join(configDirectory(), "node.json");
    const stats = await stat(path);

    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }
    // The private key is in there, which is exactly why the mode matters.
    expect(await readFile(path, "utf8")).toContain("privateKey");
  });
});
