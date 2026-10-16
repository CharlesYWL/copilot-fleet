/* global process */
// Bridge to Fleet's existing read-only GitHub and Azure DevOps snapshot helpers.
// The build bundles this file, the helpers and their @fleet/protocol/zod
// dependencies into the self-contained scripts/prm.mjs, so the installed skill
// needs only Node and the user's existing `gh`/`az` login.
import { readFile } from "node:fs/promises";
import { parsePrMaintenanceUrl } from "@fleet/protocol";
import { observe } from "../../../apps/node/skills/pr-maintenance/snapshot.mjs";
import { toHostObservation } from "../../../apps/node/skills/pr-maintenance/host-observation.mjs";

export function parsePrUrl(url) {
  const parsed = parsePrMaintenanceUrl(url);
  return { provider: parsed.provider, url: parsed.url };
}

/**
 * Test seam: PRM_PROVIDER_FIXTURE names a JSON file holding one
 * `{observation, snapshot}` result, returned instead of a live provider read.
 * Tests rewrite the file between calls. Never set it in real use.
 */
async function fixtureResult(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  return { observation: value.observation, snapshot: value.snapshot };
}

export async function observePr(input) {
  if (process.env.PRM_PROVIDER_FIXTURE)
    return fixtureResult(process.env.PRM_PROVIDER_FIXTURE);
  const attemptedAt = new Date().toISOString();
  const result = await observe(input);
  const observation = result.observation ?? toHostObservation(result, input, attemptedAt);
  // An observation the mapper downgraded to incomplete must not carry snapshot text.
  return {
    observation,
    snapshot: observation.complete ? result.snapshot : undefined,
  };
}
