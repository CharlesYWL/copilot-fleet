/* global Buffer, process, URL, URLSearchParams, setTimeout, clearTimeout, structuredClone */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { get } from "node:https";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePrMaintenanceUrl,
  PrMaintenanceIdentitySchema,
  PrMaintenanceObservationSchema,
} from "@fleet/protocol";
import { contentHash } from "./github-snapshot.mjs";

export { contentHash };
export const VERSION = 1;
const MAX_BYTES = 1_048_576;
const MAX_ITEMS = 200;
const PAGE_SIZE = 100;
const GUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SHA = /^[a-f\d]{40}$/;
const HASH = /^[a-f\d]{64}$/;
export const POLICY_TYPES = Object.freeze({
  build: "0609b952-1397-4640-95ec-e00a01b2c241",
  status: "cbdc66da-9728-4af8-aada-9a5a32e4a226",
  reviewers: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
  requiredReviewers: "fd2167ab-b0be-447a-8ec8-39368250530e",
  comments: "c6a1889d-b943-4856-b76f-9e46bb6b0df2",
});
const messages = Object.freeze({
  invalid_input: "Supply a bounded version-1 Azure DevOps PR observation request.",
  invalid_resume:
    "Continuation is invalid or belongs to different input, PR, or generation.",
  auth_required:
    "Azure DevOps rejected the authenticated read; operator access reconciliation is required.",
  local_auth_unavailable:
    "The local Azure CLI has no usable login; an independently authorized provider tool may inspect without changing credentials.",
  cli_unavailable: "The existing Azure CLI executable could not be used safely.",
  permission_denied:
    "The Node identity cannot read all required PR, policy, or build evidence.",
  rate_limited:
    "Azure DevOps rate limited the read; wait before another authorized observation.",
  network: "The bounded read failed; no complete observation was obtained.",
  timeout: "The bounded operation timed out; no complete observation was obtained.",
  budget_exhausted:
    "A complete fresh verification does not fit the remaining request allowance.",
  deadline_exhausted: "The remaining observation deadline was exhausted.",
  payload_overflow:
    "Evidence exceeds the bounded byte or 200-item limit; inspect manually.",
  malformed_response:
    "Azure DevOps returned missing, partial, or malformed required evidence.",
  unsupported_pagination:
    "This API returned pagination not defined by its supported public contract.",
  unsupported_scope: "The source repository is not provably in the exact target project.",
  scope_changed:
    "The PR repository, project, or case-sensitive ref differs from its registered pin.",
  inconsistent_snapshot:
    "PR, branch tips, discussions, checks, or policy changed during observation.",
  unsupported_policy:
    "An applicable enabled policy is not supported; human policy reconciliation is required.",
  unverifiable_policy:
    "Policy approval, exemption, or applicability cannot be proven for this iteration.",
  stale_evidence:
    "Policy, iteration, branch, or build evidence is stale or does not match the current pins.",
  ambiguous_effect:
    "Comment effects match ambiguously; reconcile receipts before triage.",
});
function fail(code) {
  return Object.assign(new Error(messages[code] ?? messages.network), { code });
}
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const positive = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const lowerGuid = (value) => {
  if (typeof value !== "string" || !GUID.test(value)) throw fail("malformed_response");
  return value.toLowerCase();
};
function bounded(value, depth = 0) {
  if (depth > 32 || (Array.isArray(value) && value.length > MAX_ITEMS))
    throw fail("payload_overflow");
  if (value && typeof value === "object")
    for (const child of Object.values(value)) bounded(child, depth + 1);
  return value;
}
function required(condition, code = "malformed_response") {
  if (!condition) throw fail(code);
}
function pick(value, keys) {
  return Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  );
}

function validate(input, started) {
  required(
    input?.schemaVersion === VERSION && positive(input.generation),
    "invalid_input",
  );
  const supplied = input.pr;
  required(supplied?.provider === "azure-devops", "invalid_input");
  required(
    supplied.url !== undefined
      ? typeof supplied.url === "string"
      : ["organization", "project", "repo"].every(
          (key) => typeof supplied[key] === "string" && supplied[key].length > 0,
        ),
    "invalid_input",
  );
  let parsed;
  try {
    parsed = parsePrMaintenanceUrl(
      supplied.url ??
        `https://dev.azure.com/${encodeURIComponent(supplied.organization)}/${encodeURIComponent(supplied.project)}/_git/${encodeURIComponent(supplied.repo)}/pullrequest/${supplied.number}`,
    );
  } catch {
    throw fail("invalid_input");
  }
  required(parsed.provider === "azure-devops", "invalid_input");
  for (const key of ["host", "organization", "project", "repo", "number"])
    if (supplied[key] !== undefined)
      required(
        (key === "organization" ? supplied[key].toLowerCase() : supplied[key]) ===
          parsed[key],
        "invalid_input",
      );
  const pr = { ...supplied, ...parsed };
  for (const key of [
    "projectId",
    "repositoryId",
    "headRepositoryId",
    "baseRepositoryId",
  ]) {
    if (pr[key] !== undefined) {
      required(typeof pr[key] === "string" && GUID.test(pr[key]), "invalid_input");
      pr[key] = pr[key].toLowerCase();
    }
  }
  // Reuse the shared identity's name/ref validators, including case-sensitive refs.
  const placeholder = "00000000-0000-0000-0000-000000000001";
  try {
    PrMaintenanceIdentitySchema.parse({
      provider: pr.provider,
      host: pr.host,
      organization: pr.organization,
      project: pr.project,
      projectId: pr.projectId ?? placeholder,
      repository: pr.repository ?? `${pr.project}/${pr.repo}`,
      repositoryId: pr.repositoryId ?? placeholder,
      prNumber: pr.number,
      headRepository: pr.headRepository ?? `${pr.project}/${pr.repo}`,
      headRepositoryId: pr.headRepositoryId ?? placeholder,
      headRef: pr.headRef ?? "refs/heads/discovery",
      baseRepository: pr.baseRepository ?? `${pr.project}/${pr.repo}`,
      baseRepositoryId: pr.baseRepositoryId ?? pr.repositoryId ?? placeholder,
      baseRef: pr.baseRef ?? "refs/heads/discovery",
    });
  } catch {
    throw fail("invalid_input");
  }
  const budget = input.budget;
  required(
    Number.isInteger(budget?.maxRequests) &&
      budget.maxRequests >= 0 &&
      budget.maxRequests <= 40 &&
      date(budget.deadlineAt) &&
      (budget.maxBytes === undefined ||
        (Number.isInteger(budget.maxBytes) &&
          budget.maxBytes >= 4096 &&
          budget.maxBytes <= MAX_BYTES)),
    "invalid_input",
  );
  for (const key of ["knownEffects", "handledSources", "previousThreads"])
    required(
      input[key] === undefined ||
        (Array.isArray(input[key]) && input[key].length <= MAX_ITEMS),
      "invalid_input",
    );
  for (const effect of input.knownEffects ?? [])
    required(
      typeof effect?.effectId === "string" &&
        effect.effectId.length > 0 &&
        effect.effectId.length <= 512 &&
        typeof effect.kind === "string" &&
        typeof effect.actor === "string" &&
        effect.actor.length > 0 &&
        HASH.test(effect.contentHash) &&
        ((typeof effect.id === "string" && effect.id.length > 0) ||
          (typeof effect.marker === "string" && effect.marker.length >= 16)),
      "invalid_input",
    );
  for (const source of input.handledSources ?? [])
    required(
      typeof source?.kind === "string" &&
        typeof source.id === "string" &&
        HASH.test(source.revision) &&
        (source.headSha === undefined || SHA.test(source.headSha)),
      "invalid_input",
    );
  for (const state of input.previousThreads ?? [])
    required(
      typeof state?.id === "string" &&
        HASH.test(state.stateHash) &&
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        state.revision < Number.MAX_SAFE_INTEGER,
      "invalid_input",
    );
  for (const [key, identityKey] of [
    ["knownEffects", "effectId"],
    ["previousThreads", "id"],
  ]) {
    const values = input[key] ?? [];
    required(
      new Set(values.map((entry) => entry[identityKey])).size === values.length,
      "invalid_input",
    );
  }
  const limits = {
    maxRequests: budget.maxRequests,
    maxBytes: budget.maxBytes ?? 262_144,
    deadline: Math.min(Date.parse(budget.deadlineAt), started + 120_000),
  };
  required(size(input) <= limits.maxBytes, "payload_overflow");
  bounded(input);
  return { pr, limits };
}

