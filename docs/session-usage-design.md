# Session usage snapshots: design and implementation

**Decision accepted:** 19 October 2026

**Implementation documented:** 20 October 2026

This document preserves the approved usage-summary design and explains its
implementation. It incorporates the implementation's handling of native-session
adoption, journal replacement, and date boundaries rather than copying the
planning proposal unchanged.

For operator instructions, see the [Usage guide](guide/usage.md). The original
execution outline is the [implementation plan](superpowers/plans/2026-10-19-session-usage-summary.md).

## Purpose and scope

Fleet should answer how many AI credits and tokens were consumed over a period,
on a machine, or for a task. It includes Fleet-managed Copilot and Hermes
sessions: Orchestrators, workers, reviewers, and standalone conversations.

The primary measures are independent:

- **AI credits:** Copilot-reported credits, including Copilot Orchestrators.
  Hermes has no Copilot credit measure; it is not assigned a zero-credit cost.
- **Total tokens:** compatible reported consumption from Copilot and Hermes.
- **Optional details:** input, output, cache read, cache write, and reasoning
  counters when the backend exposes them.

“All recorded history” means history Fleet has actually collected. This feature
is not an account-wide billing import or a scan of every terminal or Cursor
conversation on a machine. Existing closed conversations are not automatically
reconstructed from their transcripts.

## Decision: cumulative snapshots with live refresh

Use session-level cumulative snapshots while conversations remain open, and read
available final accounting on shutdown. Shutdown confirms or advances the same
counters; it does not introduce an additional charge.

This retains the simplicity of shutdown-summary accounting without requiring a
session to close before any usage can be recorded. Sources may internally have
per-call records, but Fleet collects their session aggregates rather than
importing a per-request ledger.

The implementation adds no telemetry exporter, model proxy, external analytics
service, tokenizer-based estimation, or pricing dependency.

## Ownership and data flow

The **Node** is Fleet's service on the executing machine. It owns access to the
agent's native usage sources and buffers observations locally. The **Host** owns
integrated history, authorization, reporting, and the browser interface.

The normal flow is:

1. The backend adapter reads cumulative consumption for a native conversation.
2. The Node emits an accounting update associated with its Fleet session.
3. A private Node journal persists the changed snapshot before delivery.
4. A negotiated, authenticated connection carries a bounded snapshot batch.
5. The Host validates session ownership and commits the snapshots atomically.
6. The Host acknowledges the batch's delivery position.
7. The Node deletes acknowledged pending records.
8. The summary page queries the Host; it does not read native agent stores.

The Node intercepts accounting before ordinary transcript handling. The existing
bounded transcript outbox and non-lead session journal alone are insufficient:
accounting must include Orchestrators and survive discarded transcript output.

## Backend sources

### Copilot

The existing Copilot usage reporter polls every two seconds. Its native event
reader follows complete appended lines in
`${COPILOT_HOME:-~/.copilot}/session-state/<native-id>/events.jsonl`.

- `session.usage_checkpoint` supplies cumulative `totalNanoAiu` credits.
- `session.shutdown` can supply final credits and token summaries.
- Supported accounting snapshots expose token metrics through
  `accountingSnapshot`, provider/model aggregates, or `modelMetrics`.
- One aggregate view is selected. Provider/model and model-only representations
  of the same usage are not added together.

When supported, a read-only query of `session-store.db` aggregates
`assistant_usage_events` for the exact native session. It supplies live token
snapshots without importing individual calls. Required input/output columns must
be present; optional detail columns can be missing. Null or invalid counters are
not silently converted to zero.

Once the native database supplies tokens, it remains the preferred token source
for that native conversation. Temporary database unavailability does not cause
an older checkpoint token total to replace it. Credit checkpoints continue to
advance independently.

Native nano-AIU values are converted to AI credits using one billion nano-AIU per
credit. Reporting arithmetic converts credit amounts to integer nano-units for
addition and subtraction, then returns credit quantities. The persisted snapshot
payload contains the `aiCredits` quantity, not a separate raw nano-AIU column.

### Hermes

Hermes polls the selected native session's persisted counters every three
seconds where the schema is supported. It uses `HERMES_HOME`, or `~/.hermes`, and
reads `state.db` for the default profile or `profiles/<profile>/state.db` for a
named profile.

Hermes's native database uses disjoint canonical buckets: uncached input,
cache reads, cache writes, and output. Fleet requires all four to be known,
normalizes input to include both cache buckets, and computes inclusive input plus
output. Reasoning remains a detail within output and is never added again.
Missing/invalid required buckets leave the total unavailable, not understated.

