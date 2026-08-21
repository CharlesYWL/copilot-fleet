# Dev Tunnels provider (Microsoft dev tunnels)

**Date:** 2026-08-17
**Status:** Implemented — verified against a live tunnel
**Scope:** Add `devtunnel` as a tunnel provider; handle the private-tunnel enrollment fork.

## Goal

Give operators a tunnel whose default posture is **private** instead of public.

Cloudflare quick tunnels are anonymous by construction: anyone holding the
`trycloudflare.com` URL reaches the Host. Because the Host has no user auth
(`ARCHITECTURE.md` "Security boundary"), that URL is effectively a bearer
credential for the whole fleet. Dev Tunnels requires a Microsoft/Entra/GitHub
identity by default, which puts an identity gate in front of an app that has none.

## Non-goals

- **Replacing Host authentication.** This is defense in depth, not the fix. See "Relationship to Host auth".
- `--allow-anonymous` tunnels. Explicitly rejected; see "Decisions".
- Operator-named tunnel ids. The Host generates and reuses one; see "Persistence".
- Changing how Nodes authenticate to the Host (unique Node secret is unchanged).

## Verification performed

All of the following was measured against a live `devtunnel host -p 8790` on
2026-08-17, not inferred from docs.

| Check | Result |
|---|---|
| `GET /api/health`, no credential | `302` → `global.rel.tunnels.api.visualstudio.com/auth/aad` |
| `GET /api/health`, invalid token | `401` |
| `GET /api/health`, valid connect token | `200 {"ok":true,"version":"0.1.0"}` |
| `POST /api/nodes/register`, no credential | `401` |
| `GET` with `X-Tunnel-Skip-AntiPhishing-Page` | still `302` — **the gate is auth, not the interstitial** |
| WS `/ws/browser` local baseline | OPEN |
| WS `/ws/browser` via tunnel, no token | REJECTED `302` |
| WS `/ws/browser` via tunnel, valid token | OPEN |
| WS `/ws/node` via tunnel, valid token | OPEN |
| Cloudflare `GET /api/enrollment` (control) | `200`, enrollment token in plaintext |

Two results drive the whole design:

1. **WebSockets survive the tunnel.** Both gateways upgrade correctly once
   authorized. This was the make-or-break risk and it passes.
2. **A machine-level CLI login does not authenticate HTTP clients.** With
   `devtunnel user show` reporting a logged-in user, plain `curl` to the tunnel
   still got `302`. Credentials are per-client, not per-machine.

## The enrollment fork (the crux)

Today every provider yields a public URL, that URL becomes `publicUrl`, and the
Connect card pastes it into `--url=`. **That model breaks for a private tunnel.**

A Node cannot authenticate to the tunnel:

- `apps/node/src/main.ts` register uses `fetch(...)` with only a `content-type` header.
- `apps/node/src/main.ts` connect uses `new WebSocket(url)` with no options argument.

Neither can attach `X-Tunnel-Authorization`. A Node pointed at the tunnel URL
gets `401` on register and `302` on upgrade. Confirmed by experiment.

Three ways out, and why v1 picks the third:

| Option | Verdict |
|---|---|
| `--allow-anonymous` | **Rejected.** Recreates the exact hole this feature exists to close: `/api/enrollment` public again. |
| Node sends `X-Tunnel-Authorization` | **Deferred.** Needs code changes on both call sites, and connect tokens expire in 24h (measured: `Token lifetime: 1.00:00:00`). Refresh requires a real user identity, so unattended Nodes would break daily. |
| `devtunnel connect` on the Node machine | **Chosen.** Works today with zero Node code changes. |

With `devtunnel connect`, the Node dials a forwarded **loopback** port. Verified:

```
SSH: Forwarding from 127.0.0.1:8791 to host port 8790.
curl http://127.0.0.1:8791/api/health  →  200 {"ok":true,...}
```

No header needed — the CLI's cached login authorizes the relay.

### Tunnel ID is not derivable from the URL

The Connect card must emit `devtunnel connect <tunnelId>`, and **the ID cannot be
parsed out of `publicUrl`**:

```
Tunnel ID : neat-lake-7x8gj9s.usw2
Ports     : 8790  auto  https://7m667npm-8790.usw2.devtunnels.ms/
```

`7m667npm` is an opaque routing token, unrelated to `neat-lake-7x8gj9s`.

Consequence: `ProviderSpec` must grow a second extractor. The ID appears in
`devtunnel host` output as:

```
Ready to accept connections for tunnel: neat-lake-7x8gj9s.usw2
```

### The forwarded port is not fixed

`devtunnel connect` binds the same port number as the remote when free, but
falls back silently. Observed on a machine where 8790 was taken:

```
SSH: Forwarding from 127.0.0.1:8791 to host port 8790.
```

The node therefore reads the port back from that line rather than being handed
a guess. Nothing transcribes it.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Provider id | `devtunnel` |
| Tunnel kind | Persistent named tunnel, so the URL and id survive restarts |
| Anonymous access | Never; no flag exposed in the UI |
| Node connectivity | The node runs `devtunnel connect` itself via `--devtunnel <id>` |
| Concurrency | Providers run side by side; each has its own switch |
| Broadcast safety | A private tunnel is advertised for enrollment but never pushed to live nodes |
| Tunnel ID capture | New optional `extractId` on `ProviderSpec` |
| Connect card | Provider-aware; devtunnel gets its own command block |

## Persistence: named tunnels, not throwaway ones

An anonymous `devtunnel host` mints a **new tunnel and a new URL on every
start**, and deletes it on exit. Measured across two runs of a named tunnel, the
URL is instead identical:

```
run 1  https://k9wzx0nq-8790.usw2.devtunnels.ms
run 2  https://k9wzx0nq-8790.usw2.devtunnels.ms
```

It even survives deleting and recreating the port, so the routing token belongs
to the tunnel rather than to the port.

Two consequences make this the default rather than a nicety:

- A rotating id would break the node's `devtunnel connect <id>` on every Host
  restart, which is the whole reason the id is surfaced.
- Throwaway tunnels accumulate. Eight orphans were left behind by ordinary
  dev-server restarts before persistence landed.

The Host generates an id once (`fleet-<random>`), stores it under
`tunnel.<provider>.id`, and reuses it. Registration is a three-step sequence,
discovered by experiment rather than from the docs:

```
devtunnel create <id>                                  # Conflict once it exists
devtunnel port create <id> -p <port> --protocol http   # Conflict once it exists
devtunnel host <id>
```

`devtunnel host <id> -p <port>` is rejected outright — *"Batch update of ports is
not supported"* — so the port cannot be passed inline alongside an existing id.
Both `create` calls conflict in the steady state, so a conflict is swallowed
while any other failure still surfaces; otherwise a signed-out CLI would look
like success.

## Provider spec entry

```ts
devtunnel: {
  id: "devtunnel",
  label: "Dev Tunnels",
  binary: "devtunnel",
  versionArgs: ["--version"],
  args: (target, tunnelId) =>
    tunnelId ? ["host", tunnelId] : ["host", "-p", String(target.port), "--protocol", "http"],
  prepare: async (target, tunnelId) => { /* create + port create, conflicts tolerated */ },
  newTunnelId: () => `fleet-${randomBytes(4).toString("hex")}`,
  extractUrl: matcher(DEVTUNNEL_URL_RE),
  extractId: matcher(DEVTUNNEL_ID_RE),
  nodeDialable: false,
  installHint: "winget install Microsoft.devtunnel, then run `devtunnel user login`.",
  caveat: "Private by default: remote nodes must run `devtunnel connect` and dial the forwarded localhost port.",
},
```

Patterns, both anchored on observed output and unit-checked against a captured
`devtunnel host` transcript:

```ts
const DEVTUNNEL_URL_RE = /https:\/\/[a-z0-9-]+(?<!-inspect)\.[a-z0-9]+\.devtunnels\.ms/i;
const DEVTUNNEL_ID_RE  = /(?<=for tunnel:\s)[a-z0-9-]+\.[a-z0-9]+/i;
```

The `(?<!-inspect)` lookbehind is load-bearing. `devtunnel host` prints two
`devtunnels.ms` URLs:

```
Connect via browser:      https://7m667npm-8790.usw2.devtunnels.ms
Inspect network activity: https://7m667npm-8790-inspect.usw2.devtunnels.ms
```

Without the lookbehind the pattern matches the inspect host too. Ordering
usually saves it — the connect line comes first in the byte stream and
`extractUrl` takes the first match — but `tunnel.ts` latches the first URL it
sees (`if (this.tunnelUrl) return;`), so a single mis-parse is permanent and
silently points enrollment at an inspector UI. Verified: the naive pattern
matches `...-inspect...` when tested alone; the guarded pattern returns no match
for it while still extracting the correct URL from the full transcript.

