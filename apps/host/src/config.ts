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

export function resolveEnrollmentToken(
  token: string | undefined,
  nodeEnv: string | undefined,
): string {
  const resolved = token ?? "change-me";
  if (nodeEnv === "production" && (!token || token === "change-me")) {
    throw new Error("ENROLLMENT_TOKEN must be set to a non-default value in production");
  }
  return resolved;
}