ACP prompt-completion responses can describe only an attached process and have
a different input definition. They are therefore excluded from durable Hermes
consumption, rather than compared with lifetime database counters by size.
After completion the reporter reads the database; coalesced updates are picked
up by subsequent polling.

Hermes emits source `hermes-native-totals-v2`; its counter identity includes that
version, the profile, and the native session ID. This prevents the Node journal
from suppressing a corrected reading with unchanged numbers. Hermes does not
publish AI credits into the combined report.

The reader queries the selected native session. It does not blindly sum parent
conversations, compression descendants, or auxiliary-call aggregates. Complete
coverage of those paths remains dependent on the installed backend's accounting
behavior.

### Context occupancy is separate

ACP `usage_update.used` and `size` describe context occupancy and capacity. They
remain available for session context indicators, but are excluded from consumed
token totals. Likewise, an ACP monetary `cost` field is not automatically a
Copilot AI-credit amount.

## Snapshot contract

The validated shared types live in
[`packages/protocol/src/usage.ts`](../packages/protocol/src/usage.ts).

An accounting observation contains:

- `nativeSessionId`: the backend conversation identity.
- `counterId`: the identity of the cumulative counter scope. Ordinary resume must
  not invent a new scope and charge the existing total again.
- `source`: a bounded source label.
- `observedAt`: the accounting observation timestamp.
- `startedAt`, when known: the creation time of a new native counter scope.
- `baseline`, when attaching to existing usage: identifies an opening balance.
- Optional numeric credit, total-token, and detail counters.

Each delivered snapshot also has an immutable ID, a Node delivery sequence, and
the Fleet session ID. Missing metrics are omitted. A valid explicit zero is
preserved.

A known native start time supplies the beginning of the first observation
interval without inventing a token measurement. An existing conversation without
that information enters as an opening balance instead.

## Storage

### Node journal

[`UsageJournal`](../apps/node/src/usage-journal.ts) stores private SQLite state at
`<Node configuration directory>/usage-history/usage.db`.

Its tables have distinct responsibilities:

- `positions` persists delivery sequence positions.
- `pending` retains immutable snapshots awaiting acknowledgement.
- `latest` retains numeric signatures used to suppress unchanged readings.

Journal namespaces include both Host and Node identity. Restoring another
identity must not send the previous identity's observations to the wrong Host or
machine. Transactions use `synchronous=FULL`; the directory follows Fleet's
private journal permission conventions.

Batches contain at most 100 snapshots. The pending queue is capped at 100,000
records per namespace and the database also has a page limit. Storage failures
are visible in Node diagnostics; they do not justify running another model
request. A failure before persistence can still leave a collection gap.

### Host history

[`UsageStore`](../apps/host/src/usage-store.ts) uses two tables in the existing Host
SQLite database:

- **`usage_streams`:** retained machine/session labels, backend, role, and task
  binding, keyed by Node and Fleet session. Native counter identity is carried
  by the snapshot payload rather than a separate native-session table.
- **`usage_snapshots`:** immutable snapshot payloads, their authenticated Node,
  Fleet session, normalized observation time, and Host commit order.

The table's `sequence` column is Host-owned commit order. The sequence inside the
snapshot payload is Node delivery order. They are intentionally different: a
fresh Node journal after identity migration can restart its delivery sequence
without colliding with older Host history.

Snapshot IDs deduplicate delivery. Reusing an ID with different immutable
contents is rejected. Reports read observations in source-time order with commit
order as a tie-breaker, rather than using reconnection time as consumption time.

## Delivery, compatibility, and authorization

Snapshot delivery is enabled only over the sealed Node connection when the Node
advertises `usage-snapshots-v1` and the Host confirms `usageSnapshots` in its
welcome message.

- The Node sends `usage_snapshots` batches.
- The Host sends `usage_ack` only after committing the batch.
- Acknowledgements refer to the Node's delivery sequence, not Host commit order.
- The Node refuses acknowledgements beyond history it has sent.
- Lost acknowledgements cause retries with the same snapshot IDs.
- The existing five-second heartbeat provides a retry opportunity.

The authenticated connection supplies the Node identity. The Host resolves
current or retained session ownership; it does not trust the sender to choose
another machine's identity. Foreign ownership and conflicting immutable records
are rejected. Permanently unknown sessions can be skipped and acknowledged so
one obsolete record does not block the entire pending queue.

Older peers continue their existing protocol and do not receive unnegotiated
usage messages. Both Host and Node need the updated implementation to collect
this history.

## Accounting rules

### Calculate differences, not sums of snapshots

For a continuous counter scope, reported lifetime consumption is reconstructed
from its opening amount and subsequent increases. Period consumption comes from
consecutive differences.

