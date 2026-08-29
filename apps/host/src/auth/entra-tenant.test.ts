import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "../store.js";
import { EntraConfigSchema, createEntraProvider, entraConfigFrom } from "./entra.js";
import { FleetAuth } from "./service.js";

const TENANT_UPPER = "72F988BF-86F1-41AF-91AB-2D7CD011DB47";
const TENANT_LOWER = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/**
 * A tenant is a GUID here, and only a GUID.
 *
 * Fleet authorises on `(tid, oid)` and compares the tenant Entra returns
 * against the one this Host was configured with. Entra returns the directory
 * GUID — never the domain the operator typed — so a Host configured with
 * `contoso.com` would send everybody to a login that authenticates correctly
 * and is then rejected for belonging to "a different tenant". Accepting the
 * domain is accepting a configuration that can never authenticate anybody.
 */
describe("Entra configuration", () => {
  it("refuses a tenant domain, naming what to use instead", () => {
    const parsed = EntraConfigSchema.safeParse({
      tenantId: "contoso.onmicrosoft.com",
      clientId: CLIENT,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/GUID/i);
  });

  it("normalises tenant and client casing so a comparison cannot miss", () => {
    const parsed = EntraConfigSchema.parse({
      tenantId: TENANT_UPPER,
      clientId: CLIENT.toUpperCase(),
    });
    expect(parsed.tenantId).toBe(TENANT_LOWER);
    expect(parsed.clientId).toBe(CLIENT);
  });

  it("ignores a stored domain rather than pointing the Host at one", () => {
    expect(
      entraConfigFrom({
        stored: { tenantId: "contoso.com", clientId: CLIENT },
        env: { tenantId: TENANT_UPPER, clientId: CLIENT },
      }),
    ).toEqual({ tenantId: TENANT_LOWER, clientId: CLIENT });
  });
});

describe("a Host configured with an upper-case tenant GUID", () => {
  it("accepts an identity Microsoft returns in lower case", async () => {
    const provider = createEntraProvider(
      EntraConfigSchema.parse({ tenantId: TENANT_UPPER, clientId: CLIENT }),
      {
        loadMsal: async () => ({
          redeem: async () => ({
            tenantId: TENANT_LOWER,
            objectId: "alice-object-id",
            username: "alice@example.com",
            displayName: "Alice",
          }),
        }),
      },
    );
    await expect(
      provider.redeemAuthorizationCode({
        code: "code",
        codeVerifier: "verifier",
        nonce: "nonce",
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
      }),
    ).resolves.toMatchObject({ objectId: "alice-object-id" });
  });

  it("still refuses an identity from another directory", async () => {
    const provider = createEntraProvider(
      EntraConfigSchema.parse({ tenantId: TENANT_UPPER, clientId: CLIENT }),
      {
        loadMsal: async () => ({
          redeem: async () => ({
            tenantId: "00000000-0000-0000-0000-000000000001",
            objectId: "mallory-object-id",
            username: "mallory@elsewhere.example",
            displayName: "Mallory",
          }),
        }),
      },
    );
    await expect(
      provider.redeemAuthorizationCode({
        code: "code",
        codeVerifier: "verifier",
        nonce: "nonce",
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
      }),
    ).rejects.toThrow(/different tenant/i);
  });
});

describe("saving Entra configuration", () => {
  const setup = () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    const auth = new FleetAuth({
      store,
      announceClaimCode: () => {},
      warn: () => {},
      externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    });
    return { auth, store };
  };

  it("stores the canonical lower-case GUID", () => {
    const { auth, store } = setup();
    auth.configureEntra({ tenantId: TENANT_UPPER, clientId: CLIENT.toUpperCase() });
    expect(store.getSetting("auth.entraTenantId")).toBe(TENANT_LOWER);
    expect(store.getSetting("auth.entraClientId")).toBe(CLIENT);
  });

  it("refuses a domain before it can be saved", () => {
    const { auth, store } = setup();
    expect(() =>
      auth.configureEntra({ tenantId: "contoso.com", clientId: CLIENT }),
    ).toThrow();
    expect(store.getSetting("auth.entraTenantId") ?? "").toBe("");
  });
});
