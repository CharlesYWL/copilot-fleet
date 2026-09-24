/* global Buffer, process, structuredClone, setTimeout, clearTimeout, URL */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { toHostObservation } from "./host-observation.mjs";
import { observationClock } from "./observation-clock.mjs";

export const VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const PAGE_SIZE = 20;
const collections = [
  "rules",
  "threads",
  "reviews",
  "discussions",
  "reviewRequests",
  "reviewRequestEvents",
  "checks",
];
const actor = "author { login }";
const pageInfo = "pageInfo { hasNextPage endCursor }";
const commentFields = `id body updatedAt url ${actor}`;
const reviewer =
  "requestedReviewer { ... on User { id login } ... on Team { id slug } ... on Mannequin { id login } }";
const metadataFields = `
  id number url title body state isDraft mergedAt headRefName headRefOid baseRefName baseRefOid
  mergeable mergeStateStatus reviewDecision
  repository { id nameWithOwner }
  headRepository { id nameWithOwner }
  baseRef { branchProtectionRule {
    requiresStatusChecks requiredStatusCheckContexts requiredStatusChecks { context app { databaseId } }
    requiresStrictStatusChecks
    requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews
    dismissesStaleReviews requiresConversationResolution
  } }
  commits(last: 1) { nodes { commit { oid message author { user { login } } } } }
`;

