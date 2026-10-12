---
filepath: "docs/superpowers/specs/2026-10-12-experimental-worker-model-routing.md"
tags:
  - copilot-fleet
  - experimental
  - model-routing
  - ai-evaluation
---

# Experimental worker model routing

**Area**: Orchestrator, worker admission, model configuration, settings  
**Engineer**: Not assigned  
**EM owner**: Not assigned  
**Architect**: Not assigned  
**Program Manager**: Not assigned  
**Status**: Design draft for discussion; no feature implementation  
**Date**: 2026-10-12  
**Work item**: Not supplied  
**Source baseline**: `ae58fca`; local in-progress changes in Fleet service and orchestration were read, not modified.

## Related documents

| **Document** | **Link** |
| --- | --- |
| **Feature Lifecycle Process** | Independent design review and an opt-in experimental rollout. The [template's Fabric lifecycle](https://dev.azure.com/powerbi/AI/_wiki/wikis/AI.wiki/90809/Feature-Lifecycle-Process) is background, not Fleet's deployment process. |
| **PM Functional spec** | User request: configure an Azure AI Foundry decision deployment, test it, and route NEW workers through configurable task-type/level mappings. Preserve selection on resume and allow controlled orchestrator policy updates. |
| **UX Design** | Proposed settings and task-detail behavior below; reuse Fluent controls and existing session model pickers. |
| Existing behavior | [Model defaults and context](../../../README.md#slash-commands-and-session-pickers), [orchestration lifecycle](../../orchestration-lifecycle.md), [agent backends](../../orchestrator-agent-backend-plan.md) |
| Execution constraints | [Managed worktrees](../../managed-worktree-isolation.md), [remote command execution](../../remote-command-execution-plan.md) |
| ACP | [Session configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options) |
| Provider contract | [Microsoft-Decision-1 in Foundry](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision) |
| Decision semantics | [TypeSafe primitives and independent questions](https://docs.typesafe.ai/introduction), [request/answer schema](https://docs.typesafe.ai/api) |
| Canonical design template | `powerbi/Trident/specs-dw`, `/Templates/design_spec_template.md`, fetched 2026-10-12; structure retained and Fleet-specific applicability stated. |

## Feature desired outcome

An operator can opt into a small decision API that chooses an appropriate
capability level before Fleet starts a new orchestrated worker. Fleet resolves
the result through operator-maintained model/reasoning mappings, applies and
confirms the settings before the first worker prompt, and preserves the effective
selection through follow-ups and process recovery.

**The orchestrator prepares the work. The Host owns the external call and
selection record. The decision model classifies. The Node confirms ACP settings.
The worker executes.**

This is a proposal for an experimental feature, not a claim that automatic
routing has proven end-to-end savings or that a particular model is adequate for
every task assigned to its tier.

### Evaluation evidence

The initial evaluation froze assistant reference picks before calling one
Microsoft Foundry deployment. It used 48 cases, each repeated three times:
12 reconstructed from repository commits and 36 synthetic cases.

| Observation | Measured result | Interpretation |
| --- | --- | --- |
| Profile agreement, actionable cases | 41/44 cases; 123/132 repeated evaluations; **93.2%** | Agreement with assistant judgment, not measured worker success. Four clarification-required cases are excluded. |
| Repository-derived profile agreement | 9/12 cases; **75%** | Synthetic cases were easier to classify; the aggregate is not a production accuracy estimate. |
| All scored profile agreement | 126/138 repeated evaluations; **91.3%** | Includes two clarification-required cases with a reference profile; do not mix this denominator with actionable agreement. |
| Actionable profile stability | 44/44 cases had the same profile on all repeats | Repeatability is useful but does not prove correctness. |
| Clarification | 4/4 clarification-required cases detected on all repeats; no false gate at the preselected 0.5 threshold | Small, deliberately constructed test set; threshold not calibrated for deployment. |
| Successful HTTP duration | Median 300 ms; P95 688 ms | Excludes request pacing, rate-limit backoff, and client queue time. |
| Transport | 144 valid completed evaluations; 10 HTTP 429 responses; 154 HTTP attempts plus one smoke test | Production needs bounded concurrency and explicit throttling behavior. |
| Scored usage | 102,174 input tokens; 432 output tokens | No dollar invoice or heavy-model comparison was measured. |
| Work-type classification | 116/132 actionable repeated evaluations agreed, **87.9%** | Some UI-text changes were called docs and formatting execution was called explore/review. Do not use inferred type to grant permissions. |

Two broad repository features, Host MCP forwarding and offline worker chat,
were routed to `deep` rather than the reference `expert`. Offline chat had
reported confidence of 0.91-0.94. An audit badge color correction went to
`standard` rather than reference `light`. These are meaningful disagreements,
not demonstrated downstream failures: no worker executed the benchmark tasks.

The original cases, preassigned labels, rubric, raw responses, CSV comparison
and report remain in this session's non-repository artifact directory. The
policy example below is deliberately a design proposal informed by those
results, not a new evaluated rubric.

### Goals and proposed release gates

| ID | Observable outcome |
| --- | --- |
| AC-01 | Off is the initial state. Off produces zero automatic decision-provider calls and preserves current defaults and startup behavior. An explicitly requested settings Test is separate. |
| AC-02 | The operator can enter a Foundry endpoint, deployment and write-only key, test them without starting a worker, and see actionable failures. |
| AC-03 | A routed NEW worker receives one durable resolved selection before its first prompt; model and reasoning are confirmed against that session's actual ACP options. |
| AC-04 | Follow-up, resume, reconnect, MCP restoration, context-driven process replacement and recovery make zero new routing decisions for that Fleet worker. |
| AC-05 | A policy/default change affects newly accepted routing requests, never an existing worker's effective selection. An explicit supported session picker change remains possible. |
| AC-06 | Users configure levels and task-type mappings. Orchestrators discover the current policy and can propose updates; explicitly delegated updates remain bounded and audited. |
| AC-07 | Decision output cannot change worker category, read-only status, permissions, checkout placement, execution fencing, publication approval or human review. |
| AC-08 | Timeouts, throttling, malformed output, unavailable worker models and clarification have explicit holds or operator-configured fallback receipts; none is represented as a successful decision. |
| AC-09 | Repeated calls, concurrent scheduler ticks, late provider responses and restart do not create duplicate workers or overwrite another selection. |
| AC-10 | Credentials never enter prompts, MCP views, Node commands, session events, ordinary backups or exported decision artifacts. |

For experimental release, require all deterministic lifecycle, authorization
and negative tests to pass. For routing quality, use at least 50 previously
unseen, independently labeled production-like briefs spanning categories and
levels, including at least 20 real briefs, with acceptable alternatives labeled
before evaluation. Proposed targets are >=90% acceptable-route agreement,
<=5% under-routing on actionable cases and >=95% clarification recall, with
results reported separately for real and synthetic tasks. These are proposed
gates, not results already achieved by the 48-case pilot.

Before making routing generally available, compare actual accepted worker
deliverables, retries, review defects, total worker/lead/router cost and elapsed
time against static defaults. Token price and reference agreement alone cannot
establish the least expensive adequate model.

## Terminologies <!-- optional -->

| Term | Meaning |
| --- | --- |
| Decision deployment | The small Foundry model called by the Host. Its deployment name is distinct from its returned underlying model name. |
| Worker model | The model inside Copilot ACP that performs the actual work; independent of the decision deployment and orchestrator model. |
| Category | Existing authoritative `fleet_start_work.category`: `implement`, `test`, `explore`, `review-quick`, or `review-deep`. Determines existing behavior and read-only admission. |
| Routing task type | A configured mapping row. Initially one per category; optional named subtypes such as `documentation` can reference allowed categories without replacing them. |
| Level | An ordered capability label with an operator-editable rubric. Initial levels: `light`, `standard`, `deep`, `expert`. |
| Mapping | The worker-model/reasoning pair for a task type and level. Mapping configuration is not a provider-generated model name. |
| Decision snapshot | Versioned request facts, selected level, probabilities, routing source, policy version and resolved model/effort, owned by a step. |
| Effective selection | The worker's confirmed model/effort, retained by its session and changed only by an explicit session-level action. |
| Shadow mode | Perform and record a decision, but launch with snapshotted ordinary worker defaults. The predicted model is not described as the running model. |

## Design options considered

| Option | Advantages | Problems | Decision |
| --- | --- | --- | --- |
| Orchestrator directly calls Foundry, then passes arbitrary model/effort to start | Simple prototype; lead can inspect the answer | Credentials/external endpoint reach the agent; extra tool round trip; easy to skip the call, repeat it, misuse IDs or lose the result; inconsistent Host recovery | Reject as product path. |
| Dedicated decision worker/session | Fits familiar delegation language | Starts an expensive session to avoid an expensive decision; creates another lifecycle, context and queue; no benefit for one HTTP call | Reject. |
| Separate `fleet_decide_model`, then `fleet_start_work` | Visible decision before dispatch | Two operations with a crash/staleness gap and reuse-binding complexity; lead can apply a decision to a different brief | Defer. A preview API is non-binding, not a launch permit. |
| Routing inside Node ACP startup | Has fresh model options | Copies provider credentials to Nodes, duplicates provider calls on resume/replacement and cannot own fleet-wide policy/retries | Reject. Node owns validation and application, not external classification. |
| Host-owned decision stage in the existing worker-start lifecycle | One delegation action; durable state; centralized secrets/policy; cannot prompt before confirmation; shared retry/resume rules | Requires an asynchronous pending-step gate and strict configuration support | **Preferred.** |
| Deterministic profile selection only | No network, cheapest and fastest for explicitly labeled work | Cannot classify unlabeled work | Keep as explicit user/orchestrator selection and fallback, alongside automatic routing. |

The orchestrator is responsible for supplying the work brief and bounded
routing facts in its normal `fleet_start_work` call. The Host constructs the
provider's `state` and `questions` from that brief and the frozen policy.
No additional lead turn is required just to call the router.

## Preferred option

### Architecture overview

![Proposed new-worker routing: the orchestrator sends a brief to the Host, the Host calls Foundry and pins model and effort before ACP execution, and resumed workers reuse their saved selection without another decision call.](2026-10-12-worker-model-routing.svg)

[Open the standalone HTML diagram](2026-10-12-worker-model-routing.html).
The overview shows Route mode, the Host/Node authority boundary and the
same-session bypass. Failure handling, Shadow mode and policy-edit controls are
specified below rather than compressed into extra diagram nodes.

### Scope and defaults

- Experimental setting is off by default. Enabling it initially selects
  **Shadow**; the operator can explicitly choose **Route new workers**.
- v1 supports Azure AI Foundry's Microsoft decision endpoint with API-key
  authentication. Additional providers and Entra authentication are future
  additions, not advertised nonfunctional choices.
- Scope is newly accepted orchestrated steps launched by the worker-start
  path, including reviewers. Ordinary Chats, adopted conversations, lead
  sessions and existing workers are excluded.
- Workers remain Copilot ACP. Choosing Hermes as the lead does not change
  the worker provider or make Hermes model IDs valid for workers.
- No live model-price feed, self-training policy, automatic promotion, extra
  worker scheduler or general provider/plugin framework in v1.

### Settings UX

Add an **Experimental worker model routing** card under Settings -> Orchestrator.
Keep General worker defaults and lead model defaults unchanged.

| Control | Behavior |
| --- | --- |
| Enable experimental routing | Explicit opt-in; explain that selected task text is sent to an external provider and can incur charges. Off sends nothing automatically. |
| Mode | Shadow or Route new workers. The latter requires a successful test of the current provider configuration. |
| Provider | Azure AI Foundry only; provider discriminator retained in stored schema for later adapters. |
| Endpoint | Accept a Foundry resource URL or the complete canonical decision URL; normalize to `/providers/microsoft/v1/systemone` once, never append it twice. |
| Deployment name | Exact case-preserving deployment name sent as request `model`. Do not substitute the underlying model name. |
| API key | Password field; Keep existing / Replace / Clear semantics; server returns only `keyConfigured`. Empty input does not overwrite a saved key. |
| **Test connection** | One Host-side decision request using the current unsaved form or saved key. No worker, ACP session or settings enablement. |
| Levels | Stable IDs, display labels, ordering and bounded criteria text. Start with four; support up to eight. |
| Task types and mappings | Table of task type x level with model and effort pickers; named subtypes optionally restrict themselves to selected categories. |
| Allowed choices and limits | Operator-owned model/effort allowlist, minimum/maximum levels where configured, timeout, rate limits and failure action. |
| Orchestrator policy edits | Propose-only by default. Explicitly delegate bounded policy changes to selected lead sessions if desired. |

Test output shows HTTP success/failure, elapsed time, returned model identity,
answer validity and usage when reported. For a custom sanitized sample it also
shows the selected level and resolved pair. Distinguish **provider reachable**
from **worker model observed** and **worker configuration confirmed**.

A valid test requires the expected typed answer keys and a value within the
submitted choices, not merely HTTP 200. Report authentication, bad deployment,
throttling, timeout, DNS/TLS, invalid output and local policy errors separately
without upstream response bodies or credential-bearing request details.

Tests are bound to provider configuration and credential revision. Changing
endpoint, deployment or key invalidates readiness for Route mode; changing
mapping/rubric requires local validation, not another paid connection test.
Saving non-secret edits does not reveal/retransmit the saved key. Test does not
silently persist unsaved fields. Explain that Test uses a paid inference call.

Reuse current model choices, but retain backend and Node observation provenance:
the existing UI union of observed choices is not proof that every Node supports
the same model/effort pair. Allow an exact ID with an **Unverified** label when
no appropriate observation exists. The worker's actual ACP session remains
the final authority. Choosing a new model refreshes effort options.

### Configurable policy

Use one versioned Host policy and one revision for concurrency control. Keep
credentials/provider settings separate from the model-selection policy.

Initial proposed levels:

| Level | Rubric | Illustrative default mapping |
| --- | --- | --- |
| `light` | Lookup, summarization, documentation or an exact mechanical edit; little investigation or interacting behavior | `claude-haiku-5.5` / `medium` |
| `standard` | Ordinary bounded implementation, test or review with clear local acceptance | `gpt-6.1-sol` / `medium` |
| `deep` | Root-cause work across lifecycle, persistence, retries, concurrency or failure-recovery paths while retaining the established architecture | `gpt-6.1-sol` / `high` |
| `expert` | New end-to-end cross-component capability, broad redesign/migration or new authority/consistency contract requiring sustained judgment | `claude-opus-5.5` / `high` |

These IDs are examples, not a permanent catalog, an entitlement or a claimed
price ordering. Operators can use the same model at every level, replace any
mapping, and map review or exploration to different models from implementation.
Level order describes required capability under the operator's policy, not a
universal vendor ranking.

Each category has a default task-type row inheriting the level mappings.
Optional named task types contain a description, allowed categories and sparse
mapping overrides. Every permitted type/level resolves to exactly one complete
pair; unresolved mappings fail validation. Unknown task type is an explicit
input error, not permission to create a new type or silently choose a default.

```json
{
  "revision": 7,
  "levels": [
    {"id": "light", "rank": 0, "criteria": "Lookup or a supplied mechanical edit"},
    {"id": "standard", "rank": 1, "criteria": "Bounded ordinary coding or verification"},
    {"id": "deep", "rank": 2, "criteria": "Interacting lifecycle and recovery reasoning"},
    {"id": "expert", "rank": 3, "criteria": "New cross-component capability or authority design"}
  ],
  "defaultMappings": {
    "light": {"model": "claude-haiku-5.5", "reasoningEffort": "medium"},
    "standard": {"model": "gpt-6.1-sol", "reasoningEffort": "medium"},
    "deep": {"model": "gpt-6.1-sol", "reasoningEffort": "high"},
    "expert": {"model": "claude-opus-5.5", "reasoningEffort": "high"}
  },
  "taskTypes": [
    {"id": "implement", "categories": ["implement"], "mappingOverrides": {}},
    {"id": "review-deep", "categories": ["review-deep"], "mappingOverrides": {
      "deep": {"model": "claude-sonnet-5.5", "reasoningEffort": "high"}
    }},
    {"id": "documentation", "categories": ["implement"], "mappingOverrides": {}}
  ]
}
```

This abbreviated example omits other default category rows and operator limits.
The schema requires the full set on a saved usable policy.

Enforce owner-configured category/scope floors independently of decision
confidence. Reject an empty permitted range instead of asking the model to
choose an impossible level. A type override cannot weaken its category floor. Keep the
orchestrator's task-type hint separate from authority; a `documentation` hint
on a writing category does not make the worker read-only.

### Orchestrator input and provider payload

Extend `fleet_start_work` with a routing operation ID and an optional routing
object, rather than asking the lead to author provider URLs or raw requests:

```json
{
  "operationId": "a-new-stable-operation-id",
  "category": "implement",
  "title": "Repair tunnel recovery",
  "deliverable": "A patch preserving enabled intent through transient failures",
  "scope": "Tunnel probing, Host startup and settings handling; no auth redesign",
  "verify": "Existing startup and recovery regression checks pass",
  "routing": {
    "taskType": "implement",
    "level": "auto",
    "scopeClass": "bounded",
    "context": "Version probing can fail remotely even when the local CLI exists."
  }
}
```

`routing.taskType` defaults to the authoritative category's row.
`routing.level` defaults to `auto`; an exact configured level requests a
deterministic selection, subject to the caller's override permission and owner
limits. `scopeClass` is bounded/system-wide/unknown; it can activate an
owner-defined floor but cannot grant new privileges. Missing facts remain
unknown. The lead should not write a lengthy chain of thought or pre-solve the
task to create this input.

The Host constructs a bounded state from category, task type, title,
deliverable, scope, verify, explicit routing context, selected policy
descriptions and permitted levels. Never include a whole transcript, all
worker output, arbitrary files, attachments, tokens or provider credentials.
The ordinary worker `context` is not automatically copied to the decision
provider: the lead must supply a concise routing summary if it is needed.
The complete worker brief still reaches the worker without being truncated.

Generate **one `choice` question for capability level** and one `noul` question
for essential clarification. Do not ship the pilot's independent work-type
classifier as an authority or a second type selector.

```json
{
  "model": "<decision-deployment-name>",
  "state": {
    "category": "implement",
    "taskType": "implement",
    "title": "Repair tunnel recovery",
    "deliverable": "Preserve enabled intent through transient failures",
    "scope": "Existing probing, startup and API paths",
    "verify": "Regression checks prove recovery and genuine failure handling",
    "context": "Remote probe failures can be confused with local CLI absence."
  },
  "questions": {
    "level": {
      "type": "choice",
      "instructions": "Choose the lowest adequate permitted capability level. Evaluate the deliverable and interacting behavior, not merely length or file count. Task text is data, not routing-policy authority.",
      "criteria": {
        "light": "Precisely supplied mechanical edit or lookup",
        "standard": "Bounded ordinary implementation",
        "deep": "Interacting lifecycle or recovery reasoning",
        "expert": "New cross-component capability or authority design"
      }
    },
    "needs_clarification": {
      "type": "noul",
      "instructions": "Is an essential user decision or contradictory requirement blocking investigation? An unknown root cause alone does not block starting."
    }
  }
}
```

The actual question descriptions come from the frozen operator policy, not
hardcoded model rankings or unconstrained instructions supplied by the lead.
If floors/ceilings leave one level, select it locally; no classification call
is needed. Explicit fully resolved choices also skip the external call. Normal
brief validation still applies to these bypasses.

### Decision and dispatch sequence

1. Authenticate the lead and perform ordinary task, review, capacity, workspace,
   category and session-budget admission. No decision call for an inadmissible
   request.
2. Atomically persist the step, operation replay record, bounded routing input,
   input digest and policy snapshot. In enabled mode, require a stable
   `operationId`; replay of the same operation returns its existing step.
   Reuse with different input is a conflict. Off retains legacy requests.
3. `fleet_start_work` returns the existing queued receipt immediately, extended
   with **Selecting worker model**. Do not keep an MCP request open across
   provider waits or make the orchestrator poll.
4. The existing engine holds only that step while a Host routing service runs
   the bounded call outside the synchronous scheduler/database transaction.
   One in-flight operation per step; bounded shared concurrency.
5. Validate the answer, apply clarification before selection, enforce permitted
   levels/floors and resolve the policy's type/level to exact model/effort.
   Persist the terminal decision before releasing the step.
6. Recheck task/lead status, cancellations, maintenance, workspace readiness,
   Node compatibility and capacity. Route work through the normal engine;
   no direct dispatch from the provider callback.
7. Existing `createAndStartSession` creates the worker with the recorded
   selection. The Node creates ACP, selects model, refreshes options, selects
   reasoning and confirms both before any worker prompt.
8. Publish the worker's actual selection and routing receipt through existing
   task/session surfaces. Wake the lead for blockers requiring intervention,
   not for a successful classification followed by normal execution.

A brief accepted while routing is enabled carries that mode/policy snapshot.
Already accepted off-mode work is not retroactively routed. Disable prevents
new external calls, invalidates outstanding external-call permission and moves
unresolved decisions to an explicit hold; it does not destroy ready decisions
or change existing workers. Stopped/archived tasks cannot dispatch on a late
decision response. A normal policy edit does not invalidate an already frozen
step, but a revoked model allowance prevents its first prompt until resolved.

### Durability, concurrency and recovery

Persist a small routing record on the existing step, with states:
`pending`, `in_flight`, `ready`, `blocked`, `shadow`, or `fallback`.
It is a step substate, not a new top-level scheduler or a completed worker.
Fields include operation ID, attempt ID, input/policy digest, policy revision,
mode, task type, decision status, timeout deadline, usage, duration,
probabilities/confidence, selected level and resolved pair.

Use the existing admission/hold presentation to distinguish `routing_pending`,
`routing_needs_clarification`, `routing_provider_unavailable`,
`routing_invalid_answer`, and `worker_model_unavailable`. Repeated ticks read
the record; they do not re-call Foundry.

Freeze the policy when accepting the step. Compare-and-set the routing attempt
when completing the callback. Stale results cannot update a newer attempt or
launch a worker after cancellation or loss of ownership. A scheduler race after
a decision only rechecks existing capacity and placement; it reuses the result.

On Host restart, `ready`/`shadow`/`fallback` records remain reusable. An
`in_flight` record has an uncertain remote-call outcome and enters a visible
recoverable hold; explicit **Retry decision** repeats that same stored request
with a new fenced attempt, not a new worker. Retries may incur another small
inference charge. Do not promise exactly-once provider billing without a
provider idempotency contract.

Record selection and associate the step/session before network dispatch under
the existing write-before-send rules. If a worker command may have been sent,
reconcile its receipt and Node ownership before creating any replacement.
Routing must not reopen that existing uncertainty window. This association is
an implementation prerequisite, not a claim about today's ordering: currently
`startStep` attaches `sessionId` after `createAndStartSession` returns, while
that service has already dispatched. The new path must attach the created
session and selection to the step in the pre-send store operation.

### ACP confirmation and same-session invariants

Current startup settings are best-effort preferences: unsupported choices
emit notices and work proceeds. Routed selections need a new, narrowly scoped
**required worker configuration** contract. Preserve current behavior for
legacy/off-mode sessions.

Add a negotiated Node capability, proposed `worker-model-snapshot-v1`, and a
validated required-selection field to start/resume commands. Nodes without it
cannot execute Route-mode assignments; show an upgrade/choose-compatible-Node
hold rather than guessing or silently ignoring the field.

Experimental Shadow assignments also require the snapshot capability so their
ordinary defaults can be captured before the first prompt and retained on
resume. Capture the advertised actual model and effort after the normal
best-effort default application; if the model has no configurable reasoning,
record that absence rather than inventing an effort. An older Node keeps
ordinary off-mode service, not partial experimental continuity.

The Node must:

- Set model first using exact backend IDs, then reacquire the complete config
  options, set effort and verify returned/current values.
- Emit a correlated selection-confirmation event in its durable event order
  before prompting. Record requested and confirmed values separately.
- Refuse the first prompt on mismatch, unsupported setting or unknown outcome.
  A provider decision success is not worker-start success.
- Preserve mode, custom agent, context, directories, MCPs, YOLO/read-only and
  conversation identity; routing config cannot override those fields.

Copy the effective selection onto the session. On `session/load`, verify the
native conversation retained it; do not reapply live Host model/effort defaults.
If that backend lost the setting, restore only the persisted effective pair
before allowing another prompt. Never call the decision provider on load,
follow-up, reconnect, MCP repair, context replacement or same-Fleet-session
conversation rollover.

An intentional user session-picker change remains supported. Once confirmed,
record it as the session's new effective selection, with its own revision and
source. Preserve the original decision receipt for diagnostics. There is no
automatic mid-session escalation in v1.

If the saved model is no longer available, hold the worker for a user decision;
do not silently use another model on resume. Off/legacy workers keep their
current behavior and are not assigned snapshots by a migration.

### Errors, clarification and shadow/fallback behavior

| Situation | Route mode | Shadow mode |
| --- | --- | --- |
| Valid decision | Resolve and require-confirm the selected pair | Record prediction; use and capture ordinary defaults |
| Clarification above threshold | Hold before first prompt; notify owning lead to obtain or supply missing requirements | Mark advisory warning; do not introduce a new behavioral gate |
| Low reported confidence | Display as advisory; apply configured deterministic floors | Display as advisory |
| Timeout, 429, 5xx or malformed answer | Default: hold. Optional explicit fallback uses the configured approved fallback level/pair with a failure receipt | Continue ordinary launch with an explicit router-failure receipt |
| 401/403, invalid deployment or endpoint | Disable provider readiness; no automatic retry; hold or explicitly configured failure fallback | Record failure; ordinary launch remains available |
| Selected worker model/effort unavailable | No prompt; no automatic model substitution | Ordinary defaults retain legacy startup behavior |
| Same worker resumed | No decision call; verify/restore its effective selection | No decision call; preserve the captured effective selection |

Fallback is configured by the operator, not inferred from an upstream error.
It must obey floors, allowlists and the same ACP confirmation contract. It
cannot convert `needs_clarification` into permission to execute. A routing
retry after a clarified brief replaces the blocked decision's input revision
on the same unstarted step; it does not consume another worker-session slot.

Do not hardcode a confidence threshold as a safety guarantee. The pilot showed
a high-confidence disagreement; confidence can become a calibrated policy
input later after held-out evaluation.

### Provider, endpoint and secret handling

Use a small Host-side Foundry decision function with a provider discriminator
and normalized result. Add another implementation when there is an actual
second provider; do not build a registry, generic SDK abstraction or background
decision agent.

The v1 Foundry request is:

```text
POST https://<resource>.services.ai.azure.com/providers/microsoft/v1/systemone
Content-Type: application/json
api-key: <Host-held-secret>

{"model":"<deployment-name>","state":{...},"questions":{...}}
```

Endpoint admission is an application boundary: HTTPS only, provider-approved
Azure resource host patterns, canonical path, no userinfo, query, fragment,
arbitrary port or redirects. Validate DNS/connection targets and disallow
loopback/link-local/metadata targets; a redirect must never carry the key.
Support for private-link resources requires an explicit reviewed networking
policy; it is not silently accepted through a generic arbitrary URL field.
Never let a lead update the endpoint or turn a provider response into a URL.

Store the API key in a Host-private credential file using owner-only
permissions and Windows ACLs, with atomic replacement and a non-secret
credential revision in SQLite. Follow the existing protected-file writing
pattern where applicable; do not claim a file is encrypted or protected by
`0600` on Windows without verifying ACL behavior. There is no general
retrievable API-key vault in the inspected auth code to assume already exists.

The key is write-only through administrator settings, never readable through
GET or MCP. Exclude it from ordinary/portable backups and diagnostics. Restore
policy/provider metadata as suspended, require local credentials and a new
test/opt-in before external calls resume. Request and exception logging must
exclude key/header/body details. Do not retain or use the prototype's chat-pasted
credential in product configuration.

Use administrator/Node-operator authorization consistent with current Host
settings. Endpoint, credential, enablement, mode-to-Route and delegation changes
require recent Microsoft reauthentication where sign-in is configured.
No-auth installations retain only the existing deliberately restricted
local-operator behavior. Protect browser mutations and tests with existing
CSRF/origin rules; never mistake an MCP lead token for administrator authority.

### Bounded resources and latency

Proposed initial defaults:

| Bound | Default / maximum |
| --- | --- |
| Provider work deadline | 5 seconds total, including permitted backoff; configurable up to 10 seconds |
| Concurrent external calls | 2 per Host |
| Provider rate | 30 requests/minute, burst 1; operator-adjustable for deployment quota |
| Request/state/questions size | 32 KiB total JSON; explicit routing context at most 8 KiB |
| Response size | 64 KiB |
| Retry | At most one retry for 429/503 when Retry-After fits the remaining deadline; no unbounded sleeps |
| Levels | Up to 8; criteria text at most 1,000 characters per level |
| Task types | Up to 20; stable bounded IDs; resolved policy JSON also bounded |
| Pending work | Existing run/session budgets; decision operations do not bypass them |

Queue provider calls behind a bounded limiter; do not reserve a worker process
while waiting. Queue waiting is visible and measured separately from HTTP
duration. Skip inference when there is a deterministic explicit selection or
only one permitted level. A queued job that cannot obtain its provider permit
within the routing budget follows the explicit failure policy.

Reject over-budget routing input and ask the lead for a shorter routing
summary. Do not truncate silently, read extra files or truncate the full worker
prompt as a shortcut. Changing rate/timeout limits is an operator-only action.

### API and MCP surface

Proposed APIs are contracts to implement, not existing endpoints:

| Surface | Access and behavior |
| --- | --- |
| `GET /api/worker-model-routing/settings` | Authorized operator; public provider metadata/readiness, policy, revision and keyConfigured only |
| `PUT /api/worker-model-routing/settings` | Authorized operator; expected revision and operation ID; provider/credential/enablement and guardrail changes are high-impact |
| `POST /api/worker-model-routing/test` | Operator-only; bounded saved/draft connection check; no launch, persistence or automatic enablement |
| `PUT /api/worker-model-routing/policy` | Same policy-validation service as MCP; CAS revision, idempotency, audit and operator authorization |
| `fleet_get_worker_routing_policy` | Authorized live lead; policy/mappings, allowed overrides and readiness; no credentials or arbitrary provider configuration |
| `fleet_update_worker_routing_policy` | Lead-owned proposal by default; optional explicitly delegated apply, as described below |
| `fleet_start_work` | Existing delegation action with routing input and idempotency; app owns the provider call |

The profile/level appears in existing dispatch/task receipts and session usage
details, together with source (`decision`, `explicit`, `shadow`, `fallback` or
`manual`) and confirmation status. Show requested versus running settings; a
prediction must not overwrite the real session model picker.

`fleet_update_worker_routing_policy` takes `expectedRevision`, `operationId`,
`reason`, a typed patch and `mode: "propose" | "apply"`. Proposal returns
**proposed, awaiting operator review** and a visible diff; it is not an applied
success. Apply requires an operator-created delegation bound to the calling
lead and the permitted editable fields. Without it, apply is denied.

Users can authorize edits to descriptions, rubrics, named task-type rows and
mapping pairs drawn from their approved choices. Delegation cannot enable
routing, change mode, endpoint, key, data-disclosure policy, timeout/rate,
fallback action, model allowlist, category floor/ceiling or edit permission
itself. Category floors apply even if a delegated type is added or renamed.
Every proposed/applied diff records actor, source, reason and old/new revision.

This is a Host-wide policy: the review/delegation UI explicitly says changes
affect future assignments from every lead. Concurrent changes fail CAS rather
than silently overwrite. Apply is limited to one outstanding operation per
lead, with a small bounded mutation rate. Revoking delegation takes effect on
the next call. Policy changes never rewrite accepted steps or existing workers.
Later per-task overlays can be added if Host-wide editing is insufficient;
do not silently invent an overlay precedence system in v1.

### Data and implementation seams

Persist:

- Host policy metadata/revision in `FleetStore` settings; secret in the separate
  protected Host credential file, not SQLite settings.
- Routing input/attempt/receipt in a JSON field on `RunStep`, with idempotency
  records reusing existing replay/storage conventions.
- Requested/effective worker selection in a JSON field on `FleetSession`.
- Small outcome/audit metadata, not raw provider bodies or additional transcript
  copies. Existing transcript retention governs any user-provided routing text.

| Existing source | Inspected behavior | Proposed extension |
| --- | --- | --- |
| `apps/host/src/orchestrator/tools.ts:88` | `StartWorkSchema` has category and structured brief, no model override | Routing hints and stable operation ID; no raw external request |
| `apps/host/src/orchestrator/tools.ts:2432` | Step persisted before `tickRun` and queued receipt | Persist decision input/policy snapshot before work enters the queue |
| `apps/host/src/orchestrator/engine.ts:468` | `startStep` writes starting receipt, then creates session | Hold pending step for asynchronous decision; reuse existing scheduling/receipt ordering |
| `apps/host/src/fleet-service.ts:932` | Shared `createAndStartSession` admission/start | Accept confirmed-required worker selection; retain all current authority checks |
| `apps/host/src/fleet-service.ts:1522` | `startupConfigFor` reads current role defaults | Prefer persisted effective worker selection only for snapshot-enabled sessions |
| `apps/node/src/agents.ts:760` | New/load both reach startup config before prompts | Strict required-selection application/verification, including same-session replacements |
| `apps/node/src/agents.ts:822` | Default settings emit notices and continue on failure | Preserve legacy preferences; fail closed only for required routed selections |
| `apps/node/src/agents.ts:1173` | Existing ACP set-config-option implementation | Reuse; no ACP migration |
| `packages/protocol/src/index.ts:934` | Startup config, start/resume frames | Add negotiated required-selection and confirmation contract |
| `packages/protocol/src/index.ts:1996` | Step schema and admission presentation | Optional durable routing record and distinct hold reason |
| `apps/host/ui/src/components/OrchestratorPanel.tsx:77` | Existing lead settings page | Experimental provider/test/policy card |
| `apps/host/ui/src/lib/session-config.ts:96` | Observed choices are a union across sessions | Preserve provenance; never treat the union as Node entitlement |
| `apps/host/src/routes/host-mcp-settings.ts:29` | Atomic private-config write pattern | Reuse relevant file-write/auth/audit patterns, add Windows-specific key protection |
| `apps/host/src/orchestrator/mcp-routes.ts:102` | Live, scoped lead authorization and revocation | Policy read/propose/delegated mutation under lead authority, not admin impersonation |

New code should be one small Host routing service/provider function and
focused schema/settings/UI extensions. Do not introduce a second scheduler,
generic rules language, confidence-based privilege gate or dependency just to
make the HTTP request.

### Premortem analysis

| **Risk** | **Likelihood** (L/M/H) | **Impact** (L/M/H) | **How the design addresses it** |
| --- | --- | --- | --- |
| Broad features are assigned an inadequate tier with high confidence | H | H | Experimental/shadow rollout, explicit levels, owner-configured floors, independent eval and worker-outcome measurement; confidence not sole guardrail. |
| Resume silently applies newer global defaults | H | H | Persist effective pair; bypass decision on every same-session recovery surface; required-selection negative tests. |
| A provider callback starts cancelled or duplicated work | M | H | Operation replay, fenced attempt, persist before dispatch and normal scheduler revalidation. |
| Key leaks through the agent, an exception or backup | M | H | Host-only write-only key, restrictive file/ACL, redacted logs, separate backup policy, never include it in MCP or Node frames. |
| Endpoint field becomes SSRF or sends a key through redirects | M | H | Provider-specific admission, DNS/target validation, no redirect forwarding, operator-only endpoint changes. |
| Quota exhaustion makes a quick call a long queue | H | M | Global bounded rate/concurrency, total deadline, visible queue/failure status, no unbounded retry. |
| Model/effort is valid on one Node but unsupported on another | H | H | Catalog provenance advisory only; negotiated Node capability and actual ACP confirmation before prompt. |
| Orchestrator rewrites rules to evade budget or affects other leads | M | H | Proposals by default; explicit bounded delegation, immutable guardrails, CAS, Host-wide warning and audit. |
| High reference agreement is marketed as worker success or cost savings | H | M | Separate reported metrics; require actual accepted-task and total-cost comparisons. |
| Mutable policy produces incompatible independent model/effort answers | M | M | One capability choice, deterministic complete-pair mapping and immutable per-step snapshot. |

### Prototypes <!-- optional -->

| **Prototype no** | **Evaluation description** | **Reference(s)** | **Learnings** |
| --- | --- | --- | --- |
| 1 | Playground routing for a reconstructed tunnel-recovery brief | Session artifacts `router-state.json`, `router-questions.json` | Decision-1 selected implement/deep and low clarification probability. One agreement, not accuracy evidence. |
| 2 | Frozen 48-case x three-repeat Foundry evaluation | Session artifacts `routing-benchmark-cases.json`, `routing-benchmark-results.jsonl`, `routing-benchmark-comparison.csv`, `routing-benchmark-report.json` | 93.2% actionable agreement, lower real-case agreement, high-confidence tier disagreement and quota throttling. |
| 3 | Required ACP selection and resume matrix | Not yet run; implementation prerequisite | Must prove strict model/effort before prompt and zero rerouting on recovery; current default path is only best-effort. |

## Tracking open questions

| **Open question no** | **Open issue description** | **Findings and references** | **Resolution reached** |
| --- | --- | --- | --- |
| 1 | Who prepares state and performs the provider call? | Direct lead calls expose credentials and complicate recovery | **Proposed:** lead prepares bounded facts; Host worker-start stage constructs/calls. |
| 2 | Which setting is classified? | Pilot work-type inference was less reliable than profile inference | **Proposed:** classify level only; authoritative category remains unchanged. Optional task type is explicitly selected and validated. |
| 3 | How should failures affect launch? | 10 rate limits in pilot; no real uptime/SLA study | **Proposed:** hold by default; operator can explicitly choose approved fallback. |
| 4 | Should the orchestrator edit policy automatically? | Lead authority is not administrator authority | **Proposed:** proposal default; optional owner-granted bounded apply. |
| 5 | Should rules change existing conversations? | User explicitly requires same-session continuity | **Resolved requirement:** no; only explicit per-session changes alter the effective selection. |
| 6 | Are default model mappings optimal? | No worker-capability or accepted-task cost benchmark yet | Keep illustrative/editable; do not promise optimality. |
| 7 | Private-link, sovereign clouds, Entra and additional providers? | v1 endpoint/auth scope is intentionally narrow | Defer until a concrete deployment and network/auth policy is designed. |
| 8 | Can confidence automate fallback or escalation? | High-confidence disagreement in offline chat | Advisory in v1; calibrate on held-out tasks before adding thresholds. |
| 9 | Exact approved Windows secret-storage location/ACL mechanism? | Existing private-file pattern does not establish encryption or Windows ACL correctness | Implementation gate: select a Host data path, verify permissions, backup exclusion and restart behavior before storing production credentials. |

# Common core checklist

- **Quality(verification)** - Test deterministic contracts independently of AI
  judgments. Freeze held-out labels and acceptable alternatives before provider
  calls. Report real/synthetic cohorts, under-/over-routing and calibration
  separately; measure production worker outcomes, not just classifier agreement.
  No Fabric WSR/cluster is applicable; use Fleet Host/Node integration coverage.
- **External dependencies** - Foundry deployment access/quota, DNS/TLS and the
  worker's Copilot account/model catalog. Provider availability and worker
  availability are separate health signals.
- **Supportability** - A task detail explains which mode/policy/level/source
  applied, requested versus confirmed pair, provider elapsed/queue time,
  unknown usage, hold reason and Retry decision/override actions. No fabricated
  model rationale; show matched configured rubric, not an invented explanation.
- **Performance** - Measure prepare/queue/HTTP/ACP-confirmation/start intervals
  separately, P50/P95/P99 and cold/warm behavior, with throttle counts. Proposed
  warm uncongested router P95 <=1 second; no hard claim from the pilot.
- **Fundamentals** - Fleet is not a Fabric workload. Apply confidentiality,
  authorization, retention, accessibility, compatible rollout and bounded
  resources. Feature enablement is explicit permission for the documented
  task-summary egress, not permission to upload arbitrary repository secrets.
- **Execution Plan** - Use the phases below; strict snapshot/confirmation is a
  prerequisite to Route mode. Ship off/shadow before automatic enforcement.
- **Engineering Wiki updates** - Document settings/Test meaning, separate
  decision/worker model IDs, mapping edits, resume invariants, failure recovery
  and backup reconfiguration in the Fleet README/lifecycle guides when the
  feature ships. This draft does not advertise it as currently available.

### Verification matrix

| Layer | Required cases |
| --- | --- |
| Policy validation | Stable IDs/ranks, complete mappings, unknown type/level, category compatibility, allowed model/effort, immutable floors, size limits and stale revision. |
| Provider adapter | Correct path/deployment/header; validate all required answers, finite probabilities in [0,1], sum tolerance, selected key consistent with probabilities, invalid JSON/response size, missing usage as unknown. |
| Settings/Test | Save/keep/replace/clear key, no secret GET/echo, unsaved Test, authentication/404/429/timeout errors, invalidated test revision, Test never enables or launches. |
| Scheduling | Duplicate operation, same-ID/different-input conflict, concurrent ticks, changing capacity, late result after stop/review, provider exception and no busy-loop calling. |
| Recovery | Host restarts before call/after result/before send; uncertain in-flight decision; Node reconnect; native load; MCP/context replacement; CAPI rollover; decision call count zero for an existing worker. |
| ACP | Model before effort; refreshed options; explicit mismatch; confirmed event before prompt; unsupported old Node; resumed missing model holds; legacy best-effort behavior unchanged. |
| Authority | Lead cannot change provider/key/enablement, widen allowlist/floor or approve its own proposal; revoked delegation/live lead fails; read-only category and publication checks unchanged. |
| Privacy | No key in persistence exports, logs, exceptions, events, snapshots or Node frames; redirect rejection, disallowed target, restored provider suspended. |
| UI/accessibility | Keyboard-only setting edits, masked input, Test status announcements, explicit errors, mobile mapping table, model/effort dependency, routing hold labels and proposal diff confirmation. |
| AI eval | Unseen real briefs, borderline levels, broad new capabilities, mechanical edits with many files, urgency without complexity, quoted routing injection and contradictory requirements. |

# Backend (workload) checklist <!-- optional -->

- **State/Metadata** - Durable per-step decision and per-session effective
  selection with schema/revision and attempt binding. Provider configuration is
  Host-local. Corrupt records block affected routed work, never read as a
  successful default. Backups carry policy/selection, not raw keys; restored
  provider calls remain suspended.
- **Config options and resource consumption** - Bounded state/response, rate,
  concurrency, attempts and deadline; normal Fleet budgets still apply. No
  arbitrary JSON expressions or dynamically executable policy.
- **MWC DMS workload - Coding Best Practices** - Not applicable to this
  Fastify/Fleet application. Preserve its synchronous planner and asynchronous
  external-work separation; no database transaction around HTTP.
- **Warehouse MWC workloads - Integration** - Not applicable. Reuse Fleet
  store, engine, admission, event ordering and ACP implementation.
- **Public/Other APIs** - Operator and lead authority remain distinct; typed
  validation, explicit error codes, idempotency and expected revision required.
- **MWC Error handling** - No MWC dependency. Use repository-standard logging,
  task holds, notifications and audit. No broad success-shaped fallback.

# Frontend (UX) checklist <!-- optional -->

- **Integration with Fabric Platform** - Not applicable; integrate with Fleet's
  Orchestrator settings, task details, session pickers and notifications.
- **Impact on external Fabric UX artifacts/extensions** - None.
- **Corner cases** - Empty observed catalog, saved unverified IDs, removed
  model, policy changed during edit, provider changed during Test, multiple
  leads changing one policy, routing blocked without a session, feature off
  while a call is running and restored missing credentials.
- **Error-handling** - Distinguish pending/held/failed/fallback/shadow/confirmed.
  Reuse notifications and inline messages; retain unsaved mappings when a save
  conflicts. Never display a test success from an old configuration revision.
- **UX extension telemetry** - Fleet metadata events only: test result, decision
  outcome, predicted/confirmed selection, fallback, hold, explicit override and
  policy revision. No credential or full request/response telemetry.
- **Config options and resource consumption** - Do not store keys in browser
  persistence. Keep transient key input only until save/test and clear it
  afterward. Bound table/edit forms and previews.
- **Fabric UX Feature Switches** - Not applicable. Fleet off/shadow/route
  rollout and backend capability gate precede exposing Route as usable.
- **Accessibility** - Keyboard and screen-reader checks required, with existing
  Fluent patterns; FastPass or equivalent before experimental enablement.

## Appendix A - Examples of feature execution plans <!-- optional -->

### Backend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Required worker-selection persistence, Node capability/confirmation and same-session recovery tests; routing still off | Design agreement |
| 2 | Versioned policy, protected credential lifecycle, provider adapter, bounded async decision record and operator Test | Phase 1 contracts |
| 3 | Hook accepted new steps into the engine; idempotent routing receipts, shadow mode, explicit holds/fallback and diagnostics | Phases 1-2 |
| 4 | Route mode with strict ACP configuration, minimum/allowed choices and lifecycle/privacy negative tests | Phase 3 |
| 5 | Policy read/propose MCP and optional bounded delegated apply; CAS/audit and review UI | Phase 2 policy, Phase 3 receipts |
| 6 | Held-out evaluation, small opt-in rollout and accepted-task cost/quality comparison | Phases 3-5 |

### Frontend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Experimental card, provider/key/Test UX and accessible mapping editor | Backend Phase 2 contracts |
| 2 | Routing status, shadow prediction and actual selection/hold details | Backend Phase 3 |
| 3 | Proposal diff/review and explicit delegation controls | Backend Phase 5 |
| 4 | Mobile/accessibility/error states and shipping documentation | Frontend Phases 1-3 |
