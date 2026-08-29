import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  PublicClientApplication,
  type AuthenticationResult,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
  type DeviceCodeRequest,
} from "@azure/msal-node";
import { z } from "zod";
import type { AuthErrorCode } from "@fleet/protocol";

/**
 * A tenant is named by its directory GUID, and only by its GUID.
 *
 * Entra returns the directory id in every token; it never returns the domain
 * an operator typed. Fleet compares the two, so a Host configured with
 * `contoso.com` would authenticate people correctly and then refuse every one
 * of them for belonging to "a different tenant" — a configuration that can
 * never work, accepted at the point where it is still cheap to reject.
 */
const GUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const TENANT_MESSAGE =
  "Tenant ID must be the directory (tenant) GUID from Entra, not a domain name";

/**
 * The two values that identify this Host's app registration.
 *
 * Neither is a secret — a public client has none — which is why they can be
 * typed into a first-run form and stored in the clear. What they are is
 * authorisation-relevant: the tenant decides whose identities this Host will
 * even consider. Both are lower-cased on the way in, because a GUID's casing
 * carries no meaning and a case-sensitive comparison against one Entra
 * returned would fail for a reason nobody could see.
 */
export const EntraConfigSchema = z.object({
  tenantId: z
    .string()
    .trim()
    .regex(GUID_RE, TENANT_MESSAGE)
    .transform((value) => value.toLowerCase()),
  clientId: z
    .string()
    .trim()
    .regex(GUID_RE, "Client ID must be an application GUID")
    .transform((value) => value.toLowerCase()),
});

export type EntraConfig = z.infer<typeof EntraConfigSchema>;

/**
 * A person as Entra validated them.
 *
 * `tenantId` and `objectId` are the authorisation keys. The other two are
 * display metadata: the `email` scope does not guarantee an `email` claim, and
 * `preferred_username` is mutable, so neither is ever compared against
 * anything.
 */
export type EntraIdentity = {
  tenantId: string;
  objectId: string;
  username: string;
  displayName: string;
};

export type DeviceCodeStarted = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  message: string;
};

/**
 * Whether this particular call is allowed a device operation.
 *
 * Device sign-in stays off until a Host has been shown its tenant permits it,
 * which makes the setting its own precondition — an administrator could never
 * find out. A verification lifts the gate for the one flow it starts, and only
 * for that flow: lifting it for the process would mean any anonymous caller
 * who asked at the same moment walked through a door nobody opened.
 */
export type DeviceCodeOptions = { verification?: boolean };

export type AuthorizationUrlInput = {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
};

export type RedeemAuthorizationCodeInput = {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
};

/**
 * Everything the Host asks Microsoft to do.
 *
 * An interface rather than a direct MSAL dependency so the authorisation rules
 * around it can be tested without a tenant, and so the one place that talks
 * OAuth stays one place. Fleet never validates a token itself: signature,
 * issuer, audience, nonce, and expiry are MSAL's job, and re-implementing them
 * is how subtle acceptance bugs get written.
 */
export type EntraProvider = {
  authorizationUrl: (input: AuthorizationUrlInput) => Promise<string>;
  redeemAuthorizationCode: (
    input: RedeemAuthorizationCodeInput,
  ) => Promise<EntraIdentity>;
  startDeviceCode: (options?: DeviceCodeOptions) => Promise<DeviceCodeStarted>;
  pollDeviceCode: (input: {
    flowId: string;
    options?: DeviceCodeOptions;
  }) => Promise<EntraIdentity>;
  /**
   * Ends a flow the Host has stopped caring about.
   *
   * The provider's polling loop outlives the browser that started it, so the
   * Host has to be the thing that stops it. Without this the two maps drift and
   * an abandoned tab leaves a loop asking Microsoft about a code nobody will
   * ever enter.
   */
  cancelDeviceCode: (input: { flowId: string }) => void;
};

/**
 * The MSAL-shaped half, kept minimal.
 *
 * Everything is optional except redemption because a build without the optional
 * `@azure/msal-node` dependency, or a tenant with device flow switched off,
 * must produce a named refusal rather than a half-working provider.
 */
export type MsalAdapter = {
  redeem: (input: RedeemAuthorizationCodeInput) => Promise<EntraIdentity>;
  authorizationUrl?: (input: AuthorizationUrlInput) => Promise<string>;
  deviceCode?: () => Promise<DeviceCodeStarted>;
  pollDevice?: (input: { flowId: string }) => Promise<EntraIdentity>;
  cancelDevice?: (input: { flowId: string }) => void;
};