// Array order, object insertion order, and poll time are not actionable changes.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function size(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function validRef(value) {
  return (
    typeof value === "string" &&
    value.startsWith("refs/heads/") &&
    value.length > 11 &&
    ![...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[~^:?*[\]\\]|\.\.|@\{|\/\/|[/.]$|(?:^|\/)\.|\.lock(?:\/|$)/.test(value)
  );
}

function validate(input, now) {
  const pr = input?.pr;
  if (
    input?.schemaVersion !== VERSION ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !pr ||
    !/^[a-z\d][a-z\d.-]*(?::\d+)?$/i.test(pr.host) ||
    !/^[a-z\d_.-]+$/i.test(pr.owner) ||
    !/^[a-z\d_.-]+$/i.test(pr.repo) ||
    [pr.owner, pr.repo].some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1
  ) {
    throw fail(
      "invalid_input",
      "Supply version 1, a positive generation, and an exact GitHub host/repository/PR.",
    );
  }
  for (const key of ["headRef", "baseRef"]) {
    if (pr[key] !== undefined && !validRef(pr[key])) {
      throw fail("invalid_input", `Invalid full ${key}; use refs/heads/<branch>.`);
    }
  }
  for (const key of ["repositoryId", "headRepositoryId", "baseRepositoryId"]) {
    if (pr[key] !== undefined && (typeof pr[key] !== "string" || !pr[key])) {
      throw fail("invalid_input", `${key} must be a stable GitHub GraphQL node ID.`);
    }
  }
  if (
    pr.headRepository !== undefined &&
    (typeof pr.headRepository !== "string" ||
      !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(pr.headRepository))
  ) {
    throw fail(
      "invalid_input",
      "headRepository must be the registered owner/repository name.",
    );
  }
  const budget = input.budget;
  if (
    !Number.isInteger(budget?.maxRequests) ||
    budget.maxRequests < 0 ||
    budget.maxRequests > 40 ||
    !Number.isFinite(Date.parse(budget.deadlineAt)) ||
    (budget.maxBytes !== undefined &&
      (!Number.isInteger(budget.maxBytes) ||
        budget.maxBytes < 4096 ||
        budget.maxBytes > MAX_BYTES))
  ) {
    throw fail(
      "invalid_input",
      "Supply remaining maxRequests (0–40), deadlineAt (ISO date), and optional maxBytes (4096–1048576).",
    );
  }
  for (const key of ["knownEffects", "handledSources", "previousThreads"]) {
    if (
      input[key] !== undefined &&
      (!Array.isArray(input[key]) || input[key].length > 1000)
    ) {
      throw fail("invalid_input", `${key} must be a bounded array.`);
    }
  }
  for (const effect of input.knownEffects ?? []) {
    if (
      !effect ||
      typeof effect.effectId !== "string" ||
      typeof effect.kind !== "string" ||
      typeof effect.actor !== "string" ||
      !effect.actor ||
      !/^[a-f\d]{64}$/.test(effect.contentHash) ||
      !(
        (typeof effect.id === "string" && effect.id) ||
        (typeof effect.marker === "string" && effect.marker.length >= 16)
      )
    ) {
      throw fail(
        "invalid_input",
        "Each effect needs effectId, kind, expected actor, exact contentHash, and provider id or unique marker.",
      );
    }
  }
  for (const source of input.handledSources ?? []) {
    if (
      !source ||
      typeof source.id !== "string" ||
      typeof source.kind !== "string" ||
      !/^[a-f\d]{64}$/.test(source.revision) ||
      (source.headSha !== undefined &&
        (typeof source.headSha !== "string" ||
          !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(source.headSha)))
    ) {
      throw fail(
        "invalid_input",
        "Each handled source needs kind, id, exact revision hash and a valid verification headSha when supplied.",
      );
    }
  }
  for (const state of input.previousThreads ?? []) {
    if (
      !state ||
      typeof state.id !== "string" ||
      !/^[a-f\d]{64}$/.test(state.stateHash) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0
    ) {
      throw fail(
        "invalid_input",
        "Each previous thread needs id, stateHash, and a nonnegative revision.",
      );
    }
  }
  return {
    maxRequests: budget.maxRequests,
    deadline: Math.min(Date.parse(budget.deadlineAt), now + 120_000),
    maxBytes: budget.maxBytes ?? 256 * 1024,
  };
}

function queryFor(pr, job) {
  const variables = { owner: pr.owner, repo: pr.repo, number: pr.number };
  let fields;
  if (job.kind === "metadata") fields = metadataFields;
  else {
    variables.cursor = job.cursor ?? null;
    switch (job.kind) {
      case "threads":
        fields = `reviewThreads(first:${PAGE_SIZE},after:$cursor) {
          nodes { id isResolved isOutdated path line originalLine resolvedBy { login } }
          ${pageInfo} }`;
        break;
      case "reviews":
        fields = `reviews(first:${PAGE_SIZE},after:$cursor) {
          nodes { ${commentFields} state submittedAt commit { oid } } ${pageInfo} }`;
        break;
      case "discussions":
        fields = `comments(first:${PAGE_SIZE},after:$cursor) { nodes { ${commentFields} } ${pageInfo} }`;
        break;
      case "reviewRequests":
        fields = `reviewRequests(first:${PAGE_SIZE},after:$cursor) {
          nodes { id ${reviewer} } ${pageInfo} }`;
        break;
      case "reviewRequestEvents":
        fields = `timelineItems(first:${PAGE_SIZE},after:$cursor,itemTypes:[REVIEW_REQUESTED_EVENT]) {
          nodes { ... on ReviewRequestedEvent { id createdAt actor { login } ${reviewer} } }
          ${pageInfo} }`;
        break;
      case "checks":
        fields = `commits(last:1) { nodes { commit { oid statusCheckRollup {
          contexts(first:${PAGE_SIZE},after:$cursor) { nodes {
            ... on CheckRun { id name status conclusion detailsUrl
              isRequired(pullRequestNumber:$number) checkSuite { app { databaseId slug } } }
            ... on StatusContext { id context state targetUrl isRequired(pullRequestNumber:$number) }
          } ${pageInfo} }
        } } } }`;
        break;
      case "threadComments":
        return {
          query: `query($id:ID!,$cursor:String) {
            node(id:$id) { ... on PullRequestReviewThread {
              id pullRequest { id } comments(first:${PAGE_SIZE},after:$cursor) {
                nodes { ${commentFields} diffHunk path line originalLine outdated replyTo { id } }
                ${pageInfo}
              }
            } }
          }`,
          variables: { id: job.threadId, cursor: job.cursor ?? null },
        };
      default:
        throw fail("invalid_resume", "Unknown scan collection.");
    }
  }
  return {
    query: `query($owner:String!,$repo:String!,$number:Int!${job.kind === "metadata" ? "" : ",$cursor:String"}) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${fields} } }
    }`,
    variables,
  };
}

function parseHttp(output) {
  const match = /^HTTP\/[\d.]+ (\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(
    output,
  );
  if (!match)
    throw fail("malformed_response", "GitHub CLI returned no HTTP response envelope.");
  const headers = Object.fromEntries(
    match[2].split(/\r?\n/).map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
    }),
  );
  return { status: Number(match[1]), headers, body: match[3] };
}