For example, cumulative readings of **10, 12, 12, and 15 credits** mean 15
lifetime credits. The later increases are 2, 0, and 3. Adding all four readings
would incorrectly report 49 credits.

A shutdown reading of 15 after a live reading of 15 contributes zero. A final
reading of 16 contributes only the additional credit.

### Keep metrics independent

Each metric has its own preceding valid reading. New credits without new tokens
must not erase or retime the last token observation. If a category first becomes
available on an attached existing scope, it can be an opening balance even when
other categories were available earlier.

### Keep native counter identity across Fleet aliases

Counter comparisons use Node, backend, native counter scope, and metric. They do
not use Fleet session ID as the consumption identity.

Consequently, adopting the same native conversation into a new Fleet session
does not charge its existing lifetime total twice. Differences are calculated
before applying task, backend, role, or date filters, so a filter cannot discard
the earlier reading needed as a subtraction baseline.

### Treat regressions as incomplete evidence

A decreasing value within the same scope is excluded and counted as a
regression. The implementation does not manufacture negative spend or assume
that every decrease starts a new zero-based epoch. A real disjoint counter scope
needs a distinct, justified identity.

Automated correction workflows and a manual reconciliation interface are outside
the initial implementation.

## Periods and daily allocation

Observations are represented in UTC. The API accepts an IANA reporting timezone;
the browser uses its local timezone. Ranges have an inclusive start and exclusive
end. A custom end date is converted to the following local midnight, including
that entire day and respecting daylight-saving transitions.

The page offers last 24 hours, last 7 days, last 30 days, all recorded history,
and custom dates. A month preset means 30 rolling days, not a calendar month.

- **Opening balances:** included once in all-time totals, with unknown dates.
  They are not assigned to the discovery day or included as precisely dated
  consumption in a bounded report.
- **Known increments:** belong to the interval between valid observations.
- **Filter-boundary overlap:** increments whose interval crosses the requested
  boundary are reported separately as unallocated, rather than prorated.
- **Multiple-day intervals:** can contribute to a wider selected total, but have
  a separate daily-report group instead of being spread evenly across days.
- **First reading across midnight:** a known `startedAt` preserves the interval's
  real beginning; it is not treated as consumption beginning at the first poll.
- **Offline delivery:** retains the original observation interval rather than
  attributing the backlog to reconnection day.

Snapshot accounting cannot reconstruct exact per-call timing. Clock accuracy and
backend publication timing limit date precision; Host receipt time is not a
substitute for an authoritative consumption timestamp.

## Task and Orchestrator attribution

Workers and reviewers use their existing task binding. Standalone conversations
are grouped separately.

Every Orchestrator's consumption is included in fleet, machine, and session
totals. Long-lived leads can handle several tasks, so their spend is filed under
**Shared Orchestrator usage** and excluded from individual task totals. The
initial implementation does not allocate a lead's turns to individual tasks or
estimate a percentage split.

Moving a task to another Orchestrator does not give that new lead ownership of
older workers' consumption. More precise lead attribution would require trusted
prompt-scope records and is deferred.

## Token details and units

Total tokens are the primary consumption measure. For supported Copilot native
formats, inclusive input plus output supplies the total: cache reads/writes are
already input categories, and reasoning is already an output category.

Hermes native session summaries store uncached input separately from cache reads
and writes. Fleet includes those cache buckets exactly once in normalized input,
then adds output for total tokens. Optional detail categories are not added again
to the primary total. ACP response totals are not used as a lifetime fallback.

Missing or ambiguous categories remain unknown. Fleet does not estimate them
from transcript length, derive token counts from credits, or convert token counts
into an invoice. Model/provider/session aggregate views of the same spend are
alternative representations, not independent charges.

## Reporting interface

The protected `GET /api/usage` endpoint accepts `from`, `to`, `timeZone`,
`groupBy`, `nodeId`, `taskId`, `backend`, and `role`.

Grouping supports day, machine, task, and session. Session is a grouping option,
not an additional session-ID filter in the initial API.

The response includes known totals, grouped rows, retained machine/task filter
options, and coverage information: sessions with credit/token readings, opening
balances, unallocated quantities, regressions, and the latest reported timestamp.
Coverage indicates available readings, not proof that every provider call was
captured.

The browser refreshes every five seconds while mounted, cancels obsolete
requests, and retains filter choices in session storage. Its last-reported time
is an overall timestamp, not a separate freshness indicator for every metric.

The English-language report uses Fleet's dark theme and decimal K/M/B units,
with exact readings in accessible labels and hover titles. Headline values show
tokens, AI credits, and token-reporting session coverage; no model-price estimate
is inferred. Optional token details use independent bars because their counters
can overlap, rather than a stacked composition chart.

