# Tunnel Plugin Decoupling Implementation Plan

**Date:** 2026-08-20
**Status:** Proposed (revised after contract review)

**Goal:** Separate tunnel-provider behavior from Fleet's Host and Node cores while
preserving the current tunnel lifecycle, enrollment UX, reconnect behavior, and
provider-specific safety rules.

**Architecture:** Use a compile-time plugin registry with one shared serializable
connection plan, separate Host and Node driver contracts, and generic core
supervisors. The Host core continues to own desired state, retries, primary
selection, persistence, and broadcasting. A Host driver owns provider setup and
runtime observation. A Node driver opens a route and returns the endpoint that
the unchanged Fleet registration and WebSocket code should dial.

**Tech stack:** TypeScript, Zod, Node child processes, Fastify, React, Vitest.

## Global constraints

- Compile-time plugins only; no runtime package loading.
- Fleet `hello` / `welcome`, registration, and WebSocket auth stay in core.
- `--url` and `--devtunnel` keep working; no generic CLI encoding in this refactor.
- Do not change restart backoff, primary selection, external-process ownership, or
  broadcast safety.
- Do not add another tunnel provider in this work.
- `NodeConnectionPlan` is derived each launch from CLI/env. Do not persist it in
  `settings.json`.
- `TunnelManager` restarts a session only on crash, never on operator stop.

## Proposed flow

![Proposed tunnel plugin flow: a shared manifest coordinates Host and Node adapters while Fleet registration and WebSocket authentication remain in core.](2026-08-20-tunnel-plugin-decoupling.svg)

This is the target of the plan, not the current implementation. The current
coupling being replaced is described below.

## Why this change

The Host is already close to a plugin design:

- `apps/host/src/tunnel-providers.ts` holds provider commands and output parsers.
- `apps/host/src/tunnel.ts` owns common lifecycle and supervision.
- `TunnelSupervisor` already runs one manager per provider.

The remaining coupling is concentrated in four places:

1. `TunnelManager` knows the exact shape of a CLI-backed provider.
2. `nodeDialable` is a boolean that cannot describe how a Node reaches a
   login-walled provider.
3. `apps/node/src/main.ts` contains a Dev Tunnels branch throughout startup,
   reconnect, diagnostics, and shutdown.
4. The Connect card detects Dev Tunnels by URL suffix and builds provider-specific
   commands in the UI.

The refactor should remove those provider checks from core code without creating a
runtime extension system that the product does not yet need.

## Non-goals

- Loading third-party provider packages at runtime.
- Changing Fleet registration or the `hello` / `welcome` protocol.
- Replacing the existing `--url` or `--devtunnel` CLI in this refactor.
- Changing tunnel restart, primary-selection, external-process, or broadcast
  behavior.
- Adding another tunnel provider as part of the abstraction work.
- Persisting a connection plan in Node `settings.json`.

## Decisions

### 1. Compile-time plugins first

Providers remain registered in source and shipped with Fleet. Do not load arbitrary
JavaScript packages or executable manifests at runtime.

Because plugins are closed at compile time, the connection plan is a closed
discriminated union in `@fleet/protocol`, not `params: Record<string, unknown>`.
Host enrollment and Node open() share that union. Adding an assisted provider
already requires a `TunnelProvider` enum change; it also adds a union variant.

### 2. Host and Node use different interfaces

There is one plugin identity and metadata record, but Host and Node behavior is not
forced into one symmetric interface.

The Host exposes a service and supervises its lifecycle. The Node consumes a route
and may need a local helper process. Most providers need only the Host half.

### 3. Core owns `enable` and retry policy

`enable`, `disable`, desired state, restart backoff, primary selection, and
broadcast policy stay in `TunnelSupervisor` / `TunnelManager`.

A provider must not independently decide whether it should be running. It only
implements setup and returns a running session handle.