const tokenArgs = [
  "account",
  "get-access-token",
  "--resource",
  "499b84ac-1321-427f-aa17-267ca6975798",
  "--query",
  "accessToken",
  "--output",
  "tsv",
  "--only-show-errors",
];
/** Windows MSI's az.cmd delegates to ../python.exe -IBm azure.cli. Never use a shell. */
export async function resolveAzLauncher({
  platform = process.platform,
  env = process.env,
  exists = async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  if (platform !== "win32") return { command: "az", args: [...tokenArgs] };
  for (const entry of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, "");
    const python = win32.resolve(directory, "..", "python.exe");
    if ((await exists(win32.join(directory, "az.cmd"))) && (await exists(python)))
      return { command: python, args: ["-IBm", "azure.cli", ...tokenArgs] };
  }
  throw fail("cli_unavailable");
}

/** Output and diagnostics remain in memory; all error messages are fixed, never child output. */
export async function getAccessToken({ timeoutMs, spawnProcess = spawn, launcher } = {}) {
  const selected = launcher ?? (await resolveAzLauncher());
  return new Promise((resolveToken, reject) => {
    let done = false;
    let bytes = 0;
    const chunks = [];
    const child = spawnProcess(selected.command, selected.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
        AZURE_CORE_COLLECT_TELEMETRY: "false",
      },
    });
    const finish = (error, token) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chunks.forEach((chunk) => chunk.fill(0));
      if (error) {
        child.kill();
        reject(error);
      } else resolveToken(token);
    };
    const timer = setTimeout(
      () => finish(fail("timeout")),
      Math.min(timeoutMs ?? 15_000, 15_000),
    );
    child.on("error", () => finish(fail("cli_unavailable")));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65_536) return finish(fail("payload_overflow"));
        if (stream === child.stdout) chunks.push(Buffer.from(chunk));
      });
    }
    child.on("close", (code) => {
      if (done) return;
      const token = Buffer.concat(chunks).toString("utf8").trim();
      if (code !== 0 || !/^[A-Za-z0-9._~-]{16,32768}$/.test(token))
        finish(fail("local_auth_unavailable"));
      else finish(null, token);
    });
  });
}

export function httpsRequest({ url, timeoutMs, maxBytes }, token, requestGet = get) {
  const parsed = new URL(url);
  required(
    parsed.protocol === "https:" &&
      parsed.host === "dev.azure.com" &&
      !parsed.username &&
      !parsed.password,
    "invalid_input",
  );
  return new Promise((resolveResponse, reject) => {
    let done = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        request.destroy();
        reject(error);
      } else resolveResponse(response);
    };
    // node:https never follows redirects. No provider-supplied URL is requested.
    const request = requestGet(
      parsed,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      },
      (response) => {
        if (JSON.stringify(response.headers).includes(token)) {
          response.destroy();
          finish(fail("malformed_response"));
          return;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          finish(null, { status: response.statusCode, headers: response.headers });
          return;
        }
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(fail("payload_overflow"));
          chunks.push(chunk);
        });
        response.on("error", () => finish(fail("network")));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (body.includes(token)) return finish(fail("malformed_response"));
          finish(null, { status: response.statusCode, headers: response.headers, body });
        });
      },
    );
    const timer = setTimeout(() => finish(fail("timeout")), timeoutMs);
    request.on("error", () => finish(fail("network")));
  });
}

function identity(pr, metadata) {
  const base = metadata?.repository;
  required(!metadata?.forkSource || metadata.forkSource.repository, "unsupported_scope");
  const head = metadata?.forkSource?.repository ?? base;
  required(base && head && metadata.pullRequestId === pr.number);
  const projectId = lowerGuid(base.project?.id);
  required(
    lowerGuid(head.project?.id) === projectId && head.project.name === base.project.name,
    "unsupported_scope",
  );
  let result;
  try {
    result = PrMaintenanceIdentitySchema.parse({
      provider: "azure-devops",
      host: "dev.azure.com",
      organization: pr.organization,
      project: base.project.name,
      projectId,
      prNumber: metadata.pullRequestId,
      repositoryId: lowerGuid(base.id),
      repository: `${base.project.name}/${base.name}`,
      headRepositoryId: lowerGuid(head.id),
      headRepository: `${head.project.name}/${head.name}`,
      headRef: metadata.sourceRefName,
      baseRepositoryId: lowerGuid(base.id),
      baseRepository: `${base.project.name}/${base.name}`,
      baseRef: metadata.targetRefName,
    });
  } catch {
    throw fail("malformed_response");
  }
  required(
    (pr.projectId ? pr.projectId === projectId : pr.project === result.project) &&
      (pr.repositoryId ? pr.repositoryId === result.repositoryId : pr.repo === base.name),
    "scope_changed",
  );
  for (const key of Object.keys(result))
    if (pr[key] !== undefined) required(pr[key] === result[key], "scope_changed");
  if (metadata.forkSource)
    required(metadata.forkSource.name === result.headRef, "scope_changed");
  return result;
}
function metadataValue(pr, body) {
  const id = identity(pr, body);
  required(
    ["active", "completed", "abandoned"].includes(body.status) &&
      typeof body.isDraft === "boolean" &&
      typeof body.title === "string" &&
      (body.description === undefined || typeof body.description === "string") &&
      Array.isArray(body.reviewers),
  );
  for (const voter of body.reviewers)
    required(
      GUID.test(voter?.id) &&
        [10, 5, 0, -5, -10].includes(voter.vote) &&
        (voter.isRequired === undefined || typeof voter.isRequired === "boolean"),
    );
  return {
    identity: id,
    ...pick(body, [
      "status",
      "isDraft",
      "title",
      "description",
      "supportsIterations",
      "mergeStatus",
      "lastMergeSourceCommit",
      "lastMergeTargetCommit",
      "lastMergeCommit",
      "autoCompleteSetBy",
      "completionOptions",
      "completionQueueTime",
      "mergeFailureType",
    ]),
    reviewers: body.reviewers.map((voter) => ({
      id: lowerGuid(voter.id),
      vote: voter.vote,
      isRequired: voter.isRequired === true,
      isContainer: voter.isContainer === true,
      votedFor: (voter.votedFor ?? []).map((entry) => ({
        id: lowerGuid(entry.id),
        vote: entry.vote,
      })),
    })),
  };
}
const apiRoot = (pr, id) =>
  `https://dev.azure.com/${encodeURIComponent(pr.organization)}/${encodeURIComponent(id?.projectId ?? pr.projectId ?? pr.project)}/_apis`;