`--protocol http` is set explicitly because the Host serves plain HTTP on
loopback; leaving it `auto` risks the relay guessing https.

### Login is a precondition, not a spawn concern

`devtunnel host` fails if the user has never logged in. The binary probe only
proves the CLI exists. Add a second readiness check via `devtunnel user show`
and surface "Run `devtunnel user login`" distinctly from "binary missing" —
otherwise the operator sees a generic spawn failure and has nothing to act on.

## Protocol changes

```ts
export const tunnelProviders = [
  "cloudflare", "tailscale", "ngrok", "bore", "devtunnel",
] as const;
```

`TunnelInfoSchema` gains an optional identifier so the UI can build the connect
command:

```ts
tunnelId: z.string().optional(),
```

`ExternalTunnel` / `tunnel.json` (`external-tunnel.ts`) gains the same optional
field, so a separately-run tunnel can still drive correct instructions.

## Connect card behavior

`enroll-command.ts` gains a pure, testable helper beside `isLocalOnlyHostUrl`:

```ts
export function isDevTunnelUrl(hostUrl: string): boolean;
```

When the active provider is `devtunnel` (or `hostUrl` matches), the card renders
two blocks — the interactive one-time login is kept apart from the command that
gets re-run:

```
# 1. Sign this machine in (once)
devtunnel user login

# 2. Start the node
npm install
npm run build:node
npm run start:node -- --devtunnel="<tunnelId>" --token="<token>"
```

The node opens the tunnel itself, so there is no second terminal and no port to
transcribe: `--devtunnel` spawns `devtunnel connect`, waits for its
`Forwarding from 127.0.0.1:<port>` line, and uses that as the host URL. A
`connect` that exits first is reported as a signed-out CLI rather than a hang.

One existing behavior needs care:

- **Suppress the local-only warning.** `isLocalOnlyHostUrl("http://127.0.0.1:...")`
  is true, but for devtunnel that address is *correct*. Showing "this only
  resolves on the Host itself" would actively mislead.

## Concurrent providers

Providers are not alternatives. A fixed Cloudflare hostname is the address a
teammate can reach; a private Dev Tunnel is the address only this account can.
Both are useful at once, and the old single-`provider` shape could not say so.

`TunnelSupervisor` runs one `TunnelManager` per provider over a shared binary
probe, and `TunnelInfo` carries a `tunnels[]` array of per-provider state plus a
`primary` marking whose URL enrollment advertises. Each manager is pinned to its
provider at construction: deferring that to the first `setEnabled` left every
manager answering as the default, so all of them reported the same tunnel.

## Never broadcast a tunnel a node cannot dial

The Host tells running nodes when its address changes, so they follow it. With a
private tunnel as primary that is actively destructive: the node adopts a URL it
cannot authenticate to, and having lost the Host it cannot be told to go
anywhere else. Observed in practice — a live node went offline and had to be
repointed by hand.

So two questions are kept separate:

| Question | Answer |
|---|---|
| What does enrollment advertise? | Any provider, private included — the card ships the command for it. |
| What may a running node be told to dial? | Only providers marked `nodeDialable` (default true; `devtunnel` is false). |

`broadcastTunnelUrl()` skips non-dialable providers and falls back to the
configured public URL, while `activeTunnelUrl()` keeps advertising the primary.

## Relationship to Host auth

This provider narrows exposure; it does not close the hole.

`GET /api/enrollment` and `GET /api/backup` both return the enrollment token
with no auth check. Behind a private tunnel that is far better than behind a
public one, but it remains true that any authorized tunnel client gets full
fleet control, and one `--allow-anonymous` typo re-exposes everything.

Host-side auth stays the real fix and is tracked separately.

## Testing

- Unit: `DEVTUNNEL_URL_RE` against `Connect via browser: https://7m667npm-8790.usw2.devtunnels.ms`.
- Unit: `DEVTUNNEL_ID_RE` against `Ready to accept connections for tunnel: neat-lake-7x8gj9s.usw2`.
- Unit: `DEVTUNNEL_URL_RE` must return **no match** for the inspect host in isolation (`https://7m667npm-8790-inspect.usw2.devtunnels.ms`), not merely rank it second.
- Unit: `isDevTunnelUrl` true for `*.devtunnels.ms`, false for trycloudflare/ngrok/loopback.
- Unit: `enrollCommand` emits `--devtunnel`, and never the private URL or a hard-coded port.
- Unit: the login command stays out of the start command.
- Unit: supervisor lists every provider, keeps non-serving ones `off`, and picks the serving one as primary.
- Unit: `broadcastTunnelUrl()` is undefined for a private tunnel that `activeTunnelUrl()` still advertises.
- Unit: node `connectDevTunnel` reads the forwarded port back, tolerates a split line, and reports a signed-out CLI rather than hanging.
- Manual: select provider → URL appears → browser prompts Entra login → UI loads.
- Manual: restart the Host and confirm the URL is unchanged.

