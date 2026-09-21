# Orchestration lifecycle

Orchestration control uses separate persisted facts:

- The run and step state controls scheduling.
- The session state records the latest worker state reported by a Node.
- `stopRequested` records an unacknowledged Stop across disconnects and restarts.
- `dismissed` controls visibility only.
- `stoppedByOrchestrator` identifies unfinished steps that Resume may continue.

## Operation contract

| Existing state | Stop | Dismiss | Resume |
|---|---|---|---|
| Pending or dependency-waiting step | Run becomes `cancelled`; step becomes `cancelled` and is marked resumable | No execution change | Marked step returns to `pending`; dependencies are re-evaluated |
| Starting, queued, or running step | Same persisted cancellation; worker receives Stop and remains in its reported state until acknowledgement | Rejected while the lead is live | Rejected until every Stop is acknowledged |
| Succeeded step | Preserved | No execution change | Preserved and never dispatched again |
| Failed step | Preserved | No execution change | Preserved; descendants remain blocked |
| Skipped or independently cancelled step | Preserved | No execution change | Preserved |
| Offline worker | Stop intent remains persisted and is reissued if the Node reports the session after reconnect | Rejected until the lead is terminal | Rejected while execution is unknown |
| Terminal worker | Preserved | No execution change | Reattached only when its step was marked by orchestration Stop |
| Live lead | Owned runs are cancelled before any stop command is sent; the lead records `stopRequested` | Rejected | Rejected |
| Terminal lead | Idempotent; any still-live owned run is cancelled | Allowed only after owned work settles; visibility changes and history remains stored | Lead is reattached, then eligible stopped runs reopen |

Dismiss and restore never change run, step, or worker state. A dismissed lead and
its tasks remain in persistence and continue accepting late terminal events.

## Dependency rules

A step is runnable only when every prerequisite is `succeeded`. Failed,
cancelled, or skipped prerequisites block their direct and transitive
descendants. Independent branches remain eligible. Fan-in requires every branch
to succeed.

## Event precedence

1. Persisting run cancellation prevents all new dispatches.
2. A matching turn completion followed by `idle` or `completed` wins a race
   with Stop and preserves that step as `succeeded`.
3. A reported worker failure remains `failed`.
4. A Stop acknowledgement leaves unfinished work `cancelled`.
5. Nonterminal events received after Stop do not clear stop intent; Stop is
   reissued.
6. Nonterminal state events for dismissed sessions are recorded but cannot
   restore the session to a live UI state.
7. Event sequence watermarks prevent output from an earlier attempt from being
   attached to a resumed attempt.

## Recovery and compatibility

The control fields are additive SQLite columns with safe defaults, so older
databases remain active and visible. Backups preserve the fields. On reconnect,
a stopped session still present on the Node receives Stop again; a session no
longer present is confirmed `stopped`. Resume resets only steps explicitly
marked by the orchestration Stop transaction.

## MCP follow-up decisions

Task identity and worker identity are separate. `fleet_list_work` searches the
current orchestrator's open and closed tasks and returns stable task IDs, worker
session IDs, original checkouts, session states and continuation actions.
`fleet_get_task` reads the task's criteria, notes and worker context. Task tools
accept a stable ID or an exact, unambiguous name; a name lookup miss does not
establish that the conversation was deleted. Neither tool crosses into another
orchestrator's records.

For another revision of the same deliverable, reuse the worker with
`fleet_follow_up`. Reopen a closed or handed-over task first. An accepted
follow-up is persisted in its existing step and passes through the scheduler,
including parallel limits and the original checkout's writer lock. Repeating
the same queued or in-flight prompt does not send another turn, and a different
prompt cannot overwrite it. Busy, stopping and offline are temporary states,
not evidence that the conversation must be replaced. A confirmed terminal
worker without a resumable conversation needs replacement with the retained
task context supplied explicitly.

## Jev shadow evaluation

Jev is a bounded decision model, not a replacement for the Lead's planning,
instructions or final acceptance. The first integration is deliberately **offline
shadow evaluation**. It has no connection to the running Host, database, scheduler
or MCP tools and never dispatches a worker, advances a phase, submits a task or
suppresses a wake. `actualLeadCallsSaved` is therefore always zero.

The experiment asks one question: after a routine implementation/test worker
finishes, could a **previously approved, fully specified independent review**
proceed without another Lead decision? The only answers are
`preauthorized_review` and `lead`. High/unknown risk, missing/stale authorization,
unfinished work, missing current-turn completion, Stop, offline sessions, pending
human messages and final-phase acceptance all remain with the Lead. Multi-worker
phase reconciliation is outside this first experiment.

### Prepare local cases

The synthetic example is
`apps/host/src/orchestrator/fixtures/jev-shadow.json`. Do not interpret it as
evidence of model quality. The CLI can print the complete input JSON schema:

```sh
npm run --silent jev:shadow -w @fleet/host -- --schema
```

Use curated snapshots **at the handoff, before the Lead was woken**, not today's
state of an archived run. Each case records:

- `snapshot.run`, `steps` and the relevant `sessions`, using Fleet's record
  fields. Include all of the run's steps, not just the successful one.
- `turnCompleteSequence` on the worker session: the current attempt's recorded
  `turn_complete` sequence. Idle alone is not a completion receipt.
- `authorization`: the Lead's pre-existing review brief, ownership, phase,
  checkout, source step/attempt/event watermark and approval timestamp. It must
  precede dispatch. Use `null` if no such authorization exists; **do not invent
  retrospective approvals**. These are local evaluation annotations, not a new
  authorization mechanism in the live Host.
- `risk`: independently assigned `routine`, `high` or `unknown`.
- `expected`: a separately adjudicated `preauthorized_review` or `lead` label.
  Include negative cases (blockers, missing verification, scope changes and
  decisions reserved for people), not just successful reports.
- Optional `leadDecisionMs`: the measured Lead handoff decision duration. Leave it
  absent when unknown; worker execution time is not this baseline.

No automatic export or transcript upload is enabled. Keep datasets/reports outside
the repository. Inputs are limited to 8 MiB and 200 cases; an eligible request's
state is limited to 64 KiB. Oversized state is escalated, never silently truncated.

### Replay without contacting TypeSafe

After building the protocol package, run from the repository root:

```sh
npm run build -w @fleet/protocol
npm run --silent jev:shadow -w @fleet/host -- \
  --dataset /absolute/path/cases.json \
  --predictions /absolute/path/predictions.json \
  --min-confidence 0.90 --min-probability 0.95
```

The numbers are illustrative evaluation settings, **not calibrated production
defaults**; both must be supplied explicitly. Predictions use
`{"version":1,"predictions":[...]}`. Each entry contains `caseId`, the CLI's
`fingerprint`, measured `latencyMs`, and the SDK response under `response`.
The response uses `model` and
`answers.handoff.{type,choice,confidence,probabilities}`; probabilities must contain
exactly the two declared choices. Missing/malformed predictions, ties, low scores,
unknown choices and mismatched fingerprints escalate. An empty predictions array
produces a dry report with fingerprints and no network calls.

Remote reports also contain this predictions envelope, so the entire saved report
can be passed as `--predictions` to compare thresholds locally. Fingerprints bind
predictions to the snapshot, authorization, risk and question definition, but not
the expected label or baseline timing. They detect accidental mismatches; they are
not signatures and do not make imported records authoritative.

### Optional, explicitly consented TypeSafe request

First review/redact every case and confirm that uploading its content complies
with your organization's policy and TypeSafe's data-processing terms. There is
**no automatic secret redaction**. Set `TYPESAFE_API_KEY` through your environment
or secret manager, never in a dataset, command argument or committed file.

```sh
npm run --silent jev:shadow -w @fleet/host -- \
  --dataset /absolute/path/reviewed-cases.json \
  --send-to-jev --model jev-latest \
  --min-confidence 0.90 --min-probability 0.95
```

Prefer an available pinned model ID instead of `jev-latest` for reproducibility.
The integration uses the official `@typesafe-ai/sdk` Choice API. Its contract was
checked against [the official SDK v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/tree/v0.6.0),
not inferred from marketing examples. The fixed destination is
`https://api.typesafe.ai`; SDK base-URL environment overrides and HTTP redirects
are disabled. SDK logging is forced off, including when `TYPESAFE_LOG_LEVEL` is set,
so diagnostics cannot leak request text or corrupt JSON reports. Calls are
sequential, have a two-second deadline and no retries.
Network failures and invalid responses produce a Lead fallback rather than
preventing evaluation of later cases.

Only the objective, success criteria, current/next phase names, source worker
brief/report and approved review are sent. Labels, timings, authorization
identifiers and session records are not sent, although identifiers or sensitive
content embedded in free text still require manual redaction. Reports omit source
text and raw provider diagnostics. No real inference is required by the tests.

### Interpret the report before considering automation

`wouldBypassLead`, `wouldEscalate`, `falseBypasses`, `falseBypassRate` (false
bypasses divided by all predicted bypasses), `missedBypasses` and prediction
p50/p95 latency quantify the experiment. Missing labels are rejected. Rates with
no denominator and unknown baseline timings are reported as `null`, not zero.
`estimatedNetSavingMs` is a **counterfactual handoff estimate**: baseline minus
Jev latency on bypasses, minus Jev latency on fallbacks. It excludes downstream
execution, queueing and remediation, and is not observed end-to-end speedup.
A false bypass can invalidate any apparent benefit.

Calibrate on representative development cases, then evaluate on held-out cases
and model versions; Choice confidence is not a safety guarantee. Do not enable
live bypasses on this report alone. A later live integration still needs durable
Lead authorization, atomic consumption/idempotency, fresh state checks after
asynchronous inference, the existing placement/capacity/dependency guards, and
fallback on cancellation, retries, restarts or ambiguity. Final acceptance stays
with the Lead and the human.