function endpoint(pr, scan, job) {
  const id = scan?.metadata.identity;
  const root = apiRoot(pr, id);
  const repo = `${root}/git/repositories/${encodeURIComponent(id?.repositoryId ?? pr.repositoryId ?? pr.repo)}`;
  const pull = `${repo}/pullRequests/${pr.number}`;
  let path;
  const query = new URLSearchParams({ "api-version": "7.1" });
  switch (job.kind) {
    case "metadata":
      path = pull;
      break;
    case "iterations":
      path = `${pull}/iterations`;
      break;
    case "threads":
      path = `${pull}/threads`;
      break;
    case "comments":
      required(positive(job.threadId), "invalid_resume");
      path = `${pull}/threads/${job.threadId}/comments`;
      break;
    case "statuses":
      path = `${pull}/statuses`;
      break;
    case "iterationStatuses":
      required(positive(job.iterationId), "invalid_resume");
      path = `${pull}/iterations/${job.iterationId}/statuses`;
      break;
    case "headRef":
    case "baseRef": {
      const head = job.kind === "headRef";
      path = `${root}/git/repositories/${head ? id.headRepositoryId : id.baseRepositoryId}/refs`;
      query.set("filter", (head ? id.headRef : id.baseRef).slice(5));
      query.set("$top", String(PAGE_SIZE));
      if (job.cursor !== undefined) {
        required(
          typeof job.cursor === "string" &&
            job.cursor.length > 0 &&
            job.cursor.length <= 1024,
          "invalid_resume",
        );
        query.set("continuationToken", job.cursor);
      }
      break;
    }
    case "policies":
      path = `${root}/git/policy/configurations`;
      query.set("api-version", "5.0-preview.1");
      query.set("repositoryId", id.repositoryId);
      query.set("refName", id.baseRef);
      break;
    case "evaluations":
      path = `${root}/policy/evaluations`;
      query.set("api-version", "7.1-preview.1");
      query.set(
        "artifactId",
        `vstfs:///CodeReview/CodeReviewId/${id.projectId}/${pr.number}`,
      );
      query.set("includeNotApplicable", "true");
      query.set("$top", String(PAGE_SIZE));
      required(
        job.skip === undefined ||
          (Number.isInteger(job.skip) && job.skip >= 0 && job.skip <= MAX_ITEMS),
        "invalid_resume",
      );
      query.set("$skip", String(job.skip ?? 0));
      break;
    case "build":
      required(positive(job.buildId), "invalid_resume");
      path = `${root}/build/builds/${job.buildId}`;
      break;
    default:
      throw fail("invalid_resume");
  }
  return `${path}?${query}`;
}

function listPage(body, headers, job) {
  required(
    body &&
      Array.isArray(body.value) &&
      (body.count === undefined || body.count === body.value.length),
  );
  const continuation = headers["x-ms-continuationtoken"];
  let next = null;
  if (continuation !== undefined && continuation !== "") {
    required(["headRef", "baseRef"].includes(job.kind), "unsupported_pagination");
    required(
      typeof continuation === "string" &&
        continuation.length <= 1024 &&
        continuation !== job.cursor &&
        body.value.length > 0,
    );
    next = { ...job, cursor: continuation };
  } else if (job.kind === "evaluations" && body.value.length === PAGE_SIZE) {
    next = { ...job, skip: (job.skip ?? 0) + PAGE_SIZE };
  }
  required(
    !headers.link && body.continuationToken === undefined && body.nextLink === undefined,
    "unsupported_pagination",
  );
  return { values: body.value, next };
}

