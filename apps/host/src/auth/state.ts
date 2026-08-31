import { type AuthState } from "@fleet/protocol";
import { hashPassword, verifyPassword } from "../auth.js";

/**
 * What this Host currently is, from the point of view of "who may drive it".
 *
 * Six named states rather than a pair of booleans because each one answers a
 * different question at the front door, and the UI has to say which. A Host
 * that cannot tell `entra-unconfigured` from `unclaimed` shows a login form
 * that cannot possibly work. The list itself lives in the protocol package,
 * because the browser has to render exactly these and nothing else.
 */
export type { AuthState };

export type AuthStateInput = {
  /** Active administrator rows. Zero is what "nobody owns this" means. */
  administrators: number;
  passwordEnabled: boolean;
  entraConfigured: boolean;
  /** Set by the local recovery command, which is deliberately temporary. */
  recoveryPassword: boolean;
};

/**
 * The precedence is the design's, in order.
 *
 * Administrators come first because their existence is what makes a Host
 * claimed, and a claimed Host must never be reported as claimable however its
 * password is configured. `recovery` outranks `hybrid` so the UI can say the
 * password is a temporary way back in rather than a supported mode.
 */
export function deriveAuthState(input: AuthStateInput): AuthState {
  if (input.administrators > 0) {
    if (input.passwordEnabled && input.recoveryPassword) return "recovery";
    return input.passwordEnabled ? "hybrid" : "microsoft-only";
  }
  if (input.passwordEnabled) return "legacy-password";
  return input.entraConfigured ? "unclaimed" : "entra-unconfigured";
}

/** Where an enabled password came from, which is what the warning explains. */
export type PasswordSource = "none" | "disabled" | "stored" | "migrated" | "configured";

export type PasswordMode = {
  enabled: boolean;
  /** The verifier to check against; absent whenever `enabled` is false. */
  hash: string | undefined;
  source: PasswordSource;
  /** Whether the resolution needs to be written back to settings. */
  persist: { passwordEnabled: boolean; hash: string | undefined };
  warning: string | undefined;
};

export type PasswordModeInput = {
  /** `auth.passwordEnabled`, absent on a Host that predates the setting. */
  persistedEnabled: boolean | undefined;
  /** `auth.operatorPassword`, the stored scrypt verifier. */
  storedHash: string | undefined;
  /** `FLEET_OPERATOR_PASSWORD`, when the operator set one. */
  configuredPassword: string | undefined;
};

const OPT_IN_WARNING =
  "FLEET_OPERATOR_PASSWORD is set, so this Host accepts a shared password. That is a migration escape hatch: claim it with a Microsoft account and disable the password.";

const STALE_WARNING =
  "FLEET_OPERATOR_PASSWORD is set but password sign-in was disabled on this Host, so it is ignored. Remove it from the environment.";

/**
 * Decides whether a password can sign anyone in at all.
 *
 * The old resolution invented a password whenever it found none, which meant a
 * fresh Host always had a shared secret whether or not anybody wanted one — and
 * an administrative API whose only credential was a string printed in a log.
 * Nothing here generates: a password exists because somebody asked for one, by
 * setting the environment variable or by having upgraded from a Host that had
 * one already.
 *
 * The order matters more than any single rule. An explicit disable is checked
 * first so that a variable left behind in a shell profile cannot re-enable
 * password sign-in on a Host whose administrator turned it off.
 */
export function resolvePasswordMode(input: PasswordModeInput): PasswordMode {
  if (input.persistedEnabled === false) {
    return {
      enabled: false,
      hash: undefined,
      source: "disabled",
      persist: { passwordEnabled: false, hash: undefined },
      warning: input.configuredPassword ? STALE_WARNING : undefined,
    };
  }

  // Once Settings has explicitly enabled a verifier, that stored choice wins
  // over an old FLEET_OPERATOR_PASSWORD left in the environment. Otherwise a
  // restart would silently replace the password the administrator just chose.
  if (input.persistedEnabled === true && input.storedHash) {
    return {
      enabled: true,
      hash: input.storedHash,
      source: "stored",
      persist: { passwordEnabled: true, hash: input.storedHash },
      warning: undefined,
    };
  }

  if (input.configuredPassword) {
    const matches =
      input.storedHash !== undefined &&
      verifyPassword(input.configuredPassword, input.storedHash);
    // Re-hashing salts anew, and everything derived from the verifier moves
    // with it; reusing a matching one is what keeps a restart from being a
    // sign-out.
    const hash = matches ? input.storedHash : hashPassword(input.configuredPassword);
    return {
      enabled: true,
      hash,
      source: "configured",
      persist: { passwordEnabled: true, hash },
      // Only worth saying on the boot that turns it on; a Host already running
      // in this mode has been told.
      warning: input.persistedEnabled === undefined ? OPT_IN_WARNING : undefined,
    };
  }

  if (input.storedHash) {
    return {
      enabled: true,
      hash: input.storedHash,
      // An upgraded Host has a verifier but never had the flag, and must keep
      // working until an administrator has a Microsoft identity to replace it.
      source: input.persistedEnabled === undefined ? "migrated" : "stored",
      persist: { passwordEnabled: true, hash: input.storedHash },
      warning: undefined,
    };
  }

  // A recorded enable with no verifier is the shape a half-finished disable
  // leaves behind. Trusting the flag would open a login with nothing to check.
  return {
    enabled: false,
    hash: undefined,
    source: "none",
    persist: { passwordEnabled: false, hash: undefined },
    warning: undefined,
  };
}
