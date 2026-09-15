# Native Copilot RPC migration runbook

**Status:** Implementation plan for a follow-up PR; native RPC is not enabled by
this document.<br>
**Date:** 2026-09-15<br>
**Scope:** Replace the Node's Copilot ACP adapter while preserving Fleet behavior.

## PR boundary and intended outcome

This PR ships the session context controls, the combined model/effort/context
menu, and the usage-ring popover. It keeps ACP as the execution backend. Its
context selector records a **requested** tier; it does not prove that the CLI
applied it. The usage ring reports the CLI's observed window instead.

The next PR implements this runbook. It must make long context an applied,
read-back runtime setting, use structured usage and compaction APIs, and preserve
existing sessions and Fleet features. Do not implement migration, install the
Copilot SDK, change the execution default, or remove ACP in the UI/runbook PR.

RPC means **Remote Procedure Call**. ACP already uses JSON-RPC; the proposed change
is from ACP's generic agent API to Copilot's native runtime API, not from a
non-RPC protocol to RPC. Execution and authentication remain on the owning Node.
No new public endpoint or inbound firewall rule is required.

## Evidence and limits of the investigation

On Copilot CLI **1.0.84-5**, a disposable native-RPC session created with
`contextTier: "long_context"` returned that tier from
`session.model.getCurrent`. Switching the same model to `default` and back to
`long_context` also returned the expected tier. The probe did not prove every
feature, every launcher, or that an oversized prompt would be accepted.

For GPT-6 Astra, the model catalog observed on 2026-09-15 reported:

| Tier | Prompt budget | Output reserve | Full window |
| --- | ---: | ---: | ---: |
| Default | 272,000 | 128,000 | 400,000 |
| Long | 872,000 | 128,000 | 1,000,000 |

These are observations, **not constants to copy into production**. Model limits,
availability, pricing and account entitlements can change.