function currentIteration(scan) {
  const values = scan.data.iterations;
  required(
    values?.length &&
      values.every((entry) => positive(entry.id)) &&
      new Set(values.map((entry) => entry.id)).size === values.length,
  );
  const latest = values.reduce((left, right) => (left.id > right.id ? left : right));
  required(
    SHA.test(latest.sourceRefCommit?.commitId) &&
      SHA.test(latest.targetRefCommit?.commitId) &&
      date(latest.createdDate) &&
      date(latest.updatedDate),
  );
  return latest;
}
function normalizePage(pr, scan, job, response) {
  const headers = Object.fromEntries(
    Object.entries(response.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  if (response.status === 401) throw fail("auth_required");
  if (response.status === 429 || (response.status === 403 && headers["retry-after"])) {
    const error = fail("rate_limited");
    const seconds = Number(headers["retry-after"]);
    error.retryAfterSeconds =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400, Math.ceil(seconds)) : 60;
    throw error;
  }
  if (response.status === 403) throw fail("permission_denied");
  if (response.status === 404 && job.kind === "policies")
    throw fail("unsupported_policy");
  required(response.status === 200, "network");
  let body;
  try {
    body = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  } catch {
    throw fail("malformed_response");
  }
  required(body && typeof body === "object");
  bounded(body);
  if (job.kind === "metadata") return metadataValue(pr, body);
  if (job.kind === "build") {
    required(body.id === job.buildId);
    return {
      values: [
        pick(body, [
          "id",
          "project",
          "definition",
          "repository",
          "sourceBranch",
          "sourceVersion",
          "status",
          "result",
          "queueTime",
          "startTime",
          "finishTime",
          "deleted",
        ]),
      ],
      next: null,
    };
  }
  const page = listPage(body, headers, job);
  if (job.kind === "threads") {
    page.values = page.values.map((thread) => {
      required(
        positive(thread.id) &&
          date(thread.lastUpdatedDate) &&
          Array.isArray(thread.comments),
      );
      return {
        ...pick(thread, [
          "id",
          "status",
          "isDeleted",
          "publishedDate",
          "lastUpdatedDate",
          "threadContext",
          "pullRequestThreadContext",
        ]),
        comments: thread.comments,
      };
    });
  }
  if (job.kind === "comments") {
    page.values = page.values.map((comment) => {
      required(
        positive(comment.id) &&
          Number.isInteger(comment.parentCommentId) &&
          comment.parentCommentId >= 0 &&
          date(comment.lastUpdatedDate) &&
          ["text", "system", "codeChange", "unknown"].includes(comment.commentType) &&
          (comment.isDeleted === true || typeof comment.content === "string"),
      );
      return {
        ...pick(comment, [
          "id",
          "parentCommentId",
          "content",
          "commentType",
          "isDeleted",
          "publishedDate",
          "lastUpdatedDate",
          "lastContentUpdatedDate",
        ]),
        actor: comment.author?.id ? lowerGuid(comment.author.id) : null,
        threadId: job.threadId,
      };
    });
  }
  return page;
}

/** Only one-to-one exact comment receipts are automatically settled. */
export function matchEffects(sources, effects = []) {
  const pairs = effects.map((effect) =>
    sources.filter(
      (source) =>
        effect.kind === "thread_comment" &&
        source.kind === effect.kind &&
        source.actor &&
        effect.actor.toLowerCase() === source.actor &&
        effect.contentHash === source.contentHash &&
        (effect.id ? effect.id === source.id : source.body.includes(effect.marker)),
    ),
  );
  const matched = [];
  const ambiguous = [];
  effects.forEach((effect, index) => {
    const candidates = pairs[index];
    if (
      candidates.length === 1 &&
      pairs.filter((pair) => pair.includes(candidates[0])).length === 1
    )
      matched.push({
        effectId: effect.effectId,
        kind: effect.kind,
        sourceId: candidates[0].id,
      });
    else if (candidates.length)
      ambiguous.push({
        effectId: effect.effectId,
        sourceIds: candidates.map((source) => source.id),
      });
  });
  return {
    matched,
    ambiguous,
    unobserved: effects
      .filter((effect) => !matched.some((entry) => entry.effectId === effect.effectId))
      .map((effect) => effect.effectId),
    remaining: sources.filter(
      (source) => !matched.some((entry) => entry.sourceId === source.id),
    ),
  };
}

function policyValue(config) {
  required(
    positive(config?.id) &&
      positive(config.revision) &&
      GUID.test(config.type?.id) &&
      typeof config.isEnabled === "boolean" &&
      typeof config.isBlocking === "boolean" &&
      config.settings &&
      typeof config.settings === "object" &&
      !Array.isArray(config.settings),
  );
  return {
    id: config.id,
    revision: config.revision,
    type: lowerGuid(config.type.id),
    isEnabled: config.isEnabled,
    isBlocking: config.isBlocking,
    isDeleted: config.isDeleted === true,
    settings: config.settings,
  };
}

function knownPolicySettings(config) {
  const common = ["scope", "filenamePatterns"];
  const keys = {
    [POLICY_TYPES.build]: [
      "buildDefinitionId",
      "queueOnSourceUpdateOnly",
      "manualQueueOnly",
      "displayName",
      "validDuration",
    ],
    [POLICY_TYPES.status]: [
      "statusName",
      "statusGenre",
      "authorId",
      "invalidateOnSourceUpdate",
      "defaultDisplayName",
      "policyApplicability",
    ],
    [POLICY_TYPES.reviewers]: [
      "minimumApproverCount",
      "creatorVoteCounts",
      "allowDownvotes",
      "resetOnSourcePush",
    ],
    [POLICY_TYPES.requiredReviewers]: [
      "requiredReviewerIds",
      "message",
      "addedFilesOnly",
    ],
    [POLICY_TYPES.comments]: [],
  }[config.type];
  if (
    !keys ||
    Object.keys(config.settings).some((key) => ![...common, ...keys].includes(key))
  )
    return false;
  const settings = config.settings;
  if (
    !Array.isArray(settings.scope) ||
    !settings.scope.length ||
    settings.scope.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Object.keys(entry).some(
          (key) => !["repositoryId", "refName", "matchKind"].includes(key),
        ) ||
        (entry.repositoryId != null && !GUID.test(entry.repositoryId)) ||
        (entry.refName != null &&
          (typeof entry.refName !== "string" ||
            !entry.refName.startsWith("refs/heads/"))) ||
        (entry.matchKind !== undefined &&
          !["exact", "prefix", "defaultbranch"].includes(
            String(entry.matchKind).toLowerCase(),
          )),
    )
  )
    return false;
  if (
    settings.filenamePatterns != null &&
    (!Array.isArray(settings.filenamePatterns) || settings.filenamePatterns.length > 0)
  )
    return false;
  for (const key of [
    "queueOnSourceUpdateOnly",
    "manualQueueOnly",
    "invalidateOnSourceUpdate",
    "creatorVoteCounts",
    "allowDownvotes",
    "resetOnSourcePush",
    "addedFilesOnly",
  ])
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") return false;
  for (const key of ["validDuration", "minimumApproverCount"])
    if (
      settings[key] !== undefined &&
      (!Number.isSafeInteger(settings[key]) || settings[key] < 0)
    )
      return false;
  if (
    settings.requiredReviewerIds !== undefined &&
    (!Array.isArray(settings.requiredReviewerIds) ||
      settings.requiredReviewerIds.some((value) => !GUID.test(value)))
  )
    return false;
  if (config.type === POLICY_TYPES.build && !positive(settings.buildDefinitionId))
    return false;
  if (
    config.type === POLICY_TYPES.status &&
    (typeof settings.statusName !== "string" ||
      !settings.statusName ||
      (settings.statusGenre !== undefined && typeof settings.statusGenre !== "string") ||
      (settings.authorId && !GUID.test(settings.authorId)) ||
      (settings.policyApplicability !== undefined && settings.policyApplicability !== 0))
  )
    return false;
  return true;
}