/** Exactly one gh API request; never a shell, automatic pagination, retry, or login. */
export function ghRequest({ host, endpoint, payload, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const args = ["api", "--hostname", host, "--include"];
    if (payload) args.push("graphql", "--input", "-");
    else args.push("--method", "GET", endpoint);
    const child = spawn("gh", args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_DEBUG: "" },
    });
    let bytes = 0;
    const chunks = [];
    let stderr = "";
    let aborted = false;
    const abort = (error) => {
      aborted = true;
      child.kill();
      reject(error);
    };
    const timer = setTimeout(
      () => abort(fail("request_timeout", "GitHub read timed out.")),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > maxBytes)
        abort(
          fail(
            "response_overflow",
            "A GitHub page exceeds maxBytes; increase the bounded allowance or inspect the linked evidence manually.",
          ),
        );
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.once("error", () =>
      reject(fail("gh_unavailable", "GitHub CLI could not start on this Node.")),
    );
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      if (output.startsWith("HTTP/")) {
        try {
          resolve(parseHttp(output));
        } catch (error) {
          reject(error);
        }
      } else {
        const localAuth = code === 4 && !/HTTP 40[13]/i.test(stderr);
        const auth =
          code === 4 || /(?:HTTP 401|authentication|gh auth login)/i.test(stderr);
        reject(
          fail(
            localAuth
              ? "local_auth_unavailable"
              : auth
                ? "auth_required"
                : "request_failed",
            localAuth
              ? "The local GitHub CLI has no usable login; an independently authorized provider tool may inspect without changing credentials."
              : auth
                ? "Renew the authorized Node's GitHub login; no credentials were changed."
                : "GitHub CLI failed without a usable response.",
          ),
        );
      }
    });
    child.stdin.end(payload ? JSON.stringify(payload) : undefined);
  });
}

function identity(pr, metadata) {
  const deletedFork = metadata.state !== "OPEN" && metadata.headRepository === null;
  const result = {
    host: pr.host.toLowerCase(),
    repositoryId: metadata.repository?.id,
    repository: metadata.repository?.nameWithOwner,
    number: metadata.number,
    prId: metadata.id,
    url: metadata.url,
    headRepositoryId:
      metadata.headRepository?.id ?? (deletedFork ? pr.headRepositoryId : undefined),
    headRepository:
      metadata.headRepository?.nameWithOwner ??
      (deletedFork ? pr.headRepository : undefined),
    headRef: `refs/heads/${metadata.headRefName}`,
    baseRepositoryId: metadata.repository?.id,
    baseRepository: metadata.repository?.nameWithOwner,
    baseRef: `refs/heads/${metadata.baseRefName}`,
  };
  if (
    !result.repositoryId ||
    !result.prId ||
    result.number !== pr.number ||
    !["OPEN", "CLOSED", "MERGED"].includes(metadata.state) ||
    typeof metadata.title !== "string" ||
    typeof metadata.body !== "string" ||
    typeof metadata.isDraft !== "boolean" ||
    typeof metadata.mergeable !== "string" ||
    !validRef(result.baseRef) ||
    !metadata.baseRefOid
  ) {
    throw fail(
      "malformed_response",
      "GitHub did not return a complete PR identity/base.",
    );
  }
  // A deleted source repository/branch on a terminal PR still permits terminal settlement.
  if (
    metadata.state === "OPEN" &&
    (!result.headRepositoryId || !metadata.headRefOid || !validRef(result.headRef))
  ) {
    throw fail("unavailable_ref", "The open PR has no usable head repository/ref.");
  }
  if (!result.headRepositoryId || !result.headRepository) {
    throw fail(
      "unavailable_ref",
      "A terminal deleted fork needs its registered headRepositoryId and headRepository name.",
    );
  }
  for (const key of [
    "repositoryId",
    "headRepositoryId",
    "headRef",
    "baseRepositoryId",
    "baseRef",
  ]) {
    if (
      pr[key] !== undefined &&
      pr[key] !== result[key] &&
      !(metadata.state !== "OPEN" && key === "headRepositoryId" && !result[key])
    ) {
      throw fail(
        "scope_changed",
        `The registered ${key} no longer matches GitHub; reconcile with the operator.`,
      );
    }
  }
  return result;
}

function connection(body, job, metadata) {
  const pr = body.data?.repository?.pullRequest;
  if (job.kind === "threadComments") {
    if (body.data?.node?.pullRequest?.id !== metadata.id) {
      throw fail("scope_changed", "The thread does not belong to the registered PR.");
    }
    return body.data.node.comments;
  }
  if (!pr)
    throw fail(
      "malformed_response",
      "The PR is unavailable in the requested repository.",
    );
  const keys = {
    threads: "reviewThreads",
    reviews: "reviews",
    discussions: "comments",
    reviewRequests: "reviewRequests",
    reviewRequestEvents: "timelineItems",
  };
  if (job.kind !== "checks") return pr[keys[job.kind]];
  const commit = pr.commits?.nodes?.[0]?.commit;
  if (!commit?.oid)
    throw fail("malformed_response", "Missing current-HEAD check identity.");
  if (commit.oid !== metadata.headRefOid)
    throw fail("inconsistent_snapshot", "Checks belong to a changed HEAD.");
  return (
    commit.statusCheckRollup?.contexts ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    }
  );
}

function source(kind, item, context = {}) {
  const value = {
    kind,
    id: item.id,
    actor: item.author?.login ?? item.actor?.login ?? null,
    body: item.body ?? "",
    url: item.url,
    ...context,
  };
  value.contentHash = contentHash(value.body);
  value.revision = contentHash({
    ...value,
    resolved: undefined,
    updatedAt: item.updatedAt,
    state: item.state,
    commit: item.commit?.oid,
  });
  return value;
}

