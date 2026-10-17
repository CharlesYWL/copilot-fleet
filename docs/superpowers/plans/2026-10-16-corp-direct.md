# Corp Direct Implementation Plan

> **For agentic workers:** Execute bounded tasks in the approved isolated worktree. Use test-first implementation, review changed code, and verify results before committing.

**Goal:** Add corporate-only private-IP HTTPS/WSS access with generated interactive and login-start enrollment commands.

**Architecture:** A private TLS edge forwards to the existing Host loopback server. A Node-local fixed-upstream TLS helper covers enrollment, API, control socket and agent MCP traffic using persisted public CA trust. Existing Dev Tunnels remains independent and unchanged.

**Tech Stack:** Existing TypeScript, Node HTTP/HTTPS APIs, ws, Zod, Fluent UI v9 and Vitest; native Windows certificate APIs. New code uses Node 18-compatible APIs; verification uses the repository's existing supported runtime and does not change its engine requirement.

## Global Constraints

- All work is in `Q:\Repos\copilot-fleet-worktrees\corp-direct`, branch `feat/corp-direct`, based on private `origin/main` at `02032f4`.
- Default external port is 8787, explicitly bound to a selected private IPv4. Retain the loopback listener and refuse binding conflicts.
- Verified Microsoft corporate tenant plus username is required. Never enable no-auth, public-account or implicit endpoint adoption.
- Keep certificate verification enabled; no global trust-store changes, enrollment-secret persistence, automatic firewall modification, deployment or reboot.

## Task 1: Shared contracts and fixed-upstream HTTP/WSS relay

Files: `packages/protocol/src/corp-direct.ts`, `corp-direct.test.ts`, `http-relay.ts`, `http-relay.test.ts`, package exports, `src/index.ts`.

- [x] Test RFC1918 IPv4 and CIDR containment, URL origin restrictions and configuration limits. Assert `CorpDirectConfigSchema.safeParse({hostIp:'8.8.8.8',port:8787,allowedSources:['10.0.0.0/17']}).success === false`.
- [x] Implement schemas/types and optional wire fields described in the approved spec; add `corp-direct` and `private-network` catalog values without changing defaults.
- [x] Test HTTP request/response streaming, exact upstream Host rewriting, WebSocket upgrade/data/close, trusted TLS, certificate failures, fixed target despite hostile absolute URLs, forwarding-header stripping and deterministic shutdown.
- [x] Implement the shared Node-only relay with request deadlines, socket cleanup and safe generic failure responses.
- [x] Build protocol and run targeted tests before consumers are integrated.

## Task 2: Host certificate lifecycle, provider and policy

Files: `apps/host/src/corp-direct.ts`, certificate helper and tests, `tunnel.ts`, `tunnel-providers.ts`, `tunnel-policy.ts`, `routes/system.ts`, `server.ts`, backup handling and tests.

- [x] Test that only corporate policy and a verified corporate actor can configure or enable the provider; persisted startup rechecks policy.
- [x] Implement persistent CA/leaf generation using native Windows cryptography, address detection, private-IP/source validation, explicit listener binding and peer filtering.
- [x] Integrate a built-in provider lifecycle without spawning a tunnel CLI; expose status/configuration/public CA and a source-scoped firewall setup command.
- [x] Test certificate persistence and renewal, missing/replaced trust failure, listener start/stop, port collision, source refusal, and coexistence with the existing loopback listener on the same port.
- [x] Keep private TLS material out of public routes and unencrypted backup formats; preserve or explicitly and safely disable direct access through portable restore instead of silently rotating trust.

## Task 3: Node connection persistence and Windows service lifecycle

Files: `apps/node/src/corp-direct.ts`, `cli.ts`, `settings.ts`, `main.ts`, `service-enrollment.ts`, service scripts/tests and related restore/restart handling.