function policyEvidence(scan, iteration, headSha, baseSha, now) {
  const { metadata, data } = scan;
  const id = metadata.identity;
  const configs = data.policies.map(policyValue);
  required(new Set(configs.map((config) => config.id)).size === configs.length);
  const artifact = `vstfs:///CodeReview/CodeReviewId/${id.projectId}/${id.prNumber}`;
  const checks = [];
  const reviews = [];
  let checksComplete = true;
  let reviewsComplete = true;
  const scope = { identity: id, headSha, baseSha, iteration: iteration.id };
  const fresh = (timestamp) =>
    date(timestamp) &&
    Date.parse(timestamp) >= Date.parse(iteration.updatedDate) &&
    Date.parse(timestamp) <= now;
  for (const evaluation of data.evaluations) {
    required(evaluation.artifactId === artifact && GUID.test(evaluation.evaluationId));
    policyValue(evaluation.configuration);
    required(
      ["queued", "running", "approved", "rejected", "notApplicable", "broken"].includes(
        evaluation.status,
      ) &&
        (evaluation.completedDate === undefined || date(evaluation.completedDate)) &&
        (evaluation.context === undefined ||
          (evaluation.context &&
            typeof evaluation.context === "object" &&
            !Array.isArray(evaluation.context))),
    );
    if (!configs.some((config) => config.id === evaluation.configuration.id)) {
      checksComplete = false;
      reviewsComplete = false;
    }
  }
  for (const config of configs.filter(
    (config) => config.isEnabled && !config.isDeleted,
  )) {
    const matches = data.evaluations.filter(
      (evaluation) => evaluation.configuration?.id === config.id,
    );
    required(matches.length <= 1);
    const evaluation = matches[0];
    const settingsKnown = knownPolicySettings(config);
    const status = evaluation?.status ?? "missing";
    const configMatches =
      evaluation !== undefined &&
      contentHash(policyValue(evaluation.configuration)) === contentHash(config);
    let verified =
      settingsKnown &&
      configMatches &&
      status !== "notApplicable" &&
      (!["approved", "rejected", "broken"].includes(status) ||
        fresh(evaluation.completedDate));
    if (!settingsKnown || status === "notApplicable") {
      checksComplete = false;
      reviewsComplete = false;
    }
    const reviewPolicy = [
      POLICY_TYPES.reviewers,
      POLICY_TYPES.requiredReviewers,
    ].includes(config.type);
    let state =
      status === "approved"
        ? "passed"
        : ["rejected", "broken"].includes(status)
          ? "failed"
          : ["queued", "running"].includes(status)
            ? "pending"
            : "unknown";
    if (reviewPolicy) {
      // Votes have no commit identity in the public schema; even +10 isn't HEAD proof.
      if (!verified || status === "approved") reviewsComplete = false;
      const key = contentHash({
        scope,
        config,
        status,
        verified: verified && status !== "approved",
      });
      if (config.isBlocking)
        reviews.push({
          key,
          revision: key,
          reviewer: `ado-policy:${config.id}`,
          headSha,
          state: status === "rejected" ? "changes_requested" : "required",
          evidence: `Azure DevOps review policy ${config.id}, revision ${config.revision}: ${status}; votes are not HEAD attestations.`,
        });
      continue;
    }
    let preciseFailure = false;
    if (config.type === POLICY_TYPES.build) {
      const buildId = evaluation?.context?.buildId;
      if (positive(buildId)) {
        const build = data.build?.find((entry) => entry.id === buildId);
        required(
          build &&
            GUID.test(build.project?.id) &&
            positive(build.definition?.id) &&
            typeof build.repository?.id === "string" &&
            typeof build.repository?.type === "string" &&
            typeof build.sourceBranch === "string" &&
            typeof build.sourceVersion === "string" &&
            date(build.queueTime) &&
            typeof build.status === "string",
        );
        required(lowerGuid(build.project.id) === id.projectId, "scope_changed");
        const repositoryId = build.repository.id.toLowerCase();
        const sourceBuild =
          repositoryId === id.headRepositoryId &&
          build.sourceBranch === id.headRef &&
          build.sourceVersion === headSha;
        const mergeBuild =
          repositoryId === id.baseRepositoryId &&
          build.sourceBranch === `refs/pull/${id.prNumber}/merge` &&
          SHA.test(metadata.lastMergeCommit?.commitId) &&
          build.sourceVersion === metadata.lastMergeCommit.commitId &&
          metadata.lastMergeSourceCommit?.commitId === headSha &&
          metadata.lastMergeTargetCommit?.commitId === baseSha;
        const buildProof =
          !build.deleted &&
          build.definition.id === config.settings.buildDefinitionId &&
          build.repository.type === "TfsGit" &&
          (sourceBuild || mergeBuild) &&
          fresh(build.queueTime);
        preciseFailure =
          configMatches &&
          fresh(evaluation.completedDate) &&
          buildProof &&
          state === "failed" &&
          build.status === "completed" &&
          ["failed", "partiallySucceeded", "canceled"].includes(build.result);
      }
      // The public evaluation schema does not define context.buildId as a build-policy binding.
      // It is diagnostic-only until that relationship has a supported provider contract.
      checksComplete = false;
      verified = false;
    }
    if (config.type === POLICY_TYPES.status) {
      const settings = config.settings;
      if (state !== "pending") {
        const statuses = data.iterationStatuses.filter(
          (status) =>
            status.context?.name === settings.statusName &&
            (status.context.genre ?? "") === (settings.statusGenre ?? "") &&
            (!settings.authorId ||
              (typeof settings.authorId === "string" &&
                status.createdBy?.id?.toLowerCase() === settings.authorId.toLowerCase())),
        );
        const sorted = [...statuses].sort(
          (a, b) => Date.parse(b.updatedDate) - Date.parse(a.updatedDate),
        );
        const latest = sorted[0];
        verified = Boolean(
          verified &&
          settings.invalidateOnSourceUpdate === true &&
          latest &&
          (sorted.length === 1 || latest.updatedDate !== sorted[1].updatedDate) &&
          latest.iterationId === iteration.id &&
          fresh(latest.updatedDate) &&
          Date.parse(evaluation.completedDate) >= Date.parse(latest.updatedDate) &&
          (state !== "passed" || latest.state === "succeeded"),
        );
        preciseFailure = verified && ["failed", "error"].includes(latest?.state);
      }
    }
    if (config.type === POLICY_TYPES.comments && state === "passed")
      verified =
        verified &&
        data.threads.every(
          (thread) =>
            thread.isDeleted === true ||
            !thread.comments.some(
              (comment) => comment.commentType === "text" && !comment.isDeleted,
            ) ||
            ["fixed", "closed", "wontFix", "byDesign"].includes(thread.status),
        );
    if (!verified) {
      checksComplete = false;
      if (state === "passed") state = "unknown";
    }
    const key = contentHash({ scope, config, state, verified, preciseFailure });
    if (
      config.isBlocking ||
      ([POLICY_TYPES.build, POLICY_TYPES.status].includes(config.type) &&
        ["failed", "pending"].includes(state))
    )
      checks.push({
        key,
        state,
        headSha,
        evidence: `Azure DevOps policy ${config.id}, revision ${config.revision}: ${status}; iteration ${iteration.id}; readiness evidence verified=${verified}.`,
        ...(preciseFailure ? { sourceId: `policy:${config.id}` } : {}),
      });
  }
  for (const voter of metadata.reviewers) {
    if (!voter.isRequired && voter.vote >= 0) continue;
    const revision = contentHash({ scope, voter });
    reviews.push({
      key: revision,
      revision,
      reviewer: voter.id,
      headSha,
      state: voter.vote < 0 ? "changes_requested" : "required",
      evidence: `Azure DevOps reviewer ${voter.id}: vote ${voter.vote}, required=${voter.isRequired}; positive votes alone never prove current-HEAD approval.`,
    });
  }
  return { configs, checks, reviews, checksComplete, reviewsComplete };
}