export function matchEffects(sources, knownEffects = []) {
  const candidatesBySource = sources.map((item) =>
    knownEffects.filter(
      (effect) =>
        effect.kind === item.kind &&
        effect.actor === item.actor &&
        effect.contentHash === item.contentHash &&
        (effect.id
          ? effect.id === item.id
          : effect.marker && item.body?.includes(effect.marker)),
    ),
  );
  const sourceCounts = new Map();
  for (const candidates of candidatesBySource)
    for (const effect of candidates)
      sourceCounts.set(effect, (sourceCounts.get(effect) ?? 0) + 1);
  const matched = [];
  const ambiguous = [];
  const remaining = [];
  for (const [index, item] of sources.entries()) {
    const candidates = candidatesBySource[index];
    if (candidates.length === 1 && sourceCounts.get(candidates[0]) === 1)
      matched.push({
        effectId: candidates[0].effectId,
        sourceId: item.id,
        kind: item.kind,
      });
    else {
      remaining.push(item);
      if (candidates.length > 0)
        ambiguous.push({
          sourceId: item.id,
          effectIds: candidates.map((effect) => effect.effectId),
        });
    }
  }
  return {
    matched,
    ambiguous,
    remaining,
    unobserved: knownEffects
      .filter((effect) => !matched.some((match) => match.effectId === effect.effectId))
      .map((effect) => effect.effectId),
  };
}

function requiredChecks(metadata, rules, checks) {
  const expected = new Map();
  const descriptions = metadata.baseRef?.branchProtectionRule?.requiredStatusChecks ?? [];
  for (const description of descriptions) {
    expected.set(`${description.context}:${description.app?.databaseId ?? "*"}`, {
      name: description.context,
      appId: description.app?.databaseId ?? null,
    });
  }
  for (const name of metadata.baseRef?.branchProtectionRule
    ?.requiredStatusCheckContexts ?? []) {
    if (!descriptions.some((description) => description.context === name)) {
      expected.set(`${name}:*`, { name, appId: null });
    }
  }
  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      if (!Array.isArray(rule.parameters?.required_status_checks)) {
        throw fail("malformed_response", "Incomplete required-status-check rules.");
      }
      for (const check of rule.parameters.required_status_checks) {
        expected.set(`${check.context}:${check.integration_id ?? "*"}`, {
          name: check.context,
          appId: check.integration_id ?? null,
        });
      }
    }
  }
  const effective = checks.map((check) => ({
    name: check.name ?? check.context,
    appId: check.checkSuite?.app?.databaseId ?? null,
    status: check.status ?? "COMPLETED",
    conclusion: check.conclusion ?? check.state ?? "PENDING",
    required: check.isRequired === true,
  }));
  for (const check of effective.filter((item) => item.required)) {
    expected.set(`${check.name}:${check.appId ?? "*"}`, {
      name: check.name,
      appId: check.appId,
    });
  }
  return [...expected.values()].map((requirement) => {
    const matches = effective.filter(
      (check) =>
        check.name === requirement.name &&
        (requirement.appId === null || check.appId === requirement.appId),
    );
    return {
      ...requirement,
      states: matches.length
        ? matches.map(({ status, conclusion }) => ({ status, conclusion }))
        : [{ status: "MISSING", conclusion: "UNKNOWN" }],
    };
  });
}

