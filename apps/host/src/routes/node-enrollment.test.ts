import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  MUTUAL_AUTH_PROTOCOL,
  parseEnrollmentGrant,
  type ConnectCommand,
  type NodeEnrollmentChallengeResponse,
} from "@fleet/protocol";
import {
  ENROLLMENT_CHALLENGE_LABEL,
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  createIdentityKeyPair,
  enrollmentReceiptTranscript,
  enrollmentTranscript,
  grantProof,
  grantSecretDigest,
  identityFingerprint,
  registrationHash,
  signWithIdentity,
  verifyIdentitySignature,
} from "@fleet/protocol/node-auth";
import { randomBytes } from "node:crypto";
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
  capabilities: ["copilot-acp"],
  agents: [],
  maxSessions: 2,
  homeDir: "/home/alpha",
};

/**
 * Enrolment is the moment a machine becomes part of the fleet, and the only
 * moment at which a relay could substitute itself for either end. These assert
 * the three things that make that impossible: the Host proves who it is before
 * the Node commits to anything, the grant authorises exactly one key and one
 * payload, and the grant is spent once.
 */
describe("bound node enrollment", () => {
  let app: FastifyInstance;
  let claimCode = "";

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
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    return { remember, cookie };
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

  const post = async (
    browser: Browser,
    url: string,
    payload: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: browser.cookie(), "x-csrf-token": await csrfFor(browser) },
      payload,
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
          `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?state=${state}`,
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
    await app.ready();

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
  });

  afterEach(async () => {
    await app.close();
  });

  const createGrant = async () => {
    const created = await post(owner, "/api/enrollment-grants");
    expect(created.statusCode).toBe(201);
    return created.json() as {
      id: string;
      grant: string;
      expiresAt: string;
      command: ConnectCommand;
    };
  };

  /** Everything a Node does, so a test can change exactly one step of it. */
  const enroll = async (
    options: {
      grant?: string;
      payload?: Record<string, unknown>;
      completionPayload?: Record<string, unknown>;
      nodeKeys?: ReturnType<typeof createIdentityKeyPair>;
      dialedHostUrl?: string;
    } = {},
  ) => {
    const grant = options.grant ?? (await createGrant()).grant;
    const parts = parseEnrollmentGrant(grant);
    const keys = options.nodeKeys ?? createIdentityKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const payload = options.payload ?? registration;
    const dialedHostUrl = options.dialedHostUrl ?? "https://fleet.example.com";
    const challenged = await app.inject({
      method: "POST",
      url: "/api/nodes/enrollment/challenge",
      payload: {
        grantId: parts?.id,
        nodeNonce,
        nodePublicKey: keys.publicKey,
        registrationHash: registrationHash(payload),
        dialedHostUrl,
      },
    });
    if (challenged.statusCode !== 200) return { challenged, keys };
    const challenge = challenged.json() as NodeEnrollmentChallengeResponse;
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: keys.publicKey,
      registrationHash: registrationHash(payload),
      dialedHostUrl,
    };
    const completed = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        challengeId: challenge.challengeId,
        registration: options.completionPayload ?? payload,
        nodeSignature: signWithIdentity(
          keys.privateKey,
          enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
        ),
        grantProof: grantProof(
          grantSecretDigest(parts?.secret ?? ""),
          enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
        ),
      },
    });
    return { challenged, challenge, completed, keys, fields, nodeNonce, dialedHostUrl };
  };

  it("hands the operator a Connect command with the Host identity to pin", async () => {
    const issued = await createGrant();
    const enrollment = await app.inject({
      method: "GET",
      url: "/api/enrollment",
      headers: { cookie: owner.cookie() },
    });
    const advertised = enrollment.json() as {
      hostId: string;
      hostFingerprint: string;
      hostUrl: string;
    };

    expect(issued.command.hostId).toBe(advertised.hostId);
    expect(issued.command.hostFingerprint).toBe(advertised.hostFingerprint);
    expect(issued.command.hostFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.command.enrollmentGrant).toBe(issued.grant);
    expect(parseEnrollmentGrant(issued.grant)?.id).toBe(issued.id);
    // A key-based Connect command carries no fleet-wide token to leak.
    expect(JSON.stringify(issued.command)).not.toContain("test-token");
  });

  it("never publishes the Host private key", async () => {
    const enrollment = await app.inject({
      method: "GET",
      url: "/api/enrollment",
      headers: { cookie: owner.cookie() },
    });
    expect(Object.keys(enrollment.json() as object)).not.toContain("privateKey");
    expect(enrollment.body).not.toContain("PRIVATE");
  });

  it("refuses to mint a grant for anyone who is not an administrator", async () => {
    const stranger = makeBrowser();
    const refused = await app.inject({
      method: "POST",
      url: "/api/enrollment-grants",
      headers: { cookie: stranger.cookie() },
      payload: {},
    });
    expect(refused.statusCode).toBe(401);
  });

  it("signs a challenge the Node can check against the pinned fingerprint", async () => {
    const issued = await createGrant();
    const parts = parseEnrollmentGrant(issued.grant);
    const keys = createIdentityKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const hash = registrationHash(registration);

    const response = await app.inject({
      method: "POST",
      url: "/api/nodes/enrollment/challenge",
      payload: {
        grantId: parts?.id,
        nodeNonce,
        nodePublicKey: keys.publicKey,
        registrationHash: hash,
        dialedHostUrl: "https://fleet.example.com",
      },
    });
    expect(response.statusCode).toBe(200);
    const challenge = response.json() as NodeEnrollmentChallengeResponse;

    expect(challenge.hostFingerprint).toBe(identityFingerprint(challenge.hostPublicKey));
    expect(challenge.hostFingerprint).toBe(issued.command.hostFingerprint);
    expect(
      verifyIdentitySignature(
        challenge.hostPublicKey,
        enrollmentTranscript(ENROLLMENT_CHALLENGE_LABEL, {
          challengeId: challenge.challengeId,
          hostId: challenge.hostId,
          hostNonce: challenge.hostNonce,
          nodeNonce,
          nodePublicKey: keys.publicKey,
          registrationHash: hash,
          dialedHostUrl: "https://fleet.example.com",
        }),
        challenge.signature,
      ),
    ).toBe(true);
  });

  it("refuses a challenge for a grant that does not exist or is spent", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/nodes/enrollment/challenge",
      payload: {
        grantId: "made-up",
        nodeNonce: randomBytes(32).toString("base64"),
        nodePublicKey: createIdentityKeyPair().publicKey,
        registrationHash: registrationHash(registration),
        dialedHostUrl: "https://fleet.example.com",
      },
    });
    expect(unknown.statusCode).toBe(401);

    const issued = await createGrant();
    const first = await enroll({ grant: issued.grant });
    expect(first.completed?.statusCode).toBe(201);
    const second = await enroll({ grant: issued.grant });
    expect(second.challenged.statusCode).toBe(401);
  });

  it("enrolls the Node against the exact key and payload it committed to", async () => {
    const { completed, keys } = await enroll();
    expect(completed?.statusCode).toBe(201);
    const receipt = completed?.json() as {
      nodeId: string;
      authProtocol: string;
      hostId: string;
      hostFingerprint: string;
    };

    expect(receipt.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    // Nothing reusable comes back: the Node's private key is its credential.
    expect(JSON.stringify(receipt)).not.toContain("secret");

    const nodes = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { id: string; name: string; authProtocol: string }[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe(receipt.nodeId);
    expect(nodes[0]?.name).toBe("alpha");
    expect(nodes[0]?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    expect(keys.publicKey).toBeTruthy();
  });

  /**
   * Everything else in this exchange is bound to a transcript both ends signed.
   * The receipt was not, and it is the one frame the Node writes to disk — the
   * Host it pins and the id it answers to from then on. Unsigned, a relay that
   * forwarded an honest enrolment still gets the last word.
   */
  it("signs the receipt over the transcript and the nodeId it issued", async () => {
    const { completed, fields } = await enroll();
    const receipt = completed?.json() as {
      nodeId: string;
      challengeId: string;
      hostId: string;
      hostPublicKey: string;
      hostFingerprint: string;
      signature: string;
    };

    expect(receipt.challengeId).toBe(fields?.challengeId);
    expect(receipt.hostFingerprint).toBe(identityFingerprint(receipt.hostPublicKey));
    expect(
      verifyIdentitySignature(
        receipt.hostPublicKey,
        enrollmentReceiptTranscript({ ...fields!, nodeId: receipt.nodeId }),
        receipt.signature,
      ),
    ).toBe(true);
    // Bound to the id that was issued, so one Node's receipt cannot be handed
    // to another as proof of its own enrolment.
    expect(
      verifyIdentitySignature(
        receipt.hostPublicKey,
        enrollmentReceiptTranscript({ ...fields!, nodeId: "someone-else" }),
        receipt.signature,
      ),
    ).toBe(false);
  });

  it("refuses a completion whose payload is not the one that was hashed", async () => {
    const { completed } = await enroll({
      completionPayload: { ...registration, maxSessions: 64 },
    });
    expect(completed?.statusCode).toBe(400);
  });

  it("refuses a completion signed by a different key", async () => {
    const issued = await createGrant();
    const parts = parseEnrollmentGrant(issued.grant);
    const honest = createIdentityKeyPair();
    const impostor = createIdentityKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const hash = registrationHash(registration);
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/enrollment/challenge",
        payload: {
          grantId: parts?.id,
          nodeNonce,
          nodePublicKey: honest.publicKey,
          registrationHash: hash,
          dialedHostUrl: "https://fleet.example.com",
        },
      })
    ).json() as NodeEnrollmentChallengeResponse;
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: honest.publicKey,
      registrationHash: hash,
      dialedHostUrl: "https://fleet.example.com",
    };

    const completed = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        challengeId: challenge.challengeId,
        registration,
        nodeSignature: signWithIdentity(
          impostor.privateKey,
          enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
        ),
        grantProof: grantProof(
          grantSecretDigest(parts?.secret ?? ""),
          enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
        ),
      },
    });
    expect(completed.statusCode).toBe(401);
  });

  it("refuses a completion whose grant proof is wrong, which is a relay", async () => {
    const issued = await createGrant();
    const parts = parseEnrollmentGrant(issued.grant);
    const keys = createIdentityKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const hash = registrationHash(registration);
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/enrollment/challenge",
        payload: {
          grantId: parts?.id,
          nodeNonce,
          nodePublicKey: keys.publicKey,
          registrationHash: hash,
          dialedHostUrl: "https://fleet.example.com",
        },
      })
    ).json() as NodeEnrollmentChallengeResponse;
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: keys.publicKey,
      registrationHash: hash,
      dialedHostUrl: "https://fleet.example.com",
    };

    const completed = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        challengeId: challenge.challengeId,
        registration,
        nodeSignature: signWithIdentity(
          keys.privateKey,
          enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
        ),
        // A relay that saw the whole exchange still never saw the secret.
        grantProof: grantProof(
          grantSecretDigest("a guess"),
          enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
        ),
      },
    });
    expect(completed.statusCode).toBe(401);
  });

  it("spends a challenge as well as a grant, so neither is replayed", async () => {
    const issued = await createGrant();
    const parts = parseEnrollmentGrant(issued.grant);
    const keys = createIdentityKeyPair();
    const nodeNonce = randomBytes(32).toString("base64");
    const hash = registrationHash(registration);
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/enrollment/challenge",
        payload: {
          grantId: parts?.id,
          nodeNonce,
          nodePublicKey: keys.publicKey,
          registrationHash: hash,
          dialedHostUrl: "https://fleet.example.com",
        },
      })
    ).json() as NodeEnrollmentChallengeResponse;
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: keys.publicKey,
      registrationHash: hash,
      dialedHostUrl: "https://fleet.example.com",
    };
    const body = {
      challengeId: challenge.challengeId,
      registration,
      nodeSignature: signWithIdentity(
        keys.privateKey,
        enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
      ),
      grantProof: grantProof(
        grantSecretDigest(parts?.secret ?? ""),
        enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
      ),
    };

    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/register", payload: body }))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/register", payload: body }))
        .statusCode,
    ).toBe(401);
  });

  it("keeps the legacy token path working for Nodes that still have one", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: { ...registration, name: "legacy", enrollmentToken: "test-token" },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json() as { nodeId: string; secret: string };
    expect(body.secret).toBeTruthy();
  });

  it("does not let the fleet-wide token authorise a key-based enrolment", async () => {
    const keys = createIdentityKeyPair();
    const refused = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        ...registration,
        enrollmentToken: "test-token",
        publicKey: keys.publicKey,
      },
    });
    expect(refused.statusCode).toBe(201);
    const nodes = (
      await app.inject({
        method: "GET",
        url: "/api/nodes",
        headers: { cookie: owner.cookie() },
      })
    ).json() as { authProtocol: string }[];
    // The token registers a shared-secret Node and nothing else: a public key
    // offered alongside it is not an upgrade path.
    expect(nodes.every((node) => node.authProtocol === "legacy-secret")).toBe(true);
  });

  it("refuses a bad token exactly as it always did", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: { ...registration, enrollmentToken: "wrong" },
    });
    expect(refused.statusCode).toBe(401);
  });
});