The daily chart stays visible when the breakdown is grouped by machine, task,
or session. In those modes the browser concurrently requests a second report
with `groupBy=day`, preserving the same filters, timezone, and exact range
boundaries. Day grouping reuses its single response. The browser replaces the
pair together and ignores responses from aborted selections. Separate requests
are not a transactionally frozen snapshot: new readings can arrive between Host
queries. Opening and multi-day buckets stay outside the dated chart, and missing
days are not invented as zero. A failed live refresh retains the last successful
report with an explicit error notice.

## Hermes legacy counter reconciliation

The original `hermes-session-totals` source mixed exclusive database input with inclusive ACP process totals under the same counter identity. Independent metric regressions could then leave the report with cache reads greater than its understated total. Raw legacy records do not identify which source produced each value, so adding cache to every old record or choosing per-metric maxima would invent a repair.

The report therefore retains those immutable snapshots in storage/backups but excludes them completely from consumption, detail, freshness, and baseline calculations. Corrected native v2 readings form a separate counter series. When legacy history exists for that Node + profile/native scope, the first v2 balance is forced to an undated opening even if a sender incorrectly labels it new. Subsequent observed increases retain normal period and boundary accounting. Copilot counters and credit backfills are unchanged.

Optional coverage fields `legacyHermesSessions` and `pendingHermesSessions` explain excluded sessions and those still lacking a corrected native reading before the report end. Scope matching occurs across Fleet session aliases and before task filters. The UI states that totals are partial until affected Nodes refresh and that period breakdowns from the old mixed history are unavailable. **Update the Host first, then the Nodes**; the refresh restores all-time native balances without charging the normalization difference to the upgrade day. No existing database rows are rewritten or live models invoked. Closed legacy Hermes sessions are not automatically rescanned on update and remain excluded until a trusted corrected native reading is collected; a historical query ending before the first v2 reading continues to report missing corrected coverage.

## Legacy credit backfill

The Usage page's **Backfill old credits** action previews and confirms a Host-side import of saved cumulative credits. `GET /api/usage/backfill` returns counts, skipped reasons, and a deterministic SHA-256 plan fingerprint. `POST /api/usage/backfill` accepts only that fingerprint; callers cannot supply amounts. Both endpoints require a Microsoft administrator, or the existing explicit local no-auth operator mode. The POST retains the central origin/CSRF protections and emits an authorization audit record.

[UsageBackfillStore](../apps/host/src/usage-backfill.ts) groups saved Copilot session readings by Node identity and native conversation ID. Only terminal sessions are eligible; an active alias blocks its conversation. Missing/invalid identities or values, conflicting cumulative balances/task/role attribution, and existing native credit history are skipped. Matching aliases collapse to a single balance. Existing token-only snapshots do not prevent a credit-only import. The deterministic snapshot ID and stored credit history make repeated imports, cleanup, and backup restores idempotent without a global once-only flag.

Fleet revalidates the fingerprint before backup and again under the write transaction before insertion. A nonempty import first uses SQLite `VACUUM INTO` to create a consistent full database backup in the protected Host data directory; a private, exclusive server-generated filename prevents overwrites. This backup includes sensitive Host keys and transcripts and is never exposed by a download route. Backup failure refuses the import, and an ingestion failure rolls back the entire batch. An in-memory test Host has no persistent file to back up.

Imports use source `legacy-credit-backfill-v1`, the original native counter identity, baseline=true, no startedAt, and credits only. Node snapshot batches cannot submit this reserved source. The source is always an undated opening increment, including if an older native reading arrives later and sorts before the imported record. For example, late native 80 + imported cumulative 100 + fresh native 112 yields 100 opening credits and 12 subsequent credits, never 212 credits. A lower inferred import is ignored when authoritative earlier history already exceeds it. Imported timestamps describe recording, not consumption or provider freshness; they do not advance Last reported. Original session records and token counters are unchanged.

The UI previews fleet-wide scope, counts, skipped reasons, and the undated-history limitation before confirmation. It blocks duplicate submissions, requires another preview after failure, and switches to all recorded Copilot history on success. Backfill never starts agents or requests model responses. Exact historical period attribution requires historical readings and cannot be inferred from one saved total.

## Retention, backups, and privacy

Usage tables deliberately have no cascading foreign key to disposable sessions.
Before deleting a session, the Host retains minimal ownership and label metadata.
A delayed first or final observation can then be accepted after transcript
cleanup without becoming an unowned record.