`HostTunnelSession.closed` reports why the session ended. The manager restarts
only when `wantEnabled` is still true and `reason` is `"exited"` or `"error"`.
Operator `stop()` must resolve with `reason: "stopped"` and must not schedule a
restart.

### 4. The Node driver opens a route; it does not handshake

The terms `hello` and `welcome` already describe Fleet authentication. A tunnel
driver must not own or wrap that handshake.

Its responsibility ends after it returns a dialable endpoint. `recover()` is the
reconnect recycler (today's `recycle()`). Operator rebuild is a named action on
the session, not diagnostics metadata: the Node config page currently posts
`POST /api/devtunnel/rebuild` and must keep a working button.

Fleet core then performs registration, opens `/ws/node`, sends `hello`, and waits
for `welcome` exactly as it does today.

### 5. Enrollment carries an explicit connection plan

Do not infer behavior from a hostname such as `*.devtunnels.ms`.

```ts
type NodeConnectionPlan =
  | {
      kind: "direct";
      url: string;
    }
  | {
      kind: "provider";
      provider: "devtunnel";
      tunnelId: string;
    };
```

Cloudflare, Tailscale, ngrok, and bore produce a `direct` plan and share the
built-in direct route. Dev Tunnels is the only assisted variant in this refactor.

### 6. Preserve the existing CLI during migration

Keep `--url` and `--devtunnel` working. The first refactor is internal, not a
forced command-line migration for existing Nodes.

`--devtunnel` stays a non-persisted flag. `argvForRestart` already keeps it;
`settings.json` only stores the forwarded `hostUrl`. Derive `NodeConnectionPlan`
each launch from CLI/env before loading settings. Do not write the plan into
settings.

The enrollment API should return structured bootstrap data so the UI no longer
contains provider detection:

```ts
type NodeBootstrap = {
  connection: NodeConnectionPlan;
  prerequisites: Array<{ label: string; command: string }>;
  startArgs: string[];
  /** Connect-card explanation for assisted routes; omit for direct. */
  notice?: string;
};
```

For Dev Tunnels, `startArgs` continues to contain `--devtunnel=<qualified-id>`.
A future generic CLI encoding is required before a second assisted provider can
be enrolled from the Connect card; it is out of scope here.

### 7. Preserve public URL and live-node broadcast as separate decisions

The URL shown for enrollment is not necessarily safe to broadcast to a running
Node.

- `activeTunnelUrl()` continues to answer what enrollment displays.
- Broadcast selection uses the **manifest** field `route: "direct" | "assisted"`,
  which is static per provider. Do not infer it from `enrollment(snapshot)`.
- An assisted route such as Dev Tunnels is enrollment-capable but not directly
  broadcastable.

This replaces `nodeDialable: boolean` on day one of the new contract, not in a
later cleanup task.

Fallback enrollment is core-owned. When no tunnel is up, `activeBootstrap()`
emits `{ kind: "direct", url: fallbackPublicUrl() }` with empty prerequisites.
When a tunnel is up, bootstrap comes from `primaryManager()`'s provider so a
downed Dev Tunnels primary cannot keep advertising an assisted plan for another
provider's URL.

### 8. Core owns the shared binary-probe cache

Provider manifests declare the binary and version arguments. The Host core keeps
the shared TTL and in-flight probe cache so polling `/api/tunnel` cannot regress to
one process spawn per provider on every request. `BinaryProbe` keys on
`{ binary, versionArgs }`, not on the old `ProviderSpec` type.

### 9. The provider mints persistent ids; the manager stores them

`newTunnelId` is not a manager concern. `prepare()` owns minting:

- if `context.persistedId` is present, reuse it;
- if this provider needs a stable id and none was persisted, mint `fleet-<hex>`
  and return it;
- providers that do not need an id return `{}`.

The manager persists `prepared.tunnelId` and any later snapshot id that
`shouldAdoptTunnelId()` accepts. That adoption stays in core so a bare
`fleet-abc` is replaced by the cluster-qualified name the CLI actually hosted.
The provider does not write Host settings.

## Target contracts

### Shared manifest

```ts
type TunnelRouteKind = "direct" | "assisted";

type TunnelPluginManifest = {
  id: TunnelProvider;
  label: string;
  binary: string;
  versionArgs: string[];
  installHint: string;
  setupSteps: string[];
  docsUrl?: string;
  caveat?: string;
  route: TunnelRouteKind;
};
```

The manifest is serializable and safe to expose through `/api/tunnel`. `route`
is required from the first provider module, so `broadcastTunnelUrl()` never
depends on the deleted `nodeDialable` flag.

### Host provider

```ts
type HostTunnelContext = {
  target: LocalTarget;
  persistedId?: string;
  log(message: string): void;
};

type PreparedTunnel = {
  tunnelId?: string;
};

type HostTunnelSnapshot = {
  status: TunnelStatus;
  url?: string;
  inspectUrl?: string;
  tunnelId?: string;
  error?: string;
};

type TunnelExit = {
  reason: "stopped" | "exited" | "error";
  code?: number | null;
  signal?: string | null;
  message?: string;
};

interface HostTunnelProvider {
  readonly manifest: TunnelPluginManifest;
  prepare(context: HostTunnelContext): Promise<PreparedTunnel>;
  start(
    context: HostTunnelContext,
    prepared: PreparedTunnel,
  ): Promise<HostTunnelSession>;
  enrollment(snapshot: HostTunnelSnapshot): NodeBootstrap;
}

interface HostTunnelSession {
  snapshot(): HostTunnelSnapshot;
  onUpdate(listener: (snapshot: HostTunnelSnapshot) => void): () => void;
  readonly closed: Promise<TunnelExit>;
  stop(): Promise<void>;
}

type CliTunnelHooks = {
  args: (target: LocalTarget, tunnelId?: string) => string[];
  extractUrl: (text: string) => string | undefined;
  extractInspectUrl?: (text: string) => string | undefined;
  extractId?: (text: string) => string | undefined;
};

function createCliTunnelSession(
  manifest: TunnelPluginManifest,
  context: HostTunnelContext,
  prepared: PreparedTunnel,
  hooks: CliTunnelHooks,
): Promise<HostTunnelSession>;
```

All current providers use `createCliTunnelSession` for spawn, bounded output
buffering, URL observation, SIGTERM-then-SIGKILL shutdown, and `closed`. Dev
Tunnels supplies setup in `prepare()`, plus identifier and inspector parsers,
rather than reimplementing process supervision.

`stop()` waits for the child, then resolves `closed` with `reason: "stopped"`.
An unexpected child exit resolves with `reason: "exited"` or `"error"`.

### Node route provider

```ts
type NodeRouteContext = {
  log(message: string): void;
  warn(message: string): void;
};

type NodeRouteAction = {
  id: string;
  label: string;
  run(): void;
};

interface NodeRouteSession {
  readonly endpoint: string;
  onEndpointChanged(listener: (endpoint: string) => void): () => void;
  recover(): void;
  readonly actions: readonly NodeRouteAction[];
  stop(): Promise<void>;
}

interface NodeRouteProvider {
  readonly id: "devtunnel";
  open(
    plan: Extract<NodeConnectionPlan, { kind: "provider"; provider: "devtunnel" }>,
    context: NodeRouteContext,
  ): Promise<NodeRouteSession>;
}

function openRoute(
  plan: NodeConnectionPlan,
  context: NodeRouteContext,
): Promise<NodeRouteSession>;
```

The registry contains the built-in direct route plus providers that require
Node-side work. A direct plan is a session whose endpoint is the supplied URL
and whose `recover`, `stop`, and `actions` are no-ops.

Dev Tunnels exposes `actions: [{ id: "rebuild", label: "Rebuild tunnel", run }]`.
That `run` is today's `rebuildNow()`. `recover()` remains today's `recycle()`.

## Task 1: Lock current behavior with characterization tests

**Files:**

- Modify: `apps/host/src/tunnel.test.ts`
- Modify: `apps/node/src/devtunnel.test.ts`
- Modify: `apps/node/src/host-endpoints.test.ts`
- Modify: `apps/host/ui/src/lib/enroll-command.test.ts`

**Steps:**

1. Add a Host matrix test covering every current provider:
   - command and arguments,
   - URL extraction,
   - optional identifier and inspector URL,
   - whether the provider is enrollment-direct or Node-assisted (`nodeDialable`
     is the current signal; Task 3 replaces it with `route`).
2. Add tests proving the core lifecycle behavior that must not move into plugins:
   - idempotent enable/disable,
   - disable does not restart,
   - restart backoff after a crash,
   - primary fallback,
   - external-process ownership.
3. Preserve the Dev Tunnels Node tests for:
   - forwarded-port discovery,
   - reconnect backoff,
   - fatal login and visibility failures,
   - `recycle()` when the process is alive but the Host is unreachable,
   - `rebuildNow()` as an operator action,
   - endpoint-change notification.
4. Add a test proving a direct route requires no child process.
5. Add a UI test proving enrollment rendering can use structured bootstrap data
   without inspecting the URL suffix.
6. Run:

   ```bash
   npx vitest run apps/host/src/tunnel.test.ts \
     apps/node/src/devtunnel.test.ts \
     apps/node/src/host-endpoints.test.ts \
     apps/host/ui/src/lib/enroll-command.test.ts
   ```

Do not add protocol tests in this task. The schemas do not exist yet.

## Task 2: Add the shared connection-plan protocol

**Files:**

- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/index.test.ts`

**Steps:**

1. Add `NodeConnectionPlanSchema` as the closed union in Decision 5.
2. Add `NodeBootstrapSchema` with connection, prerequisites, start arguments,
   and optional `notice`.
3. Add `EnrollmentSchema` with `enrollmentToken`, `bootstrap`, and deprecated
   `hostUrl` / `tunnelId` for compatibility.
4. Reject missing `tunnelId` on the Dev Tunnels variant, invalid URLs on the
   direct variant, and unknown `provider` values.
5. Do not change UI hooks in this task. `useEnrollment.ts` moves in Task 5.
6. Build the protocol before touching Host or Node consumers:

   ```bash
   npm run build -w @fleet/protocol
   ```

## Task 3: Create the Host plugin registry

**Files:**

- Add: `apps/host/src/tunnels/types.ts`
- Add: `apps/host/src/tunnels/cli-session.ts`
- Add: `apps/host/src/tunnels/registry.ts`
- Add: `apps/host/src/tunnels/providers/cloudflare.ts`
- Add: `apps/host/src/tunnels/providers/tailscale.ts`
- Add: `apps/host/src/tunnels/providers/ngrok.ts`
- Add: `apps/host/src/tunnels/providers/bore.ts`
- Add: `apps/host/src/tunnels/providers/devtunnel.ts`
- Modify: `apps/host/src/tunnel-providers.ts`
- Modify: `apps/host/src/tunnel.test.ts`

**Steps:**

1. Define the manifest, provider, session, snapshot, exit, and CLI-session
   contracts from Target contracts, including `route` on every manifest.
2. Keep one shared `BinaryProbe` in the supervisor and probe each provider from
   its manifest's `binary` and `versionArgs`.
3. Move generic process spawning, bounded output buffering, URL observation, and
   graceful shutdown into `createCliTunnelSession`. `stop()` must resolve
   `closed` with `reason: "stopped"`.
4. Move each current provider's command, setup, parser, metadata, and enrollment
   builder into its provider module. Dev Tunnels `prepare()` mints or reuses the
   id; Cloudflare/Tailscale/ngrok/bore `prepare()` is a no-op.
5. Keep `tunnel-providers.ts` as a temporary compatibility re-export so the
   manager and tests can migrate without a big-bang rename. Map leftover
   `nodeDialable` reads to `manifest.route === "direct"` until Task 8 deletes
   the alias.
6. Add registry conformance tests:
   - every `TunnelProvider` has exactly one Host provider,
   - manifest IDs match registry keys,
   - every `route: "direct"` provider's `enrollment()` returns `kind: "direct"`,
   - the Dev Tunnels provider returns `kind: "provider"` with a `tunnelId`,
   - `prepare()` without `persistedId` returns a minted id only for assisted
     providers.

## Task 4: Make the Host manager depend only on the provider contract

**Files:**

- Modify: `apps/host/src/tunnel.ts`
- Modify: `apps/host/src/tunnel-process.ts`
- Modify: `apps/host/src/external-tunnel.ts`
- Modify: `apps/host/src/server.ts`
- Modify: `apps/host/src/routes/system.ts`
- Modify: `apps/host/src/tunnel.test.ts`
- Modify: `apps/host/src/external-tunnel.test.ts`

**Steps:**

1. Inject a `HostTunnelProvider` into each `TunnelManager`; remove provider
   switching from a manager after construction.
2. Keep these responsibilities in `TunnelManager`:
   - desired enabled state,
   - status and error transitions,
   - restart timers,
   - external-session ownership,
   - persistent provider identifier storage.
3. Replace direct `spawn`, output parser, and `ProviderSpec` access with
   `provider.prepare()` and `provider.start()`. Persist `prepared.tunnelId`,
   then adopt a later snapshot id through `shouldAdoptTunnelId()`.
4. Make `TunnelSupervisor` construct managers from the registry.
5. Drive manager updates from `onUpdate`. Schedule restart only when `closed`
   resolves with `reason: "exited" | "error"` while `wantEnabled` is true.
6. Point `broadcastTunnelUrl()` at managers whose `manifest.route === "direct"`.
7. Make `tunnel-process.ts` call the same `prepare()` then `start()` path rather
   than `spawn(spec.args(target))` with no id. Today's external Dev Tunnels
   launch is `host -p <port>`, a throwaway tunnel; do not freeze that.
   - `persistedId` comes from `FLEET_TUNNEL_ID` if set, otherwise from the
     `tunnelId` already in the state file, otherwise `prepare()` mints one.
   - Write the minted or adopted id to `tunnel.json` beside `url`.
8. Preserve the current `/api/enrollment` response shape until Task 5.

## Task 5: Make enrollment provider-neutral

**Files:**

- Modify: `apps/host/src/tunnel.ts`
- Modify: `apps/host/src/routes/system.ts`
- Modify: `apps/host/ui/src/hooks/useEnrollment.ts`
- Modify: `apps/host/ui/src/lib/enroll-command.ts`
- Modify: `apps/host/ui/src/lib/enroll-command.test.ts`
- Modify: `apps/host/ui/src/components/ConnectNodeCard.tsx`
- Modify: `apps/host/src/routes.test.ts`

**Steps:**

1. Add `activeBootstrap()` beside `activeTunnelUrl()`:
   - live primary → that provider's `enrollment(snapshot)`;
   - no tunnel → core direct plan with `fallbackPublicUrl()`.
2. Return `EnrollmentSchema` from `/api/enrollment`.
3. Switch `useEnrollment` to `EnrollmentSchema`. The new UI reads `bootstrap`;
   it may still display deprecated `hostUrl` as the default field value.
4. Change `enrollCommand` to accept `startArgs: string[]`; it only quotes
   arguments and appends the enrollment token.
5. Connect card command generation:
   - default command comes from Host `bootstrap.startArgs`;
   - if the operator edits the URL and `connection.kind === "direct"`, rewrite
     `startArgs` to `--url=<edited>`;
   - if the plan is assisted, the URL field is display-only and must not change
     `startArgs` or reintroduce hostname detection.
6. Render `bootstrap.prerequisites` generically. Show `bootstrap.notice` for
   assisted plans. Keep the local-only warning only for a direct plan whose
   (possibly edited) URL is loopback.
7. Remove `isDevTunnelUrl`, `devTunnelLoginCommand`, and all URL-suffix branching
   from the UI.
8. Test direct and Dev Tunnels enrollment responses end to end, including
   fallback-when-no-tunnel and edited-direct-URL command rewriting.

## Task 6: Create the Node route registry

**Files:**

- Add: `apps/node/src/tunnels/types.ts`
- Add: `apps/node/src/tunnels/direct.ts`
- Add: `apps/node/src/tunnels/registry.ts`
- Move: `apps/node/src/devtunnel.ts` to
  `apps/node/src/tunnels/devtunnel.ts`
- Move: `apps/node/src/devtunnel.test.ts` to
  `apps/node/src/tunnels/devtunnel.test.ts`
- Add: `apps/node/src/tunnels/registry.test.ts`

**Steps:**

1. Define `NodeRouteProvider`, `NodeRouteSession`, `NodeRouteAction`, and
   `NodeRouteContext`.
2. Implement the direct route as a session whose endpoint is the supplied URL
   and whose recovery, stop, and actions are no-ops.
3. Adapt `connectDevTunnel` to the common session interface:
   - `url` becomes `endpoint`,
   - `recycle` becomes `recover`,
   - `rebuildNow` becomes `actions` entry `{ id: "rebuild", run }`.
4. Register Dev Tunnels against the protocol union variant
   `{ kind: "provider", provider: "devtunnel", tunnelId }`.
5. Reject an unknown plan or missing `tunnelId` with an actionable startup error.
6. Preserve the existing supervision tests while renaming only the public
   abstraction.

## Task 7: Remove Dev Tunnels branches from Node core

**Files:**

- Modify: `apps/node/src/main.ts`
- Modify: `apps/node/src/cli.ts`
- Modify: `apps/node/src/cli.test.ts`
- Modify: `apps/node/src/host-endpoints.ts`
- Modify: `apps/node/src/host-endpoints.test.ts`
- Modify: `apps/node/src/config-server.ts`
- Modify: `apps/node/src/config-server.test.ts`
- Modify: `apps/node/public/config.js`
- Modify: `apps/node/src/settings.ts`

**Steps:**

1. Resolve a `NodeConnectionPlan` from command-line/environment inputs before
   loading effective settings. `--devtunnel` / `FLEET_DEVTUNNEL_ID` become a
   Dev Tunnels provider plan; `--url` / `FLEET_HOST_URL` become a direct plan.
   Do not persist the plan in `settings.json`.
2. Ask `openRoute()` to open it and seed settings from `routeSession.endpoint`.
3. Replace `TunnelMode = "devtunnel" | "direct"` with route-session policy:
   - a direct session can rotate among direct known URLs,
   - a provider session owns its endpoint and does not dial unrelated fallbacks,
     including a public login-walled URL announced over `host_url`.
4. Replace direct calls to `devTunnel.recycle()` with `routeSession.recover()`.
5. Replace Dev Tunnels-specific config status with generic route status:
   `{ provider, endpoint, state, actions }`. Wire `POST /api/route/rebuild` (or
   keep `/api/devtunnel/rebuild` as an alias) to `actions` id `"rebuild"`.
6. Update `apps/node/public/config.js` in the same task. The rebuild button and
   status line must not keep reading `status.devTunnel`.
7. Keep `--devtunnel` and `FLEET_DEVTUNNEL_ID` as a compatibility input.
8. Ensure `main.ts` imports no provider implementation and contains no
   `devtunnel` hostname or command checks.

## Task 8: Remove the leftover broadcast boolean

**Files:**

- Modify: `apps/host/src/tunnel.ts`
- Modify: `apps/host/src/host-url.ts`
- Modify: `apps/host/src/host-url.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Steps:**

1. Delete `nodeDialable` from any remaining compatibility re-export or comment.
   Broadcast already uses `manifest.route === "direct"` from Task 4.
2. Keep the defense-in-depth hostname check in `isBroadcastableHostUrl()` for
   manually configured `FLEET_PUBLIC_URL`; a typed Dev Tunnels URL must still
   never be broadcast.
3. Test:
   - Dev Tunnels is advertised for enrollment but not broadcast,
   - direct providers remain broadcastable,
   - a manually entered login-walled URL remains blocked.

Node adoption of announced URLs was already moved to route-session policy in
Task 7. Do not reopen `host-endpoints.ts` here.

## Task 9: Remove compatibility shims and document the extension point

**Files:**

- Delete: `apps/host/src/tunnel-providers.ts` after all imports move
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Steps:**

1. Remove the temporary `tunnel-providers.ts` re-export after all internal imports
   move. Keep the documented legacy enrollment fields until a separately versioned
   API cleanup.
2. Document the ownership boundary:
   - core owns lifecycle and Fleet authentication,
   - Host plugins expose tunnels,
   - Node plugins open routes,
   - direct providers share the built-in direct route,
   - `route` on the manifest decides broadcast eligibility.
3. Add a concise "adding a provider" checklist:
   - add the id to `TunnelProvider` in protocol,
   - register manifest (`route` included) and Host driver,
   - for a **direct** CLI provider: provider module plus tests; no Node or
     Connect-card changes;
   - for an **assisted** route: Host driver, Node driver, a new
     `NodeConnectionPlan` union variant, and a CLI encoding (this refactor only
     keeps `--devtunnel`);
   - add parser and conformance tests;
   - document authentication and URL stability.
4. Mark the Dev Tunnels design as historical implementation evidence and point
   future provider work to this plan's final architecture.

## Validation

Run the smallest relevant groups while implementing, then the complete repository
gate:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Manual checks:

1. Enable every installed Host provider and verify status/URL parsing.
2. Run two providers concurrently and change the enrollment primary.
3. Enroll a direct Node from the generated command.
4. Enroll a Dev Tunnels Node from the generated prerequisite and start commands.
5. Restart the Dev Tunnels Host and confirm the Node route recovers and follows a
   changed forwarded port.
6. Confirm a private Dev Tunnels URL is never sent in a `host_url` message.
7. Run an external tunnel process, including Dev Tunnels, and confirm it reuses a
   named tunnel rather than minting a throwaway `host -p` tunnel.
8. Disable a running provider and confirm it does not restart.
9. Use the Node config page rebuild button on a Dev Tunnels node.

## Acceptance criteria

- Adding a **direct** CLI-backed Host provider requires one protocol id, one
  Host provider module, and tests; no change to `TunnelManager`,
  `TunnelSupervisor`, Node `main.ts`, or the Connect card.
- Adding an **assisted** route in a later change requires one Host provider, one
  Node route provider, a new `NodeConnectionPlan` union variant, and a CLI
  encoding. This refactor does not add that encoding; `--devtunnel` remains the
  only assisted CLI.
- `apps/node/src/main.ts` has no Dev Tunnels-specific branches.
- The UI does not inspect provider URL suffixes.
- Editing the Connect-card URL rewrites a direct command and leaves an assisted
  command unchanged.
- Disable does not restart; crash while enabled does.
- External `tunnel-process` runs `prepare()` then `start()` and persists the
  tunnel id.
- Fleet `hello` / `welcome`, registration, event buffering, and session behavior
  are unchanged.
- All existing tunnel and reconnect regression tests remain green.
- No arbitrary runtime plugin loading is introduced.
