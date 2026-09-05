import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "../store.js";
import {
  EntraProviderUnavailableError,
  classifyEntraFailure,
  type EntraIdentity,
  type EntraProvider,
} from "./entra.js";
import { FleetAuth, MAX_DEVICE_FLOWS } from "./service.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

const bob: EntraIdentity = {
  tenantId: TENANT,
  objectId: "bob-object-id",
  username: "bob@example.com",
  displayName: "Bob",
};

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

type Harness = {
  auth: FleetAuth;
  store: FleetStore;
  started: { verification: boolean }[];
  cancelled: string[];
  live: Set<string>;
  answers: (identity: EntraIdentity) => void;
  /** Makes the next start fail the way Microsoft would, through the real classifier. */
  refuseWith: (error: unknown) => void;
  claimCode: () => string;
};

/**
 * A provider that behaves like the real one: it refuses a device operation
 * unless that particular call was allowed one, and it holds every flow it hands
 * out until something removes it.
 */
function setup(options: { deviceEnabled?: boolean } = {}): Harness {
  const store = new FleetStore(":memory:");
  stores.push(store);
  store.setSetting("auth.entraTenantId", TENANT);
  store.setSetting("auth.entraClientId", CLIENT);
  if (options.deviceEnabled) store.setSetting("auth.deviceFlowEnabled", "1");

  const started: { verification: boolean }[] = [];
  const cancelled: string[] = [];
  const live = new Set<string>();
  const announced: string[] = [];
  let identity: EntraIdentity = alice;
  let refusal: unknown;
  let sequence = 0;

  const provider: EntraProvider = {
    authorizationUrl: async ({ state }) => `https://login.example/?state=${state}`,
    redeemAuthorizationCode: async () => identity,
    startDeviceCode: async (input) => {
      const verification = input?.verification === true;
      // The gate the real provider applies: a Host that has not verified its
      // tenant may only start the one flow that is trying to verify it.
      if (!verification && store.getSetting("auth.deviceFlowEnabled") !== "1") {
        throw new EntraProviderUnavailableError("device sign-in is disabled");
      }
      // Routed through the production classifier, so what the service sees is
      // exactly what it would see from a real refusal.
      if (refusal) throw classifyEntraFailure(refusal);
      started.push({ verification });
      const flowId = `provider-flow-${(sequence += 1)}`;
      live.add(flowId);
      return {
        flowId,
        userCode: "ABC-DEF",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresAt: Date.now() + 600_000,
        message: "Enter ABC-DEF",
      };
    },
    pollDeviceCode: async ({ flowId }) => {
      if (!live.has(flowId)) {
        // The shape of a genuine Microsoft refusal: the code died before
        // anybody entered it.
        throw Object.assign(new Error("AADSTS70016: expired_token"), {
          errorCode: "expired_token",
        });
      }
      live.delete(flowId);
      return identity;
    },
    cancelDeviceCode: ({ flowId }) => {
      cancelled.push(flowId);
      live.delete(flowId);
    },
  };

  const auth = new FleetAuth({
    store,
    announceClaimCode: (code) => announced.push(code),
    warn: () => {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    entraProvider: () => provider,
  });
  return {
    auth,
    store,
    started,
    cancelled,
    live,
    answers: (next) => {
      identity = next;
    },
    refuseWith: (error) => {
      refusal = error;
    },
    claimCode: () => announced.at(-1) ?? "",
  };
}

/** Claims the Host through the authorization-code flow, the way an operator does. */
const claim = async (harness: Harness): Promise<void> => {
  const redeemed = harness.auth.redeemClaimCode(
    harness.claimCode(),
    "browser",
    "localhost:8787",
  );
  if (!redeemed.ok) throw new Error("expected the claim code to be accepted");
  const started = await harness.auth.startCodeLogin({
    binding: "browser",
    bootstrapToken: redeemed.token,
    host: "localhost:8787",
    redirectUri: "http://localhost:8787/api/auth/entra/callback",
  });
  if (!started.ok) throw new Error("expected the login to start");
  const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
  const completed = await harness.auth.completeCodeLogin({
    state,
    code: "code",
    binding: "browser",
    host: "localhost:8787",
  });
  if (!completed.ok) throw new Error("expected the claim to succeed");
};

/**
 * A verification is a question one administrator asks, not a switch anybody
 * else can lean on.
 *
 * Device sign-in is off until a Host has been shown its tenant permits it,
 * which makes the setting its own precondition — so a verification runs one
 * flow with the gate lifted. Lifting it for the process rather than for that
 * one flow means an anonymous caller who starts a device login at the same
 * moment walks through a door the operator never opened.
 */
describe("device flow verification", () => {
  it("does not let an ordinary device login ride on a verification in flight", async () => {
    const harness = setup();
    await claim(harness);

    const verification = await harness.auth.startDeviceVerification({
      administratorId: harness.auth.listAdministrators()[0]!.id,
      binding: "admin-browser",
    });
    expect(verification.ok).toBe(true);

    // While that flow is open and unanswered, a stranger asks for one of their
    // own. This Host's persisted setting still says no.
    const stranger = await harness.auth.startDeviceLogin({
      binding: "stranger-browser",
      bootstrapToken: undefined,
      host: "localhost:8787",
    });
    expect(stranger.ok).toBe(false);
    expect(harness.started.filter((entry) => !entry.verification)).toHaveLength(0);
  });

  it("refuses to complete a verification another administrator started", async () => {
    const harness = setup();
    await claim(harness);
    const verification = await harness.auth.startDeviceVerification({
      administratorId: harness.auth.listAdministrators()[0]!.id,
      binding: "admin-browser",
    });
    if (!verification.ok) throw new Error("expected the verification to start");

    const impostor = await harness.auth.completeDeviceVerification({
      flowId: verification.flow.flowId,
      binding: "admin-browser",
      administratorId: "some-other-administrator",
    });
    expect(impostor.ok).toBe(false);
    expect(harness.store.getSetting("auth.deviceFlowEnabled")).not.toBe("1");
  });

  it("will not let a verification flow be redeemed for a Fleet session", async () => {
    const harness = setup();
    await claim(harness);
    const verification = await harness.auth.startDeviceVerification({
      administratorId: harness.auth.listAdministrators()[0]!.id,
      binding: "admin-browser",
    });
    if (!verification.ok) throw new Error("expected the verification to start");

    const stolen = await harness.auth.pollDeviceLogin({
      flowId: verification.flow.flowId,
      binding: "admin-browser",
      host: "localhost:8787",
    });
    expect(stolen.ok).toBe(false);
  });

  /*
   * Conditional Access blocking this flow is the documented default, not a
   * malfunction. It has to survive being turned into Fleet's own words on the
   * way out: a Host that reported it as a generic provider outage would tell an
   * administrator to retry something their tenant will refuse forever, instead
   * of pointing at the local forward that works.
   */
  it("reports a Conditional Access block as its own named state", async () => {
    const harness = setup();
    await claim(harness);
    harness.refuseWith(
      Object.assign(
        new Error("AADSTS53003: Access has been blocked by Conditional Access policies"),
        {
          errorCode: "unauthorized_client",
        },
      ),
    );

    const outcome = await harness.auth.startDeviceVerification({
      administratorId: harness.auth.listAdministrators()[0]!.id,
      binding: "admin-browser",
    });
    expect(outcome).toMatchObject({ ok: false, code: "device-blocked", blocked: true });
  });
});

/**
 * A flow the Host has forgotten is a flow the provider is still holding.
 *
 * Every device operation started here has a live MSAL polling loop behind it.
 * When the browser closes its tab, the Host has to be the thing that ends it —
 * otherwise the two maps drift and the process keeps asking Microsoft about a
 * sign-in nobody is waiting for.
 */
describe("device flow bookkeeping", () => {
  it("cancels the provider's flow when a poll fails", async () => {
    const harness = setup({ deviceEnabled: true });
    await claim(harness);
    const started = await harness.auth.startDeviceLogin({
      binding: "browser",
      bootstrapToken: undefined,
      host: "localhost:8787",
    });
    if (!started.ok) throw new Error("expected the device login to start");

    // Microsoft refuses. The Host must drop its own record and tell the
    // provider to stop, rather than leaving an entry that can never settle.
    harness.live.clear();
    const polled = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "browser",
      host: "localhost:8787",
    });
    expect(polled.ok).toBe(false);
    expect(harness.cancelled).toHaveLength(1);

    const again = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "browser",
      host: "localhost:8787",
    });
    expect(again).toMatchObject({ ok: false, code: "expired" });
  });

  it.each(["login", "verification"] as const)(
    "cancels an evicted %s flow",
    async (kind) => {
      const harness = setup({ deviceEnabled: true });
      await claim(harness);
      const administratorId = harness.auth.listAdministrators()[0]!.id;
      for (let index = 0; index <= MAX_DEVICE_FLOWS; index += 1) {
        const binding = `browser-${index}`;
        const started =
          kind === "login"
            ? await harness.auth.startDeviceLogin({
                binding,
                bootstrapToken: undefined,
                host: "localhost:8787",
              })
            : await harness.auth.startDeviceVerification({ binding, administratorId });
        expect(started.ok).toBe(true);
      }
      expect(harness.cancelled).toHaveLength(1);
      expect(harness.live.size).toBe(MAX_DEVICE_FLOWS);
    },
  );

  it("forgets a settled login on both sides", async () => {
    const harness = setup({ deviceEnabled: true });
    await claim(harness);
    const started = await harness.auth.startDeviceLogin({
      binding: "browser",
      bootstrapToken: undefined,
      host: "localhost:8787",
    });
    if (!started.ok) throw new Error("expected the device login to start");

    const polled = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "browser",
      host: "localhost:8787",
    });
    expect(polled.ok).toBe(true);
    expect(harness.live.size).toBe(0);

    const again = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "browser",
      host: "localhost:8787",
    });
    expect(again.ok).toBe(false);
  });
});

