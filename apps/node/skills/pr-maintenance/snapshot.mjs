/* global process */
import { pathToFileURL } from "node:url";
import { parsePrMaintenanceUrl } from "@fleet/protocol";
import { main, observe as observeGithub } from "./github-snapshot.mjs";
import { toHostObservation } from "./host-observation.mjs";

export function providerInput(input) {
  const pr = input?.pr;
  if (!pr || typeof pr !== "object" || Array.isArray(pr))
    throw Object.assign(new Error("Supply an exact PR URL or provider identity."), {
      code: "invalid_input",
    });
  const parsed = pr.url === undefined ? undefined : parsePrMaintenanceUrl(pr.url);
  if (parsed) {
    for (const key of [
      "provider",
      "host",
      "organization",
      "project",
      "owner",
      "repo",
      "number",
    ]) {
      if (pr[key] !== undefined && pr[key] !== parsed[key])
        throw Object.assign(
          new Error("PR URL and explicit provider identity disagree."),
          { code: "scope_changed" },
        );
    }
  }
  const normalized = { ...pr, ...parsed };
  normalized.provider ??= "github";
  if (!["github", "azure-devops"].includes(normalized.provider))
    throw Object.assign(new Error("Unsupported PR provider."), { code: "invalid_input" });
  if (
    normalized.provider === "github" &&
    (normalized.host === "dev.azure.com" ||
      normalized.host?.endsWith(".visualstudio.com"))
  )
    throw Object.assign(
      new Error("Azure DevOps requires its provider identity or PR URL."),
      { code: "invalid_input" },
    );
  if (normalized.prNumber !== undefined) {
    if (normalized.number !== undefined && normalized.prNumber !== normalized.number)
      throw Object.assign(new Error("PR number pins disagree."), {
        code: "scope_changed",
      });
    normalized.number = normalized.prNumber;
  }
  if (typeof normalized.repository === "string") {
    const [owner, repo, extra] = normalized.repository.split("/");
    if (
      !owner ||
      !repo ||
      extra !== undefined ||
      (normalized.repo !== undefined && normalized.repo !== repo) ||
      (normalized.provider === "github" &&
        normalized.owner !== undefined &&
        normalized.owner !== owner) ||
      (normalized.provider === "azure-devops" &&
        normalized.project !== undefined &&
        normalized.project !== owner)
    )
      throw Object.assign(
        new Error("Repository display names disagree with discovery scope."),
        { code: "scope_changed" },
      );
    normalized.repo = repo;
    if (normalized.provider === "github") normalized.owner = owner;
    else normalized.project = owner;
  }
  return { ...input, pr: normalized };
}

export async function observe(input, options) {
  const normalized = providerInput(input);
  if (normalized.pr.provider === "azure-devops") {
    const ado = await import("./ado-snapshot.mjs");
    return ado.observe(normalized, options);
  }
  return observeGithub(normalized, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(
    observe,
    (result, input, attemptedAt) =>
      result.observation ?? toHostObservation(result, input, attemptedAt),
  );
}