function snapshot(input, scan, now) {
  const { metadata, data } = scan;
  const identity = metadata.identity;
  const terminal = metadata.status !== "active";
  const iteration = terminal ? null : currentIteration(scan);
  const headSha = terminal
    ? metadata.lastMergeSourceCommit?.commitId
    : iteration.sourceRefCommit.commitId;
  let baseSha = terminal
    ? metadata.lastMergeTargetCommit?.commitId
    : iteration.targetRefCommit.commitId;
  required(SHA.test(headSha) && SHA.test(baseSha));
  if (!terminal) {
    required(metadata.supportsIterations === true, "stale_evidence");
    required(
      Date.parse(iteration.createdDate) <= Date.parse(iteration.updatedDate) &&
        Date.parse(iteration.updatedDate) <= now,
      "stale_evidence",
    );
    const liveHead = data.headRef.filter((entry) => entry.name === identity.headRef);
    const liveBase = data.baseRef.filter((entry) => entry.name === identity.baseRef);
    required(
      liveHead.length === 1 &&
        liveHead[0].objectId === headSha &&
        liveBase.length === 1 &&
        SHA.test(liveBase[0].objectId),
      "stale_evidence",
    );
    // A source iteration does not advance when only the target branch moves.
    baseSha = liveBase[0].objectId;
    for (const status of [...data.statuses, ...data.iterationStatuses])
      required(
        positive(status.id) &&
          typeof status.context?.name === "string" &&
          date(status.updatedDate) &&
          ["notSet", "pending", "succeeded", "failed", "error", "notApplicable"].includes(
            status.state,
          ),
      );
    required(
      data.iterationStatuses.every((status) => status.iterationId === iteration.id),
      "stale_evidence",
    );
  }
  const mergeEvaluation = {
    sourceSha: metadata.lastMergeSourceCommit?.commitId,
    targetSha: metadata.lastMergeTargetCommit?.commitId,
    mergeSha: metadata.lastMergeCommit?.commitId,
    current:
      metadata.lastMergeSourceCommit?.commitId === headSha &&
      metadata.lastMergeTargetCommit?.commitId === baseSha,
  };
  const url = `https://dev.azure.com/${identity.organization}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(identity.repository.split("/")[1])}/pullrequest/${identity.prNumber}`;
  const threads = (data.threads ?? []).map((thread) => {
    const comments = (data.comments ?? []).filter(
      (comment) => comment.threadId === thread.id,
    );
    required(
      thread.comments.length === comments.length &&
        thread.comments.every((comment) =>
          comments.some(
            (entry) =>
              entry.id === comment.id &&
              entry.content === comment.content &&
              entry.lastUpdatedDate === comment.lastUpdatedDate,
          ),
        ),
      "inconsistent_snapshot",
    );
    required(
      [
        "unknown",
        "active",
        "fixed",
        "wontFix",
        "closed",
        "byDesign",
        "pending",
        undefined,
      ].includes(thread.status),
    );
    required(
      thread.status !== undefined ||
        comments.every((comment) => comment.commentType === "system"),
    );
    return { ...thread, comments };
  });
  const threadStates = threads.map((thread) => {
    const stateHash = contentHash({
      status: thread.status,
      isDeleted: thread.isDeleted,
      threadContext: thread.threadContext,
      pullRequestThreadContext: thread.pullRequestThreadContext,
    });
    const previous = input.previousThreads?.find(
      (state) => state.id === String(thread.id),
    );
    return {
      id: String(thread.id),
      stateHash,
      revision: previous
        ? previous.revision + Number(previous.stateHash !== stateHash)
        : 0,
    };
  });
  const sources = threads.flatMap((thread) =>
    thread.comments
      .filter(
        (comment) =>
          !thread.isDeleted && !comment.isDeleted && comment.commentType === "text",
      )
      .map((comment) => {
        const source = {
          kind: "thread_comment",
          id: `${thread.id}:${comment.id}`,
          threadId: String(thread.id),
          parentCommentId: comment.parentCommentId,
          actor: comment.actor,
          body: comment.content,
          contentHash: contentHash(comment.content),
          url,
          threadRevision: threadStates.find((state) => state.id === String(thread.id))
            .revision,
          lastUpdatedDate: comment.lastUpdatedDate,
          lastContentUpdatedDate: comment.lastContentUpdatedDate,
        };
        return { ...source, revision: contentHash(source) };
      }),
  );
  const effects = matchEffects(sources, input.knownEffects);
  required(!effects.ambiguous.length, "ambiguous_effect");
  const actionableSources = effects.remaining.filter(
    (source) =>
      !(input.handledSources ?? []).some(
        (handled) =>
          handled.kind === source.kind &&
          handled.id === source.id &&
          handled.revision === source.revision &&
          handled.headSha === headSha,
      ),
  );
  const policy = terminal
    ? {
        configs: [],
        checks: [],
        reviews: [],
        checksComplete: true,
        reviewsComplete: true,
      }
    : policyEvidence(scan, iteration, headSha, baseSha, now);
  const checks = [...policy.checks];
  if (!terminal) {
    checks.push({
      key: contentHash({
        headSha,
        baseSha,
        mergeEvaluationCurrent: mergeEvaluation.current,
      }),
      state: mergeEvaluation.current ? "passed" : "pending",
      headSha,
      evidence: `Azure DevOps merge evaluation matches current source ${headSha} and live target ${baseSha}: ${mergeEvaluation.current}. The iteration target is ${iteration.targetRefCommit.commitId}.`,
    });
    const clear =
      !metadata.isDraft &&
      !metadata.autoCompleteSetBy &&
      !metadata.completionQueueTime &&
      !metadata.completionOptions?.bypassPolicy;
    checks.push({
      key: contentHash({
        headSha,
        baseSha,
        draft: metadata.isDraft,
        autoComplete: Boolean(metadata.autoCompleteSetBy),
        queue: Boolean(metadata.completionQueueTime),
        bypass: Boolean(metadata.completionOptions?.bypassPolicy),
      }),
      state: clear ? "passed" : "pending",
      headSha,
      evidence: `Azure DevOps lifecycle guard: draft=${metadata.isDraft}, autoComplete=${Boolean(metadata.autoCompleteSetBy)}, completionQueued=${Boolean(metadata.completionQueueTime)}, bypass=${Boolean(metadata.completionOptions?.bypassPolicy)}.`,
    });
    // Non-policy statuses can still be running; only failures are repair sources.
    const contexts = new Map();
    const ambiguousContexts = new Set();
    for (const status of data.iterationStatuses) {
      // Hash the encoded tuple: canonical hashing sorts arrays, but not strings.
      const contextId = contentHash(
        JSON.stringify([status.context.genre ?? "", status.context.name]),
      );
      const previous = contexts.get(contextId);
      if (
        !previous ||
        Date.parse(status.updatedDate) > Date.parse(previous.updatedDate)
      ) {
        contexts.set(contextId, status);
        ambiguousContexts.delete(contextId);
      } else if (
        Date.parse(status.updatedDate) === Date.parse(previous.updatedDate) &&
        status.state !== previous.state
      )
        ambiguousContexts.add(contextId);
    }
    for (const [contextId, status] of contexts) {
      const label = JSON.stringify([
        status.context.genre ?? "",
        status.context.name,
      ]).slice(0, 1024);
      if (ambiguousContexts.has(contextId)) {
        policy.checksComplete = false;
        checks.push({
          key: contentHash({ identity, headSha, baseSha, contextId, ambiguous: true }),
          state: "unknown",
          headSha,
          evidence: `Azure DevOps iteration ${iteration.id} status ${label} has conflicting latest states.`,
        });
        continue;
      }
      if (!["failed", "error", "pending", "notSet"].includes(status.state)) continue;
      const state = ["failed", "error"].includes(status.state)
        ? "failed"
        : status.state === "pending"
          ? "pending"
          : "unknown";
      checks.push({
        key: contentHash({ identity, headSha, baseSha, contextId, state: status.state }),
        ...(state === "failed" ? { sourceId: `status:${contextId}` } : {}),
        state,
        headSha,
        evidence: `Azure DevOps iteration ${iteration.id} status ${label}: ${status.state}.`,
      });
    }
  }
  const result = {
    identity,
    url,
    generation: input.generation,
    headSha,
    baseSha,
    iteration,
    state: terminal ? (metadata.status === "completed" ? "merged" : "closed") : "open",
    title: metadata.title,
    body: metadata.description ?? "",
    mergeability: !mergeEvaluation.current
      ? "unknown"
      : metadata.mergeStatus === "succeeded" &&
          SHA.test(metadata.lastMergeCommit?.commitId)
        ? "mergeable"
        : metadata.mergeStatus === "conflicts"
          ? "conflicting"
          : "unknown",
    mergeStatus: metadata.mergeStatus,
    mergeEvaluation,
    isDraft: metadata.isDraft,
    autoComplete: Boolean(metadata.autoCompleteSetBy),
    threads,
    threadStates,
    reviewers: metadata.reviewers,
    statuses: data.statuses ?? [],
    builds: data.build ?? [],
    policies: policy.configs,
    evaluations: data.evaluations ?? [],
    checks,
    checksComplete: policy.checksComplete,
    reviewsComplete: policy.reviewsComplete,
    reviews: policy.reviews,
    actionableSources,
    effects,
  };
  result.actionableFingerprint = contentHash({
    identity,
    generation: input.generation,
    headSha,
    baseSha,
    iteration: iteration?.id,
    state: result.state,
    title: result.title,
    body: result.body,
    mergeStatus: result.mergeStatus,
    checks,
    checksComplete: result.checksComplete,
    reviewsComplete: result.reviewsComplete,
    reviews: result.reviews,
    policies: result.policies,
    sources: actionableSources.map(({ kind, id, revision }) => ({ kind, id, revision })),
  });
  bounded(result);
  return result;
}

