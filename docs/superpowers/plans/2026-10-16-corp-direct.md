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

- [ ] Test RFC1918 IPv4 and CIDR containment, URL origin restrictions and configuration limits. Assert `CorpDirectConfigSchema.safeParse({hostIp:'8.8.8.8',port:8787,allowedSources:['10.0.0.0/17']}).success === false`.
- [ ] Implement schemas/types and optional wire fields described in the approved spec; add `corp-direct` and `private-network` catalog values without changing defaults.
- [ ] Test HTTP request/response streaming, exact upstream Host rewriting, WebSocket upgrade/data/close, trusted TLS, certificate failures, fixed target despite hostile absolute URLs, forwarding-header stripping and deterministic shutdown.
- [ ] Implement the shared Node-only relay with request deadlines, socket cleanup and safe generic failure responses.
- [ ] Build protocol and run targeted tests before consumers are integrated.

## Task 2: Host certificate lifecycle, provider and policy

Files: `apps/host/src/corp-direct.ts`, certificate helper and tests, `tunnel.ts`, `tunnel-providers.ts`, `tunnel-policy.ts`, `routes/system.ts`, `server.ts`, backup handling and tests.

- [ ] Test that only corporate policy and a verified corporate actor can configure or enable the provider; persisted startup rechecks policy.
- [ ] Implement persistent CA/leaf generation using native Windows cryptography, address detection, private-IP/source validation, explicit listener binding and peer filtering.
- [ ] Integrate a built-in provider lifecycle without spawning a tunnel CLI; expose status/configuration/public CA and a source-scoped firewall setup command.
- [ ] Test certificate persistence and renewal, missing/replaced trust failure, listener start/stop, port collision, source refusal, and coexistence with the existing loopback listener on the same port.
- [ ] Keep private TLS material out of public routes and unencrypted backup formats; preserve or explicitly and safely disable direct access through portable restore instead of silently rotating trust.

## Task 3: Node connection persistence and Windows service lifecycle

Files: `apps/node/src/corp-direct.ts`, `cli.ts`, `settings.ts`, `main.ts`, `service-enrollment.ts`, service scripts/tests and related restore/restart handling.

- [ ] Test decoding/public-CA validation, conflicting flags, persistence, startup using saved connection and deliberate operator mode changes.
- [ ] Start the loopback helper before any enrollment HTTP request, rebase runtime endpoints onto it, and retain the canonical remote connection separately.
- [ ] Use exclusive local-forward dialing behavior for direct mode so Host announcements cannot bypass trust or strand the Node.
- [ ] Cover normal CLI and service install; strip one-use secrets and persist trust outside scheduled-task arguments. Verify later login/service restart does not need the original enrollment grant.
- [ ] Test agent MCP requests through the helper, self-update restart behavior, cleanup and backup/restore compatibility.

## Task 4: Fluent UI configuration and generated commands

Files: `apps/host/ui/src/components/TunnelPanel.tsx`, a focused Corp direct card, `ConnectNodeCard.tsx`, `lib/enroll-command.ts`, hooks and tests.

- [ ] Show the option only when available to a corporate administrator. Use labeled address, port and allowed-source controls with descriptive error states.
- [ ] Persist configuration via the existing authenticated tunnel API. Show the HTTPS endpoint, one-time firewall command and clear certificate/browser caveats.
- [ ] Add `corpDirectCa` to generated commands as public base64 PEM; produce both `npm run node -- ...` and `npm run service -- node ...` while retaining existing launch modes for other providers.
- [ ] Test command quoting, absence of Dev Tunnels flags/login in direct mode, unchanged public-provider behavior and service instructions.

## Task 5: Verification, documentation and private PR

- [ ] Run focused baseline and regression tests, then `npm run lint`, formatting checks, type checks, tests and build. Distinguish pre-existing/environment failures from introduced failures and do not claim tests passed without output.
- [ ] Review security boundaries, secrets, policy revocation, forwarding origin guards, restore behavior, lingering listeners and task persistence. Fix findings and rerun affected checks.
- [ ] Document setup, firewall privileges, interactive vs login startup, IP changes and certificate renewal; provide a real Host/Node manual checklist in the PR.
- [ ] Commit only feature files, push `feat/corp-direct` to private `origin`, and create a PR against `main` in `charlesyin_microsoft/copilot-fleet`. Do not push to public upstream, merge, or deploy.
