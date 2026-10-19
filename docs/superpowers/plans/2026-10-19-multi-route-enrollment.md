# Mixed Connection Enrollment Implementation Plan

> **For agentic workers:** Execute this approved plan inline in the existing isolated worktree. Use test-first changes and verify results before publishing.

**Goal:** Let each worker choose an enabled remote-access provider without changing the Host default, show the last successful Node connection route, and warn that cross-region private access is not guaranteed.

**Architecture:** Reuse `TunnelSupervisor`'s parallel provider managers. Add provider-specific enrollment options and grant selection. Report connection metadata only in authenticated Node inventory, normalize it against active Host endpoints, and attach it to the existing runtime Node telemetry alongside health. Preserve existing tunnel policy, trust, reconnect and announcement behavior.

**Tech Stack:** Existing TypeScript, Zod, Node HTTP/WebSocket APIs, React, Fluent UI v9 and Vitest. No dependencies or runtime-requirement changes.

## Global constraints

- User approved the design in chat on 2026-10-19.
- Work only in `Q:\Repos\copilot-fleet-worktrees\corp-direct`, branch `feat/multi-route-enrollment`, based on private `origin/main` at `c40de01`.
- Keep the running Host checkout, fleet database, services, firewall and endpoint-security monitoring unchanged.
- Microsoft corporate policy permits only the existing corporate providers. Other accounts retain their current permitted HTTPS providers; plain-HTTP/public-policy refusals stay enforced.
- Generate a fresh one-use grant on demand per provider card, never during polling. Foreground/service variants on one card share that one grant.
- A grant for a public/Dev Tunnels route must not include Corp direct trust; a Corp direct grant must not include a Dev Tunnels ID.
- Route metadata is informational, not authentication or a new source of trusted Host URLs. Validate it and accept it only after Node authentication.
- Missing route reports remain backward compatible. Infer a provider from an exact known ingress hostname only when possible; otherwise display Unknown. Preserve last-known telemetry while offline, clear it on identity replacement, and refresh on successful reconnect.
- Region warning: cross-region private-IP access is not guaranteed in the configured networks. Our failed West US 3/West US 2 pair does not establish a platform-wide prohibition.
- Deliver a new private PR; do not merge or deploy it. The separate email deliverable is an unsent HTML draft to the verified original recipients; the protected original thread is not decrypted or copied.

## Task 1: Provider-specific enrollment

**Files:** `packages/protocol/src/index.ts`, `apps/host/src/tunnel.ts`, `apps/host/src/routes/system.ts`, `apps/host/ui/src/hooks/useEnrollment.ts`, `apps/host/ui/src/components/ConnectNodeCard.tsx`, and focused tests.

- [x] Add shared `EnrollmentConnectionOptionSchema` with `provider`, `label`, `hostUrl`, optional `tunnelId` and public `corpDirectCa`; retain existing single-command response fields.
- [x] Expose live per-provider URL/ID pairs through `TunnelSupervisor.enrollmentEndpoints()` without probing or starting another provider.
- [x] Return enabled, eligible connection options from `/api/enrollment`; use the configured fallback only when no eligible provider is active.
- [x] Validate optional `{provider}` in `/api/enrollment-grants`, choose the requested live/authorized endpoint before minting, and preserve the no-body default behavior. Refuse unavailable/forbidden selections without issuing a grant.
- [x] Extract per-option command-card state so each card independently generates and copies foreground/service commands. Keep older Host responses and custom fallback URLs working; reset card state when its endpoint/trust changes.
- [x] Test concurrent Corp direct/Dev Tunnels and public-provider choices, distinct URLs/flags, policy restrictions, unchanged default selection and on-demand grants.

## Task 2: Authenticated route telemetry and Node column

**Files:** `packages/protocol/src/index.ts`, `apps/node/src/main.ts`, `apps/host/src/node-connection.ts`, `apps/host/src/gateway/node-socket.ts`, `apps/host/src/fleet-service.ts`, `apps/host/src/server.ts`, `apps/host/ui/src/components/NodesPanel.tsx`, and focused tests.

- [x] Move the existing provider enum before Node schemas and share provider display labels. Add optional `NodeConnectionSchema` metadata (`provider`, optional safe origin) to Node inventory and Fleet Node snapshots.
- [x] Report Corp direct's canonical private origin, Dev Tunnels' transport kind rather than its ephemeral loopback port, and the actual dial origin for ordinary direct/public routes.
- [x] Resolve generic direct origins against currently active provider endpoints. For older Nodes, use exact known request Host matches where available; never guess from a loopback address or use these claims for authorization.
- [x] Store route information in the existing service's runtime telemetry, refresh it on authenticated attachment, retain last known while offline and clear on eviction/restore. No database schema migration or credential change is required.
- [x] Add an accessible Connection table column with shared labels and endpoint hints; distinguish Unknown and last-known offline values.
- [x] Add the qualified regional warning to Corp direct setup/enrollment and document mixed-provider startup.
- [x] Test private, Dev Tunnels, public, local/direct and old-Node cases, plus reconnect, offline, eviction/restore and UI rendering.

## Task 3: Verification and publication

- [x] Build shared packages, run affected service/UI/protocol regressions, then lint, type checks, changed-file Prettier and production builds.
- [x] Review trust/eligibility boundaries, one-use grant handling, stale endpoint resets, telemetry accuracy, compatibility and live-data isolation.
- [x] Record fresh test results and pre-existing failures accurately. The previous full-suite baseline issues remain documented; do not imply a fresh full-suite pass without running one.
- [x] Commit only feature files, push `feat/multi-route-enrollment` to private `origin`, and open a PR against `main` in `charlesyin_microsoft/copilot-fleet`. Delivered as [PR #92](https://github.com/charlesyin_microsoft/copilot-fleet/pull/92); the small MCP test timing correction is isolated in its own commit.

## Validation record

- Final affected run: **598 tests passed across 31 files**, including mixed-provider grants/commands, policy refusals, authoritative endpoint selection, endpoint rotation, authenticated inventory, route labels, reconnect/offline/eviction, and existing private HTTPS/WSS and service behavior.
- The first complete UI run passed **1,372 tests in 101 files**. After an additional provider-flag regression was added, the final UI sweep passed **1,372 with one failure** in the unchanged Host MCP dialog test. That test queried the trigger before asynchronous modal accessibility cleanup completed; its assertion now awaits the accessible trigger. Its isolated nine-test file passed after the test-only correction. The MCP production component was not changed.
- `npm run lint`, `npm run typecheck` and `npm run build` passed. Changed-file Prettier and `git diff --check` passed. Full-repository formatting still identifies the pre-existing, unchanged `apps/host/ui/src/App.tsx` issue; unrelated source formatting was left alone.
- New behavior was observed failing before implementation and passing afterward. Review also added an explicit provider hint to generated command metadata so Dev Tunnels commands do not depend solely on recognizing a URL hostname, and cannot print an incomplete explicit tunnel-ID command.
- The entire OS-process-heavy suite was not rerun; previous baseline failures are documented in the preceding Corp direct work. No new full-repository pass is claimed.
- Validation used only isolated/memory test data and temporary listeners. The live Host checkout, database, services, firewall, credentials and endpoint-security monitoring were not changed by this feature implementation.
