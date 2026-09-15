---
filepath: "docs/superpowers/specs/2026-09-15-host-refresh-persistence.md"
tags:
  - copilot-fleet
  - browser-state
  - refresh-continuity
---

# Host refresh persistence

**Area**: Host web app<br>
**Engineer**: Not assigned<br>
**EM owner**: Not assigned<br>
**Architect**: Not assigned<br>
**Program Manager**: Not assigned<br>
**Status**: Proposed for review; design only, not implemented<br>
**Source baseline**: `dfbfbe063b8ba707c9034ccd881b5c5d824e81e1`<br>
**Scope**: Independent of inline GitHub re-authentication.

## Related documents

| Document | Reference |
| --- | --- |
| Feature Lifecycle Process | Review this proposal before implementation; no Fabric deployment process applies. |
| PM Functional spec | Operator request: preserve context and reduce empty/loading screens on refresh. |
| UX Design | The storage and restore contracts below; no visual redesign. |
| Current UI ownership | [App](../../../apps/host/ui/src/App.tsx), [useFleet](../../../apps/host/ui/src/hooks/useFleet.ts), [useStickyFlag](../../../apps/host/ui/src/hooks/useStickyFlag.ts) |
| Authentication boundary | [AuthGate](../../../apps/host/ui/src/components/AuthGate.tsx), [auth client](../../../apps/host/ui/src/lib/auth.ts), [auth routes](../../../apps/host/src/routes/auth.ts), [operator sessions](../../../apps/host/src/auth/sessions.ts) |

## Feature desired outcome

After the Host validates the existing browser login, refresh restores the previous
page, selection, layout, and unsent prompt text without waiting for fleet responses.
A separate metadata-cache step reduces empty list/overview rendering while current
data loads. Authentication checks and background refetches remain mandatory.

This app uses React hooks, not Redux. `App` owns navigation/drafts; `useFleet` starts
with empty data and hydrates through REST/WebSocket. Some boolean preferences
already survive refresh. Extend these patterns, not the state-management stack.

**Acceptance**: with fleet responses delayed by two seconds, restored context is
visible before those responses resolve. Fresh data reconciles without resetting
valid selections or drafts. No cached record enables an action or generates an alert.
This is a proposed deterministic evaluation, not a measured performance result.

## Terminologies <!-- optional -->

**Restored** means loaded from browser storage. **Fresh** means reconciled with the
current authenticated Host response. Restored data never becomes authoritative by
age, by opening a socket, or by being deserialized successfully.

## Design options considered

| Option | Trade-off | Decision |
| --- | --- | --- |
| Memory only | Simplest, but loses context on refresh | Keep for transient state |
| Cookies or server sessions for UI data | Request overhead and unnecessary server ownership of per-tab choices | Keep cookies for authentication only |
| Selective Web Storage | Native, bounded, compatible with existing hooks | Preferred |
| Whole-store persistence/new library | Persists opaque or sensitive state and adds migration/reconciliation work | Not needed |

## Preferred option

### Storage contract

| State | Storage and retention |
| --- | --- |
| Harmless layout preferences | Existing origin-local `localStorage` flags; add view-mode preferences as needed |
| Navigation | Scoped `sessionStorage`: page, selected session/run, settings tab, filter, and return context |
| Drafts | Scoped `sessionStorage`: per-session prompt text and attachment names/count for a reattachment notice; no file bytes |
| Fleet metadata, later step | Scoped `sessionStorage`: allowlisted IDs, display labels, states, relationships, and timestamps needed for lists/overview; five-minute maximum age |
| Never persist | Auth/CSRF tokens, grants, keys, full transcripts, run prompts/notes, attachment payloads, approval requests, queued commands, loading/connection flags, or notification-delivery state |

New structured records carry `version`, `scope`, `savedAt`, and validated `data`.
Proposed serialized UTF-16 budgets are 32 KiB for navigation, 256 KiB for drafts,
and 1 MiB for metadata, stored separately. Metadata is optional and cannot evict
drafts. Oversized drafts stay in memory with a warning, never silently truncated.
Metadata over budget is not cached. Drafts have no time-based eviction; remove
them after successful send, authoritative session deletion, or scope invalidation.
Drafts intentionally do not survive logout or replacement of an expired login.
Browser-managed session storage is not a durable backup and may be restored with
tabs or evicted by the browser.

Coalesce writes at 250 ms and flush pending text/navigation on `pagehide` and
visibility loss. Do not depend solely on unload. On corruption, incompatible
versions, blocked storage, or quota failure, keep the live app usable and show one
actionable persistence warning. Missing/expired optional metadata simply refetches.
Restored attachments are not sendable chips: require reattachment or explicit
acknowledgement to send text without the previous files.

### Identity and restore order

1. Keep `AuthGate` closed until a fresh `/api/auth/status` response authorizes the
   operator. Do not render private cached labels or drafts behind a logged-out gate.
