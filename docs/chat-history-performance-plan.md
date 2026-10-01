# Chat history performance plan

Source baseline: `b88e238`. Revised September 30, 2026 after reviewing the supplied
measurement scripts and the actual history-loading paths, then updated with the
implementation in this PR.

## Status of this PR

This PR implements Phases 0 to 4 and the Phase 1 data-path fixes. Phase 5's
browser-level verification is covered by the new browser benchmark; the full
native-Git test gate is still not green on the maintainer's machine (see below).

| Phase | Implemented |
|---|---|
| 0 | `npm run benchmark:history` (Node stages, isolated HTTP route, event-loop probe) and `npm run benchmark:browser` (production build in headless Edge). See [the benchmark guide](chat-history-benchmarks.md). |
| 1 | One deduplicated transcript load per session; ordered live append; per-session permission ledger hydrated from a compact query; bookkeeping events excluded in SQL; no overview history backfill; indexed `listEventsAfter` for the three attempt-scoped readers. |
| 2 | `TerminalView` renders blocks through `react-virtuoso` with stable keys. Expansion state lives outside rows; bottom pinning, "Jump to latest", unread counts, and the prompt rail work from the visible range. A prompt jump loads older pages until its block is present, then scrolls to it. |
| 3 | `TranscriptProjector` in `@fleet/protocol` folds one event at a time and reports at most one change: an append to a block's text or a replacement block. Published blocks are never mutated. `toTerminalBlocks` delegates to it, so live and whole-history folds share one set of rules. The browser batches live messages every 32 ms in arrival order. |
| 4 | The Host keeps an in-memory projection per session (`TranscriptProjections`) and serves `/api/sessions/:id/transcript` as pages of 200 blocks with a `before` cursor. Each stored event advances the projection and carries its change on the live `event` message, stamped with a generation and revision. The browser keeps a per-session copy (`TranscriptCache`), applies changes in order, and refetches when it sees a gap or reset. |

Deliberate differences from the plan below:

- The Host projection is not persisted. The first open after a Host start rebuilds
  it from `listTranscriptRows` in batches of 2,000 rows that yield to the event loop.
  It restarts if an event lands behind its cursor. A persisted projection is not
  needed at the measured cost (about 0.4 to 0.5 s once per session per Host start).
- Every page request checks the projection against `COUNT(*)` and `MAX(sequence)`.
  That catches writes that bypassed the live path, and costs about 16 ms on the
  112,000-event fixture. It is most of the warm request time.
- The projection reader skips the outer `SessionEventSchema` check, because its
  output is display-only and payloads are still parsed. Canonical readers such as
  `listEvents` keep the full validation.
- There is no around-prompt page. A prompt jump loads older pages in sequence.
- Caches are bounded: the Host keeps projections up to about 128 MiB (least
  recently used first); the browser keeps up to six sessions and trims inactive
  ones to their last 200 blocks.
- Native Ctrl+F only finds rows that are mounted. Whole-conversation search or
  export is not part of this PR.

Raw events remain authoritative. Existing full-history APIs, agent context,
orchestration semantics, and retention policy are unchanged. The projection is
disposable: a restore clears it, and a restart rebuilds it.

### Results

Representative synthetic workload: 112,000 lead events (5,600 blocks), 312,000
events across 26 sessions. Windows, Node 22.22.3, AMD EPYC 7763 (16 vCPUs),
headless Microsoft Edge at 1440x900. "Before" is `b88e238`. The JSON reports
live under `dist\benchmarks`; regenerate them with the commands in the
[benchmark guide](chat-history-benchmarks.md) rather than treating these as
portable thresholds.

Browser (production build, 10 iterations; "cold" is the first open after a Host start):

| Measure | Before median / P95 | After median / P95 |
|---|---:|---:|
| Open the long conversation, cold | 5,341.7 ms | 576.2 ms |
| Switch back to the long conversation | 4,346.5 / 5,484.0 ms | 147.4 / 149.0 ms |
| Switch to a short conversation | 1,035.1 / 1,405.7 ms | 146.9 / 162.0 ms |
| Key press to next paint while streaming | 1,409.1 / 2,723.2 ms | 12.7 / 18.9 ms |
| Frame gap while streaming | 133.2 / 1,733.2 ms | 16.7 / 16.7 ms |
| Long-task time while streaming 200 chunks | 6,928.0 ms | 0.0 ms |
| Last chunk to paint | 2,197.8 ms | 8.7 ms |
| DOM elements with the long conversation open | 52,186 | 933 |
| Elements inside the transcript | 51,474 | 221 |
| JS heap | 89.5 MiB | 21.0 MiB |