type MsalAccount = {
  tenantId: string;
  localAccountId: string;
  username: string;
  name?: string | undefined;
};

type MsalResult = {
  tenantId: string;
  uniqueId: string;
  account: MsalAccount | null;
};

export type MsalClient = {
  getAuthCodeUrl: (request: AuthorizationUrlRequest) => Promise<string>;
  acquireTokenByCode: (request: AuthorizationCodeRequest) => Promise<MsalResult>;
  acquireTokenByDeviceCode: (request: DeviceCodeRequest) => Promise<MsalResult | null>;
  removeAccount: (account: MsalAccount) => Promise<void>;
};

/** Raised when Microsoft sign-in cannot be attempted at all. */
export class EntraProviderUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(reason: string, cause?: unknown) {
    super(
      `Microsoft sign-in is not available on this Host: ${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "EntraProviderUnavailableError";
  }
}

/** Raised when Microsoft authenticated somebody this Host will not consider. */
export class EntraIdentityRejectedError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "EntraIdentityRejectedError";
  }
}

/**
 * Raised when a sign-in attempt did not succeed, for a reason that is ordinary.
 *
 * A code redeemed twice, a browser left open past the transaction's ten
 * minutes, a person who pressed Cancel: none of these is a malfunction, and
 * none may reach an operator as a stack trace or a framework 500. The `code`
 * is what the callback puts in a redirect and the app looks up its own words
 * for; the message here is Fleet's, never the provider's — the provider's is
 * kept as the `cause`, for the log and for the callers that still have to tell
 * one refusal from another.
 */
export class EntraAuthenticationFailedError extends Error {
  readonly statusCode = 400;
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EntraAuthenticationFailedError";
    this.code = code;
  }
}

/** Every string MSAL might put a reason in, flattened into one haystack. */
export function entraFailureText(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as {
    errorCode?: unknown;
    errorMessage?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const parts = [error.message, extra.errorCode, extra.errorMessage, extra.code].filter(
    (value) => typeof value === "string",
  );
  /*
   * The chain matters, not just the top. Classification replaces a provider's
   * sentence with Fleet's own — which is the point, because the provider's can
   * name an account — but the caller that has to tell "Conditional Access says
   * no" apart from "Microsoft is having a bad day" still needs the original.
   */
  if (extra.cause !== undefined && depth < 4) {
    parts.push(entraFailureText(extra.cause, depth + 1));
  }
  return parts.join(" ");
}

/** A code redeemed twice, a stale transaction, a mismatched nonce or state. */
const SPENT_OR_STALE =
  /invalid_grant|AADSTS(54005|70008|70000|50173|9002313)|nonce[_ ]?mismatch|state[_ ]?mismatch|invalid[_ ]?state|invalid[_ ]?nonce|invalid[_ ]?token|token.{0,20}(expired|validation)|expired[_ ]?token|authorization[_ ]?pending/i;

/** The person said no, which is an answer rather than a failure. */
const DECLINED = /access_denied|AADSTS(65004|65001)|user_cancelled|consent_required/i;

/** Nothing to talk to: DNS, TCP, TLS, proxy, or a bare fetch failure. */
const UNREACHABLE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_|self[- ]signed certificate|fetch failed|network[_ ]?error|socket hang up|request to .* failed/i;

/** A registration or tenant policy problem: nothing the operator can retry. */
const MISCONFIGURED =
  /unauthorized_client|invalid_client|invalid_request|AADSTS(700016|7000215|700051|900023|50011|50194|53003|50199)|conditional access|blocked|not allowed|disabled/i;

/** Anything Microsoft numbered is Microsoft's answer, not a fault in Fleet. */
const MICROSOFT_ORIGIN = /AADSTS\d+/i;

function fromMicrosoft(error: unknown, text: string): boolean {
  if (MICROSOFT_ORIGIN.test(text)) return true;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && code.length > 0;
}

/**
 * Turns whatever Microsoft threw into something Fleet is willing to say.
 *
 * Two rules govern this. First, no provider text leaves the Host: it lands in
 * an address bar and can name the account that failed, so Fleet supplies its
 * own sentence and leaves Microsoft's for the log. Second, an error this does
 * not recognise is returned untouched — a `TypeError` from Fleet's own code is
 * a bug, and dressing it up as "provider unavailable" is how a bug becomes a
 * mystery.
 */
export function classifyEntraFailure(error: unknown): unknown {
  if (
    error instanceof EntraProviderUnavailableError ||
    error instanceof EntraIdentityRejectedError ||
    error instanceof EntraAuthenticationFailedError
  ) {
    return error;
  }
  const text = entraFailureText(error);
  if (DECLINED.test(text)) {
    return new EntraAuthenticationFailedError(
      "cancelled",
      "That sign-in was cancelled.",
      error,
    );
  }
  if (SPENT_OR_STALE.test(text)) {
    return new EntraAuthenticationFailedError(
      "expired",
      "That sign-in expired or was already used. Start another.",
      error,
    );
  }
  if (UNREACHABLE.test(text)) {
    return new EntraProviderUnavailableError(
      "this Host could not reach Microsoft",
      error,
    );
  }
  if (MISCONFIGURED.test(text)) {
    return new EntraProviderUnavailableError(
      "Microsoft refused this Host's sign-in configuration",
      error,
    );
  }
  /*
   * A refusal Fleet has no specific words for is still Microsoft's refusal, and
   * its text can name the account that failed. It becomes a generic, safe
   * sentence rather than a `500` carrying provider output into an address bar.
   */
  if (fromMicrosoft(error, text)) {
    return new EntraProviderUnavailableError(
      "Microsoft did not complete that sign-in",
      error,
    );
  }
  return error;
}

/** Applies {@link classifyEntraFailure} to whatever a provider call rejects with. */
async function named<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw classifyEntraFailure(error);
  }
}

export type EntraConfigSources = {
  stored: { tenantId: string; clientId: string } | undefined;
  env: { tenantId: string; clientId: string } | undefined;
};

/**
 * What an administrator saved, or failing that what the distribution shipped.
 *
 * Stored wins so that an administrator who reconfigures a Host is not silently
 * overruled by a variable left in the environment. A half-filled pair is
 * treated as no configuration at all: a client ID without a tenant cannot
 * authorise anybody, and pretending otherwise produces a login form that
 * always fails.
 */
export function entraConfigFrom(sources: EntraConfigSources): EntraConfig | undefined {
  for (const candidate of [sources.stored, sources.env]) {
    if (!candidate) continue;
    const parsed = EntraConfigSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** How long a started login has to come back before it is forgotten. */
export const AUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** A ceiling on concurrent logins, so a public URL cannot exhaust memory. */
export const MAX_AUTH_TRANSACTIONS = 500;

export type AuthTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  binding: string;
  /** Whether this login carries a live bootstrap grant and may claim. */
  bootstrap: boolean;
  /** The grant to consume on success, so the claim spends it exactly once. */
  grantToken: string | undefined;
  /** An admin invitation being redeemed, if the login started from a link. */
  invitation: string | undefined;
  redirectUri: string;
  expiresAt: number;
};

export type StartTransactionInput = {
  binding: string;
  bootstrap: boolean;
  grantToken?: string | undefined;
  invitation?: string | undefined;
  redirectUri?: string | undefined;
};

/**
 * The pending half of a login.
 *
 * In memory and bounded on purpose. A transaction is a capability — whoever
 * holds its `state` can complete the login it started — so one that survived a
 * restart would be a credential with no way to revoke it, and one that survived
 * a flood would be a way to exhaust the Host.
 */
export class EntraTransactions {
  private readonly now: () => number;
  private readonly byState = new Map<string, AuthTransaction>();
  private readonly byBinding = new Map<string, string>();

  constructor(options: { now?: (() => number) | undefined } = {}) {
    this.now = options.now ?? Date.now;
  }

  start(input: StartTransactionInput): AuthTransaction {
    this.sweep();
    // One in flight per browser: a second start replaces the first rather than
    // leaving two states that both complete.
    const previous = this.byBinding.get(input.binding);
    if (previous) this.byState.delete(previous);
    if (this.byState.size >= MAX_AUTH_TRANSACTIONS) this.evictOldest();

    const codeVerifier = randomBytes(48).toString("base64url");
    const transaction: AuthTransaction = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      binding: input.binding,
      bootstrap: input.bootstrap,
      grantToken: input.grantToken,
      invitation: input.invitation,
      redirectUri: input.redirectUri ?? "",
      expiresAt: this.now() + AUTH_TRANSACTION_TTL_MS,
    };
    this.byState.set(transaction.state, transaction);
    this.byBinding.set(input.binding, transaction.state);
    return transaction;
  }

  /** Single use: the callback that redeems a state is the only one that can. */
  consume(state: string | undefined): AuthTransaction | undefined {
    if (!state) return undefined;
    const transaction = this.byState.get(state);
    if (!transaction) return undefined;
    this.byState.delete(state);
    if (this.byBinding.get(transaction.binding) === state) {
      this.byBinding.delete(transaction.binding);
    }
    if (transaction.expiresAt <= this.now()) return undefined;
    return transaction;
  }

  size(): number {
    return this.byState.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, transaction] of this.byState) {
      if (transaction.expiresAt <= now) {
        this.byState.delete(state);
        if (this.byBinding.get(transaction.binding) === state) {
          this.byBinding.delete(transaction.binding);
        }
      }
    }
  }

  private evictOldest(): void {
    const oldest = [...this.byState].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) return;
    this.byState.delete(oldest[0]);
    if (this.byBinding.get(oldest[1].binding) === oldest[0]) {
      this.byBinding.delete(oldest[1].binding);
    }
  }
}

export type EntraProviderDeps = {
  loadMsal?: (config: EntraConfig) => Promise<MsalAdapter>;
  /** Off until a Host has proved its tenant's Conditional Access allows it. */
  deviceFlowEnabled?: () => boolean;
};

/**
 * The provider the Host actually calls, with Fleet's own rules around it.
 *
 * Two of those rules are not MSAL's to enforce. The tenant check is Fleet's
 * because a misconfigured authority would otherwise let another directory's
 * users through, and Fleet keys authorisation on `(tid, oid)` — a matching
 * `oid` from the wrong tenant is a different person. The device-flow gate is
 * Fleet's because Microsoft recommends blocking that flow by default and a
 * Host must not offer it until its tenant has been shown to permit it.
 *
 * Every failure path here throws. There is no branch that returns an identity
 * it could not obtain, and none that downgrades to a weaker check.
 */
export function createEntraProvider(
  config: EntraConfig,
  deps: EntraProviderDeps = {},
): EntraProvider {
  const load = deps.loadMsal ?? loadMsalNode;
  const deviceFlowEnabled = deps.deviceFlowEnabled ?? (() => false);
  let adapterPromise: Promise<MsalAdapter> | undefined;

  const adapter = async (): Promise<MsalAdapter> => {
    try {
      adapterPromise ??= load(config);
      return await adapterPromise;
    } catch (error) {
      adapterPromise = undefined;
      throw new EntraProviderUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const checkTenant = (identity: EntraIdentity): EntraIdentity => {
    // GUID casing is not meaningful, and Entra is not obliged to echo back the
    // spelling this Host was configured with.
    if (identity.tenantId.toLowerCase() !== config.tenantId.toLowerCase()) {
      throw new EntraIdentityRejectedError(
        "That account belongs to a different tenant than this Host is configured for.",
      );
    }
    if (!identity.objectId) {
      throw new EntraIdentityRejectedError(
        "Microsoft returned no object id for that account.",
      );
    }
    return identity;
  };

  /*
   * The gate, applied per call rather than per process. A verification is the
   * one operation allowed to run while the switch is off, because it is the
   * operation that decides the switch.
   */
  const requireDeviceFlow = (options: DeviceCodeOptions | undefined): void => {
    if (options?.verification === true) return;
    if (deviceFlowEnabled()) return;
    throw new EntraProviderUnavailableError(
      "device sign-in is disabled until this tenant's policy has been verified",
    );
  };

  return {
    authorizationUrl: async (input) => {
      const msal = await adapter();
      if (!msal.authorizationUrl) {
        throw new EntraProviderUnavailableError(
          "the configured provider cannot build an authorization URL",
        );
      }
      return named(msal.authorizationUrl(input));
    },
    redeemAuthorizationCode: async (input) => {
      const msal = await adapter();
      return checkTenant(await named(msal.redeem(input)));
    },
    startDeviceCode: async (options) => {
      requireDeviceFlow(options);
      const msal = await adapter();
      if (!msal.deviceCode) {
        throw new EntraProviderUnavailableError(
          "the configured provider does not support device sign-in",
        );
      }
      return named(msal.deviceCode());
    },
    pollDeviceCode: async (input) => {
      requireDeviceFlow(input.options);
      const msal = await adapter();
      if (!msal.pollDevice) {
        throw new EntraProviderUnavailableError(
          "the configured provider does not support device sign-in",
        );
      }
      return checkTenant(await named(msal.pollDevice({ flowId: input.flowId })));
    },
    cancelDeviceCode: ({ flowId }) => {
      // Best effort and never awaited: the caller is discarding a flow, and a
      // provider that has not loaded has nothing to cancel.
      void adapterPromise
        ?.then((msal) => msal.cancelDevice?.({ flowId }))
        .catch(() => undefined);
    },
  };
}

const IDENTITY_SCOPES = ["openid", "profile", "email"];

/**
 * How many device flows one Host will hold open at once.
 *
 * Each one is a live MSAL polling loop against Microsoft that outlives the
 * browser which asked for it. The Host's own map is bounded too, but this is
 * the bound that matters: it is the one standing between a reachable public
 * endpoint and an unbounded number of outbound polling loops.
 */
export const MAX_PROVIDER_DEVICE_FLOWS = 25;

/** How many may be started in a burst before the caller has to wait. */
export const PROVIDER_DEVICE_START_BURST = 30;

/** How fast the burst refills, so a steady trickle is still allowed through. */
export const PROVIDER_DEVICE_START_REFILL_MS = 5_000;

/** A ceiling on how long one flow may live, whatever expiry Microsoft returns. */
export const MAX_PROVIDER_DEVICE_FLOW_MS = 20 * 60 * 1000;

type ProviderDeviceFlow = {
  result: Promise<EntraIdentity>;
  request: DeviceCodeRequest;
  expiresAt: number;
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
};

/**
 * Adapts MSAL's token-shaped result into the only thing Fleet retains: who
 * Microsoft authenticated.
 *
 * The device half owns its own lifetime. A browser can close its tab, lose its
 * network, or simply stop polling, and none of that reaches MSAL — so every
 * flow started here carries a cancel flag MSAL reads on each iteration, a timer
 * that trips it at expiry, a handler attached before anybody can await it, and
 * a place in a bounded, rate-limited map that removes it the moment it settles.
 */
export function createMsalAdapter(_config: EntraConfig, client: MsalClient): MsalAdapter {
  const flows = new Map<string, ProviderDeviceFlow>();
  let burst = PROVIDER_DEVICE_START_BURST;
  let refilledAt = Date.now();

  const identity = async (result: MsalResult | null): Promise<EntraIdentity> => {
    if (!result) throw new Error("Microsoft returned no authentication result");
    const objectId = result.uniqueId || result.account?.localAccountId || "";
    if (!result.tenantId || !objectId) {
      throw new Error("Microsoft returned no tenant or object id");
    }
    const account = result.account;
    const resolved = {
      tenantId: result.tenantId,
      objectId,
      username: account?.username ?? "",
      displayName: account?.name ?? "",
    };
    if (account) await client.removeAccount(account);
    return resolved;
  };

  const forget = (flowId: string): void => {
    const flow = flows.get(flowId);
    if (!flow) return;
    if (flow.timer) clearTimeout(flow.timer);
    flows.delete(flowId);
  };

  /** Tells MSAL to stop on its next iteration and drops the bookkeeping. */
  const cancel = (flowId: string): void => {
    const flow = flows.get(flowId);
    if (!flow) return;
    flow.request.cancel = true;
    forget(flowId);
  };

  /** (Re)schedules the deadline this flow dies at, whoever is still watching. */
  const arm = (flow: ProviderDeviceFlow, flowId: string, expiresAt: number): void => {
    flow.expiresAt = expiresAt;
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = setTimeout(() => cancel(flowId), Math.max(0, expiresAt - Date.now()));
    flow.timer.unref?.();
  };

  const sweep = (): void => {
    const now = Date.now();
    for (const [flowId, flow] of [...flows]) {
      if (flow.settled || flow.expiresAt <= now) cancel(flowId);
    }
  };

  /** A token bucket, so a reachable endpoint cannot become a flood of loops. */
  const spendStartAllowance = (): void => {
    const now = Date.now();
    const refilled = Math.floor((now - refilledAt) / PROVIDER_DEVICE_START_REFILL_MS);
    if (refilled > 0) {
      burst = Math.min(PROVIDER_DEVICE_START_BURST, burst + refilled);
      refilledAt = now;
    }
    if (burst <= 0) {
      throw new EntraProviderUnavailableError(
        "too many device sign-ins have been started recently; slow down and try again",
      );
    }
    burst -= 1;
  };

  return {
    authorizationUrl: (input) =>
      client.getAuthCodeUrl({
        scopes: [...IDENTITY_SCOPES],
        redirectUri: input.redirectUri,
        state: input.state,
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: "S256",
        responseMode: "query",
        prompt: "select_account",
      }),
    redeem: (input) =>
      client
        .acquireTokenByCode({
          scopes: [...IDENTITY_SCOPES],
          redirectUri: input.redirectUri,
          code: input.code,
          codeVerifier: input.codeVerifier,
          nonce: input.nonce,
        })
        .then(identity),
    deviceCode: async () => {
      sweep();
      if (flows.size >= MAX_PROVIDER_DEVICE_FLOWS) {
        throw new EntraProviderUnavailableError(
          "too many device sign-ins are already in progress on this Host",
        );
      }
      spendStartAllowance();

      const flowId = randomUUID();
      let announce: ((started: DeviceCodeStarted) => void) | undefined;
      let rejectStart: ((error: unknown) => void) | undefined;
      let expiresAt = Date.now() + MAX_PROVIDER_DEVICE_FLOW_MS;
      const started = new Promise<DeviceCodeStarted>((resolve, reject) => {
        announce = resolve;
        rejectStart = reject;
      });
      /*
       * A live object rather than a snapshot: MSAL re-reads `cancel` on every
       * poll, so flipping it here is what actually ends the loop. `timeout`
       * bounds the same thing from MSAL's side in case nothing ever flips it.
       */
      const request: DeviceCodeRequest = {
        scopes: [...IDENTITY_SCOPES],
        cancel: false,
        timeout: Math.floor(MAX_PROVIDER_DEVICE_FLOW_MS / 1_000),
        deviceCodeCallback: (response) => {
          expiresAt = Math.min(
            Date.now() + response.expiresIn * 1_000,
            Date.now() + MAX_PROVIDER_DEVICE_FLOW_MS,
          );
          // The callback may fire before or after the record exists, depending
          // on whether MSAL calls it synchronously; whichever happens second
          // is the one that arms the timer.
          const flow = flows.get(flowId);
          if (flow) arm(flow, flowId, expiresAt);
          announce?.({
            flowId,
            userCode: response.userCode,
            verificationUri: response.verificationUri,
            expiresAt,
            message: response.message,
          });
          announce = undefined;
          rejectStart = undefined;
        },
      };

      const result = client.acquireTokenByDeviceCode(request).then(identity);
      const record: ProviderDeviceFlow = {
        result,
        request,
        expiresAt,
        timer: undefined,
        settled: false,
      };
      flows.set(flowId, record);
      arm(record, flowId, expiresAt);

      /*
       * Attached now, not when somebody polls. A rejection with no handler
       * takes the process down under Node's default, and the whole point of
       * this map is that nobody may ever come back for the answer.
       */
      result.then(
        () => {
          record.settled = true;
          forget(flowId);
        },
        (error: unknown) => {
          record.settled = true;
          forget(flowId);
          rejectStart?.(error);
        },
      );

      return started;
    },
    pollDevice: async ({ flowId }) => {
      const flow = flows.get(flowId);
      if (!flow) {
        // Cancelled, expired, or already settled. All three are ordinary, so
        // this is a named refusal rather than something a route has to guess at.
        throw new EntraAuthenticationFailedError(
          "expired",
          "That device sign-in is no longer available. Start another.",
        );
      }
      try {
        return await flow.result;
      } finally {
        forget(flowId);
      }
    },
    cancelDevice: ({ flowId }) => cancel(flowId),
  };
}

/** The production public-client adapter. No cache plugin persists tokens. */
async function loadMsalNode(config: EntraConfig): Promise<MsalAdapter> {
  const application = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
  });
  return createMsalAdapter(config, {
    getAuthCodeUrl: (request) => application.getAuthCodeUrl(request),
    acquireTokenByCode: (request) => application.acquireTokenByCode(request),
    acquireTokenByDeviceCode: (request) => application.acquireTokenByDeviceCode(request),
    removeAccount: (account) =>
      application
        .getTokenCache()
        .removeAccount(account as AuthenticationResult["account"] & MsalAccount),
  });
}

/** A flow id for a device login, distinct from the user code Microsoft shows. */
export function newDeviceFlowId(): string {
  return randomUUID();
}