export function toAdoHostObservation(
  result,
  input = {},
  attemptedAt = new Date().toISOString(),
) {
  const value = result.snapshot;
  const observation = {
    attemptedAt,
    complete: result.complete,
    requestsConsumed: result.requestsConsumed,
    elapsedMs: Math.min(1_000_000, Math.ceil(result.elapsedMs)),
    helperState: {
      resume: result.resume ?? null,
      previousThreads: value?.threadStates ?? input.previousThreads ?? [],
      ...(result.error ? { error: result.error } : {}),
    },
    cursor: JSON.stringify(result.progress),
    evidence: result.complete
      ? `Azure DevOps helper v1: ${value.url}; fingerprint ${value.actionableFingerprint}; checksComplete=${value.checksComplete}, reviewsComplete=${value.reviewsComplete}.`
      : `Azure DevOps helper v1: ${result.error.code}; ${result.error.message}`,
  };
  if (!result.complete) {
    observation.failure = ["cli_unavailable", "local_auth_unavailable"].includes(
      result.error.code,
    )
      ? "capability"
      : result.error.code === "auth_required"
        ? "auth"
        : result.error.code === "permission_denied"
          ? "permission"
          : result.error.code === "rate_limited"
            ? "rate_limit"
            : ["deadline_exhausted", "budget_exhausted"].includes(result.error.code)
              ? "budget"
              : ["network", "timeout"].includes(result.error.code)
                ? "network"
                : "incomplete";
    if (result.error.retryAfterSeconds)
      observation.retryAfter = new Date(
        Date.parse(attemptedAt) + result.error.retryAfterSeconds * 1000,
      ).toISOString();
  } else {
    Object.assign(observation, {
      identity: value.identity,
      snapshotId: value.actionableFingerprint,
      fingerprint: value.actionableFingerprint,
      headSha: value.headSha,
      baseSha: value.baseSha,
      state: value.state,
      draft: value.isDraft,
      mergeability: value.mergeability,
      checksComplete: value.checksComplete,
      reviewsComplete: value.reviewsComplete,
      checks: value.checks.map((check) =>
        pick(check, ["key", "state", "headSha", "evidence"]),
      ),
      reviews: value.reviews,
      sources: [
        ...value.actionableSources.map((source) => ({
          id: `${source.kind}:${source.id}`,
          revision: source.revision,
          groupKey: `thread:${source.threadId}`,
          evidence: `${value.url}; source ${source.id}; content hash ${source.contentHash}. Read the complete helper snapshot.`,
        })),
        ...value.checks
          .filter((check) => check.state === "failed" && check.sourceId)
          .map((check) => ({
            id: `check:${check.sourceId}`,
            revision: check.key,
            groupKey: `check:${check.sourceId}`,
            evidence: check.evidence,
          })),
      ],
      knownSelfEffectIds: value.effects.matched.map((effect) => effect.effectId),
    });
  }
  return PrMaintenanceObservationSchema.parse(observation);
}

