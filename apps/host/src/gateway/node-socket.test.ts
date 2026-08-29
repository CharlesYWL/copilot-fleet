import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import {
  AUTH_FAILED_CLOSE_CODE,
  MUTUAL_AUTH_PROTOCOL,
  parseEnrollmentGrant,
  type AuthenticatedEnvelope,
  type HostChallenge,
  type NodeEnrollmentChallengeResponse,
  type NodeEnrollmentReceipt,
} from "@fleet/protocol";
import {
  AuthenticatedChannel,
  CHANNEL_KEY_LABEL,
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  HOST_CHALLENGE_LABEL,
  NODE_PROOF_LABEL,
  createEphemeralKeyPair,
  createIdentityKeyPair,
  deriveChannelKeys,
  enrollmentTranscript,
  grantProof,
  grantSecretDigest,
  handshakeTranscript,
  registrationHash,
  signWithIdentity,
  verifyIdentitySignature,
} from "@fleet/protocol/node-auth";
import { buildServer } from "../server.js";
import type { EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

const registration = {
  name: "alpha",
  os: "linux",
  arch: "x64",
  version: "0.3.0",
  revision: "abc1234",
  capabilities: ["copilot-acp", "node-key-upgrade"],
  agents: [],
  maxSessions: 2,
  homeDir: "/home/alpha",
};

/**
 * The Node gateway, end to end over a real socket.
 *
 * The connection is where a relay would live if it could: it forwards the
 * handshake, sees every frame, and has all the time in the world. What these
 * assert is that seeing it is all it can do — the persistent keys authenticate
 * the ephemeral ones, the AEAD keys come out of that exchange, and every frame
 * after it is bound to this connection and this position in the stream.
 */
describe("node gateway mutual authentication", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let baseUrl = "";
  let hostFingerprint = "";

  const makeBrowser = () => {
    const jar = new Map<string, string>();
    const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
      const raw = response.headers["set-cookie"];
      const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
      for (const pair of list.map((value) => value.split(";")[0] ?? "")) {
        const [name, ...rest] = pair.split("=");
        if (!name) continue;
        const value = rest.join("=");
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return {
      remember,
      cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    };
  };
  type Browser = ReturnType<typeof makeBrowser>;
  let owner: Browser;

  const csrfFor = async (browser: Browser) =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: browser.cookie() },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

  /** Enrols a Node the way a real one does, and keeps its private key. */
  const enrollNode = async (name = "alpha") => {
    const issued = (
      await app.inject({
        method: "POST",
        url: "/api/enrollment-grants",
        headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
        payload: {},
      })
    ).json() as { grant: string };
    const parts = parseEnrollmentGrant(issued.grant);
    const keys = createIdentityKeyPair();
    const payload = { ...registration, name };
    const nodeNonce = randomBytes(32).toString("base64");
    const dialedHostUrl = "https://fleet.example.com";
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/enrollment/challenge",
        payload: {
          grantId: parts?.id,
          nodeNonce,
          nodePublicKey: keys.publicKey,
          registrationHash: registrationHash(payload),
          dialedHostUrl,
        },
      })
    ).json() as NodeEnrollmentChallengeResponse;
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: keys.publicKey,
      registrationHash: registrationHash(payload),
      dialedHostUrl,
    };
    const receipt = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: {
          challengeId: challenge.challengeId,
          registration: payload,
          nodeSignature: signWithIdentity(
            keys.privateKey,
            enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
          ),
          grantProof: grantProof(
            grantSecretDigest(parts?.secret ?? ""),
            enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
          ),
        },
      })
    ).json() as NodeEnrollmentReceipt;
    return { keys, receipt, payload };
  };

  /**
   * Every frame a socket has received, buffered from the moment it opened.
   *
   * A `once("message")` per read loses whatever arrived between reads, and the
   * Host legitimately sends two frames back to back — a welcome and an upgrade
   * request. Buffering is the difference between a test that asserts ordering
   * and one that races it.
   */
  const inbox = new WeakMap<
    WebSocket,
    {
      frames: Record<string, unknown>[];
      waiting: ((frame: Record<string, unknown>) => void)[];
    }
  >();

  const open = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}/ws/node`);
      const queue = {
        frames: [] as Record<string, unknown>[],
        waiting: [] as ((frame: Record<string, unknown>) => void)[],
      };
      inbox.set(socket, queue);
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        const waiter = queue.waiting.shift();
        if (waiter) waiter(frame);
        else queue.frames.push(frame);
      });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });

  const nextFrame = (socket: WebSocket) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const queue = inbox.get(socket);
      const buffered = queue?.frames.shift();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => reject(new Error("no frame arrived")), 5_000);
      queue?.waiting.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      socket.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`closed ${code}`));
      });
    });

  const closeCode = (socket: WebSocket) =>
    new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stayed open")), 5_000);
      socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  /**
   * Asserting a frame that must not arrive.
   *
   * `nextFrame` waits five seconds before giving up, which is the test timeout
   * — so proving silence with it fails for the wrong reason. This waits a
   * beat, which is orders of magnitude longer than the Host takes to send the
   * frames it does send on this path.
   */
  const noFrameWithin = async (socket: WebSocket, ms = 250) => {
    const queue = inbox.get(socket);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return queue?.frames ?? [];
  };

  /** Everything a Node does to reach an authenticated channel. */
  const handshake = async (input: {
    nodeId: string;
    keys: ReturnType<typeof createIdentityKeyPair>;
    proofKeys?: ReturnType<typeof createIdentityKeyPair>;
    hostId?: string;
    ready?: boolean;
  }) => {
    const socket = await open();
    const ephemeral = createEphemeralKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const dialedHostUrl = "https://fleet.example.com";
    const hostId = input.hostId ?? "";
    socket.send(
      JSON.stringify({
        type: "client_hello",
        protocol: MUTUAL_AUTH_PROTOCOL,
        nodeId: input.nodeId,
        hostId: hostId || (await advertisedHostId()),
        nodeNonce,
        nodeEphemeralPublicKey: ephemeral.publicKey,
        dialedHostUrl,
      }),
    );
    const challenge = (await nextFrame(socket)) as unknown as HostChallenge;
    const transcript = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: challenge.hostId,
      nodeId: input.nodeId,
      connectionId: challenge.connectionId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      hostPublicKey: challenge.hostPublicKey,
      nodePublicKey: input.keys.publicKey,
      hostEphemeralPublicKey: challenge.hostEphemeralPublicKey,
      nodeEphemeralPublicKey: ephemeral.publicKey,
      dialedHostUrl,
    };
    socket.send(
      JSON.stringify({
        type: "node_proof",
        signature: signWithIdentity(
          (input.proofKeys ?? input.keys).privateKey,
          handshakeTranscript(NODE_PROOF_LABEL, transcript),
        ),
      }),
    );
    const keys = deriveChannelKeys({
      privateKey: ephemeral.privateKey,
      peerPublicKey: challenge.hostEphemeralPublicKey,
      transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
    });
    const channel = new AuthenticatedChannel({
      keys,
      binding: {
        protocol: MUTUAL_AUTH_PROTOCOL,
        hostId: challenge.hostId,
        nodeId: input.nodeId,
        connectionId: challenge.connectionId,
      },
      seals: "node-to-host",
    });
    // The inventory a legacy Node put in its `hello` travels here instead:
    // sealed, after the key check, so nothing a stranger sends can write to
    // the Node's row.
    if (input.ready !== false) {
      socket.send(
        JSON.stringify(
          channel.seal(
            JSON.stringify({
              type: "ready",
              os: "linux",
              arch: "x64",
              version: "0.3.0",
              revision: "abc1234",
              capabilities: registration.capabilities,
              agents: [],
              maxSessions: 2,
              homeDir: "/home/alpha",
              activeSessionIds: [],
              busySessionIds: [],
            }),
          ),
        ),
      );
    }
    return { socket, challenge, channel, transcript };
  };

  const advertisedHostId = async () =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/enrollment",
          headers: { cookie: owner.cookie() },
        })
      ).json() as { hostId: string }
    ).hostId;

  /** The frame a machine that has not upgraded still sends. */
  const legacyHello = (registered: { nodeId: string; secret: string }) => ({
    type: "hello",
    nodeId: registered.nodeId,
    secret: registered.secret,
    os: "linux",
    arch: "x64",
    version: "0.3.0",
    revision: "abc1234",
    capabilities: registration.capabilities,
    agents: [],
    maxSessions: 2,
    homeDir: "/home/legacy",
    name: "legacy",
    activeSessionIds: [],
    busySessionIds: [],
  });

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.example/authorize?state=${state}`,
        redeemAuthorizationCode: async () => alice,
        startDeviceCode: async () => {
          throw new Error("device flow is not enabled on this Host");
        },
        pollDeviceCode: async () => alice,
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;

    owner = makeBrowser();
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: owner.cookie() },
        payload: { code: claimCode },
      }),
    );
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: owner.cookie() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );
    const started = owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: owner.cookie() },
        payload: {},
      }),
    );
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    owner.remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
        headers: { cookie: owner.cookie() },
      }),
    );
    hostFingerprint = (
      (
        await app.inject({
          method: "GET",
          url: "/api/enrollment",
          headers: { cookie: owner.cookie() },
        })
      ).json() as { hostFingerprint: string }
    ).hostFingerprint;
  });

  afterEach(async () => {
    await app.close();
  });

  it("proves the Host before the Node has sent anything but a nonce", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, challenge, transcript } = await handshake({
      nodeId: receipt.nodeId,
      keys,
      ready: false,
    });

    expect(challenge.type).toBe("host_challenge");
    expect(challenge.hostFingerprint).toBe(hostFingerprint);
    // The Node checks the signature against the fingerprint it pinned at
    // enrolment; nothing it has sent so far is usable by anything else.
    expect(
      verifyIdentitySignature(
        challenge.hostPublicKey,
        handshakeTranscript(HOST_CHALLENGE_LABEL, transcript),
        challenge.signature,
      ),
    ).toBe(true);
    socket.close();
  });

  it("carries the Node's inventory sealed, and welcomes it back", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });
    channel.open((await nextFrame(socket)) as unknown as AuthenticatedEnvelope);

    const nodes = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { id: string; online: boolean; capabilities: string[] }[];
    const row = nodes.find((node) => node.id === receipt.nodeId);
    expect(row?.online).toBe(true);
    expect(row?.capabilities).toContain("copilot-acp");
    socket.close();
  });

  it("welcomes the Node inside a sealed envelope once both have proved", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });

    const sealed = (await nextFrame(socket)) as unknown as AuthenticatedEnvelope;
    expect(sealed.type).toBe("envelope");
    expect(sealed.sequence).toBe(0);
    // Nothing about the fleet is readable off the wire.
    expect(JSON.stringify(sealed)).not.toContain("welcome");

    const opened = channel.open(sealed);
    expect(opened.ok && JSON.parse(opened.plaintext)).toEqual({
      type: "welcome",
      nodeId: receipt.nodeId,
    });
    socket.close();
  });

  it("carries heartbeats and events over the sealed channel", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });
    channel.open((await nextFrame(socket)) as unknown as AuthenticatedEnvelope);

    socket.send(
      JSON.stringify(
        channel.seal(
          JSON.stringify({
            type: "heartbeat",
            activeSessionIds: [],
            busySessionIds: [],
            sentAt: new Date().toISOString(),
          }),
        ),
      ),
    );
    // The Host stays connected and the Node shows online, which is the whole
    // observable effect of a heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const nodes = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { id: string; online: boolean }[];
    expect(nodes.find((node) => node.id === receipt.nodeId)?.online).toBe(true);
    socket.close();
  });

  it("refuses a client_hello for a Node it has never enrolled", async () => {
    const socket = await open();
    socket.send(
      JSON.stringify({
        type: "client_hello",
        protocol: MUTUAL_AUTH_PROTOCOL,
        nodeId: "not-a-node",
        hostId: await advertisedHostId(),
        nodeNonce: randomBytes(32).toString("base64"),
        nodeEphemeralPublicKey: createEphemeralKeyPair().publicKey,
        dialedHostUrl: "https://fleet.example.com",
      }),
    );
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  it("refuses a client_hello that names another Host", async () => {
    const { keys, receipt } = await enrollNode();
    const socket = await open();
    socket.send(
      JSON.stringify({
        type: "client_hello",
        protocol: MUTUAL_AUTH_PROTOCOL,
        nodeId: receipt.nodeId,
        hostId: "some-other-host",
        nodeNonce: randomBytes(32).toString("base64"),
        nodeEphemeralPublicKey: createEphemeralKeyPair().publicKey,
        dialedHostUrl: "https://fleet.example.com",
      }),
    );
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
    expect(keys.publicKey).toBeTruthy();
  });

  it("refuses a proof signed by a key the Host did not enrol", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket } = await handshake({
      nodeId: receipt.nodeId,
      keys,
      proofKeys: createIdentityKeyPair(),
    });
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  /**
   * A schema-valid ephemeral key is not a usable one.
   *
   * `nodeEphemeralPublicKey` is checked as base64 of a plausible length, which
   * says nothing about whether it decodes to an X25519 point — and the key
   * exchange that consumes it is reached before anything has authenticated. An
   * error raised there is not a refused connection: it is an exception inside a
   * socket listener, on a path any stranger who can open a WebSocket can drive.
   * The connection has to end, and nothing else may notice.
   */
  it("closes only the socket that sent an unusable ephemeral key", async () => {
    const { keys, receipt } = await enrollNode();
    const hostId = await advertisedHostId();
    for (const ephemeral of [
      Buffer.from("not-a-key").toString("base64"),
      createIdentityKeyPair().publicKey,
      createEphemeralKeyPair().publicKey.slice(0, 8),
    ]) {
      const socket = await open();
      const nodeNonce = randomBytes(32).toString("base64");
      const dialedHostUrl = "https://fleet.example.com";
      socket.send(
        JSON.stringify({
          type: "client_hello",
          protocol: MUTUAL_AUTH_PROTOCOL,
          nodeId: receipt.nodeId,
          hostId,
          nodeNonce,
          nodeEphemeralPublicKey: ephemeral,
          dialedHostUrl,
        }),
      );
      // The challenge still comes back: the Host cannot know the key is junk
      // until it tries to use it, which is at the key exchange.
      const challenge = (await nextFrame(socket)) as unknown as HostChallenge;
      // A genuine signature over the transcript that carries the bad key, so
      // the refusal cannot come from the proof check standing in front of it.
      socket.send(
        JSON.stringify({
          type: "node_proof",
          signature: signWithIdentity(
            keys.privateKey,
            handshakeTranscript(NODE_PROOF_LABEL, {
              protocol: MUTUAL_AUTH_PROTOCOL,
              hostId: challenge.hostId,
              nodeId: receipt.nodeId,
              connectionId: challenge.connectionId,
              hostNonce: challenge.hostNonce,
              nodeNonce,
              hostPublicKey: challenge.hostPublicKey,
              nodePublicKey: keys.publicKey,
              hostEphemeralPublicKey: challenge.hostEphemeralPublicKey,
              nodeEphemeralPublicKey: ephemeral,
              dialedHostUrl,
            }),
          ),
        }),
      );
      expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
    }

    // The Host is still serving, which is the half of this that matters.
    const survivor = await handshake({ nodeId: receipt.nodeId, keys });
    expect(
      survivor.channel.open(
        (await nextFrame(survivor.socket)) as unknown as AuthenticatedEnvelope,
      ).ok,
    ).toBe(true);
    survivor.socket.close();
  });

  it("accepts no command or event before the handshake is finished", async () => {
    const socket = await open();
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        activeSessionIds: [],
        busySessionIds: [],
        sentAt: new Date().toISOString(),
      }),
    );
    expect(await closeCode(socket)).toBe(1008);

    const second = await open();
    const { keys, receipt } = await enrollNode();
    second.send(
      JSON.stringify({
        type: "client_hello",
        protocol: MUTUAL_AUTH_PROTOCOL,
        nodeId: receipt.nodeId,
        hostId: await advertisedHostId(),
        nodeNonce: randomBytes(32).toString("base64"),
        nodeEphemeralPublicKey: createEphemeralKeyPair().publicKey,
        dialedHostUrl: "https://fleet.example.com",
      }),
    );
    await nextFrame(second);
    // A frame where the proof belongs is not a proof.
    second.send(
      JSON.stringify({
        type: "heartbeat",
        activeSessionIds: [],
        busySessionIds: [],
        sentAt: new Date().toISOString(),
      }),
    );
    expect(await closeCode(second)).toBe(1008);
    expect(keys.publicKey).toBeTruthy();
  });

  it("closes the connection on a replayed envelope", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });
    channel.open((await nextFrame(socket)) as unknown as AuthenticatedEnvelope);

    const beat = channel.seal(
      JSON.stringify({
        type: "heartbeat",
        activeSessionIds: [],
        busySessionIds: [],
        sentAt: new Date().toISOString(),
      }),
    );
    socket.send(JSON.stringify(beat));
    socket.send(JSON.stringify(beat));
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  it("closes the connection on a gap in the sequence", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });
    channel.open((await nextFrame(socket)) as unknown as AuthenticatedEnvelope);

    const beat = () =>
      channel.seal(
        JSON.stringify({
          type: "heartbeat",
          activeSessionIds: [],
          busySessionIds: [],
          sentAt: new Date().toISOString(),
        }),
      );
    beat();
    // The first is dropped, so what arrives is sequence 1 with no 0 before it.
    socket.send(JSON.stringify(beat()));
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  it("closes the connection on an edited envelope", async () => {
    const { keys, receipt } = await enrollNode();
    const { socket, channel } = await handshake({ nodeId: receipt.nodeId, keys });
    channel.open((await nextFrame(socket)) as unknown as AuthenticatedEnvelope);

    const beat = channel.seal(
      JSON.stringify({
        type: "heartbeat",
        activeSessionIds: [],
        busySessionIds: [],
        sentAt: new Date().toISOString(),
      }),
    );
    const bytes = Buffer.from(beat.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    socket.send(JSON.stringify({ ...beat, ciphertext: bytes.toString("base64") }));
    expect(await closeCode(socket)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  it("still accepts a legacy hello, so a fleet can upgrade one machine at a time", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    const socket = await open();
    socket.send(
      JSON.stringify({
        type: "hello",
        nodeId: registered.nodeId,
        secret: registered.secret,
        os: "linux",
        arch: "x64",
        version: "0.3.0",
        revision: "abc1234",
        capabilities: registration.capabilities,
        agents: [],
        maxSessions: 2,
        homeDir: "/home/legacy",
        name: "legacy",
        activeSessionIds: [],
        busySessionIds: [],
      }),
    );
    const frame = await nextFrame(socket);
    // Plain JSON, exactly as before: the old protocol is untouched.
    expect(frame).toEqual({ type: "welcome", nodeId: registered.nodeId });
    socket.close();
  });

  /**
   * The upgrade the Host must not offer.
   *
   * A legacy Node has already handed its shared secret to whatever terminated
   * the connection — that is what "legacy" means on a relayed tunnel — so a
   * `request_node_key` keyed on the digest of that secret proves nothing about
   * who is asking. Anything holding the secret can compute the HMAC, hand the
   * Node a key of its own, and be that machine's Host for good. There is no
   * safe automatic path off a disclosed credential, so there is no automatic
   * path: a legacy machine migrates by running a fresh Connect command, which
   * pins the Host fingerprint from the operator rather than from the wire.
   */
  it("never asks a legacy Node to hand over a key", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    const socket = await open();
    socket.send(JSON.stringify(legacyHello(registered)));
    expect(await nextFrame(socket)).toEqual({
      type: "welcome",
      nodeId: registered.nodeId,
    });
    // Nothing follows the welcome. A second frame would be the Host asking a
    // machine it cannot authenticate to pin a key it cannot verify.
    expect(await noFrameWithin(socket)).toEqual([]);
    socket.close();
  });

  it("ignores a key a legacy Node offers, and stages nothing", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    const socket = await open();
    socket.send(JSON.stringify(legacyHello(registered)));
    await nextFrame(socket);

    const keys = createIdentityKeyPair();
    socket.send(JSON.stringify({ type: "node_key", publicKey: keys.publicKey }));
    // Ignored rather than answered — and ignored rather than fatal, because a
    // machine running the older build still offers one and must not be dropped
    // for it while the shared secret is still accepted.
    expect(await noFrameWithin(socket)).toEqual([]);
    socket.close();

    const nodes = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { id: string; authProtocol: string }[];
    expect(nodes.find((node) => node.id === registered.nodeId)?.authProtocol).toBe(
      "legacy-secret",
    );

    // And the key it offered was never recorded, so it cannot be used to get in.
    const rejected = await open();
    rejected.send(
      JSON.stringify({
        type: "client_hello",
        protocol: MUTUAL_AUTH_PROTOCOL,
        nodeId: registered.nodeId,
        hostId: await advertisedHostId(),
        nodeNonce: randomBytes(32).toString("base64"),
        nodeEphemeralPublicKey: createEphemeralKeyPair().publicKey,
        dialedHostUrl: "https://fleet.example.com",
      }),
    );
    expect(await closeCode(rejected)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  /**
   * The migration that is left, and the only one that authenticates the Host.
   *
   * A fresh Connect command carries a one-time grant and the Host fingerprint
   * out of band, and enrolling against the machine's existing name reclaims its
   * row — so the id, the placements and the session history survive, and the
   * secret is gone from that row when it lands.
   */
  it("lets a legacy machine migrate by re-enrolling under its own name", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    const reclaimed = await enrollNode("legacy");
    expect(reclaimed.receipt.nodeId).toBe(registered.nodeId);
    expect(reclaimed.receipt.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);

    const upgraded = await handshake({
      nodeId: registered.nodeId,
      keys: reclaimed.keys,
    });
    expect(
      upgraded.channel.open(
        (await nextFrame(upgraded.socket)) as unknown as AuthenticatedEnvelope,
      ).ok,
    ).toBe(true);
    upgraded.socket.close();

    const after = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { id: string; authProtocol: string }[];
    expect(after.find((node) => node.id === registered.nodeId)?.authProtocol).toBe(
      MUTUAL_AUTH_PROTOCOL,
    );

    // The old secret went with the row it was replaced on.
    const stale = await open();
    stale.send(JSON.stringify(legacyHello(registered)));
    expect(await closeCode(stale)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  it("does not let a legacy secret stand in for the key it upgraded to", async () => {
    const { keys, receipt } = await enrollNode();
    const socket = await open();
    socket.send(
      JSON.stringify({
        type: "hello",
        nodeId: receipt.nodeId,
        // A key-based Node has no shared secret at all, so nothing presented
        // here can be the right one.
        secret: "",
        os: "linux",
        arch: "x64",
        version: "0.3.0",
        capabilities: [],
        maxSessions: 1,
      }),
    );
    expect(await closeCode(socket)).toBeGreaterThanOrEqual(1008);
    expect(keys.publicKey).toBeTruthy();
  });

  /**
   * The switch an operator throws once every machine has upgraded.
   *
   * Off by default and for as long as the migration lasts, because turning it
   * on early does not make the fleet safer — it makes the machines that have
   * not been restarted yet unreachable, which is how an operator ends up
   * turning it back off and leaving it off.
   */
  it("accepts a legacy hello while mutual authentication is not enforced", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    const enrollment = (
      await app.inject({
        method: "GET",
        url: "/api/enrollment",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { mutualAuthenticationRequired: boolean };
    expect(enrollment.mutualAuthenticationRequired).toBe(false);

    const socket = await open();
    socket.send(JSON.stringify(legacyHello(registered)));
    expect(await nextFrame(socket)).toMatchObject({ type: "welcome" });
    socket.close();
  });

  it("refuses to enforce while any machine still holds a shared secret", async () => {
    await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
    });

    const refused = await app.inject({
      method: "POST",
      url: "/api/nodes/mutual-authentication",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: { required: true },
    });
    // Enforcing here would lock that machine out of the fleet it belongs to,
    // and out of the connection it would have upgraded over.
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ nodeAuthentication: { legacy: 1 } });
  });

  it("refuses a legacy hello once every machine has upgraded and it is enforced", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    // Enforcing now would lock that machine out with no way to reach it, so
    // the switch is refused until it has run a Connect command.
    const early = await app.inject({
      method: "POST",
      url: "/api/nodes/mutual-authentication",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: { required: true },
    });
    expect(early.statusCode).toBe(409);

    // The machine migrates the only way it safely can: a fresh grant, the Host
    // fingerprint from the operator, and its own name reclaimed.
    const reclaimed = await enrollNode("legacy");
    expect(reclaimed.receipt.nodeId).toBe(registered.nodeId);

    const enforced = await app.inject({
      method: "POST",
      url: "/api/nodes/mutual-authentication",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: { required: true },
    });
    expect(enforced.statusCode).toBe(200);

    const refused = await open();
    refused.send(JSON.stringify(legacyHello(registered)));
    expect(await closeCode(refused)).toBe(AUTH_FAILED_CLOSE_CODE);

    // And the same machine gets in on the protocol it upgraded to.
    const upgraded = await handshake({
      nodeId: registered.nodeId,
      keys: reclaimed.keys,
    });
    const welcome = upgraded.channel.open(
      (await nextFrame(upgraded.socket)) as unknown as AuthenticatedEnvelope,
    );
    expect(welcome.ok).toBe(true);
    upgraded.socket.close();
  });

  /**
   * Enforcement is the operator saying the weaker proof is over. Leaving the
   * hashes behind would mean a switch that can be flipped back — or a database
   * copy that can be — restores a credential the fleet has moved past.
   */
  it("deletes the shared secret of an upgraded Node once it is enforced", async () => {
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
      })
    ).json() as { nodeId: string; secret: string };

    await enrollNode("legacy");

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/mutual-authentication",
          headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
          payload: { required: true },
        })
      ).statusCode,
    ).toBe(200);

    // Relaxing the switch afterwards must not bring the old credential back.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/mutual-authentication",
          headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
          payload: { required: false },
        })
      ).statusCode,
    ).toBe(200);
    const relaxed = await open();
    relaxed.send(JSON.stringify(legacyHello(registered)));
    expect(await closeCode(relaxed)).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  /**
   * The fleet-wide token is the credential the key protocol replaces. While
   * machines that predate keys exist it has to keep working; once the operator
   * has declared they do not, a path that mints a reusable secret from a static
   * string is a way back around the switch.
   */
  it("closes the legacy token registration path once mutual auth is enforced", async () => {
    const { keys, receipt } = await enrollNode();
    expect(keys.publicKey).toBeTruthy();
    expect(receipt.nodeId).toBeTruthy();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/mutual-authentication",
          headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
          payload: { required: true },
        })
      ).statusCode,
    ).toBe(200);

    const refused = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: { ...registration, name: "late", enrollmentToken: "test-token" },
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.stringify(refused.json())).not.toContain("test-token");

    // And a bound enrolment still works, because that is the path that replaced it.
    const enrolled = await enrollNode();
    expect(enrolled.receipt.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
  });
});
