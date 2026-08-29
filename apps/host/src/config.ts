import { resolve, isAbsolute, basename } from "node:path";
import { packageRoot } from "./paths.js";

/**
 * Existing .env files carry a repo-root-relative DATABASE_PATH, so a bare
 * resolve() against cwd would keep creating nested apps/host/apps/host trees.
 * Relative values are therefore interpreted against the package, and only the
 * trailing file name is honoured.
 */
export function resolveDatabasePath(
  configured: string | undefined,
  root = packageRoot(),
): string {
  if (!configured) return resolve(root, "data", "fleet.db");
  if (isAbsolute(configured)) return configured;
  return resolve(root, "data", basename(configured));
}

/**
 * The URL a node on another machine should dial. Wildcard bind addresses are
 * not dialable, so they fall back to loopback and the operator is expected to
 * set FLEET_PUBLIC_URL once the Host is reachable from outside.
 */
export function resolvePublicHostUrl(
  publicUrl: string | undefined,
  host: string | undefined,
  port: string | undefined,
): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const wildcard = !host || host === "0.0.0.0" || host === "::";
  return `http://${wildcard ? "127.0.0.1" : host}:${port ?? "8787"}`;
}

/** Enrollment / Connect commands prefer a live tunnel URL over env / bind fallbacks. */
export function resolveEnrollmentHostUrl(
  tunnelUrl: string | undefined,
  fallbackPublicUrl: string,
): string {
  if (tunnelUrl) return tunnelUrl.replace(/\/+$/, "");
  return fallbackPublicUrl.replace(/\/+$/, "");
}

/**
 * Whether this Host has a fleet-wide enrollment token at all, and which one.
 *
 * The token is a migration artefact. New machines enrol with a one-time grant
 * bound to their own key, so a fresh install has nothing for a reusable
 * fleet-wide string to do — and demanding one to boot would make every operator
 * invent, store, and eventually leak a credential that authorises nothing they
 * wanted. `undefined` therefore means "this Host does not do that", not "this
 * Host is misconfigured".
 *
 * An upgrade is recognised by evidence rather than by a flag: a stored token,
 * or Nodes still authenticating with a shared secret. The second case is the
 * one that matters — a settings table that lost the token would otherwise leave
 * those machines unable to re-register, so one is minted for them.
 */
export function resolveLegacyEnrollmentToken(input: {
  /** What a test or an explicit option asked for. */
  explicit?: string | undefined;
  /** What this Host already had, which is the definition of an upgrade. */
  stored: string | undefined;
  /** `ENROLLMENT_TOKEN`, if the operator opted in. */
  env: string | undefined;
  /** How many Nodes still authenticate with a shared secret. */
  legacyNodes: number;
  nodeEnv: string | undefined;
  generate: () => string;
}): string | undefined {
  const production = input.nodeEnv === "production";
  const chosen = input.explicit || input.stored || input.env;
  if (chosen === PLACEHOLDER_ENROLLMENT_TOKEN && production) {
    // The one value that is never a decision: it is what the sample file ships
    // with, so accepting it would turn "left the example alone" into a
    // fleet-wide credential every reader of the repository already knows.
    throw new Error(
      "ENROLLMENT_TOKEN must be set to a non-default value in production, or left unset to use one-time enrollment grants",
    );
  }
  if (chosen) return chosen;
  // No token anywhere, but machines that need one. Mint rather than refuse:
  // those Nodes are already enrolled and the alternative is locking them out.
  if (input.legacyNodes > 0) return input.generate();
  return undefined;
}

/** What `.env.example` ships with, and therefore never a real credential. */
export const PLACEHOLDER_ENROLLMENT_TOKEN = "change-me";

/**
 * The Host's live legacy credential, or its absence.
 *
 * Shared by reference because a restore replaces it: the routes that check it
 * have to see the value the archive brought, not the one the process started
 * with. `undefined` means this Host does not accept token registration at all.
 */
export type LegacyEnrollment = { token: string | undefined };