The inspect-URL case is a real trap rather than a hypothetical: both URLs share
the `devtunnels.ms` suffix, differ only by an infix, and `tunnel.ts` latches the
first URL it parses. Test the pattern in isolation so the suite does not pass
merely because the transcript happens to be ordered favorably.

## Risks

| Risk | Mitigation |
|---|---|
| Operator pastes the public URL into node config | Card never generates it; caveat states the rule. Observed failure is a confusing `401`, so the copy must be explicit. |
| CLI installed but not logged in | Separate readiness check + distinct message. |
| Forwarded port differs from 8790 | Instructions tell the operator to read the CLI output. |
| Connect token expiry (24h) | Not on the v1 path; `devtunnel connect` uses the CLI's own refreshable login. |
| Inspect URL captured instead of connect URL | Explicit regression test. |
| Preview-stage CLI | Docs flag `devtunnel` as public preview; flags may change. Pin behavior with the parser tests above. |

## Spec self-review

- Enrollment fork resolved with a concrete chosen option, alternatives recorded with reasons.
- Every protocol/UI touch point named (`tunnelProviders`, `TunnelInfoSchema`, `ExternalTunnel`, `enroll-command.ts`, `ConnectNodeCard.tsx`).
- Non-derivable tunnel ID and variable forwarded port both handled rather than assumed away.
- Security claim bounded: narrows exposure, does not replace Host auth.

## Implementation notes

Shipped:

- `tunnelProviders` gains `devtunnel`; `TunnelInfo` becomes a per-provider
  `tunnels[]` array with a `primary`, replacing the single-provider shape.
- `ProviderSpec` gains `extractId`, `prepare`, `newTunnelId` and `nodeDialable`.
- `TunnelSupervisor` runs one manager per provider over a shared probe cache.
- Persistent named tunnels, with the id stored under `tunnel.<provider>.id`.
- Per-provider enabled flags (`tunnel.<provider>.enabled`), falling back to the
  legacy single-provider keys so an existing install keeps what it had running.
- `tunnel-process.ts` keeps scanning after the URL is found, because the id line
  arrives later — the old `if (url) return` would have discarded it.
- Node `--devtunnel <id>`: spawns `devtunnel connect`, discovers the forwarded
  port, and uses it as the host URL.
- Connect card splits into a one-time login block and a start block.

Deferred, with reasons:

- **Login readiness check.** Spec proposed probing `devtunnel user show` to
  distinguish "not logged in" from "binary missing" on the Host. Not implemented
  there: it adds a second probe to a path shared by every provider, and the
  failure already surfaces as `status: error` with the CLI's exit code. The node
  side *does* special-case it, because a node has no UI to read an error from.
- **Operator-chosen tunnel id.** The generated `fleet-<random>` is stable and
  needs no UI; a custom name would only matter for sharing one tunnel across
  Hosts, which nothing asks for yet.

### Bugs this design walked into

Recorded because each was found by testing rather than reasoning, and each would
have been quiet in production:

1. **Broadcasting a private URL stranded a live node.** Fixed by `nodeDialable`.
2. **Provider pinning was asynchronous**, so every manager still answered as the
   default and reported the same tunnel. Fixed by pinning at construction.
3. **`activeTunnelUrl()` claimed any external tunnel** regardless of which
   provider owned it, so one external tunnel appeared under every provider.
4. **The inspect URL parsed as the forwarding URL** when seen alone.

### Operational gotcha: PATH staleness

A newly installed CLI is invisible to an already-running Host. Observed here:
`devtunnel` installs to a WinGet package directory appended to the user PATH at
install time, but a process inherits its PATH at launch, so `/api/tunnel`
reported `binaryPresent: false` while `devtunnel --version` succeeded in a fresh
shell. The probe itself is correct — a fresh Node process resolves the binary in
~1s, well inside the 5s timeout.

Restarting the Host is not sufficient if its *parent* also predates the install;
the shell that launches it has to be new. This is pre-existing behavior
affecting every provider, but Dev Tunnels is the most likely one to be installed
while the Host is already running.
