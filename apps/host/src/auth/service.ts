import { createHash, randomBytes } from "node:crypto";
import { OperatorPasswordSchema, type AuthErrorCode } from "@fleet/protocol";
import { OperatorAuth, generatePassword, hashPassword } from "../auth.js";
import type {
  Administrator,
  AdministratorInvitation,
  FleetStore,
  OperatorAuthMethod,
  RevokedSession,
  SecurityAuditInput,
} from "../store.js";
import { ClaimCodeService, type ClaimRedeemOutcome } from "./claim.js";
import {
  EntraAuthenticationFailedError,
  EntraConfigSchema,
  EntraIdentityRejectedError,
  EntraProviderUnavailableError,
  EntraTransactions,
  classifyEntraFailure,
  createEntraProvider,
  entraConfigFrom,
  entraFailureText,
  type AuthTransaction,
  type DeviceCodeStarted,
  type EntraConfig,
  type EntraConfigInput,
  type EntraIdentity,
  type EntraProvider,
} from "./entra.js";
import {
  classifyRequestHost,
  cookieSecure,
  endpointLabel,
  externalSchemeMap,
  sessionIssuanceAllowed,
  type ExternalSchemeSources,
  type SchemeDecision,
} from "./external-scheme.js";
import {
  OperatorSessions,
  hasRecentCodeReauth,
  type ActiveSession,
  type IssuedSession,
} from "./sessions.js";
import { deriveAuthState, resolvePasswordMode, type AuthState } from "./state.js";

export const AUTH_MODE_SETTING = "auth.mode";
export const PASSWORD_ENABLED_SETTING = "auth.passwordEnabled";
export const PASSWORD_RECOVERY_SETTING = "auth.passwordIsRecovery";
export const PASSWORD_EXPLICIT_SETTING = "auth.passwordExplicitlyEnabled";
export const ENTRA_TENANT_SETTING = "auth.entraTenantId";
export const ENTRA_CLIENT_SETTING = "auth.entraClientId";
export const DEVICE_FLOW_SETTING = "auth.deviceFlowEnabled";
export const CSRF_KEY_SETTING = "auth.csrfKey";

/** An admin invitation is short-lived and single-use by construction. */
export const INVITATION_TTL_MS = 15 * 60 * 1000;
export { MIN_OPERATOR_PASSWORD_LENGTH } from "@fleet/protocol";

/** A ceiling on concurrent device logins, per the design's bounds. */
export const MAX_DEVICE_FLOWS = 50;

/** What the browser is told about a device login it just started. */
export type DeviceFlowStartedResponse = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: string;
};

type DeviceFlowRecord = {
  binding: string;
  providerFlowId: string;
  provider: EntraProvider;
  configurationKey: string;
  polling?: boolean;
  bootstrap: boolean;
  grantToken: string | undefined;
  /** An admin invitation being redeemed, if the login started from a link. */
  invitation: string | undefined;
  expiresAt: number;
  /** A policy check rather than a sign-in; it produces a setting, not a session. */
  verifying?: boolean;
  /**
   * Which administrator asked, for a verification.
   *
   * A verification runs with the device gate lifted, so it is the one flow that
   * must not be completable by anybody else: the allowance belongs to that
   * administrator's question, not to the Host for the duration.
   */
  administratorId?: string;
};

export type AuthFailure = {
  ok: false;
  status: number;
  error: string;
  /**
   * Why, as a code the browser can render its own words for.
   *
   * A failed callback is a redirect back into the app rather than a JSON body,
   * and the app must not paste a server sentence onto its sign-in screen. The
   * refusal site knows the reason, so it says so here instead of leaving the
   * route to infer it from a status code that several outcomes share.
   */
  code?: AuthErrorCode;
};
export type LoginSuccess = {
  ok: true;
  session: IssuedSession;
  administrator?: Administrator;
};
export type AdministratorAddedSuccess = {
  ok: true;
  addedAdministrator: Administrator;
};

type MicrosoftLoginInput = {
  binding: string;
  bootstrapToken: string | undefined;
  host: string | undefined;
  invitation?: string | undefined;
};

export type FleetAuthOptions = {
  store: FleetStore;
  /** `FLEET_OPERATOR_PASSWORD`, when the operator set one. */
  configuredPassword?: string | undefined;
  /** `FLEET_ENTRA_*`, for a distribution that ships a registration. */
  envEntra?: EntraConfigInput | undefined;
  /** Only pins previously claimed Hosts that relied on the old packaged default. */
  legacyEntra?: EntraConfig | undefined;
  /** Writes the claim code somewhere only console access reaches. */
  announceClaimCode: (code: string) => void;
  warn: (message: string) => void;
  externalScheme: ExternalSchemeSources;
  /** Injected in tests; production builds the MSAL-backed provider. */
  entraProvider?: ((config: EntraConfig) => EntraProvider) | undefined;
  now?: (() => number) | undefined;
  /** Called whenever sessions die, so their live sockets can be closed. */
  onSessionsRevoked?: ((revoked: readonly RevokedSession[]) => void) | undefined;
  /** Called when an administrator is removed, for the same reason. */
  onAdministratorRemoved?: ((administratorId: string) => void) | undefined;
  /** Ends every browser connection, including sessions already pruned from storage. */
  onAuthenticationReset?: (() => void) | undefined;
};

/**
 * Everything the Host knows about who may drive it.
 *
 * One object rather than a set of collaborating singletons because the rules
 * only make sense together: whether a password may sign anyone in depends on
 * whether an administrator exists, whether a login may even start depends on
 * whether the endpoint it arrived on can carry a cookie safely, and claiming
 * the Host has to spend a console grant and insert an administrator as one
 * decision. Splitting those apart is how a check ends up on one path and not
 * the other.
 */
export class FleetAuth {
  readonly claim: ClaimCodeService;
  readonly sessions: OperatorSessions;
  readonly transactions: EntraTransactions;

  private readonly store: FleetStore;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly externalScheme: ExternalSchemeSources;
  private readonly providerFactory: (config: EntraConfig) => EntraProvider;
  private readonly onSessionsRevoked: (revoked: readonly RevokedSession[]) => void;
  private readonly onAdministratorRemoved: (administratorId: string) => void;
  private readonly onAuthenticationReset: () => void;
  private readonly envEntra: EntraConfigInput | undefined;
  private readonly legacyEntra: EntraConfig | undefined;
  private readonly configuredPassword: string | undefined;
  private readonly deviceFlows = new Map<string, DeviceFlowRecord>();
  private providerCache: { key: string; provider: EntraProvider } | undefined;
  private configurationGeneration = 0;
  private ignoreAuthEnvironment = false;
  private passwordAuth: OperatorAuth | undefined;