export function buildSnapshot(input, scan) {
  const metadata = scan.metadata;
  const data = scan.data;
  const threads = data.threads.map((thread) => ({
    ...thread,
    comments: data.threadComments.filter((comment) => comment.threadId === thread.id),
  }));
  const threadStates = threads.map((thread) => {
    const stateHash = contentHash({
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      resolvedBy: thread.resolvedBy,
    });
    const previous = input.previousThreads?.find((state) => state.id === thread.id);
    const knownResolution =
      thread.isResolved &&
      matchEffects(
        [
          {
            kind: "thread_resolution",
            id: thread.id,
            actor: thread.resolvedBy?.login ?? null,
            contentHash: contentHash({ threadId: thread.id, isResolved: true }),
          },
        ],
        input.knownEffects,
      ).matched.length === 1;
    return {
      id: thread.id,
      stateHash,
      revision: previous
        ? previous.revision + Number(previous.stateHash !== stateHash && !knownResolution)
        : 0,
    };
  });
  const sources = [
    ...threads.flatMap((thread) =>
      thread.comments.map((comment) =>
        source("thread_comment", comment, {
          threadId: thread.id,
          threadRevision: threadStates.find((state) => state.id === thread.id).revision,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
          path: thread.path,
          line: thread.line,
          diffHunk: comment.diffHunk,
        }),
      ),
    ),
    ...data.reviews
      .filter((review) => review.state !== "PENDING" && review.body)
      .map((review) => source("review", review)),
    ...data.discussions.map((comment) => source("discussion", comment)),
    ...data.reviewRequestEvents.map((event) => ({
      ...source("review_request", event),
      contentHash: contentHash({ reviewerId: event.requestedReviewer?.id }),
    })),
    ...threads
      .filter((thread) => thread.isResolved)
      .map((thread) => ({
        kind: "thread_resolution",
        id: thread.id,
        actor: thread.resolvedBy?.login ?? null,
        contentHash: contentHash({ threadId: thread.id, isResolved: true }),
      })),
  ];
  const commit = metadata.commits?.nodes?.[0]?.commit;
  if (commit)
    sources.push({
      kind: "commit",
      id: commit.oid,
      actor: commit.author?.user?.login ?? null,
      contentHash: contentHash({ oid: commit.oid, message: commit.message }),
    });
  const effects = matchEffects(sources, input.knownEffects);
  const actionable = effects.remaining.filter(
    (item) =>
      ["thread_comment", "discussion", "review"].includes(item.kind) &&
      !(input.handledSources ?? []).some(
        (handled) =>
          handled.kind === item.kind &&
          handled.id === item.id &&
          handled.revision === item.revision &&
          handled.headSha === metadata.headRefOid,
      ),
  );
  const checks = requiredChecks(metadata, data.rules, data.checks);
  const reviewPolicy = {
    branchProtection: metadata.baseRef?.branchProtectionRule ?? null,
    rules: data.rules.filter((rule) => rule.type === "pull_request"),
  };
  const decisions = data.reviews
    .filter(
      (review) =>
        review.state !== "PENDING" &&
        !effects.matched.some(
          (effect) => effect.kind === "review" && effect.sourceId === review.id,
        ),
    )
    .map((review) => ({
      id: review.id,
      actor: review.author?.login,
      state: review.state,
      commit: review.commit?.oid,
      submittedAt: review.submittedAt,
    }));
  const scope = {
    generation: input.generation,
    ...identity(input.pr, metadata),
    headSha: metadata.headRefOid,
    baseSha: metadata.baseRefOid,
  };
  const externalReviewRevision = contentHash({
    decisions,
    reviewPolicy,
    decision: metadata.reviewDecision,
  });
  const obligationKeys = {
    review: contentHash({ scope, externalReviewRevision }),
    reviewers: data.reviewRequests.map((request) => ({
      reviewerId: request.requestedReviewer?.id,
      key: contentHash({
        scope,
        externalReviewRevision,
        reviewerId: request.requestedReviewer?.id,
      }),
    })),
    checks: checks.map((check) => ({
      name: check.name,
      appId: check.appId,
      // A new check-run ID or infrastructure retry is not a new failure incident.
      key: contentHash({
        scope,
        name: check.name,
        appId: check.appId,
        states: check.states,
      }),
    })),
  };
  return {
    identity: identity(input.pr, metadata),
    generation: input.generation,
    headSha: metadata.headRefOid,
    baseSha: metadata.baseRefOid,
    state: metadata.mergedAt ? "merged" : metadata.state === "CLOSED" ? "closed" : "open",
    isDraft: metadata.isDraft,
    title: metadata.title,
    body: metadata.body,
    mergeable: metadata.mergeable,
    mergeStateStatus: metadata.mergeStateStatus ?? "UNKNOWN",
    threads,
    threadStates,
    reviews: data.reviews,
    discussions: data.discussions,
    requiredChecks: checks,
    checks: data.checks,
    reviewPolicy,
    rules: data.rules,
    reviewRequests: data.reviewRequests,
    reviewDecision: metadata.reviewDecision ?? "UNKNOWN",
    actionableSources: actionable,
    effects,
    obligationKeys,
    actionableFingerprint: contentHash({
      scope,
      state: metadata.state,
      isDraft: metadata.isDraft,
      design: { title: metadata.title, body: metadata.body },
      mergeable: metadata.mergeable,
      mergeStateStatus: metadata.mergeStateStatus ?? "UNKNOWN",
      checks,
      rules: data.rules,
      externalReviewRevision,
      sources: actionable.map(({ kind, id, revision }) => ({ kind, id, revision })),
    }),
  };
}

