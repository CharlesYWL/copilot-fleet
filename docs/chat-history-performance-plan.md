# Chat history performance plan

Source baseline: `b88e238`. Revised September 30, 2026 after reviewing the supplied
measurement scripts and the actual history-loading paths, then updated with the
implementation in this PR.

## Status of this PR

This PR implements Phases 0 to 4 and most of Phase 5: real-browser tests, a 10x
workload run, and the fixes those found. What is left is listed under
[Not done](#not-done).

| Phase | Implemented |
|---|---|
| 0 | `npm run benchmark:history` (Node stages, isolated HTTP route, event-loop probe) and `npm run benchmark:browser` (production build in headless Edge). See [the benchmark guide](chat-history-benchmarks.md). |
| 1 | One deduplicated transcript load per session; ordered live append; per-session permission ledger; bookkeeping events excluded in SQL; no overview history backfill; indexed `listEventsAfter` for the three attempt-scoped readers. |
| 2 | `TerminalView` renders blocks through `react-virtuoso` with stable keys. Expansion state lives outside rows; bottom pinning, "Jump to latest", unread counts, and the prompt rail work from the visible range. A prompt jump loads older pages until its block is present, then scrolls to it. |
| 3 | `TranscriptProjector` in `@fleet/protocol` folds one event at a time and reports at most one change: an append to a block's text or a replacement block. Published blocks are never mutated. `toTerminalBlocks` delegates to it, so live and whole-history folds share one set of rules. The browser batches live messages every 32 ms in arrival order. |
| 4 | The Host keeps an in-memory projection per session (`TranscriptProjections`) and serves `/api/sessions/:id/transcript` as pages of 200 blocks with a `before` cursor. Each stored event advances the projection and carries its change on the live `event` message, stamped with a generation and revision. The browser keeps a per-session copy (`TranscriptCache`), applies changes in order, and refetches when it sees a gap or reset. |
| 5 | `npm run test:e2e` drives the built UI in headless Edge against a real Host and a fake Node (8 scenarios below). Both benchmarks were run at 1x and 10x. |

Deliberate differences from the plan below:

- The Host projection is not persisted. The first open after a Host start rebuilds
  it from `listTranscriptRows` in batches of 2,000 rows that yield to the event loop.
  It restarts if an event lands behind its cursor. That costs about 0.4 s at 1x and
  5 s at 10x, once per session per Host start, and other requests stay responsive.
- A page checks that no event write went around the projection by comparing an
  in-process write counter in `FleetStore` (`eventWrites`), in constant time.
  Writes from another process are not detected; the Host owns its database.
- The projection reader skips the outer `SessionEventSchema` check, because its
  output is display-only and payloads are still parsed. Canonical readers such as
  `listEvents` keep the full validation.
- Snapshots read permissions from a ledger the service keeps advancing, and read
  the store again only after a write that went around the service.
- There is no around-prompt page. A prompt jump loads every page between, up to
  10,000 blocks per request.
- A page never leaves less than a quarter of a page above it; that remainder
  comes with it (see the paging fix below).
- Caches are bounded: the Host keeps projections up to about 128 MiB (least
  recently used first); the browser keeps up to six sessions and trims inactive
  ones to their last 200 blocks.

Raw events remain authoritative. Existing full-history APIs, agent context,
orchestration semantics, and retention policy are unchanged. The projection is
disposable: a restore clears it, and a restart rebuilds it.

### What the browser tests and the 10x run found

| Found by | Problem | Fix |
|---|---|---|
| 10x Host run | Each page counted the session's events (`COUNT(*)`) to detect missed writes: 210 ms P95 per page at 1.12 million events, blocking the Host | Per-session write counter in the store; a page costs 0.02 ms |
| 10x Host run | Every snapshot (each browser load and reconnect) reread every permission event: 417 ms at 10x | Ledger kept in the service, read from the store once |
| Browser tests | Jumping to a prompt on an unloaded page from the newest output landed tens of thousands of pixels away, with the prompt not rendered | Scroll two frames after the page arrives, once Virtuoso has corrected for the prepended rows |
| Browser tests | Prepending the last few rows of a history shifted the view by 258 px, uncorrected | The Host includes a remainder of under a quarter page with the page below it |
| Review for 10x | A jump further back than one 10,000-block request stopped after the first page | Each arriving page asks for the next until the prompt is loaded |

The three browser-facing fixes each have a test that fails without them. The
Host fixes are shown by the benchmark figures below; the ledger's test also
checks that snapshots stop rereading the store.

### Results

Representative synthetic workload: 112,000 lead events (5,600 blocks), 312,000
events across 26 sessions. The 10x workload has 1,120,000 lead events (56,000
blocks) and 3,120,000 in total. Windows, Node 22.22.3, AMD EPYC 7763 (16 vCPUs),
headless Microsoft Edge at 1440x900. "Before" is `b88e238`. The JSON reports
live under `dist\benchmarks`; regenerate them with the commands in the
[benchmark guide](chat-history-benchmarks.md) rather than treating these as
portable thresholds.

Browser (production build; 10 iterations at 1x, 5 at 10x; "cold" is the first
open after a Host start, a single sample):

| Measure | Before, 1x | After, 1x | After, 10x |
|---|---:|---:|---:|
| Open the long conversation, cold | 5,341.7 ms | 572.1 ms | 4,243.8 ms |
| Switch back to it, median / P95 | 4,346.5 / 5,484.0 ms | 147.1 / 148.8 ms | 161.3 / 178.0 ms |
| Switch to a short conversation, median / P95 | 1,035.1 / 1,405.7 ms | 147.7 / 161.5 ms | 161.6 / 165.0 ms |
| Key press to next paint while streaming, median / P95 | 1,409.1 / 2,723.2 ms | 12.2 / 18.2 ms | 12.0 / 18.5 ms |
| Frame gap while streaming, P95 | 1,733.2 ms | 16.8 ms | 16.7 ms |
| Long-task time while streaming 200 chunks | 6,928.0 ms | 0.0 ms | 0.0 ms |
| Last chunk to paint (one sample) | 2,197.8 ms | 43.9 ms | 16.9 ms |
| DOM elements with the long conversation open | 52,186 | 933 | 933 |
| Elements inside the transcript | 51,474 | 221 | 221 |
| JS heap | 89.5 MiB | 21.0 MiB | 25.3 MiB |

Host and data path (1x: 5 warm-up and 30 measured iterations; 10x: 2 and 10):

| Measure | Before, 1x | After, 1x | After, 10x |
|---|---:|---:|---:|
| History response, warm, P95 | 1,282.31 ms | 4.12 ms | 15.58 ms |
| History response, projection rebuilt each request, median | n/a | 408.30 ms | 4,528.11 ms |
| Lightweight request during a history response, P95 | 1,263.26 ms | 3.89 ms | 12.92 ms |
| The same, during a rebuild, P95 | n/a | 17.67 ms | 34.88 ms |
| Host event-loop delay, maximum | 1,313.87 ms | 18.83 ms | 18.04 ms |
| The same, during rebuilds | n/a | 26.18 ms | 50.17 ms |
| History response size | 28,211,687 bytes | 164,922 bytes | 844,004 bytes |
| Browser work per streamed text event, P95 | 59.36 ms (merge and full refold) | 0.01 ms | 0.03 ms |
| Host work per streamed text event, P95 | n/a | 0.01 ms | 0.11 ms |
| Permissions for a snapshot, P95 | n/a | 34.33 ms first, then 0.03 ms | 417.18 ms first, then cached (not measured) |
| Attempt-scoped suffix read (last 10%), P95 | 841.79 ms (read all, then filter) | 85.93 ms | 979.07 ms |
| Projection retained for the long conversation | n/a | 4.9 MB | 47.8 MB |

Before this PR, the 10x workload's history response would have been about 283 MB
of raw events. Before the fixes above, this PR's own 10x warm response was
199.81 ms P95, with a 200.93 ms Host stall. Rebuild timings at 10x varied run to
run (median 4.5 s, P95 7.8 s); other requests stay responsive throughout.

The latency, payload, and Host-responsiveness budgets in
[Proposed acceptance budgets](#proposed-acceptance-budgets) are met at 1x. At 10x,
the cold open takes 4.2 s, over the 1 s budget, and one rebuild pause reached
50 ms; everything else is within budget. Mounted rows did not grow from 5,600 to
56,000 blocks. These are synthetic, single-machine figures; confirm specific
findings with a trace on the live Host.

### Browser tests

`npm run test:e2e` (`scripts/e2e/transcript.e2e.ts`) builds the workspace and
runs the built Host on a disposable database with 12,000 lead events (602
blocks, three pages). A fake Node sends live events through the real gateway.
Each test opens a fresh page in headless Edge:

1. Opening a long conversation lands on its newest line with fewer than 60 rows mounted.
2. Scrolling up loads each older page with the row being read held in place, down to the first prompt.
3. New output is followed only while pinned. Scrolled up, the view holds still and "Jump to latest" shows the new count.
4. Prompt jumps reach a middle, the first, and the newest prompt, loading pages as needed.
5. An expanded thought stays expanded after it scrolls out of the list and back.
6. Typing in the composer keeps focus and every keystroke while output streams. The transcript scrolls by keyboard.
7. After a lost connection, output stored meanwhile appears once, and live output resumes.
8. Rapid switching, with the long conversation's pages delayed, ends on the chosen conversation only.

All eight pass, in three consecutive runs after the last change.

### Verification status for review

- Lint, formatting, all workspace typechecks (including benchmarks and browser
  tests), and production builds pass.
- `npm run test:e2e`: 8 of 8 pass, in three consecutive runs after the last
  change.
- A serial run of every unit and integration test file except the two native-Git
  suites: 272 of 273 files pass. The failure was a 5-second timeout in
  `ManagedWorktreePanel.test.tsx`, which this PR does not change. It then timed
  out in 2 of 5 runs of that file alone while the machine was busy, and passed in
  8 of 8 runs on both this branch and `main` afterwards.
- `routes/notifications.test.ts` used to fail from 2026-10-01 on, because its
  fixture's fixed dates aged past the 30-day notification retention. Its dates are
  now relative to the current time.
- `apps/node/src/managed-worktrees.test.ts` and
  `scripts/managed-worktrees.integration.test.js` were not rerun. On this machine
  the first stalled and the second failed in every earlier run, the second also
  on untouched `main`. This PR does not change them or anything they exercise.

### Not done

- Whole-conversation search or export. Native Ctrl+F only finds rows that are
  mounted.
- A persisted projection. The 10x cold open spends about 4 s rebuilding it once
  per Host start.
- Around-prompt pages. Jumping to the first prompt of a 56,000-block conversation
  loads all of it into the browser.
- The newest page carries every prompt mark, so its size grows with the number
  of prompts: 165 KB at 1x, 844 KB at 10x.
- A deleted session's projection is released only by the LRU bound.
- A DevTools trace on the live Host, and a temporary switch to compare old and new
  rendering during rollout.

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

These were set before implementation. The [results](#results) above meet them at
1x; at 10x, the cold open (4.2 s) and one rebuild pause (50 ms) exceed them.
Mounted rows were checked through DOM counts (221 transcript elements at both 1x
and 10x), and per-switch heap growth only through one heap reading after the
switches.

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