  constructor(options: FleetAuthOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.warn = options.warn;
    this.externalScheme = options.externalScheme;
    this.envEntra = options.envEntra;
    this.legacyEntra = options.legacyEntra;
    this.configuredPassword = options.configuredPassword;
    this.onSessionsRevoked = options.onSessionsRevoked ?? (() => {});
    this.onAdministratorRemoved = options.onAdministratorRemoved ?? (() => {});
    this.onAuthenticationReset = options.onAuthenticationReset ?? (() => {});
    this.providerFactory =
      options.entraProvider ??
      /*
       * The gate the provider applies is this Host's persisted setting and
       * nothing else. A verification lifts it by asking for one, per call — a
       * process-wide flag would mean an anonymous device login started while an
       * administrator was verifying rode in on their allowance.
       */
      ((config) =>
        createEntraProvider(config, {
          deviceFlowEnabled: () => this.deviceFlowEnabled(),
        }));

    this.pinLegacyEntra(options.legacyEntra);
    this.applyPasswordMode(options.configuredPassword);
    this.sessions = new OperatorSessions({
      store: this.store,
      csrfKey: this.csrfKey(),
      now: this.now,
    });
    this.transactions = new EntraTransactions({ now: this.now });
    this.claim = new ClaimCodeService({
      now: this.now,
      announce: options.announceClaimCode,
    });
    // A Host nobody owns prints a code on every boot; a claimed one has no use
    // for one and must not leave a second way in lying around.
    if (this.store.countActiveAdministrators() === 0) {
      this.claim.issue();
    } else if (
      this.passwordAuth &&
      this.store.getSetting(PASSWORD_EXPLICIT_SETTING) !== "1"
    ) {
      // Passwords that survived from before Microsoft ownership were never an
      // administrator's explicit hybrid-mode choice. Retire them on the first
      // boot under this policy; only Settings can opt back in.
      this.disablePassword();
    }
  }

  // -- state -----------------------------------------------------------------

  state(): AuthState {
    return deriveAuthState({
      administrators: this.store.countActiveAdministrators(),
      passwordEnabled: this.passwordAuth !== undefined,
      entraConfigured: this.entraConfig() !== undefined,
      recoveryPassword: this.store.getSetting(PASSWORD_RECOVERY_SETTING) === "1",
    });
  }

  passwordEnabled(): boolean {
    return this.passwordAuth !== undefined;
  }

  entraConfig(): EntraConfig | undefined {
    return entraConfigFrom({
      stored: this.storedEntraConfig(),
      env: this.ignoreAuthEnvironment ? undefined : this.envEntra,
    });
  }

  private storedEntraConfig(): EntraConfigInput | undefined {
    const tenantId = this.store.getSetting(ENTRA_TENANT_SETTING);
    const clientId = this.store.getSetting(ENTRA_CLIENT_SETTING);
    // A half-written legacy pair is invalid, not permission to use the public default.
    return tenantId || clientId
      ? { tenantId: tenantId ?? "", clientId: clientId ?? "" }
      : undefined;
  }

  private pinLegacyEntra(legacy: EntraConfig | undefined): void {
    const stored = this.storedEntraConfig();
    if (stored) {
      EntraConfigSchema.parse(stored);
      return;
    }
    const configured =
      !this.ignoreAuthEnvironment && this.envEntra
        ? EntraConfigSchema.parse(this.envEntra)
        : undefined;
    if (!this.claimed()) return;
    const previous = configured?.tenantId !== "common" ? (configured ?? legacy) : legacy;
    if (configured?.tenantId === "common") {
      if (!previous) {
        throw new EntraProviderUnavailableError(
          "a claimed Host must retain its previous registration before switching to public sign-in",
        );
      }
      this.warn(
        "Public Microsoft sign-in was not applied to this claimed Host. Switch registrations through Settings -> Security after signing in with the existing configuration.",
      );
    }
    if (previous) {
      this.store.writeAtomically(() => {
        this.store.setSetting(ENTRA_TENANT_SETTING, previous.tenantId);
        this.store.setSetting(ENTRA_CLIENT_SETTING, previous.clientId);
      });
    }
  }

  private configurationKey(config = this.entraConfig()): string {
    return `${this.configurationGeneration}:${config?.tenantId ?? ""}:${config?.clientId ?? ""}`;
  }

  private configurationChanged(): AuthFailure {
    return {
      ok: false,
      status: 409,
      code: "expired",
      error: "The Microsoft sign-in configuration changed. Start a new sign-in.",
    };
  }

  private clearPendingAuthentication(): void {
    this.configurationGeneration += 1;
    this.transactions.clear();
    for (const flowId of this.deviceFlows.keys()) this.discardDeviceFlow(flowId);
    this.providerCache = undefined;
  }

  private saveEntra(config: EntraConfig): void {
    this.store.setSetting(ENTRA_TENANT_SETTING, config.tenantId);
    this.store.setSetting(ENTRA_CLIENT_SETTING, config.clientId);
    this.store.setSetting(DEVICE_FLOW_SETTING, "0");
  }

  eraseAuthentication(session: ActiveSession): { ok: true } | AuthFailure {
    const current = this.sessions.inspect(session.tokenHash);
    const administrator = current ? this.administratorFor(current) : undefined;
    if (!current || !administrator || !this.requireRecentReauth(current)) {
      return {
        ok: false,
        status: 403,
        error:
          "Sign in with your current Microsoft administrator account to erase authentication.",
      };
    }
    const csrfKey = randomBytes(32);
    const revoked = this.store.eraseOperatorAuthentication(
      csrfKey.toString("base64"),
      administrator.id,
    );
    this.ignoreAuthEnvironment = true;
    this.passwordAuth = undefined;
    this.clearPendingAuthentication();
    this.sessions.adoptCsrfKey(csrfKey);
    this.claim.clear();
    this.claim.issue();
    this.onSessionsRevoked(revoked);
    this.onAuthenticationReset();
    return { ok: true };
  }

  deviceFlowEnabled(): boolean {
    return this.store.getSetting(DEVICE_FLOW_SETTING) === "1";
  }

  private provider(config: EntraConfig): EntraProvider {
    const key = `${config.tenantId}:${config.clientId}`;
    if (this.providerCache?.key === key) return this.providerCache.provider;
    const provider = this.providerFactory(config);
    this.providerCache = { key, provider };
    return provider;
  }

  claimed(): boolean {
    return this.store.countActiveAdministrators() > 0;
  }

  // -- endpoint policy -------------------------------------------------------

  /** How the Host classifies the name a request claims to have arrived on. */
  classify(host: string | undefined): SchemeDecision {
    return classifyRequestHost(host, externalSchemeMap(this.externalScheme));
  }

  /**
   * Whether a credential may be handed out over this endpoint at all.
   *
   * Nothing here consults the socket, `x-forwarded-proto`, or a claimed source
   * address: all three describe the relay in front of the Host rather than the
   * browser behind it, and all three are settable by the caller.
   */
  mayIssueCredential(host: string | undefined): boolean {
    return sessionIssuanceAllowed(this.classify(host));
  }

  secureCookies(host: string | undefined): boolean {
    return cookieSecure(this.classify(host));
  }