Host and data path (Node, 5 warm-up and 30 measured iterations):

| Measure | Before P95 | After P95 |
|---|---:|---:|
| History response, warm | 1,282.31 ms | 20.56 ms |
| History response, projection rebuilt each request | n/a | 471.80 ms |
| Lightweight request during a history response | 1,263.26 ms | 20.39 ms (18.12 ms during a rebuild) |
| Host event-loop delay, maximum | 1,313.87 ms | 21.82 ms (39.55 ms during rebuilds) |
| History response size | 28,211,687 bytes | 164,922 bytes |
| Browser work per streamed text event | 59.36 ms (merge and full refold) | 0.01 ms (apply one change) |
| Host work per streamed event | n/a | 0.01 ms |
| Twelve-line preview | 6.30 ms | 0.16 ms |
| Attempt-scoped suffix read | 846.17 ms (read all, then filter) | 71.35 ms |

The latency, payload, and Host-responsiveness budgets in
[Proposed acceptance budgets](#proposed-acceptance-budgets) are met on this workload. Node
timings and the browser benchmark use synthetic data on one machine; confirm
with a trace on the live Host before relying on exact figures.

### Verification status for review

- Lint, formatting, all workspace typechecks (including the benchmarks), and
  production builds pass.
- A serial run of every test file except the two native-Git suites below:
  272 of 273 files and 5,204 tests pass, 3 are skipped, and 1 fails. The
  failure is `routes/notifications.test.ts` "lists and paginates the
  non-dismissed hydration view". It fails identically on untouched `b88e238`:
  its fixture dismisses a notification on 2026-09-01, which the 30-day
  notification retention now prunes.
- `apps/node/src/managed-worktrees.test.ts` and
  `scripts/managed-worktrees.integration.test.js` were run separately and
  stalled without output for 10 minutes, as they did for the first slice. This
  PR does not change them or anything they exercise.
- New tests cover the projector (equivalence with the whole-history fold,
  immutability, older tool updates), Host pages (ordering, late fills, stale
  detection, yielding rebuilds, eviction), the browser cache (buffering, gaps,
  resets, older pages, trimming), and the virtualized `TerminalView`.

The full gate is therefore not green on this machine, for reasons outside this
change. Review accordingly.

## Why data-path fixes come first

The supplied review reports 26 sessions with 312,934 events. Its largest lead
contains 111,598 events but only 5,797 presentation blocks. About 85% of events
are tiny text/thought chunks. Virtualizing those blocks is worthwhile, but it
cannot remove SQL/JSON work or history scans performed before React renders.

Verified scaling problems at the baseline:

| Path | Cost |
|---|---|
| `App.tsx` selected-session and selected-Orchestrator effects | Both could request the same full history |
| `useFleet.ts` request tickets | Discarded superseded results without preventing duplicate work |
| `store.listEvents` / `eventFromRow` | Selected, decoded, and validated every event |
| `mergeEvents` on each live frame | Filtered/copied/sorted history before each state update |
| `TerminalView` / `toTerminalBlocks` | Refolded history and mounted every block |
| App-level permission derivation | Flattened all cached histories on text updates |
| `TerminalView` prompt tracking | Queried/measured every prompt element |
| Overview backfill / `toPreviewLines` | Loaded resumable ended histories and processed every block for a short preview |
| `engine.ts` reconciliation/`collectOutputs`, `fleet-service.ts` maintenance receipts | Read complete histories before discarding events at or before an attempt boundary |

### Measurement provenance

The external scripts reported approximately one second of synchronous Host work,
33.4 million serialized history characters, 190 ms parsing plus 94 ms folding in
Node, 86 ms for an added event's merge/refold, and 25 ms for a global permission
scan. They reported about 3.6 million characters for all blocks and 113,000 for
the last 200.

Those are exploratory numbers, not browser latency measurements:

- Most stages ran once without warm-up; only the permission scan averaged ten runs.
- `JSON.stringify(...).length` counts UTF-16 code units, not transfer bytes.
- The simulated chunk cloned the last event; it was not necessarily a text event.
- The timing scripts loaded payloads into memory but printed aggregate results.
- No HTTP, React, layout, paint, or event-loop probe was measured.
- Do not add stage timings together and call the sum end-to-end latency, or assume
  that Node timings are a browser lower bound.

Use the checked-in [benchmark harness](chat-history-benchmarks.md) for repeated,
reproducible measurements rather than carrying forward those figures as facts
about the live UI.

## Phase 0: reusable, representative baseline

Keep benchmark code and synthetic fixtures in this repository. Default to an
isolated Host and disposable database, never the operator's live database.

The current fixture has 112,000 lead events, 5,600 lead blocks, and 312,000 events
across 26 sessions. Include small and 10x workloads, retaining the same visible
tail. Match event types/chunk sizes with synthetic content, not private messages.
Keep a 100,000-block test as an optional stress test, not the representative case.

Measure warmed median/P95 with at least 30 samples and retain the raw samples.
Record CPU/OS/Node versions, Git revision and dirty state, counts, UTF-8 bytes,
cache warmth, and GC assumptions. Measure the real history route's headers/body
timings and a concurrent lightweight request from a separate process/connection.
Use `monitorEventLoopDelay`, including its maximum, to reveal Host stalls.

Separately profile a production browser build: cold open, cached A-to-B-to-A
switching, typing during streaming, scrolling away from the bottom, prompt jumps,
resizing, reconnect, and repeated switching. Measure to painted, usable output,
not just fetch completion or React commit. Capture mounted rows and retained heap.

## Phase 1: independently shippable data-path fixes

1. Consolidate transcript loading and deduplicate concurrent requests per session.
   Treat live events and hydrated history as different states. Preserve live
   events arriving during REST requests. Abort on disconnect/unmount, and prevent
   an old request's cleanup from deleting a newer request.
2. Append a new ordered event without sorting the whole list. Retain replay,
   out-of-order, and authoritative replacement handling. The initial fast path
   still checks IDs and copies the array; it is not constant-time streaming.
3. Track permissions by session and request ID, not by flattening transcript
   arrays on every text chunk. Hydrate latest requests **and resolutions** from
   the Host so delayed requests cannot resurrect an already-resolved approval.
4. Exclude `commands`, `config`, `usage`, and `agent_session` in the browser-specific
   SQL reader, before decoding/validation/serialization. Keep canonical storage
   and the existing raw event route intact.
5. Carry activity identity separately. The existing transcript treats commands,
   config, and agent-session events as activity but not usage. Preserve that
   behavior without retaining their payloads or counting backfill as new output.
   The retention helper has different semantics and is not a drop-in replacement.
6. Stop overview history fan-out. Use bounded known tails and the existing
   `session.lastText` fallback; hydrate approvals independently. An unloaded tile
   may show a shorter fallback until the conversation is opened.
7. Use `WHERE session_id=? AND sequence>? ORDER BY sequence` for attempt-scoped
   readers. Preserve the exact exclusive bound, including
   `Math.max(step.eventSeqFrom, dispatch.eventSeqFrom)` for stopped attempts.
   Keep real full-history consumers unchanged.

The first implementation adds a small partial permission-event index so compact
permission hydration does not scan text/chunk history. Measure that query and
its write/migration overhead rather than assuming metadata is free.

Read-time validation removal is conditional: ingress and imports are validated,
but the fresh-insert branch of `appendEvent` does not itself enforce the outer
schema. Prove/enforce all write paths and supported existing-data invariants
before removing checks. Keep payload validation and explicit malformed-data
errors. Do not replace validation with an unchecked cast.

## Phase 2: virtualize the shared transcript

Use the standard MIT `react-virtuoso` core, keeping Fluent styling and the existing
row renderers. Do not use the deprecated alpha Fluent virtualizer already present
transitively, or build a custom scrolling engine.

Virtualize `TerminalBlock` rows with stable keys and approximately one viewport
of overscan on each side. Keep composer, header, permissions, and overlays outside
the recycled rows. Measure variable heights for Markdown, tables, expansion,
streaming, fonts, and resize; include margins inside measured wrappers.

Preserve bottom-following only while pinned, "Jump to latest", unread counts,
keyboard access, reduced-motion behavior, copies, file downloads, and attachments.
Keep expansion state outside recycled rows. Initially preserve current switching
semantics: a different session opens at its latest output.

Replace prompt-wide DOM scans with visible-range tracking and key/index lookup.
A prompt-rail click must load/scroll to a target even when it is not mounted.
Keep the native Ctrl+F caveat explicit: provide a read-only full-text/export path
for whole-conversation search/copy rather than implying unmounted text is searchable.

Phase 2 and Phase 3 are independent. If browser traces show folding dominates
typing lag, land Phase 3 first.

## Phase 3: immutable incremental blocks and composer isolation

Move the pure projection and the relevant `fleet-wake.ts` parser into the
protocol/shared layer. The Host must not import React/UI files. Share one set of
folding rules between live browser updates and future Host block projection.

Append text by replacing the affected text block; update tools through a
`toolCallId` lookup. An older tool block can change, not only the tail. Never mutate
objects already published to React. The existing `last.text +=` / `previous.* =`
operations are safe only inside a newly allocated whole-history fold.

Keep the whole-history fold as an equivalence reference. Assert unchanged prior
snapshots, new identities for changed blocks, stable identities for untouched
blocks, and correct replay/out-of-order reconciliation.

Batch text updates in short intervals, initially about 33 ms. Flush preceding
text before permissions, errors, or completion so batching cannot reorder meaning.
Account for background-tab throttling.

Isolate the composer from transcript work and cache projections per session.
Use narrow React subscriptions (`useSyncExternalStore` if needed), not a new
application state framework. Measure array-copy/allocation costs as well as renders.

## Phase 4: block pages and bounded caches

Page by blocks, initially about 200 recent blocks with a measured byte budget,
plus older and around-prompt windows. Keep the raw diagnostic API.

Do **not** implement this as `toTerminalBlocks(listEvents(id)).slice(-200)`: it
retains full Host reconstruction on every request. Nor does a raw-event `LIMIT`
return a complete block page.

Maintain a rebuildable, versioned Host projection using Phase 3's reducer.
Persist block snapshots and coverage so restart does not force a synchronous
whole-history reconstruction. Build existing histories in bounded batches that
yield to the event loop; commit coverage with projection changes. Resume interrupted
builds and invalidate incompatible versions on restore/reducer changes. Expose
preparation/errors explicitly, and measure projection write amplification.

Use separate cursor meanings:

- Stable block order (originating sequence/key) for navigation and older pages.
- Synchronization coverage/revision for all changed blocks, including previously
  sent tool rows. A sequence-only high-water mark cannot detect a later fill of an
  older hole; use a reset/invalidation revision and reconcile.

The raw `(session_id, sequence)` index supports replay/backfill, not automatically
block-page queries. Index and verify the derived projection separately.

A rendered snapshot can omit tool identity/merge provenance. Retain sufficient
projector state or deliver authoritative block upserts; do not mix block snapshots
and raw deltas using implicit assumptions. Huge individual blocks need explicit
on-demand full content rather than silent truncation.

Keep prompt metadata and permissions independent of retained pages. Bound browser
and Host caches, including pages, deltas, deduplication indexes, and geometry.
Pin the visible neighborhood/live tail; evict inactive data without deleting
canonical history or drafts.

## Phase 5: verification and rollout

Run targeted data/component tests for each slice and the integrated verification
gate before final release. Include rapid switching, concurrent/aborted fetches,
REST/live races, reconnect, sparse sequences, older-tool changes, permission
resolution outside retained pages, hidden-event activity, and immutable snapshots.
Test stopped-attempt bounds, validation boundaries, projection rebuild/restart,
version changes, restoration, and Host responsiveness under load.

Use a real browser for variable-height geometry, anchoring, focus, scrolling,
accessibility, and paint. jsdom cannot prove these properties.

Ship Phase 1 improvements independently. Use a temporary development comparison
switch for virtualization, not a permanent user setting. Keep new APIs additive
and projections disposable so rollback never rewrites raw events. Fail visibly
with retry; do not silently fall back to unbounded downloads.

## Proposed acceptance budgets

These were set before implementation. The [results](#results) above meet the latency,
payload, and Host-responsiveness budgets on the representative workload. Mounted rows
were checked only through DOM counts (221 elements in the transcript) at that size, not
at 10x, and per-switch heap growth only through one heap reading after the switches.

| Measure | Target |
|---|---|
| Cached switch to painted, usable transcript | P95 below 200 ms |
| Cold recent-history display on a local Host after paging | P95 below 1 second |
| Typing input-to-next-paint while streaming | P95 below 50 ms |
| Additional latency of a lightweight concurrent Host request | Below 100 ms; no history-attributable synchronous task over 50 ms after paging/batching |
| Mounted rows in a representative 1440x900 fixture | At most 150, without meaningful growth from about 5,800 to 58,000 blocks |
| Ordinary streaming update | No full-history fold/sort or rerenders of unchanged historical rows |
| Payload and cache scale | Bounded pages and retained data; no per-switch heap accumulation |
| Correctness | No lost/duplicated output, false approvals, wrong-session updates, or unexpected scroll jumps |

Re-evaluate unrealistic budgets explicitly on the recorded hardware/workload.
Completion is the integrated outcome, not merely adding a virtual list.

## References

- [Benchmark commands and metric definitions](chat-history-benchmarks.md)
- [React Virtuoso core](https://github.com/petyosi/react-virtuoso)
- [Automatic resizing](https://virtuoso.dev/react-virtuoso/virtuoso/auto-resizing/)
- [Index navigation](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-to-index/)
- [Deprecated Fluent virtualizer notice](https://github.com/microsoft/fluentui/blob/master/packages/react-components/deprecated/react-virtualizer/README.md)