/** Exported only for deterministic transport fixtures; CLI always uses ghRequest. */
export async function observe(
  input,
  { request = ghRequest, now = Date.now, monotonic } = {},
) {
  const started = now();
  let requestsConsumed = 0;
  let scan;
  let discardResume = false;
  let limits;
  let clock;
  const progress = () => ({
    phase: scan?.phase ?? "metadata",
    pages: scan?.pages.length ?? 0,
    verifiedPages: scan?.verified ?? 0,
    cursor: scan?.phase === "verify" ? scan.verified : (scan?.jobs[0] ?? null),
  });
  const base = () => ({
    schemaVersion: VERSION,
    complete: false,
    requestsConsumed,
    elapsedMs: Math.max(0, now() - started),
    progress: progress(),
  });
  try {
    limits = validate(input, started);
    clock = observationClock(input, now, monotonic);
    limits.deadline = Math.min(clock.deadline, started + 120_000);
    if (size(input) > limits.maxBytes)
      throw fail("payload_overflow", "Input/checkpoint exceeds maxBytes.");
    const scopeKey = contentHash({ generation: input.generation, pr: input.pr });
    if (input.resume) {
      scan = structuredClone(input.resume);
      if (
        scan.schemaVersion !== VERSION ||
        scan.scopeKey !== scopeKey ||
        !["scan", "verify"].includes(scan.phase) ||
        !Array.isArray(scan.jobs) ||
        !Array.isArray(scan.pages) ||
        !scan.data ||
        !scan.metadata ||
        !Number.isInteger(scan.verified) ||
        scan.verified < 0 ||
        scan.verified > scan.pages.length ||
        scan.digest !== contentHash({ ...scan, digest: undefined })
      ) {
        scan = undefined;
        throw fail(
          "invalid_resume",
          "Checkpoint is malformed or belongs to another PR/generation.",
        );
      }
      delete scan.digest;
      // Verification from another wake is stale even when top-level metadata is unchanged.
      if (scan.phase === "verify") scan.verified = 0;
    }
    const read = async (job, metadata) => {
      if (requestsConsumed >= limits.maxRequests)
        throw fail(
          "budget_exhausted",
          "Remaining request allowance exhausted; carry the scan to the next existing wake.",
        );
      if (clock.now() >= limits.deadline)
        throw fail(
          "deadline_exhausted",
          "Maintenance deadline reached; carry the scan to the next existing wake.",
        );
      let endpoint;
      let payload;
      if (job.kind === "rules") {
        if (
          job.cursor !== null &&
          job.cursor !== undefined &&
          (typeof job.cursor !== "string" || !/^[1-9]\d*$/.test(job.cursor))
        )
          throw fail(
            "invalid_resume",
            "The rule-page cursor must be a positive page number.",
          );
        endpoint = `repos/${encodeURIComponent(input.pr.owner)}/${encodeURIComponent(input.pr.repo)}/rules/branches/${encodeURIComponent(metadata.baseRefName)}?per_page=100${job.cursor ? `&page=${job.cursor}` : ""}`;
      } else payload = queryFor(input.pr, job);
      const remaining = Math.floor(limits.deadline - clock.now());
      if (remaining < 1)
        throw fail("deadline_exhausted", "Maintenance deadline reached.");
      requestsConsumed += 1;
      const response = await request({
        host: input.pr.host.toLowerCase(),
        endpoint,
        payload,
        timeoutMs: Math.min(15_000, remaining),
        maxBytes: limits.maxBytes,
      });
      if (clock.now() > limits.deadline)
        throw fail(
          "deadline_exhausted",
          "The read reached the remaining maintenance deadline.",
        );
      const headers = response.headers ?? {};
      const retryAfter = Number(headers["retry-after"]);
      const resetAfter = Math.ceil(
        (Number(headers["x-ratelimit-reset"]) * 1000 - now()) / 1000,
      );
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"]))
      ) {
        throw fail(
          "rate_limited",
          "GitHub rate limited the read; wait before the next authorized observation.",
          {
            retryAfterSeconds: Math.max(
              1,
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter
                : resetAfter || 60,
            ),
          },
        );
      }
      if (response.status === 401)
        throw fail(
          "auth_required",
          "Renew GitHub authentication on the authorized Node.",
        );
      if (response.status === 403)
        throw fail(
          "permission_denied",
          "The Node identity cannot read all required PR/policy evidence.",
        );
      if (response.status < 200 || response.status >= 300) {
        throw fail(
          job.kind === "rules" && response.status === 404
            ? "unsupported_rules"
            : "request_failed",
          "GitHub did not return the requested evidence; no observation was completed.",
        );
      }
      if (size(response.body) > limits.maxBytes)
        throw fail("response_overflow", "GitHub response exceeds maxBytes.");
      let body;
      try {
        body =
          typeof response.body === "string" ? JSON.parse(response.body) : response.body;
      } catch {
        throw fail("malformed_response", "GitHub returned invalid JSON.");
      }
      if (body?.errors?.length)
        throw fail("graphql_error", "GitHub returned incomplete GraphQL evidence.");
      if (job.kind === "metadata") {
        const value = body?.data?.repository?.pullRequest;
        if (!value) throw fail("malformed_response", "The exact PR was not readable.");
        identity(input.pr, value);
        return value;
      }
      if (job.kind === "rules") {
        if (!Array.isArray(body) || body.some((rule) => typeof rule?.type !== "string"))
          throw fail(
            "malformed_response",
            "GitHub returned no effective branch-rule array.",
          );
        const nextLink = /<([^>]+)>[^,]*?\brel\s*=\s*"?next"?(?=\s*(?:[,;]|$))/i.exec(
          headers.link ?? "",
        );
        let nextPage = null;
        if (nextLink) {
          let url;
          try {
            url = new URL(nextLink[1]);
          } catch {
            throw fail("malformed_response", "The next rule-page link is invalid.");
          }
          nextPage = url.searchParams.get("page");
          const host = input.pr.host.toLowerCase();
          if (
            url.protocol !== "https:" ||
            ![host, `api.${host}`].includes(url.host) ||
            !url.pathname.endsWith(`/${endpoint.split("?")[0]}`) ||
            !/^[1-9]\d*$/.test(nextPage ?? "") ||
            !Number.isSafeInteger(Number(nextPage)) ||
            Number(nextPage) !== Number(job.cursor ?? 1) + 1 ||
            (url.searchParams.has("per_page") &&
              url.searchParams.get("per_page") !== "100")
          )
            throw fail(
              "malformed_response",
              "The next rule page does not match this branch and scan.",
            );
        } else if (/\brel\s*=\s*"?next\b/i.test(headers.link ?? "")) {
          throw fail("malformed_response", "The next rule-page link is incomplete.");
        }
        return {
          nodes: body,
          pageInfo: { hasNextPage: nextPage !== null, endCursor: nextPage },
        };
      }
      const result = connection(body, job, metadata);
      if (
        !Array.isArray(result?.nodes) ||
        result.nodes.some((node) => !node?.id) ||
        typeof result.pageInfo?.hasNextPage !== "boolean" ||
        (result.pageInfo.hasNextPage &&
          (typeof result.pageInfo.endCursor !== "string" ||
            !result.pageInfo.endCursor ||
            result.pageInfo.endCursor === job.cursor))
      ) {
        throw fail(
          "malformed_response",
          "A feedback page or pagination cursor is incomplete.",
        );
      }
      const valid = (node) => {
        if (job.kind === "threads")
          return (
            typeof node.isResolved === "boolean" &&
            typeof node.isOutdated === "boolean" &&
            typeof node.path === "string"
          );
        if (["reviews", "discussions", "threadComments"].includes(job.kind)) {
          return (
            typeof node.body === "string" &&
            typeof node.updatedAt === "string" &&
            typeof node.url === "string" &&
            (job.kind !== "reviews" || typeof node.state === "string")
          );
        }
        if (["reviewRequests", "reviewRequestEvents"].includes(job.kind)) {
          return typeof node.requestedReviewer?.id === "string";
        }
        if (job.kind === "checks")
          return (
            typeof (node.name ?? node.context) === "string" &&
            typeof node.isRequired === "boolean" &&
            typeof (node.status ?? node.state) === "string"
          );
        return true;
      };
      if (result.nodes.some((node) => !valid(node))) {
        throw fail(
          "malformed_response",
          "A source is missing required content/state/identity fields.",
        );
      }
      return result;
    };
    const metadata = await read({ kind: "metadata" });
    if (scan && contentHash(metadata) !== contentHash(scan.metadata)) {
      discardResume = true;
      throw fail(
        "inconsistent_snapshot",
        "HEAD/base, policy, PR metadata, or review state changed; discard the old scan.",
      );
    }
    scan ??= {
      schemaVersion: VERSION,
      scopeKey,
      metadata,
      phase: "scan",
      verified: 0,
      pages: [],
      jobs: collections.map((kind) => ({ kind, cursor: null })),
      data: Object.fromEntries(
        [...collections, "threadComments"].map((kind) => [kind, []]),
      ),
    };
    while (scan.jobs.length) {
      const job = scan.jobs[0];
      const page = await read(job, metadata);
      const next = structuredClone(scan);
      next.jobs.shift();
      next.pages.push({ ...job, hash: contentHash(page) });
      const seen = new Set(next.data[job.kind].map((item) => item.id));
      if (job.kind !== "rules" && page.nodes.some((item) => seen.has(item.id))) {
        discardResume = true;
        throw fail(
          "inconsistent_snapshot",
          "Feedback moved across pages; discard the old scan.",
        );
      }
      next.data[job.kind].push(
        ...page.nodes.map((item) =>
          job.kind === "threadComments" ? { ...item, threadId: job.threadId } : item,
        ),
      );
      if (page.pageInfo.hasNextPage) {
        const cursor = page.pageInfo.endCursor;
        if (
          next.pages.some(
            (previous) =>
              previous.kind === job.kind &&
              previous.threadId === job.threadId &&
              previous.cursor === cursor,
          )
        ) {
          throw fail(
            "malformed_response",
            "GitHub repeated a previously visited cursor.",
          );
        }
        next.jobs.unshift({ ...job, cursor });
      }
      if (job.kind === "threads") {
        next.jobs.push(
          ...page.nodes.map((thread) => ({
            kind: "threadComments",
            threadId: thread.id,
            cursor: null,
          })),
        );
      }
      if (size(next) + 2048 > limits.maxBytes) {
        throw fail(
          "payload_overflow",
          "The scan exceeds checkpoint maxBytes. Preserve this progress and request a larger bounded allowance/manual evidence; do not triage it.",
        );
      }
      scan = next;
    }
    scan.phase = "verify";
    // Re-read every page, including bodies and nested replies. updatedAt on the PR
    // is not a revision token for edits to its feedback.
    while (scan.verified < scan.pages.length) {
      const job = scan.pages[scan.verified];
      const page = await read(job, metadata);
      if (contentHash(page) !== job.hash) {
        discardResume = true;
        throw fail(
          "inconsistent_snapshot",
          "Feedback, checks, or policy changed during pagination; discard partial evidence.",
        );
      }
      scan.verified += 1;
    }
    const finalMetadata = await read({ kind: "metadata" });
    if (contentHash(finalMetadata) !== contentHash(metadata)) {
      discardResume = true;
      throw fail(
        "inconsistent_snapshot",
        "HEAD/base or relevant PR metadata changed during observation.",
      );
    }
    const snapshot = buildSnapshot(input, scan);
    const result = {
      ...base(),
      complete: true,
      progress: { ...progress(), phase: "complete", cursor: null },
      snapshot,
    };
    if (size(result) > limits.maxBytes)
      throw fail(
        "payload_overflow",
        "Complete evidence exceeds maxBytes; use a larger bounded allowance or manual evidence.",
      );
    if (clock.now() > limits.deadline)
      throw fail(
        "deadline_exhausted",
        "Evidence completed after the maintenance deadline.",
      );
    return result;
  } catch (error) {
    const result = {
      ...base(),
      error: {
        code: error.code ?? "observation_failed",
        message: error.code
          ? error.message
          : "Observation failed without complete evidence.",
        ...(error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    };
    if (
      scan &&
      !discardResume &&
      !["scope_changed", "inconsistent_snapshot"].includes(error.code)
    ) {
      const resume = { ...scan, digest: contentHash(scan) };
      if (size({ ...result, resume }) <= (limits?.maxBytes ?? MAX_BYTES))
        result.resume = resume;
      else
        result.error = {
          code: "payload_overflow",
          message:
            "Checkpoint cannot fit; manual evidence or a larger bounded allowance is required.",
        };
    }
    return result;
  }
}

export async function main(
  observeProvider = observe,
  mapObservation = toHostObservation,
) {
  let bytes = 0;
  const chunks = [];
  let result;
  let input;
  let attemptedAt = new Date().toISOString();
  const inputTimer = setTimeout(
    () =>
      process.stdin.destroy(
        fail("input_timeout", "Timed out waiting for bounded JSON input."),
      ),
    15_000,
  );
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES)
        throw fail("payload_overflow", "Input exceeds the 1 MiB helper limit.");
      chunks.push(chunk);
    }
    clearTimeout(inputTimer);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attemptedAt = new Date().toISOString();
    result = await observeProvider(input);
    const observation = mapObservation(result, input, attemptedAt);
    // The opaque resume lives once, inside the durable Host observation.
    delete result.resume;
    result.observation = observation;
    if (!observation.complete && result.complete) {
      result.complete = false;
      delete result.snapshot;
      result.error = { code: "unresolved_obligation", message: observation.evidence };
    }
    if (size(result) > (input.budget?.maxBytes ?? 262144)) {
      throw fail(
        "payload_overflow",
        "Host checkpoint and evidence exceed maxBytes; request a larger bounded allowance or manual evidence.",
      );
    }
  } catch (error) {
    result = {
      schemaVersion: VERSION,
      complete: false,
      requestsConsumed: result?.requestsConsumed ?? 0,
      elapsedMs: result?.elapsedMs ?? 0,
      progress: result?.progress ?? {
        phase: "input",
        pages: 0,
        verifiedPages: 0,
        cursor: null,
      },
      error: {
        code: error.code ?? "invalid_input",
        message: result
          ? "Helper evidence could not fit the bounded Host observation contract; no complete observation is available."
          : "Supply bounded version-1 JSON on stdin.",
      },
    };
    result.observation = mapObservation(result, input ?? {}, attemptedAt);
  } finally {
    clearTimeout(inputTimer);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.complete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