/** Fixture transport receives only {method:"GET",url,timeoutMs,maxBytes}; never a credential. */
export async function observe(input, { request, now = Date.now } = {}) {
  const started = now();
  let requestsConsumed = 0;
  let scan;
  let limits;
  let token;
  let result;
  const progress = () => ({
    phase: scan?.phase ?? "metadata",
    pages: scan?.pages.length ?? 0,
    verifiedPages: scan?.verified ?? 0,
    cursor: scan?.jobs[0] ?? null,
  });
  const base = () => ({
    schemaVersion: VERSION,
    complete: false,
    requestsConsumed,
    elapsedMs: Math.max(0, now() - started),
    progress: progress(),
  });
  try {
    const validated = validate(input, started);
    const pr = validated.pr;
    limits = validated.limits;
    const scopeKey = contentHash({
      generation: input.generation,
      pr,
      knownEffects: input.knownEffects,
      handledSources: input.handledSources,
      previousThreads: input.previousThreads,
    });
    if (input.resume) {
      const candidate = structuredClone(input.resume);
      required(
        candidate.schemaVersion === VERSION &&
          candidate.scopeKey === scopeKey &&
          ["scan", "verify"].includes(candidate.phase) &&
          Array.isArray(candidate.pages) &&
          Array.isArray(candidate.jobs) &&
          candidate.data &&
          candidate.metadata &&
          candidate.digest === contentHash({ ...candidate, digest: undefined }),
        "invalid_resume",
      );
      scan = candidate;
      delete scan.digest;
      scan.verified = 0;
    }
    const charge = () => {
      required(now() < limits.deadline, "deadline_exhausted");
      required(requestsConsumed < limits.maxRequests, "budget_exhausted");
      requestsConsumed++;
      return Math.max(1, Math.min(15_000, limits.deadline - now()));
    };
    const read = async (job) => {
      const url = endpoint(pr, scan, job);
      if (!request) {
        if (!token) token = await getAccessToken({ timeoutMs: charge() });
      }
      const timeoutMs = charge();
      const args = { method: "GET", url, timeoutMs, maxBytes: limits.maxBytes };
      const response = await (request ? request(args) : httpsRequest(args, token));
      required(now() <= limits.deadline, "deadline_exhausted");
      required(size(response) <= limits.maxBytes, "payload_overflow");
      return normalizePage(pr, scan, job, response);
    };
    const metadata = await read({ kind: "metadata" });
    required(
      !scan || contentHash(metadata) === contentHash(scan.metadata),
      "inconsistent_snapshot",
    );
    scan ??= {
      schemaVersion: VERSION,
      scopeKey,
      metadata,
      phase: "scan",
      verified: 0,
      pages: [],
      jobs:
        metadata.status === "active"
          ? [
              "iterations",
              "headRef",
              "baseRef",
              "threads",
              "statuses",
              "policies",
              "evaluations",
            ].map((kind) => ({ kind }))
          : [],
      data: {},
    };
    while (scan.jobs.length) {
      const job = scan.jobs[0];
      const page = await read(job);
      const next = structuredClone(scan);
      next.jobs.shift();
      next.pages.push({ job, hash: contentHash(page) });
      next.data[job.kind] ??= [];
      const keyOf = (entry) =>
        job.kind === "evaluations"
          ? entry.evaluationId
          : job.kind === "comments"
            ? `${entry.threadId}:${entry.id}`
            : ["headRef", "baseRef"].includes(job.kind)
              ? entry.name
              : entry.id;
      const all = [...next.data[job.kind], ...page.values];
      required(new Set(all.map(keyOf)).size === all.length, "inconsistent_snapshot");
      next.data[job.kind] = all;
      if (page.next) {
        required(
          !next.pages.some((entry) => contentHash(entry.job) === contentHash(page.next)),
          "inconsistent_snapshot",
        );
        next.jobs.unshift(page.next);
      }
      if (job.kind === "iterations")
        next.jobs.push({
          kind: "iterationStatuses",
          iterationId: currentIteration(next).id,
        });
      if (job.kind === "threads")
        next.jobs.push(
          ...page.values.map((thread) => ({ kind: "comments", threadId: thread.id })),
        );
      if (job.kind === "evaluations") {
        for (const evaluation of page.values) {
          const buildId = evaluation.context?.buildId;
          if (
            evaluation.configuration?.type?.id?.toLowerCase() === POLICY_TYPES.build &&
            positive(buildId) &&
            !next.jobs.some(
              (entry) => entry.kind === "build" && entry.buildId === buildId,
            ) &&
            !next.data.build?.some((entry) => entry.id === buildId)
          )
            next.jobs.push({ kind: "build", buildId });
        }
      }
      bounded(next);
      required(size(next) + 4096 <= limits.maxBytes, "payload_overflow");
      scan = next;
    }
    scan.phase = "verify";
    // Never carry verification credit across wakes. Every recorded page must fit this wake.
    required(
      scan.pages.length + 1 <= limits.maxRequests - requestsConsumed,
      "budget_exhausted",
    );
    for (const page of scan.pages) {
      required(contentHash(await read(page.job)) === page.hash, "inconsistent_snapshot");
      scan.verified++;
    }
    required(
      contentHash(await read({ kind: "metadata" })) === contentHash(metadata),
      "inconsistent_snapshot",
    );
    const value = snapshot(input, scan, now());
    result = {
      ...base(),
      complete: true,
      snapshot: value,
      progress: { ...progress(), phase: "complete", cursor: null },
    };
    required(size(result) <= limits.maxBytes, "payload_overflow");
  } catch (error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : "network";
    result = { ...base(), error: { code, message: messages[code] } };
    if (code === "rate_limited" && Number.isFinite(error.retryAfterSeconds))
      result.error.retryAfterSeconds = error.retryAfterSeconds;
    if (
      scan &&
      [
        "budget_exhausted",
        "deadline_exhausted",
        "network",
        "timeout",
        "rate_limited",
      ].includes(code)
    ) {
      const resume = { ...scan, digest: contentHash(scan) };
      if (size({ ...result, resume }) + 4096 <= (limits?.maxBytes ?? MAX_BYTES))
        result.resume = resume;
    }
  } finally {
    token = undefined;
  }
  try {
    result.observation = toAdoHostObservation(
      result,
      limits ? input : {},
      new Date(started).toISOString(),
    );
    required(size(result) <= (limits?.maxBytes ?? MAX_BYTES), "payload_overflow");
  } catch {
    result = {
      ...base(),
      error: { code: "payload_overflow", message: messages.payload_overflow },
    };
    result.observation = toAdoHostObservation(
      result,
      {},
      new Date(started).toISOString(),
    );
  }
  return result;
}

export async function runCli() {
  let input;
  let result;
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(fail("timeout")), 15_000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      required(bytes <= MAX_BYTES, "payload_overflow");
      chunks.push(chunk);
    }
    clearTimeout(timer);
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw fail("invalid_input");
    }
    result = await observe(input);
  } catch (error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : "invalid_input";
    result = {
      schemaVersion: VERSION,
      complete: false,
      requestsConsumed: 0,
      elapsedMs: 0,
      progress: { phase: "input", pages: 0, verifiedPages: 0, cursor: null },
      error: { code, message: messages[code] },
    };
    result.observation = toAdoHostObservation(result);
  } finally {
    clearTimeout(timer);
  }
  delete result.resume;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.complete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runCli();