  // -- sessions --------------------------------------------------------------

  verifySession(token: string | undefined): ActiveSession | undefined {
    return this.sessions.verify(token);
  }

  /**
   * The person behind a session, if it belongs to one.
   *
   * A legacy password session has no administrator, which is why the return is
   * optional rather than the session being rejected: password mode is a real
   * principal for as long as it is switched on.
   */
  administratorFor(session: ActiveSession): Administrator | undefined {
    if (!session.administratorId) return undefined;
    return this.store.getAdministrator(session.administratorId);
  }

  /**
   * Whether a session is still allowed to act.
   *
   * Checked on every request, not just at sign-in: an administrator removed
   * two minutes ago must not keep working because their cookie has not expired.
   */
  sessionStillAuthorized(session: ActiveSession): boolean {
    if (!session.administratorId) {
      return this.passwordAuth !== undefined && session.authMethod !== "microsoft-code";
    }
    return this.store.getAdministrator(session.administratorId) !== undefined;
  }

  requireRecentReauth(session: ActiveSession): boolean {
    return hasRecentCodeReauth(session, this.now());
  }

  logout(token: string | undefined): void {
    const tokenHash = this.sessions.revoke(token);
    if (!tokenHash) return;
    this.onSessionsRevoked([{ tokenHash, administratorId: "" }]);
    this.audit({
      eventType: "operator_session_revoked",
      actorKind: "operator",
      outcome: "allowed",
    });
  }

  // -- password --------------------------------------------------------------

  passwordLogin(password: string, host: string | undefined): LoginSuccess | AuthFailure {
    if (!this.passwordAuth) {
      return {
        ok: false,
        status: 409,
        error: "Password sign-in is disabled on this Host.",
      };
    }
    if (!this.mayIssueCredential(host)) return this.refuseEndpoint(host);
    const checked = this.passwordAuth.check(password);
    if (!checked.ok) {
      this.audit({
        eventType: "password_login_failed",
        actorKind: "anonymous",
        outcome: "denied",
        requestHost: endpointLabel(this.classify(host)),
      });
      return checked;
    }
    return {
      ok: true,
      session: this.sessions.issue({
        administratorId: "",
        // A recovery password is a different principal from a migration
        // password: naming it lets `disablePassword` end exactly those
        // sessions, and lets the audit say which one was used.
        authMethod:
          this.store.getSetting(PASSWORD_RECOVERY_SETTING) === "1"
            ? "recovery"
            : "password",
      }),
    };
  }

  /**
   * Turns the shared password off for good.
   *
   * Deleting the verifier as well as clearing the flag matters: a flag alone
   * would leave a credential in the database that any future code path could
   * decide to honour again.
   */
  disablePassword(actorId = ""): RevokedSession[] {
    this.store.setSetting(PASSWORD_ENABLED_SETTING, "0");
    this.store.setSetting(PASSWORD_RECOVERY_SETTING, "0");
    this.store.setSetting(PASSWORD_EXPLICIT_SETTING, "0");
    this.store.setSetting("auth.operatorPassword", "");
    if (this.claimed()) this.store.setSetting(AUTH_MODE_SETTING, "microsoft-only");
    this.passwordAuth = undefined;
    const revoked = [
      ...this.sessions.revokeByMethod("password"),
      ...this.sessions.revokeByMethod("recovery"),
    ];
    this.onSessionsRevoked(revoked);
    this.audit({
      eventType: "password_login_disabled",
      actorKind: actorId ? "administrator" : "operator",
      actorId,
      outcome: "allowed",
    });
    return revoked;
  }

  /** Explicitly restores the optional shared-password login path. */
  enablePassword(password: string, actorId: string): void {
    OperatorPasswordSchema.parse(password);
    const hash = hashPassword(password);
    this.store.setSetting("auth.operatorPassword", hash);
    this.store.setSetting(PASSWORD_ENABLED_SETTING, "1");
    this.store.setSetting(PASSWORD_RECOVERY_SETTING, "0");
    this.store.setSetting(PASSWORD_EXPLICIT_SETTING, "1");
    this.store.setSetting(AUTH_MODE_SETTING, "hybrid");
    this.passwordAuth = new OperatorAuth(hash, this.now);
    this.audit({
      eventType: "password_login_enabled",
      actorKind: "administrator",
      actorId,
      outcome: "allowed",
    });
  }

  /**
   * The way back in when Microsoft sign-in cannot be reached.
   *
   * Reachable only from the Host console, because that is the trust boundary
   * the claim code already assumes: somebody with the console has the database
   * anyway. It returns the password once, to be printed and used, and puts the
   * Host into a state the UI names as temporary rather than one that looks like
   * ordinary password mode.
   */
  enableRecoveryPassword(): string {
    const password = `A!${generatePassword()}`;
    const hash = hashPassword(password);
    this.store.setSetting("auth.operatorPassword", hash);
    this.store.setSetting(PASSWORD_ENABLED_SETTING, "1");
    this.store.setSetting(PASSWORD_RECOVERY_SETTING, "1");
    this.store.setSetting(PASSWORD_EXPLICIT_SETTING, "0");
    this.passwordAuth = new OperatorAuth(hash, this.now);
    this.audit({
      eventType: "recovery_password_enabled",
      actorKind: "console",
      outcome: "allowed",
      detail: "temporary password enabled from the Host console",
    });
    return password;
  }

  // -- bootstrap -------------------------------------------------------------

  redeemClaimCode(
    code: string,
    binding: string,
    host: string | undefined,
  ): ClaimRedeemOutcome {
    if (!this.mayIssueCredential(host)) {
      const refusal = this.refuseEndpoint(host);
      return { ok: false, status: 409, error: refusal.error };
    }
    if (this.claimed()) {
      return { ok: false, status: 409, error: "This Fleet has already been claimed." };
    }
    const outcome = this.claim.redeem(code, binding);
    this.audit({
      eventType: outcome.ok ? "bootstrap_code_accepted" : "bootstrap_code_rejected",
      actorKind: "anonymous",
      outcome: outcome.ok ? "allowed" : "denied",
      requestHost: endpointLabel(this.classify(host)),
    });
    return outcome;
  }