The ACP path reported a 272k input budget even when launched with
`--context long_context`; `/context` reported the 400k full window. The native
readback for an ACP-created diagnostic conversation had no context tier.
[Copilot CLI issue 4275](https://github.com/github/copilot-cli/issues/4275)
documents missing context-tier plumbing in the ACP bridge. This is not a
fundamental limit of the model or JSON-RPC.

Agency Hub uses a different control path from ACP and reads live model/tier and
usage metadata. Its context toggle restarts the normal CLI with the same session
ID and the new tier. We verified native RPC can also apply a tier directly.
Do not reproduce Agency's private implementation or assume adding a native
control-server flag to `--acp` is supported.

Useful public contracts, reviewed on 2026-09-15:

- [SDK architecture](https://github.com/github/copilot-sdk#architecture)
- [SDK/CLI compatibility](https://github.com/github/copilot-sdk/blob/main/docs/troubleshooting/compatibility.md)
- [Generated native RPC types](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/rpc.ts)
- [Usage and billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
- [Persistence and resume](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md)
- [MCP configuration](https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md)
- [Attachments](https://github.com/github/copilot-sdk/blob/main/docs/features/image-input.md)

Documentation on `main` can describe a newer runtime than a Node has installed.
Some native APIs are experimental. A pinned SDK version, a compatible runtime
version, and measured contracts are required before rollout; **the exact
supported version pair is an implementation gate, not yet selected**.

## Ownership and non-negotiable compatibility

Keep the Host/browser protocol and `SessionAgent`/`AgentFactory` boundary wherever
possible. Translate native calls and events on the Node, rather than leaking SDK
objects into Host storage or React components.

- Keep one execution process per Fleet session initially. Do not combine this
  migration with shared-process pooling or a new scheduler.
- Preserve Fleet session IDs, ordered event sequences, dispatch attempts,
  outbox acknowledgements, and historical transcript rows.
- Preserve the orchestrator's completion contract: an acknowledged send is not a
  completed turn; a completed turn followed by idle is not a process exit.
- Preserve managed-workspace isolation, effective working directories, process
  ownership/quiescence, artifact sealing and integration gates from the latest
  `main`. Do not port only the older pre-worktree adapter.
- Preserve permission policy. Never use blanket approval as an SDK convenience
  unless that individual session's existing YOLO policy permits it.
- Keep node-local credentials, configured CLI selection, and Agency launcher
  selection. Do not silently replace Agency with a bundled stock CLI.
- Do not move an active conversation between backends. Quiesce its old process
  first, preserve pending work, and resume only after a verified handoff.

## Implementation map

Names below are existing integration points, not a requirement to create a large
framework. Reuse helpers and extract only transport-independent contracts.

| Surface | Work in the migration PR |
| --- | --- |
| `apps\node\src\agents.ts` | Retain ACP and mock behavior; extract the small shared agent contract/event helpers if needed. |
| `apps\node\src\copilot-rpc-agent.ts` (proposed) | Implement a native `SessionAgent` using the official Node SDK and verified native RPC methods. |
| `apps\node\src\copilot-launch.ts`, `main.ts`, `settings.ts` | Select the backend and reuse launcher resolution, auth, startup deadlines and runtime reconfiguration. |
| `apps\node\src\router.ts` | Dispatch to the selected adapter; preserve process ownership, working directories, generation fencing and restart sequencing. |
| `apps\node\src\copilot-sessions.ts`, `config-session-routes.ts` | Cover list, preview, adoption, resume and retention deletion, not just new chat creation. |
| `packages\protocol\src\index.ts`, `node-capabilities.ts` | Add optional backend/capability metadata and explicit reported-tier state where required; keep old messages readable. |
| `apps\host\src\fleet-service.ts`, `store.ts`, session routes | Gate native dispatch, persist selection/readback, and preserve backup/recovery behavior. |
| `SessionConfigBar.tsx`, `SessionUsageBar.tsx`, session config helpers | Keep the shipped UI; consume confirmed native options and structured usage without changing its layout. |

### Feature parity checklist

Each row is a release gate, not a promise that SDK defaults match today's CLI.

| Feature | Required proof before switching the default |
| --- | --- |
| Ordinary sessions and Chats | Correct cwd, first prompt exactly once, follow-ups, independent parallel sessions and capacity. |
| Streaming and tool results | Text/thought deltas, tool updates/errors, final `task_complete` output and no duplicated replay. |
| Permissions and YOLO | Allow once, deny, timeout, cancellation and disconnect resolution; no unrequested approval escalation. |
| Questions and plan exits | Preserve current behavior and correctly map native user-input/plan-exit callbacks if enabled; no hidden waiting state. |
| Cancel, Stop and spontaneous work | Busy/idle accuracy, background tool completion, exact process-tree shutdown and no orphaned child. |
| Model, effort, mode and tier | Catalog-driven options, empty-string agent choice, fleet-owned mode restrictions, actual tier readback and failed-change recovery. |
| Orchestrators, workers and reviewers | Custom agent selection, lead-only scoped Fleet MCP, wake delivery, dependencies, retry/review and turn settlement. |
| Managed workspaces | Use router-provided effective cwd; preserve process callbacks, finalization, hooks checks and integration behavior. |
| Attachments | Existing image/text/binary handling, size limits, additional directories and no attachment bytes in Host events. |
| Skills, agents, plugins and MCP | Explicitly preserve config discovery and local/HTTP servers on create and cold resume, including Agency launches. |
| Slash commands | Discover/execute advertised native commands; distinguish local results from intentional agent prompts and unsupported UI-only actions. |
| Existing sessions | Resume ACP-created and native-created conversations without changing Fleet identity or replaying old notifications. |
| Discovery and retention | List/preview/adopt and idempotent deletion with inactivity/favorite/task protection; never edit native journals to delete sessions. |
| Host/Node restart | Outbox replay, reconciliation, auto-resume, MCP restoration and no duplicate initial prompts. |
| Context overflow recovery | Preserve the latest `main` recovery contract; distinguish a new conversation/handoff from successful same-history compaction. |
| UI and stored data | Settings, favorites, rename/dismiss, drafts, notification policy, history and backup/restore remain usable. |

## Execution sequence

### 1. Capture the installed native contract

- [ ] Start from `main` after the UI/runbook PR merges and inventory its current
      `SessionAgent` options and process-ownership callbacks.
- [ ] Select an exact SDK/runtime pair. Verify supported Node versions and the
      Node distribution/update packaging before adding the dependency.
- [ ] Use disposable sessions to record sanitized native responses/events for:
      create/resume, model catalog/current/switch, send/idle, tool execution,
      permission requests, abort, compact, usage, commands and deletion.
- [ ] Repeat launcher checks with configured stock Copilot and Agency. Verify
      the executable, environment, local auth and configuration discovery.
- [ ] Prefer local stdio through the SDK. If a launcher requires a separate
      transport, document and review that boundary before implementing it.

**Gate:** A compatibility table identifies which operations are supported by the
pinned pair. Missing mandatory features block native rollout; a successful
`model.getCurrent` alone does not pass this gate.

### 2. Add native execution without changing defaults

- [ ] Introduce an explicit `acp`/`native` backend selection, separate from
      standard/Agency launcher selection. Keep ACP as the initial default.
- [ ] Persist the backend for each session/activation. Missing fields in old
      records mean ACP. Report requested and effective backend separately if
      compatibility policy can select a different one.
- [ ] Advertise native support only after a successful compatibility check.
      The Host must not dispatch an unrecognized command to an older Node.
- [ ] Implement native create/resume with explicit permissions, cwd, MCP,
      custom agent, model, effort and context tier before the first prompt.
- [ ] Adapt native events into Fleet events with stable sequence numbers.
      Fence late callbacks from retired processes and deduplicate history.
- [ ] Retain startup timeouts and process-tree ownership. Close transports,
      cancel polls and reject pending callbacks on every failure/stop path.

**Gate:** Run a common adapter contract suite against ACP, native and mock.
Native errors must not trigger a silent ACP restart: a turn may already have
executed, and replaying it can duplicate file edits or commands.

### 3. Implement confirmed context, usage and compaction

- [ ] Apply tier at native session creation/resume and preserve it explicitly
      when switching models. Use the pinned SDK's typed API; do not fabricate
      field names or depend on absent fields meaning "keep the old tier."
- [ ] Read back `session.model.getCurrent`. Commit UI selection only after the
      runtime confirms it; distinguish pending, unsupported and failed changes.
- [ ] Use an idle-only live tier switch initially. If the installed runtime
      requires restart, reuse the existing fenced restart flow. Keep other
      sessions and the user's unsent draft untouched.
- [ ] Resolve the selected model's tier-aware prompt budget from
      `billing.tokenPrices.maxPromptTokens` (legacy `contextMax`) or the
      corresponding `longContext` entry, plus its output reserve. Use capability
      fallbacks only when their meaning is verified; never assume all models
      have 1M or add the output reserve twice.
- [ ] Use structured `session.metadata.contextInfo`, passing the resolved
      limits when the pinned runtime requires them. Calculate the full-window
      percentage from one coherent snapshot; show source/time and uncertainty.
      Model changes invalidate the old snapshot.
- [ ] Use `session.usage.getMetrics` for cumulative AI credits. Convert
      `totalNanoAiu / 1e9` once; never sum cumulative snapshots or relabel premium
      requests. Missing billing remains unavailable, not zero.
- [ ] Map Compact to `session.history.compact` and verify its result before
      reporting success. Refresh context/credits afterward, preserve saved
      history and drafts, and do not count metadata reads as model turns.

**Gate:** For a model offering both tiers, confirm the actual tier and resolved
window after create, switch, resume and model change. Compare with the CLI's own
readout. Tier readback/capacity checks are not a large-prompt acceptance test;
any expensive boundary test needs a separately approved test-credit budget.

### 4. Complete commands, recovery and old-session compatibility

- [ ] Inventory today's advertised commands and native command equivalents.
      Use native command discovery/invocation when supported; handle text,
      completed, selection and agent-prompt results deliberately.
- [ ] Never treat an unsupported slash command as ordinary model text just to
      make it appear to work. Show a specific unsupported-action message.
- [ ] Test skills/plugin commands and the workflows currently used for review
      and research; documentation labels and installed behavior may differ.
- [ ] Test cold resume from an ACP-created session. Re-supply runtime-only
      configuration, preserve history and suppress historical activity alerts.
- [ ] Test reconnection while busy, while awaiting permission and after
      disconnect during send. Do not create a second owner of the conversation.
- [ ] Preserve retention barriers and native deletion confirmation, including
      lost acknowledgements and mismatched/late receipts.

**Gate:** Every parity row passes or an explicitly approved scope decision names
the gap. Unverified Agency behavior, missing commands or broken managed-workspace
finalization means ACP remains the default.

### 5. Canary and enable

1. Build/deploy the compatible Node and Host while the default remains ACP.
2. Back up Host data using the existing supported backup flow. Record runtime
   versions and backend selection without credentials or transcript contents.
3. Opt one Node/test session into native. Exercise an ordinary chat, an
   orchestrator with a worker/reviewer, and one old-session resume.
4. Confirm zero duplicate prompts, permission-policy changes, lost transcript
   segments, false task completion, orphaned processes or backend downgrades.
5. Stop the canary, reopen the Host, restart the Node, and repeat resume/usage.
6. Change the default only after the parity checklist and canary evidence are
   reviewed. Existing live sessions remain on their selected backend.
7. Remove ACP-specific polling/parsing only from native execution. Keep the
   ACP adapter and its compatibility paths during the rollback window.

## Verification commands

Run from the repository root on Windows. These commands already exist; new
native contract/integration tests must be included in the normal test discovery.

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test -- --maxWorkers=3
npm run build
```

Start with focused adapter, router, protocol, store, orchestration and composer
tests while developing. Then run the full suite and classify failures against
the same baseline. Do not edit unrelated failing tests to make migration appear
green. Browser-check hover, keyboard, touch, narrow viewports and draft retention.

Real-runtime tests must use disposable sessions/workspaces, never the operator's
active conversation. Use the existing permission policy and approved test-credit
budget; do not enable YOLO, alter global Copilot preferences or delete real
session state merely to simplify validation.

## Rollback and failure handling

- **Before native sends work:** a failed compatibility/startup gate leaves the
  session unstarted with an actionable error. An operator may explicitly select
  ACP if its limitations are acceptable.
- **After native starts work:** stop/quiesce the owning process first. Retain
  transcript, session ID and dispatch receipts. Do not automatically replay the
  last prompt on ACP after a timeout or unknown outcome.
- **Default rollback:** set the backend default back to ACP for future sessions.
  This is an application setting proposed for the migration PR, not a command
  available in this PR. Do not mass-restart live sessions.
- **Individual native session:** resume in ACP only after cross-backend resume
  has passed the compatibility gate and the user accepts tier limitations.
  Otherwise keep it stopped/resumable with its native state preserved.
- **Binary rollback:** additive schemas and optional fields must remain readable
  by the previous release. No destructive schema/journal migration is allowed.
  Restore a Host backup only as a deliberate recovery operation, not as the
  normal way to revert a backend preference.

Log backend, launcher, CLI/SDK versions, Fleet/native session correlation,
requested/reported tier, operation and elapsed time. Do not log auth tokens, MCP
headers, full prompts or attachment bytes. A missing metric must not fail an
otherwise healthy conversation; a failed safety or ownership check must block
execution rather than degrade silently.

## Follow-up PR completion checklist

- [ ] Exact compatible SDK/runtime versions documented and packaged.
- [ ] Both stock and Agency launchers pass their required paths.
- [ ] Full feature-parity matrix and managed-workspace tests pass.
- [ ] Applied long tier is verified, including after model changes and resume.
- [ ] Structured metrics and compaction replace native-path text/file parsing.
- [ ] Existing sessions, backups and mixed-version fleets remain safe.
- [ ] Canary and rollback evidence are attached to the migration PR.
- [ ] README and architecture docs describe the shipped backend and limitations.
- [ ] No claim of universal 1M support or automatic feature parity remains.