2. Add optional `cacheScope` to `AuthStatusSchema` and the authenticated status
   response. Derive a domain-separated HMAC using the existing persisted auth key,
   Host ID, stable principal ID, and active session `tokenHash`; return only the
   digest, never the token/hash/key inputs. This stays stable across refresh and
   Host restart for the same operator session, but changes on a new login or auth
   key rotation. Display names are not identifiers. The scope is not a credential
   and is never accepted to authorize requests. Missing scope
   on an older Host means no scoped persistence; harmless preferences still work.
3. Pass the verified scope into `App`. Restore navigation/drafts in initializers
   before default-selection effects; initialize an optional metadata cache once.
   Schema-validate an allowlisted display model, not an entire serialized `Snapshot`.
4. Mark cached content "Refreshing"; keep live connectivity false until established.
   Block actions dependent on fleet data until a fresh snapshot; approvals and
   notifications also require fresh event data. The server always authorizes writes.
   Hydration silently seeds alert baselines; only subsequent live updates can notify.
5. Retain REST/WebSocket reconciliation and request tickets. Fetch independent
   snapshot/run data concurrently; deduplicate in-flight transcript loads. Network
   results supersede the initial cache, never the reverse. Full transcripts still
   load from the Host, so this is not an offline console.
6. Only after authoritative hydration, validate selections and prune deleted
   sessions' drafts. Today, the initial empty snapshot would prune restored drafts,
   and the missing-run effect would redirect a restored task before its data loads.

On logout, 401, account/Host change, or security reset, clear the relevant scoped
records and in-memory state. Broadcast invalidation to other tabs using native
`BroadcastChannel`, without synchronizing their drafts or navigation. If unavailable,
other tabs invalidate on their next auth check; recheck on visibility regain before
revealing scoped content. Guard asynchronous completions with the active scope/load
generation so late responses cannot repopulate cleared data. Remove obsolete scopes
when a new verified scope is mounted.

Web Storage is readable by same-origin scripts and the browser profile; this design
does not protect data from XSS or someone controlling that profile. Limit content,
retain the existing authentication boundary, and never store credentials.

### Premortem analysis

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Initial empty state destroys restored context | H | M | Defer pruning/redirects until authoritative hydration |
| Old-account data returns after logout | M | H | Verified scope, invalidation, asynchronous generation guards |
| Cached state appears live or replays alerts | M | H | Separate freshness; never restore approval/delivery state |
| Storage limits silently lose work | M | H | Independent budgets, no draft truncation, explicit warning |

### Prototypes <!-- optional -->

| Prototype no | Evaluation description | References | Learnings |
| --- | --- | --- | --- |
| N/A | No runtime prototype in this PR | Source baseline above | Limits and UX remain proposed |

## Tracking open questions

| Open question no | Open issue description | Findings and references | Resolution reached |
| --- | --- | --- | --- |
| 1 | Approve text-only drafts, bounds, and five-minute metadata age | Storage contract above | Proposed defaults for review; attachment persistence is out of scope |

<details>
<summary>Implementation and review checklist</summary>

# Common core checklist

- **Quality(verification)**: Cover delayed responses, StrictMode/remounts, deleted
  selections, failed sends, attachment notices, expiry/version errors, quota denial,
  account switches, cross-tab logout, and late network results. Assert zero
  replayed alerts and zero cached-state command enablement.
- **External dependencies**: Existing React/Zod plus browser storage APIs; no package.
- **Supportability**: Clear persistence warnings; never log draft/cache contents.
- **Performance**: Verify the budgets and delayed-response criterion above; avoid
  serializing on every streamed event. No new telemetry service.
- **Fundamentals**: Authentication, privacy, and accessible status notices apply;
  Fabric-specific compliance/release gates do not.
- **Execution Plan**: First deliver scope/invalidation, navigation/preferences, and
  text drafts. Then independently deliver optional metadata caching and background
  refresh. Rollback ignores/removes only versioned Fleet keys; never clear all
  origin storage. No runtime work is included in this design PR.
- **Engineering Wiki updates**: Document persisted fields, limits, attachment
  behavior, and cleanup in the repository README when implemented.

# Backend (workload) checklist <!-- optional -->

- **State/Metadata**: Only add the authenticated cache namespace and protocol field;
  retain existing Host ownership of all fleet data.
- **Config options and resource consumption**: Fixed proposed browser bounds above;
  no new server session store or configuration knobs.
- **MWC DMS workload - Coding Best Practices / Warehouse MWC workloads - Integration**:
  Not applicable; this is not a Fabric workload.
- **Public/Other APIs / MWC Error handling**: The optional status field is additive;
  existing authentication and error contracts remain authoritative.

# Frontend (UX) checklist <!-- optional -->

- **Integration with Fabric Platform / Impact on external Fabric UX artifacts/extensions**:
  Not applicable; standalone Fleet UI.
- **Corner cases / Error-handling**: Hydration, invalidation, and storage failures
  follow the contracts above; cached read-only content never hides refresh failures.
- **UX extension telemetry**: No content-bearing telemetry; existing notifications suffice.
- **Config options and resource consumption**: Per-record budgets and bounded write cadence.
- **Fabric UX Feature Switches**: Not applicable; ship the two UI steps independently.
- **Accessibility**: Announce refreshing/storage-failure states without stealing
  focus; attachment notices and disabled actions must explain their reason.

</details>