  /**
   * A bootstrap grant for an operator who has already proved the old password.
   *
   * The console code exists because a fresh Host has no other secret a network
   * attacker cannot obtain. An upgraded Host does: the password it has always
   * had, which the caller has just presented over a session this Host issued.
   * Asking for the console code on top is asking for a second proof of the same
   * fact, and on a Host reached only through a tunnel it is the reason legacy
   * fleets never finished migrating.
   *
   * Three things make that safe to accept, and all three are checked here
   * rather than left to the route:
   *
   *  - the session must still be one this Host would honour, so a removed
   *    principal or a disabled password ends the path;
   *  - it must have been authenticated by the password itself. A Microsoft
   *    session is refused because it has no business minting bootstrap grants:
   *    the identity behind it is either already an administrator, in which case
   *    there is nothing to claim, or it is not, in which case it holds no
   *    authority over this Host at all;
   *  - the Host must still have no administrators, because a grant is the right
   *    to become the first one and there is exactly one of those.
   */
  grantPasswordBootstrap(input: {
    session: ActiveSession;
    binding: string;
    host: string | undefined;
  }): { ok: true; token: string; expiresAt: number } | AuthFailure {
    const requestHost = endpointLabel(this.classify(input.host));
    const refuse = (status: number, error: string, detail: string): AuthFailure => {
      this.audit({
        eventType: "bootstrap_password_refused",
        actorKind: "operator",
        outcome: "denied",
        requestHost,
        detail,
      });
      return { ok: false, status, error };
    };

    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    if (!this.sessionStillAuthorized(input.session)) {
      return refuse(401, "Sign in to use this Host", "session is no longer authorized");
    }
    if (
      input.session.authMethod !== "password" &&
      input.session.authMethod !== "recovery"
    ) {
      return refuse(
        403,
        "Only a session signed in with this Host's existing password can set up Microsoft sign-in this way.",
        `session authenticated by ${input.session.authMethod}`,
      );
    }
    if (this.claimed()) {
      return refuse(
        409,
        "This Fleet has already been claimed.",
        "host already has an administrator",
      );
    }

    const grant = this.claim.grantTrusted(input.binding);
    this.audit({
      eventType: "bootstrap_password_granted",
      actorKind: "operator",
      outcome: "allowed",
      requestHost,
      detail: `bootstrap granted to a ${input.session.authMethod} session`,
    });
    return { ok: true, ...grant };
  }

  configureEntra(input: unknown): EntraConfig {
    if (this.claimed()) {
      throw new EntraAuthenticationFailedError(
        "invalid-configuration",
        "A claimed Host must verify a configuration change from Settings -> Security.",
      );
    }
    const config = EntraConfigSchema.parse(input);
    this.store.writeAtomically(() => this.saveEntra(config));
    this.clearPendingAuthentication();
    this.audit({
      eventType: "entra_configuration_changed",
      actorKind: "bootstrap",
      outcome: "allowed",
      detail: `tenant ${config.tenantId}`,
    });
    return config;
  }