/**
 * An invitation is redeemed by signing in, and device sign-in is the only way
 * to sign in from a public origin.
 *
 * A candidate who can reach the Host only through its tunnel would otherwise
 * authenticate, be told they are not an administrator, and leave no trace for
 * the inviting administrator to approve — making the invitation unusable for
 * exactly the people it exists to reach.
 */
describe("device login carrying an invitation", () => {
  it("records a candidate rather than refusing outright", async () => {
    const harness = setup({ deviceEnabled: true });
    await claim(harness);
    const administrator = harness.auth.listAdministrators()[0]!;
    const invitation = harness.auth.createInvitation(administrator.id);

    const started = await harness.auth.startDeviceLogin({
      binding: "candidate-browser",
      bootstrapToken: undefined,
      host: "localhost:8787",
      invitation: invitation.token,
    });
    if (!started.ok) throw new Error("expected the device login to start");

    // Somebody who is not yet an administrator answers the code.
    harness.answers(bob);
    const outcome = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "candidate-browser",
      host: "localhost:8787",
    });
    expect(outcome).toMatchObject({ ok: false, code: "pending-approval" });
    expect(harness.auth.listPendingCandidates()).toHaveLength(1);
    expect(harness.auth.listPendingCandidates()[0]?.candidateObjectId).toBe(bob.objectId);
  });

  it("still refuses a stranger who carries no invitation", async () => {
    const harness = setup({ deviceEnabled: true });
    await claim(harness);
    const started = await harness.auth.startDeviceLogin({
      binding: "stranger-browser",
      bootstrapToken: undefined,
      host: "localhost:8787",
    });
    if (!started.ok) throw new Error("expected the device login to start");
    harness.answers(bob);
    const outcome = await harness.auth.pollDeviceLogin({
      flowId: started.flow.flowId,
      binding: "stranger-browser",
      host: "localhost:8787",
    });
    expect(outcome).toMatchObject({ ok: false, code: "not-authorized" });
    expect(harness.auth.listPendingCandidates()).toHaveLength(0);
  });
});
