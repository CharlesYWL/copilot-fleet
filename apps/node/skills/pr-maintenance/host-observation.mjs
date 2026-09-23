import {
  PrMaintenanceObservationSchema,
  PrMaintenanceGithubSnapshotIdentitySchema,
} from "@fleet/protocol";

const failureCodes = {
  local_auth_unavailable: "capability",
  gh_unavailable: "capability",
  authentication_required: "auth",
  auth_required: "auth",
  authentication: "auth",
  permission_denied: "permission",
  permission_required: "permission",
  rate_limited: "rate_limit",
  rate_limit: "rate_limit",
  budget_exhausted: "budget",
  deadline_exhausted: "budget",
  payload_overflow: "incomplete",
  inconsistent_snapshot: "incomplete",
  scope_changed: "incomplete",
  invalid_resume: "incomplete",
};

function checkState(states) {
  if (
    states.some(
      ({ status, conclusion }) => status === "MISSING" || conclusion === "UNKNOWN",
    )
  )
    return "unknown";
  if (
    states.some(
      ({ status, conclusion }) =>
        status !== "COMPLETED" || ["PENDING", "EXPECTED"].includes(conclusion),
    )
  )
    return "pending";
  return states.every(({ conclusion }) =>
    ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion),
  )
    ? "passed"
    : "failed";
}