- [x] Test decoding/public-CA validation, conflicting flags, persistence, startup using saved connection and deliberate operator mode changes.
- [x] Start the loopback helper before any enrollment HTTP request, rebase runtime endpoints onto it, and retain the canonical remote connection separately.
- [x] Use exclusive local-forward dialing behavior for direct mode so Host announcements cannot bypass trust or strand the Node.
- [x] Cover normal CLI and service install; strip one-use secrets and persist trust outside scheduled-task arguments. Verify later login/service restart does not need the original enrollment grant.
- [x] Test agent MCP requests through the helper, self-update restart behavior, cleanup and backup/restore compatibility.

## Task 4: Fluent UI configuration and generated commands

Files: `apps/host/ui/src/components/TunnelPanel.tsx`, a focused Corp direct card, `ConnectNodeCard.tsx`, `lib/enroll-command.ts`, hooks and tests.

- [x] Show the option only when available to a corporate administrator. Use labeled address, port and allowed-source controls with descriptive error states.
- [x] Persist configuration via the existing authenticated tunnel API. Show the HTTPS endpoint, one-time firewall command and clear certificate/browser caveats.
- [x] Add `corpDirectCa` to generated commands as public base64 PEM; produce both `npm run node -- ...` and `npm run service -- node ...` while retaining existing launch modes for other providers.
- [x] Test command quoting, absence of Dev Tunnels flags/login in direct mode, unchanged public-provider behavior and service instructions.

## Task 5: Verification, documentation and private PR

- [x] Run focused baseline and regression tests, then `npm run lint`, formatting checks, type checks, tests and build. Distinguish pre-existing/environment failures from introduced failures and do not claim tests passed without output.
- [x] Review security boundaries, secrets, policy revocation, forwarding origin guards, restore behavior, lingering listeners and task persistence. Fix findings and rerun affected checks.
- [x] Document setup, firewall privileges, interactive vs login startup, IP changes and certificate renewal; provide a real Host/Node manual checklist in the PR.
- [x] Commit only feature files, push `feat/corp-direct` to private `origin`, and create a PR against `main` in `charlesyin_microsoft/copilot-fleet`. Do not push to public upstream, merge, or deploy. Delivered as private draft [PR #91](https://github.com/charlesyin_microsoft/copilot-fleet/pull/91); deployment and manual rollout remain pending by design.

## Validation record

- Verified on Windows with Node.js 22.22.3 (the repository's existing supported runtime). No engine requirement or dependency was changed.
- Final consolidated Corp direct acceptance/regression run: **272 tests passed in 21 files**. This includes native Windows CA issuance and renewal, real private-interface HTTPS/WSS with the same loopback port, grant enrollment, authenticated Node control, MCP forwarding, service persistence, source/origin/certificate refusals and existing-provider regressions.
- `npm run lint`, `npm run typecheck`, `npm run build`, changed-file Prettier checks and `git diff --check` passed. Full-repository formatting has two pre-existing failures in `apps/host/ui/src/App.tsx` and `apps/host/src/gateway/node-socket.ts`, reproduced on unchanged base `02032f4`; their formatting-only changes were removed to keep this feature scoped.
- The complete regression run finished: **6,016 passed, 7 failed, 5 skipped**. It is not reported as green. Baseline checks reproduced the Hermes error-message assertion, the missing Windows `TMPDIR` assumption, and two Windows supervisor start-expiry/restriction failures. The temporary-directory test passed with `TMPDIR` set to the existing Windows temp directory. The command-permission end-to-end and silent-job timeout failures passed on isolated reruns. The remote-access notification test had a baseline effect-timing race; the touched test now waits for its notification and passed in the final 272-test run.
- Direct code review found and fixed post-start listener retry and request-relative redirect handling; both fixes were demonstrated with failing-then-passing tests. Two independent background review attempts could not return results because their connections stalled; no independent-review success is claimed.
- Production deployment, firewall changes, service reconfiguration, reboot, actual two-box agent sessions, cross-region access and long-duration stability remain the explicit manual rollout checks in `docs/corp-direct.md`.