Host backups include optional `usageData` with retained metadata and snapshots.
Older backups without that field remain readable. Usage metadata is retained
independently of transcript retention; the initial feature has no automatic
usage-expiry policy or dedicated purge interface.

The accounting tables contain counters, identities, timestamps, and labels.
They do not copy prompts, responses, transcript bodies, or authentication
credentials. Native source stores are read locally and read-only. Normal
permission checks on the Host's reporting endpoint remain in force.

Durability covers successfully persisted observations. Provider/export gaps,
unsupported native schemas, failures before persistence, and already-deleted
native history can still make the data incomplete.

## Implementation map and tests

- [Shared contracts](../packages/protocol/src/usage.ts): snapshot validation,
  reporting filters, response types, and backup shape.
- [Copilot native reader](../apps/node/src/session-credits.ts): checkpoint,
  shutdown, and agent-loop reading.
- [Native aggregate helpers](../apps/node/src/usage-totals.ts): compatible token
  totals and read-only database queries.
- [Copilot reporter](../apps/node/src/agent-kinds/copilot-usage.ts) and
  [Hermes reporter](../apps/node/src/agent-kinds/hermes-usage.ts): live collection
  and source selection.
- [Agent lifecycle](../apps/node/src/agents.ts): start/resume, prompt completion,
  and final flush integration.
- [Node journal](../apps/node/src/usage-journal.ts) and
  [Node runtime](../apps/node/src/main.ts): persistence, batching, retry, and ACKs.
- [Host gateway](../apps/host/src/gateway/node-socket.ts): capability negotiation
  and authenticated ingestion.
- [Host usage store](../apps/host/src/usage-store.ts) and
  [Fleet store](../apps/host/src/store.ts): accounting, retained metadata, and
  backup integration.
- [Reporting route](../apps/host/src/routes/usage.ts) and
  [Usage page](../apps/host/ui/src/components/UsagePage.tsx): querying and display.

Focused tests accompany those modules. Important regression cases include
repeated live/shutdown totals, missing versus zero counters, late first metrics,
cache/reasoning overlap, source fallback, offline replay, retained ownership after
cleanup, identity migration with a fresh journal, adoption into another Fleet
session, filter baselines, and first readings spanning midnight.

Backend formats were verified with synthetic fixtures. This is not a claim that
all installed Copilot, Agency, or Hermes versions, compression paths, and
auxiliary-call paths have been exercised against paid live provider sessions.

## Alternatives and deferred work

- **Shutdown events alone:** simplest source, but cannot update open sessions.
- **A per-call ledger or telemetry pipeline:** better attribution and timing,
  with more source reconciliation and operational complexity than requested.
- **A model gateway/proxy:** could observe provider responses directly, but would
  change Fleet's execution and authentication boundary unnecessarily.

The initial implementation therefore defers exact per-call timing, per-task lead
turn allocation, account-wide imports, model-pricing calculations, automatic
counter correction, and precomputed daily rollup tables. Reporting currently
streams snapshot history; additional indexing or derived aggregates should follow
measured performance needs.

## Research references

Public source was reviewed during the design on 19 October 2026. Main-branch
links can change; installed versions may differ.

- [ACP session context size and cost](https://agentclientprotocol.com/rfds/session-usage):
  distinguishes context occupancy from cumulative consumption and explicit cost
  units.
- [Copilot checkpoint schema](https://github.com/github/copilot-sdk/blob/main/java/sdk/src/generated/java/com/github/copilot/generated/SessionUsageCheckpointEvent.java)
  and [cumulative metrics](https://github.com/github/copilot-sdk/blob/main/java/sdk/src/generated/java/com/github/copilot/generated/UsageGetMetricsResult.java).
- [Hermes canonical usage buckets](https://github.com/NousResearch/hermes-agent/blob/main/agent/usage_pricing.py): `prompt_tokens` includes uncached input plus cache read/write; total adds output. Reviewed for the correction on 20 October 2026.
- [Hermes ACP usage projection](https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/gateway_session_meta.py)
  and [persisted usage accounting](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_usage.py).
- [Tokscale Copilot native-store reader](https://github.com/junhoyeo/tokscale/blob/main/crates/tokscale-core/src/sessions/copilot_session_store.rs):
  evidence for native cumulative aggregates without a proxy.
- [ccusage Copilot guide](https://ccusage.com/guide/copilot): cumulative shutdown
  baselines, source overlap, and historical recovery limitations.
- [cursor-byok Anthropic provider](https://github.com/leookun/cursor-byok/blob/main/server/src/provider/anthropic.rs):
  provider-reported usage and cache-inclusive accounting principles. Its gateway
  architecture is prior art, not a dependency introduced into Fleet.