/** Lossless continuation, bounded evidence references, and explicit policy completeness. */
export function toHostObservation(result, input, attemptedAt = new Date().toISOString()) {
  const snapshot = result.snapshot;
  const observation = {
    attemptedAt,
    complete: result.complete,
    requestsConsumed: result.requestsConsumed,
    elapsedMs: Math.ceil(result.elapsedMs),
    helperState: {
      resume: result.resume ?? null,
      previousThreads: snapshot?.threadStates ?? input.previousThreads ?? [],
      ...(result.error ? { error: result.error } : {}),
    },
    cursor: JSON.stringify(result.progress),
    evidence: result.complete
      ? `GitHub helper v1: ${snapshot.identity.url}; fingerprint ${snapshot.actionableFingerprint}. Full evidence is in the helper snapshot.`
      : `GitHub helper v1: ${result.error?.code ?? "incomplete"}; ${result.error?.message ?? "No complete evidence."}`,
  };
  if (!result.complete) {
    observation.failure = failureCodes[result.error?.code] ?? "network";
    if (result.error?.retryAfterSeconds) {
      observation.retryAfter = new Date(
        Date.parse(attemptedAt) + result.error.retryAfterSeconds * 1_000,
      ).toISOString();
    }
    return PrMaintenanceObservationSchema.parse(observation);
  }
  const { identity, headSha, baseSha } = snapshot;
  if (
    snapshot.rules.some(
      (rule) =>
        ![
          "pull_request",
          "required_status_checks",
          "non_fast_forward",
          "deletion",
          "creation",
          "update",
        ].includes(rule.type),
    )
  ) {
    return PrMaintenanceObservationSchema.parse({
      ...observation,
      complete: false,
      failure: "incomplete",
      evidence: `${identity.url}; an effective branch rule requires evidence this helper does not evaluate. Request human policy reconciliation.`,
    });
  }
  observation.identity = PrMaintenanceGithubSnapshotIdentitySchema.parse(identity);
  observation.snapshotId = snapshot.actionableFingerprint;
  observation.fingerprint = snapshot.actionableFingerprint;
  observation.headSha = headSha;
  observation.baseSha = baseSha;
  observation.state = snapshot.state;
  if (typeof snapshot.isDraft === "boolean") observation.draft = snapshot.isDraft;
  observation.mergeability =
    snapshot.mergeable === "MERGEABLE"
      ? "mergeable"
      : snapshot.mergeable === "CONFLICTING"
        ? "conflicting"
        : "unknown";
  observation.checksComplete = true;
  observation.checks = snapshot.requiredChecks.map((check) => ({
    key: snapshot.obligationKeys.checks.find(
      (entry) => entry.name === check.name && entry.appId === check.appId,
    ).key,
    state: checkState(check.states),
    headSha,
    evidence: `${identity.url}/checks; ${check.name}; ${JSON.stringify(check.states)}`,
  }));
  const reviewRule = snapshot.reviewPolicy.branchProtection;
  const requiredReviews =
    Boolean(reviewRule?.requiresApprovingReviews) ||
    snapshot.reviewDecision === "REVIEW_REQUIRED" ||
    snapshot.reviewPolicy.rules.some(
      (rule) =>
        (rule.parameters?.required_approving_review_count ?? 0) > 0 ||
        rule.parameters?.require_code_owner_review ||
        rule.parameters?.require_last_push_approval ||
        rule.parameters?.required_reviewers?.some(
          (reviewer) => reviewer.minimum_approvals > 0,
        ),
    );
  // GitHub's aggregate decision supersedes historical reviews by the same reviewer.
  const reviewState =
    snapshot.reviewDecision === "APPROVED"
      ? "approved"
      : snapshot.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : "required";
  observation.reviewsComplete =
    (!requiredReviews && snapshot.reviewDecision !== "CHANGES_REQUESTED") ||
    snapshot.reviewDecision !== "UNKNOWN";
  observation.reviews =
    requiredReviews || snapshot.reviewDecision === "CHANGES_REQUESTED"
      ? [
          {
            key: snapshot.obligationKeys.review,
            reviewer: "effective-review-policy",
            state: reviewState,
            headSha,
            revision: snapshot.obligationKeys.review,
            evidence: `${identity.url}; effective review decision ${snapshot.reviewDecision}.`,
          },
        ]
      : [];
  if (
    reviewRule?.requiresConversationResolution ||
    snapshot.reviewPolicy.rules.some(
      (rule) => rule.parameters?.required_review_thread_resolution,
    )
  ) {
    for (const thread of snapshot.threads.filter((entry) => !entry.isResolved)) {
      observation.reviews.push({
        key: `thread-resolution:${thread.id}`,
        reviewer: "required-thread-resolution",
        state: "required",
        headSha,
        revision: snapshot.obligationKeys.review,
        evidence: `${identity.url}; effective branch policy requires thread ${thread.id} to be resolved.`,
      });
    }
  }
  observation.sources = snapshot.actionableSources.map((source) => ({
    id: `${source.kind}:${source.id}`,
    revision: source.revision,
    groupKey: source.threadId
      ? `thread:${source.threadId}`
      : `${source.kind}:${source.id}`,
    evidence: `${source.url ?? identity.url}; source ${source.id}; content hash ${source.contentHash}. Read the full body from the helper snapshot.`,
  }));
  // CI-only failures must be eligible for a real repair batch, not an empty comment batch.
  for (let i = 0; i < observation.checks.length; i++) {
    const check = observation.checks[i];
    if (check.state !== "failed") continue;
    const requirement = snapshot.requiredChecks[i];
    observation.sources.push({
      id: `check:${requirement.name}:${requirement.appId ?? "*"}`,
      revision: check.key,
      groupKey: `check:${requirement.name}:${requirement.appId ?? "*"}`,
      evidence: check.evidence,
    });
  }
  if (
    (reviewRule?.requiresStatusChecks && reviewRule.requiresStrictStatusChecks) ||
    snapshot.rules.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        rule.parameters?.strict_required_status_checks_policy &&
        rule.parameters?.required_status_checks?.length > 0,
    )
  ) {
    observation.checks.push({
      key: `strict-base:${baseSha}`,
      headSha,
      state:
        snapshot.mergeStateStatus === "CLEAN"
          ? "passed"
          : snapshot.mergeStateStatus === "BEHIND"
            ? "pending"
            : "unknown",
      evidence: `${identity.url}; strict base-update policy at ${baseSha}: ${snapshot.mergeStateStatus ?? "UNKNOWN"}.`,
    });
  }
  observation.knownSelfEffectIds = snapshot.effects.matched.map(
    (effect) => effect.effectId,
  );
  if (snapshot.effects.ambiguous.length) {
    return PrMaintenanceObservationSchema.parse({
      ...observation,
      complete: false,
      failure: "incomplete",
      evidence: `${identity.url}; ambiguous effect matches require reconciliation before triage.`,
    });
  }
  return PrMaintenanceObservationSchema.parse(observation);
}
