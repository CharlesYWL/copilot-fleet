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
- Persistent/named tunnels with stable URLs (possible later; not needed for v1 — see "URL rotation is a non-issue here").
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

So generated instructions must tell the operator to read the CLI's actual
`Forwarding from` line rather than assuming the port. Do not hard-code it.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Provider id | `devtunnel` |
| Tunnel kind | Temporary (`devtunnel host`), deleted on exit |
| Anonymous access | Never; no flag exposed in the UI |
| Node connectivity | `devtunnel connect` on the Node machine |
| Node code changes | None in v1 |
| Tunnel ID capture | New optional `extractId` on `ProviderSpec` |
| Connect card | Provider-aware; devtunnel gets its own command block |

## URL rotation is a non-issue here

`tunnel-providers.ts` carries `caveat: "Quick tunnel URLs change on every restart."`
for Cloudflare, and `host-url.ts` / `knownHostUrls` exist to chase that rotation.

Under this design the **Node's dial URL is `http://127.0.0.1:<forwarded>`, which
never changes.** Only the browser-facing URL rotates, and a human re-reads that
anyway. So temporary tunnels are acceptable for v1 and persistent named tunnels
buy little.

## Provider spec entry

```ts
devtunnel: {
  id: "devtunnel",
  label: "Dev Tunnels",
  binary: "devtunnel",
  versionArgs: ["--version"],
  args: (target) => ["host", "-p", String(target.port), "--protocol", "http"],
  extractUrl: matcher(DEVTUNNEL_URL_RE),
  extractId: matcher(DEVTUNNEL_ID_RE),
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

When the active provider is `devtunnel` (or `hostUrl` matches), the card renders:

```
# On the node machine, once:
devtunnel user login
devtunnel connect <tunnelId>

# Read the "Forwarding from 127.0.0.1:<port>" line the CLI prints,
# then use that port below.
npm install
npm run build:node
npm run start:node -- --url="http://127.0.0.1:<port>" --token="<token>"
```

Two existing behaviors need care:

- **Suppress the local-only warning.** `isLocalOnlyHostUrl("http://127.0.0.1:...")`
  is true, but for devtunnel that address is *correct*. Showing "this only
  resolves on the Host itself" would actively mislead.
- **Keep the URL field showing the public tunnel URL**, since that is what a
  human opens in a browser. Only the generated command uses loopback.

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
- Unit: `enrollCommand` emits the connect form for a devtunnel URL.
- Unit: local-only warning suppressed for devtunnel loopback commands.
- Manual: select provider → URL appears → browser prompts Entra login → UI loads.
- Manual: remote node via `devtunnel connect` → registers → `connected: true`.

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

- `tunnelProviders` gains `devtunnel`; `TunnelInfoSchema` gains optional `tunnelId`.
- `ProviderSpec.extractId` (optional) plus the `devtunnel` entry with the guarded URL pattern.
- `TunnelManager` parses and clears `tunnelId` alongside the URL, and exposes `activeTunnelId()`.
- `tunnel-process.ts` keeps scanning after the URL is found, because the id line arrives later — the old `if (url) return` would have discarded it.
- `external-tunnel.ts` state carries `tunnelId`, so a hand-run tunnel still yields correct instructions.
- `/api/enrollment` returns `tunnelId` when one exists.
- `enrollCommand` forks on `isDevTunnelUrl`; the Connect card swaps the misleading
  local-only warning for an explanation of why loopback is correct here.

Deferred, with reasons:

- **Login readiness check.** Spec proposed probing `devtunnel user show` to
  distinguish "not logged in" from "binary missing". Not implemented: it adds a
  second probe to a code path shared by every provider, and the failure is
  already surfaced (`status: error` with the CLI's exit code) rather than silent.
  The install hint names `devtunnel user login`. Worth revisiting if operators
  actually trip on it.
- **Persistent named tunnels.** Unnecessary while nodes dial loopback; see
  "URL rotation is a non-issue here".

### Operational gotcha: PATH staleness

A newly installed CLI is invisible to an already-running Host. Observed here:
`devtunnel` installs to a WinGet package directory that is appended to the user
PATH at install time, but the Host process inherited its PATH at launch, so
`/api/tunnel` reported `binaryPresent: false` while `devtunnel --version`
succeeded in a fresh shell. The probe logic is correct — a fresh Node process
resolves the binary in ~1s, well inside the 5s timeout.

**Restart the Host after installing a provider CLI.** This is pre-existing
behavior affecting every provider, not specific to Dev Tunnels, but Dev Tunnels
is the most likely one to be installed while the Host is already running.