  async startConfigurationChange(input: {
    config: unknown;
    session: ActiveSession;
    binding: string;
    host: string | undefined;
    redirectUri: string;
  }): Promise<{ ok: true; authorizationUrl: string } | AuthFailure> {
    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    const session = this.sessions.inspect(input.session.tokenHash);
    const administrator = session ? this.administratorFor(session) : undefined;
    if (!session || !administrator || !this.requireRecentReauth(session)) {
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error:
          "Sign in with your current Microsoft administrator account to confirm this change.",
      };
    }
    const config = EntraConfigSchema.parse(input.config);
    const transaction = this.transactions.start({
      binding: input.binding,
      bootstrap: false,
      redirectUri: input.redirectUri,
      configurationKey: this.configurationKey(),
      migration: {
        config,
        administratorId: administrator.id,
        sessionTokenHash: session.tokenHash,
      },
    });
    try {
      const authorizationUrl = await this.providerFactory(config).authorizationUrl({
        redirectUri: input.redirectUri,
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: transaction.codeChallenge,
      });
      if (transaction.configurationKey !== this.configurationKey()) {
        this.transactions.consume(transaction.state);
        return this.configurationChanged();
      }
      return { ok: true, authorizationUrl };
    } catch (error) {
      this.transactions.consume(transaction.state);
      return this.providerFailure(error);
    }
  }

  // -- Microsoft login -------------------------------------------------------

  async startAdministratorAddition(input: {
    session: ActiveSession;
    binding: string;
    host: string | undefined;
    redirectUri: string;
  }): Promise<{ ok: true; authorizationUrl: string } | AuthFailure> {
    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    const session = this.sessions.inspect(input.session.tokenHash);
    const administrator = session ? this.administratorFor(session) : undefined;
    if (!session || !administrator || !this.requireRecentReauth(session)) {
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error: "Sign in with Microsoft again before adding another administrator.",
      };
    }
    const config = this.entraConfig();
    if (!config) {
      return {
        ok: false,
        status: 409,
        code: "provider-unavailable",
        error: "Microsoft sign-in is not configured.",
      };
    }
    const transaction = this.transactions.start({
      binding: input.binding,
      bootstrap: false,
      redirectUri: input.redirectUri,
      configurationKey: this.configurationKey(config),
      administratorAddition: {
        administratorId: administrator.id,
        sessionTokenHash: session.tokenHash,
      },
    });
    try {
      // The shared provider always uses select_account, including with browser SSO.
      const authorizationUrl = await this.provider(config).authorizationUrl({
        redirectUri: transaction.redirectUri,
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: transaction.codeChallenge,
      });
      if (transaction.configurationKey !== this.configurationKey()) {
        this.transactions.consume(transaction.state);
        return this.configurationChanged();
      }
      return { ok: true, authorizationUrl };
    } catch (error) {
      this.transactions.consume(transaction.state);
      return this.providerFailure(error);
    }
  }

  /**
   * Begins an authorization-code login.
   *
   * An unclaimed Host additionally demands the console grant here rather than
   * at the callback, because the callback arrives as a cross-site navigation
   * that a `SameSite=Strict` bootstrap cookie is deliberately not sent with.
   * The transaction carries the grant across that gap and spends it on success.
   */
  async startCodeLogin(
    input: MicrosoftLoginInput & {
      redirectUri: string;
    },
  ): Promise<{ ok: true; authorizationUrl: string } | AuthFailure> {
    const prepared = this.prepareMicrosoftLogin(input);
    if (!prepared.ok) return prepared;
    const transaction = this.transactions.start({
      binding: input.binding,
      bootstrap: prepared.bootstrap,
      grantToken: prepared.bootstrap ? input.bootstrapToken : undefined,
      invitation: input.invitation,
      redirectUri: input.redirectUri,
      configurationKey: this.configurationKey(prepared.config),
    });
    try {
      const authorizationUrl = await this.provider(prepared.config).authorizationUrl({
        redirectUri: input.redirectUri,
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: transaction.codeChallenge,
      });
      if (transaction.configurationKey !== this.configurationKey()) {
        this.transactions.consume(transaction.state);
        return this.configurationChanged();
      }
      return { ok: true, authorizationUrl };
    } catch (error) {
      this.transactions.consume(transaction.state);
      return this.providerFailure(error);
    }
  }

  private prepareMicrosoftLogin(
    input: MicrosoftLoginInput,
  ): { ok: true; config: EntraConfig; bootstrap: boolean } | AuthFailure {
    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    const config = this.entraConfig();
    if (!config) {
      return {
        ok: false,
        status: 409,
        error: "This Host has no Microsoft sign-in configuration yet.",
      };
    }
    const grant = this.claimed()
      ? undefined
      : this.claim.verifyBootstrap(input.bootstrapToken, input.binding);
    if (!this.claimed() && !grant) {
      return {
        ok: false,
        status: 401,
        error: "Enter the claim code printed on the Host console before signing in.",
      };
    }
    return { ok: true, config, bootstrap: grant !== undefined };
  }

  /**
   * Finishes a login, and decides what it was worth.
   *
   * Microsoft authenticating somebody is not Fleet authorising them: an
   * identity absent from the administrator table gets a `403` and no session at
   * all, which is the difference between "works at this company" and "may run
   * commands on every machine in this fleet".
   */
  async completeCodeLogin(input: {
    state: string | undefined;
    code: string;
    binding: string;
    host: string | undefined;
  }): Promise<LoginSuccess | AdministratorAddedSuccess | AuthFailure> {
    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    const transaction = this.transactions.consume(input.state);
    if (!transaction) {
      return {
        ok: false,
        status: 400,
        code: "expired",
        error: "That sign-in has expired. Start again.",
      };
    }
    if (transaction.binding !== input.binding) {
      return {
        ok: false,
        status: 400,
        code: "expired",
        error: "That sign-in belongs to another browser.",
      };
    }
    const config = this.entraConfig();
    if (!config) {
      return {
        ok: false,
        status: 409,
        code: "provider-unavailable",
        error: "Microsoft sign-in is not configured.",
      };
    }
    if (transaction.configurationKey !== this.configurationKey(config)) {
      return this.configurationChanged();
    }
    let identity: EntraIdentity;
    try {
      const provider = transaction.migration
        ? this.providerFactory(transaction.migration.config)
        : this.provider(config);
      identity = await provider.redeemAuthorizationCode({
        code: input.code,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
        redirectUri: transaction.redirectUri,
      });
    } catch (error) {
      return this.providerFailure(error);
    }
    if (
      transaction.configurationKey !== this.configurationKey() ||
      transaction.expiresAt <= this.now()
    ) {
      return this.configurationChanged();
    }
    if (transaction.migration) {
      return this.completeConfigurationChange(
        transaction.migration,
        identity,
        input.host,
      );
    }
    if (transaction.administratorAddition) {
      return this.completeAdministratorAddition(
        transaction.administratorAddition,
        identity,
        input.host,
      );
    }
    return this.authorize(identity, "microsoft-code", {
      bootstrap: transaction.bootstrap,
      grantToken: transaction.grantToken,
      invitation: transaction.invitation,
      host: input.host,
    });
  }

  cancelCodeLogin(state: string | undefined, binding: string): void {
    this.transactions.cancel(state, binding);
  }

  private completeAdministratorAddition(
    addition: NonNullable<AuthTransaction["administratorAddition"]>,
    identity: EntraIdentity,
    host: string | undefined,
  ): AdministratorAddedSuccess | AuthFailure {
    return this.store.writeAtomically(() => {
      // The Strict operator cookie need not accompany Microsoft's redirect.
      // Revalidate its original server-side session instead of creating a new one.
      const session = this.sessions.inspect(addition.sessionTokenHash);
      const authorizer = this.store.getAdministrator(addition.administratorId);
      if (
        !session ||
        !authorizer ||
        session.administratorId !== authorizer.id ||
        !this.requireRecentReauth(session)
      ) {
        return {
          ok: false,
          status: 403,
          code: "not-authorized",
          error:
            "The administrator who started this addition must still be signed in with a recent Microsoft sign-in. Start again.",
        };
      }
      const existing = this.store.findAdministrator(identity.tenantId, identity.objectId);
      const addedAdministrator =
        existing ??
        this.store.insertAdministrator({
          ...identity,
          addedVia: "administrator-add",
          addedByAdminId: authorizer.id,
        });
      this.audit({
        eventType: "administrator_addition_completed",
        actorKind: "administrator",
        actorId: authorizer.id,
        targetId: addedAdministrator.id,
        outcome: "allowed",
        requestHost: endpointLabel(this.classify(host)),
        detail: `${existing ? "already active" : "added"}; tenant ${identity.tenantId}; object ${identity.objectId}`,
      });
      return { ok: true, addedAdministrator };
    });
  }

  private completeConfigurationChange(
    migration: NonNullable<AuthTransaction["migration"]>,
    identity: EntraIdentity,
    host: string | undefined,
  ): LoginSuccess | AuthFailure {
    const session = this.sessions.inspect(migration.sessionTokenHash);
    const administrator = this.store.getAdministrator(migration.administratorId);
    if (
      !session ||
      !this.requireRecentReauth(session) ||
      session.administratorId !== administrator?.id ||
      !administrator ||
      administrator.tenantId !== identity.tenantId ||
      administrator.objectId !== identity.objectId
    ) {
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error:
          "Sign in as the same administrator in the same directory. The existing Microsoft configuration has not changed.",
      };
    }

    const { revoked, result } = this.store.writeAtomically(() => {
      this.saveEntra(migration.config);
      const revoked = this.store.revokeAllOperatorSessions();
      this.audit({
        eventType: "entra_configuration_changed",
        actorKind: "administrator",
        actorId: administrator.id,
        outcome: "allowed",
        detail: `authority ${migration.config.tenantId}`,
      });
      return {
        revoked,
        result: this.sessionFor(
          administrator,
          "microsoft-code",
          endpointLabel(this.classify(host)),
        ),
      };
    });
    this.clearPendingAuthentication();
    this.onSessionsRevoked(revoked);
    return result;
  }

  /**
   * Turns an authenticated identity into a Fleet session, or nothing.
   *
   * The claim branch consumes the console grant before inserting, and the
   * insert itself is the store's atomic first-claim: two identities racing
   * produce one administrator and one `409`, never two owners.
   */
  private authorize(
    identity: EntraIdentity,
    authMethod: OperatorAuthMethod,
    context: {
      bootstrap: boolean;
      grantToken: string | undefined;
      invitation?: string | undefined;
      host: string | undefined;
    },
  ): LoginSuccess | AuthFailure {
    const requestHost = endpointLabel(this.classify(context.host));
    if (!this.claimed()) {
      if (!context.bootstrap || !this.claim.consumeBootstrap(context.grantToken)) {
        this.audit({
          eventType: "microsoft_login_denied_not_admin",
          actorKind: "anonymous",
          outcome: "denied",
          requestHost,
          detail: "no live console claim grant",
        });
        return {
          ok: false,
          status: 401,
          code: "claim-required",
          error: "Enter the claim code printed on the Host console before signing in.",
        };
      }
      const config = this.entraConfig();
      const administrator = this.store.writeAtomically(() => {
        const claimed = this.store.claimFirstAdministrator(identity);
        // Pin env/built-in configuration in the same commit as the first owner.
        if (claimed && config) {
          this.store.setSetting(ENTRA_TENANT_SETTING, config.tenantId);
          this.store.setSetting(ENTRA_CLIENT_SETTING, config.clientId);
        }
        return claimed;
      });
      if (!administrator) {
        return {
          ok: false,
          status: 409,
          code: "already-claimed",
          error: "This Fleet has already been claimed.",
        };
      }
      this.claim.clear();
      if (this.passwordEnabled()) this.disablePassword(administrator.id);
      else this.store.setSetting(AUTH_MODE_SETTING, "microsoft-only");
      this.audit({
        eventType: "fleet_claimed",
        actorKind: "administrator",
        actorId: administrator.id,
        outcome: "allowed",
        requestHost,
      });
      return this.sessionFor(administrator, authMethod, requestHost);
    }

    const administrator = this.store.findAdministrator(
      identity.tenantId,
      identity.objectId,
    );
    if (!administrator) {
      /*
       * An invitation buys a place in the queue, not a session. If the link
       * leaked and the wrong tenant user opened it, the inviting administrator
       * sees exactly who turned up and rejects them — which is the whole reason
       * redemption is not itself the grant.
       */
      if (context.invitation && this.recordCandidate(context.invitation, identity)) {
        this.audit({
          eventType: "administrator_invitation_consumed",
          actorKind: "anonymous",
          outcome: "denied",
          requestHost,
          detail: "candidate recorded, awaiting approval",
        });
        return {
          ok: false,
          status: 403,
          code: "pending-approval",
          error:
            "Your request was recorded. An existing administrator has to approve it before you can sign in.",
        };
      }
      this.audit({
        eventType: "microsoft_login_denied_not_admin",
        actorKind: "anonymous",
        outcome: "denied",
        requestHost,
        detail: "identity is not an administrator of this Host",
      });
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error: "That account is not authorized to use this Fleet.",
      };
    }
    // Display metadata may have changed since the row was written; the keys it
    // is looked up by cannot.
    this.store.insertAdministrator({
      tenantId: administrator.tenantId,
      objectId: administrator.objectId,
      username: identity.username,
      displayName: identity.displayName,
      addedVia: administrator.addedVia,
    });
    return this.sessionFor(administrator, authMethod, requestHost);
  }

  private sessionFor(
    administrator: Administrator,
    authMethod: OperatorAuthMethod,
    requestHost: string,
  ): LoginSuccess {
    this.store.touchAdministratorLogin(
      administrator.id,
      new Date(this.now()).toISOString(),
    );
    this.audit({
      eventType: "microsoft_login_succeeded",
      actorKind: "administrator",
      actorId: administrator.id,
      outcome: "allowed",
      requestHost,
    });
    return {
      ok: true,
      administrator,
      session: this.sessions.issue({
        administratorId: administrator.id,
        authMethod,
      }),
    };
  }

  // -- device flow -----------------------------------------------------------

  /**
   * Starts the optional device login.
   *
   * The flow id the browser receives is the Host's own, not the provider's, and
   * only the browser that started it may exchange it. Without that binding an
   * attacker who watched a code being displayed could poll for the session it
   * produced, which is the phishing shape this flow already invites.
   */
  async startDeviceLogin(
    input: MicrosoftLoginInput,
  ): Promise<{ ok: true; flow: DeviceFlowStartedResponse } | AuthFailure> {
    const prepared = this.prepareMicrosoftLogin(input);
    if (!prepared.ok) return prepared;
    const provider = this.provider(prepared.config);
    const configurationKey = this.configurationKey(prepared.config);
    let started: DeviceCodeStarted;
    try {
      started = await provider.startDeviceCode();
    } catch (error) {
      return this.providerFailure(error);
    }
    if (configurationKey !== this.configurationKey()) {
      provider.cancelDeviceCode({ flowId: started.flowId });
      return this.configurationChanged();
    }
    return {
      ok: true,
      flow: this.trackDeviceFlow(started, {
        binding: input.binding,
        bootstrap: prepared.bootstrap,
        grantToken: prepared.bootstrap ? input.bootstrapToken : undefined,
        invitation: input.invitation,
        provider,
        configurationKey,
      }),
    };
  }

  async pollDeviceLogin(input: {
    flowId: string;
    binding: string;
    host: string | undefined;
  }): Promise<LoginSuccess | AuthFailure> {
    if (!this.mayIssueCredential(input.host)) return this.refuseEndpoint(input.host);
    const flow = this.deviceFlows.get(input.flowId);
    if (
      !flow ||
      // A verification is not a sign-in. It runs with the device gate lifted,
      // so redeeming one for a session would be exactly the bypass the gate is
      // there to prevent.
      flow.verifying ||
      flow.polling ||
      flow.binding !== input.binding ||
      flow.expiresAt <= this.now()
    ) {
      // One answer for "never existed", "belongs to someone else", and
      // "expired": telling them apart is telling a poller which guess was warm.
      return {
        ok: false,
        status: 400,
        code: "expired",
        error: "That sign-in is not available.",
      };
    }
    if (flow.configurationKey !== this.configurationKey()) {
      this.discardDeviceFlow(input.flowId);
      return this.configurationChanged();
    }
    flow.polling = true;
    let identity: EntraIdentity;
    try {
      identity = await flow.provider.pollDeviceCode({
        flowId: flow.providerFlowId,
      });
    } catch (error) {
      /*
       * A flow that cannot produce an identity is over on both sides. Leaving
       * the Host's record behind would let a browser poll something the
       * provider has already discarded; leaving the provider's behind would
       * keep a loop running for a sign-in nobody is waiting for.
       */
      this.discardDeviceFlow(input.flowId);
      return this.providerFailure(error);
    }
    this.discardDeviceFlow(input.flowId);
    if (
      flow.configurationKey !== this.configurationKey() ||
      flow.expiresAt <= this.now()
    ) {
      return this.configurationChanged();
    }
    return this.authorize(identity, "microsoft-device", {
      bootstrap: flow.bootstrap,
      grantToken: flow.grantToken,
      invitation: flow.invitation,
      host: input.host,
    });
  }

  // -- device flow verification ----------------------------------------------

  /**
   * Asks Microsoft for a device code while the Host's own switch is still off.
   *
   * Without this an administrator has no way to answer the only question that
   * matters — does this tenant permit the flow at all — because the setting
   * that would let them try is the setting they are trying to decide. The
   * allowance covers the single flow it starts and is dropped whatever happens
   * to it; the setting is written only by a completion Microsoft actually
   * returned.
   */
  async startDeviceVerification(input: {
    administratorId: string;
    binding: string;
  }): Promise<
    { ok: true; flow: DeviceFlowStartedResponse } | (AuthFailure & { blocked?: true })
  > {
    const config = this.entraConfig();
    if (!config) {
      return {
        ok: false,
        status: 409,
        code: "provider-unavailable",
        error: "This Host has no Microsoft sign-in configuration yet.",
      };
    }
    if (!this.store.getAdministrator(input.administratorId)) {
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error: "Only a current administrator may verify device sign-in.",
      };
    }
    const provider = this.provider(config);
    const configurationKey = this.configurationKey(config);
    let started: DeviceCodeStarted;
    try {
      // The allowance is an argument to this one call, so nothing else running
      // at the same moment is affected by it.
      started = await provider.startDeviceCode({ verification: true });
    } catch (error) {
      return this.deviceUnavailable(error, input.administratorId);
    }
    if (configurationKey !== this.configurationKey()) {
      provider.cancelDeviceCode({ flowId: started.flowId });
      return this.configurationChanged();
    }
    return {
      ok: true,
      flow: this.trackDeviceFlow(started, {
        binding: input.binding,
        bootstrap: false,
        grantToken: undefined,
        invitation: undefined,
        verifying: true,
        administratorId: input.administratorId,
        provider,
        configurationKey,
      }),
    };
  }

  /**
   * Turns a completed verification into the setting, and nothing else.
   *
   * No Fleet session comes out of this: the administrator already has one, and
   * a device session would replace an authorization-code session with a weaker
   * one — which is exactly the session that may not remove administrators.
   */
  async completeDeviceVerification(input: {
    flowId: string;
    binding: string;
    administratorId: string;
  }): Promise<
    { ok: true; deviceFlowEnabled: true } | (AuthFailure & { blocked?: true })
  > {
    const flow = this.deviceFlows.get(input.flowId);
    if (
      !flow?.verifying ||
      flow.polling ||
      flow.binding !== input.binding ||
      // The allowance belongs to the administrator who asked the question, so
      // nobody else may spend it — not even another administrator.
      flow.administratorId !== input.administratorId ||
      flow.expiresAt <= this.now()
    ) {
      return {
        ok: false,
        status: 400,
        code: "expired",
        error: "That verification is no longer available. Start another.",
      };
    }
    if (flow.configurationKey !== this.configurationKey()) {
      this.discardDeviceFlow(input.flowId);
      return this.configurationChanged();
    }
    flow.polling = true;
    let identity: EntraIdentity;
    try {
      identity = await flow.provider.pollDeviceCode({
        flowId: flow.providerFlowId,
        options: { verification: true },
      });
    } catch (error) {
      this.discardDeviceFlow(input.flowId);
      return this.deviceUnavailable(error, input.administratorId);
    }
    this.discardDeviceFlow(input.flowId);
    if (
      flow.configurationKey !== this.configurationKey() ||
      flow.expiresAt <= this.now()
    ) {
      return this.configurationChanged();
    }
    // Whoever answered the code has to be an administrator of this Host, or the
    // proof is that some tenant user can sign in — which was never in doubt.
    const administrator = this.store.findAdministrator(
      identity.tenantId,
      identity.objectId,
    );
    if (!administrator || administrator.id !== input.administratorId) {
      this.audit({
        eventType: "device_flow_verification_denied",
        actorKind: "administrator",
        actorId: input.administratorId,
        outcome: "denied",
        detail: "the account that answered the code is not an administrator",
      });
      return {
        ok: false,
        status: 403,
        code: "not-authorized",
        error:
          "The account that answered that code is not the administrator verifying this Fleet, so device sign-in stays off.",
      };
    }
    this.store.setSetting(DEVICE_FLOW_SETTING, "1");
    this.audit({
      eventType: "device_flow_verified",
      actorKind: "administrator",
      actorId: input.administratorId,
      targetId: administrator.id,
      outcome: "allowed",
    });
    return { ok: true, deviceFlowEnabled: true };
  }

  /**
   * Turns a refused device flow into a named, supported state.
   *
   * Conditional Access blocking this flow is the documented default, not a
   * malfunction, so it must not read as one: the Host stays disabled, says so,
   * and points at the local forward that does work.
   */
  private deviceUnavailable(
    error: unknown,
    administratorId: string,
  ): AuthFailure & { blocked?: true } {
    /*
     * The whole chain, not just the sentence on top. A refusal has already been
     * turned into Fleet's own words by the time it reaches here — deliberately,
     * because Microsoft's can name an account — but "Conditional Access says no"
     * and "Microsoft is having a bad day" are different states, and only the
     * original text tells them apart.
     */
    const detail = entraFailureText(error);
    const blocked =
      /AADSTS(50199|53003|700016|65001)|conditional access|blocked|not allowed|unauthorized_client|disabled/i.test(
        detail,
      );
    this.audit({
      eventType: blocked ? "device_flow_blocked" : "device_flow_verification_failed",
      actorKind: "administrator",
      actorId: administratorId,
      outcome: "denied",
      detail: blocked
        ? "organization policy refused device sign-in"
        : "device verification failed",
    });
    if (!blocked) {
      return {
        ok: false,
        status: 503,
        code: "provider-unavailable",
        // Fleet's own sentence for the browser; the provider's stays in the
        // audit row above, which only an administrator of this Host can read.
        error:
          "Microsoft could not start a device sign-in on this Host. Try again, or reach it through a local forward and sign in with Microsoft there.",
      };
    }
    return {
      ok: false,
      status: 409,
      code: "device-blocked",
      blocked: true,
      error:
        "Organization policy blocks this device sign-in, so it stays off. Reach this Host through a local forward and sign in with Microsoft there instead.",
    };
  }

  private trackDeviceFlow(
    started: DeviceCodeStarted,
    context: Omit<DeviceFlowRecord, "providerFlowId" | "expiresAt">,
  ): DeviceFlowStartedResponse {
    this.sweepDeviceFlows();
    if (this.deviceFlows.size >= MAX_DEVICE_FLOWS) {
      const oldest = [...this.deviceFlows].sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      )[0];
      if (oldest) this.discardDeviceFlow(oldest[0]);
    }
    const flowId = randomBytes(24).toString("base64url");
    this.deviceFlows.set(flowId, {
      ...context,
      providerFlowId: started.flowId,
      expiresAt: started.expiresAt,
    });
    return {
      flowId,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      message: started.message,
      expiresAt: new Date(started.expiresAt).toISOString(),
    };
  }

  /**
   * Drops a flow from both maps at once.
   *
   * The Host's record and the provider's polling loop are two halves of one
   * thing. Removing either alone is a drift: a record with no loop is a browser
   * polling something that can never answer, and a loop with no record is the
   * Host asking Microsoft about a sign-in it has already forgotten.
   */
  private discardDeviceFlow(flowId: string): void {
    const flow = this.deviceFlows.get(flowId);
    if (!flow) return;
    this.deviceFlows.delete(flowId);
    flow.provider.cancelDeviceCode({ flowId: flow.providerFlowId });
  }

  /** Removes the flows whose codes have died, whatever any browser is doing. */
  private sweepDeviceFlows(): void {
    const now = this.now();
    for (const [flowId, flow] of this.deviceFlows) {
      if (flow.expiresAt <= now) this.discardDeviceFlow(flowId);
    }
  }

  // -- administrators --------------------------------------------------------

  listAdministrators(): Administrator[] {
    return this.store.listAdministrators();
  }

  createInvitation(createdByAdminId: string): { id: string; token: string } {
    const token = randomBytes(32).toString("base64url");
    const invitation = this.store.createInvitation({
      tokenHash: hashToken(token),
      createdByAdminId,
      expiresAt: new Date(this.now() + INVITATION_TTL_MS).toISOString(),
    });
    this.audit({
      eventType: "administrator_invitation_created",
      actorKind: "administrator",
      actorId: createdByAdminId,
      targetId: invitation.id,
      outcome: "allowed",
    });
    return { id: invitation.id, token: `${invitation.id}.${token}` };
  }

  listPendingCandidates(): AdministratorInvitation[] {
    return this.store.listPendingCandidates();
  }

  /**
   * Records who redeemed an invitation, if the token names a live one.
   *
   * The link is `<id>.<secret>` and only the secret's digest is stored, so a
   * database read yields no usable invitations. Consumption is a single atomic
   * update: a leaked link that two people open produces one candidate.
   */
  private recordCandidate(token: string, identity: EntraIdentity): boolean {
    const separator = token.indexOf(".");
    if (separator <= 0) return false;
    const secret = token.slice(separator + 1);
    if (!secret) return false;
    return this.store.consumeInvitation(hashToken(secret), identity) !== undefined;
  }

  revokeInvitation(invitationId: string): boolean {
    return this.store.revokeInvitation(invitationId);
  }

  approveCandidate(
    invitationId: string,
    decidedByAdminId: string,
  ): Administrator | undefined {
    const administrator = this.store.approveCandidate(invitationId, decidedByAdminId);
    if (administrator) {
      this.audit({
        eventType: "administrator_candidate_approved",
        actorKind: "administrator",
        actorId: decidedByAdminId,
        targetId: administrator.id,
        outcome: "allowed",
      });
    }
    return administrator;
  }

  rejectCandidate(invitationId: string, decidedByAdminId: string): boolean {
    const rejected = this.store.rejectCandidate(invitationId, decidedByAdminId);
    if (rejected) {
      this.audit({
        eventType: "administrator_candidate_rejected",
        actorKind: "administrator",
        actorId: decidedByAdminId,
        targetId: invitationId,
        outcome: "allowed",
      });
    }
    return rejected;
  }

  /**
   * Removes an administrator, ends their sessions, and closes their sockets.
   *
   * One call because the three are one decision. A removal that left a live
   * transcript stream open would be a removal in name only.
   */
  removeAdministrator(administratorId: string): boolean {
    const revoked = this.store.disableAdministratorAndRevoke(administratorId);
    if (this.store.getAdministrator(administratorId)) return false;
    this.onSessionsRevoked(revoked);
    this.onAdministratorRemoved(administratorId);
    this.audit({
      eventType: "administrator_removed",
      actorKind: "administrator",
      targetId: administratorId,
      outcome: "allowed",
    });
    return true;
  }

  // -- audit -----------------------------------------------------------------

  audit(entry: SecurityAuditInput): void {
    this.store.recordSecurityAudit(entry);
  }

  securityAudit(limit: number) {
    return this.store.listSecurityAudit(limit);
  }

  // -- internals -------------------------------------------------------------

  private refuseEndpoint(host: string | undefined): AuthFailure {
    const decision = this.classify(host);
    this.audit({
      eventType: "operator_login_endpoint_refused",
      actorKind: "anonymous",
      outcome: "denied",
      requestHost: endpointLabel(decision),
    });
    return {
      ok: false,
      status: 403,
      code: "endpoint-refused",
      error:
        decision.kind === "external-http"
          ? "This endpoint is plain HTTP, so Fleet will not issue a session over it. Use the loopback URL or an HTTPS tunnel."
          : "This Host has not published that address, so it will not sign anyone in over it.",
    };
  }

  private providerFailure(error: unknown): AuthFailure {
    const named = classifyEntraFailure(error);
    if (named instanceof EntraIdentityRejectedError) {
      return { ok: false, status: 403, code: "wrong-tenant", error: named.message };
    }
    if (named instanceof EntraAuthenticationFailedError) {
      return {
        ok: false,
        status: named.statusCode,
        code: named.code,
        error: named.message,
      };
    }
    if (named instanceof EntraProviderUnavailableError) {
      return {
        ok: false,
        status: 503,
        code: "provider-unavailable",
        error: named.message,
      };
    }
    // Nothing Microsoft said maps to this, so it is Fleet's own bug. It is
    // rethrown rather than dressed up, and the route that owns the browser
    // decides what the operator is left looking at.
    throw error;
  }

  /**
   * Settles password mode once, at construction, and records what it decided.
   *
   * Writing the resolution back is what makes the precedence stable: a Host
   * that inferred "enabled" from the presence of a verifier had no way to
   * record that somebody had since turned it off.
   */
  private applyPasswordMode(configuredPassword: string | undefined): void {
    const persisted = this.store.getSetting(PASSWORD_ENABLED_SETTING);
    const storedHash = this.store.getSetting("auth.operatorPassword") || undefined;
    const mode = resolvePasswordMode({
      persistedEnabled: persisted === undefined ? undefined : persisted === "1",
      storedHash,
      configuredPassword: this.ignoreAuthEnvironment ? undefined : configuredPassword,
    });
    if (mode.warning) this.warn(mode.warning);
    this.store.setSetting(PASSWORD_ENABLED_SETTING, mode.enabled ? "1" : "0");
    this.store.setSetting("auth.operatorPassword", mode.hash ?? "");
    if (!mode.enabled || !mode.hash) {
      this.passwordAuth = undefined;
      return;
    }
    this.passwordAuth = new OperatorAuth(mode.hash, this.now);
  }

  // -- restore ---------------------------------------------------------------

  /**
   * Takes on the security state a portable backup just wrote.
   *
   * A restore replaces the administrator table, the Entra configuration, the
   * password mode and the CSRF key underneath a service that read all four
   * when it started. Without this the Host would keep deriving proofs with the
   * key it no longer has, keep offering a password the archive turned off, and
   * keep printing a claim code for a Host that now has an owner — each of them
   * a restore that only half happened.
   */
  adoptRestoredSecurity(revoked: readonly RevokedSession[]): void {
    this.clearPendingAuthentication();
    this.sessions.adoptCsrfKey(this.csrfKey());
    this.applyPasswordMode(this.configuredPassword);
    // The Entra registration may be a different one entirely.
    this.pinLegacyEntra(this.legacyEntra);
    if (this.claimed()) this.claim.clear();
    else this.claim.issue();
    this.onSessionsRevoked(revoked);
    this.audit({
      eventType: "security_backup_imported",
      actorKind: "administrator",
      outcome: "allowed",
      detail: `${this.store.countActiveAdministrators()} administrators restored`,
    });
  }

  private csrfKey(): Buffer {
    const existing = this.store.getSetting(CSRF_KEY_SETTING);
    if (existing) return Buffer.from(existing, "base64");
    const key = randomBytes(32);
    this.store.setSetting(CSRF_KEY_SETTING, key.toString("base64"));
    return key;
  }
}

/** Only the digest is stored, so a database read is not a set of live links. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
