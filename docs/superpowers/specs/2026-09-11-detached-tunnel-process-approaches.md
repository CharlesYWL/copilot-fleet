# Detached tunnel process — approaches

**Status:** Approaches for review. No implementation until this file is approved.  
**Date:** 2026-09-11  
**Companion:** [Windows boot service approaches](./2026-09-11-windows-boot-service-approaches.md)

## 1. What this is answering

You want the Settings tunnel switch to start a **separate process** that is not part of the Host/Node session tree. After the Host process dies, is rebuilt, or is restarted during testing, that tunnel should **keep forwarding**. When the Host comes back, it should **find the same tunnel** and be able to **turn it off or on again** from the UI.

This is a process-lifecycle problem (Host rebuilds; tunnel stays). OS reboot is a different problem and is covered in the companion doc. The two compose: a tunnel the Host does not parent is also the process you can later register as a login/boot task.

## 2. Current behavior (what HEAD actually does)

Fleet already has two tunnel runtimes. They are not equivalent.

### 2.1 In-process tunnel (Settings switch, `npm run host`)

`TunnelSupervisor` / `TunnelManager` in `apps/host/src/tunnel.ts` spawn the provider CLI (`devtunnel`, `cloudflared`, …) as a **child of the Host**. Desired on/off is stored in SQLite (`tunnel.enabled` / enabled-provider list). On Host ready, enabled providers are started again. On Host close, `tunnel.stop()` is called.

Consequences:

- `tsx watch` reloads, a Host process restart, or Ctrl+C of the Host **kill the tunnel**.
- The public URL can rotate. Remote Nodes then have to follow the new URL (Fleet does broadcast a changed Host URL, but the outage is real).
- This is why `npm run tunnel` / `npm run dev:tunnel` exist.

### 2.2 External tunnel (`npm run tunnel` / `npm run dev:tunnel`)

`apps/host/src/tunnel-process.ts` is a **sibling** process. It writes `apps/host/data/tunnel.json` (`provider`, `url`, optional `tunnelId`, `pid`). The Host reads that file via `readExternalTunnel()` and **adopts** a matching, control-plane-eligible provider: it publishes the URL, marks `external: true`, and **refuses to start or stop** that process.

The Settings switch is **disabled** while `state.external` is true. `POST /api/tunnel` still writes SQLite, but `setEnabled` returns immediately if an external process of that provider exists. Tests lock this in: stopping would kill a process the Host never started; starting would race a second binary onto the same local port.

`adoptOrKillStale()` runs when a **new** `tunnel-process` starts. A leftover live PID is **SIGTERM'd**, not adopted. A second `npm run tunnel` therefore kills the first.

Root scripts today:

```text
npm run tunnel          → tsx apps/host/src/tunnel-process.ts
npm run dev:tunnel      → concurrently: tunnel + host + node
```

README still documents `dev:tunnel` as the way to keep the public URL stable across `tsx watch` reloads.

### 2.3 Does `dev:tunnel` still work after the big changes?

**Mechanically yes, with two important caveats.** The scripts, the state file, Host adoption, and the disabled toggle are all still wired. Protocol/auth/orchestrator work did not remove this path.

Caveats:

1. **`concurrently` still owns the tunnel.** Ctrl+C of `dev:tunnel` stops tunnel, Host, and Node together. It only survives **Host-internal** restarts (tsx watch of `src/server.ts`), not a full terminal restart and not an OS reboot.
2. **Default provider is `bore`.** `tunnel-process.ts` uses `FLEET_TUNNEL_PROVIDER ?? "bore"`. Bore is `controlPlaneEligible: false`. The Host **will not adopt** it, will not put it on the enrollment URL, and reports it as an error. So `npm run tunnel` / `dev:tunnel` without `FLEET_TUNNEL_PROVIDER=devtunnel` (or `cloudflare` / `tailscale` / `ngrok`) is the wrong tunnel for the operator console.

Named Dev Tunnels already persist the **id** in Host settings so the URL can stay stable across Host-owned restarts. That does not keep the **hosting process** alive. `devtunnel host` dies with its parent unless something else is hosting it.

## 3. Desired contract

| Event | Desired |
| --- | --- |
| Operator turns a provider **on** in Settings | A tunnel process starts **outside** the Host process tree. Same local target (`127.0.0.1:PORT`). |
| Host process exits, tsx-watch reloads, or you rebuild/restart the Host | Tunnel process **keeps running**. URL does not rotate. |
| Host process starts again | Host **discovers** the live tunnel, uses its URL for enrollment / node broadcast, and the Settings switch is **usable** again. |
| Operator turns it **off** | Host asks the tunnel process to stop. Process exits. SQLite records disabled. Next Host start does not spawn one. |
| Operator turns it **on** after that | A new detached process is dispatched. |
| Two Hosts or two tunnel processes | Exactly one owner of a given provider. No silent second `devtunnel host` fighting for the same named tunnel. |
| OS reboot | Out of scope here unless the same process is also a boot/login task (companion doc). |

Non-goals for this slice:

- New tunnel providers.
- Changing Node dial rules (`devtunnel` stays not node-dialable; Nodes still use `--devtunnel <id>`).
- Making bore eligible for the operator console.
- Replacing SQLite as the source of *desired* enabled state.

## 4. Decision criteria (before options)

Weighted for this repo's actual use (Windows Host, Dev Tunnels as the default private path, frequent Host rebuilds during testing):

| Criterion | Weight | Must-have? |
| --- | --- | --- |
| Tunnel survives Host process death/rebuild | High | Yes |
| Settings can start **and stop** the detached process | High | Yes |
| Host re-adopts after restart without URL rotation | High | Yes |
| Dev Tunnels user login (DPAPI / user keychain) still works | High | Yes for the default provider |
| No second tunnel on the same provider/port | High | Yes |
| Works without `concurrently` / a dedicated extra terminal | Medium | Yes for the Settings-switch story |
| Survives OS reboot | Medium | No — compose with the service doc |
| Unix parity | Medium | Should not paint Unix into a corner |
| Smallest change to `TunnelManager` | Low | Nice |

## 5. Options

### Option A — Keep `dev:tunnel` / second terminal as the only detached path

**Do nothing in product code.** Document `FLEET_TUNNEL_PROVIDER=devtunnel` and run `npm run tunnel` in its own window (or fix the default). Host already adopts; toggle stays disabled.

| Pros | Cons |
| --- | --- |
| Already shipped; no new IPC | Toggle cannot stop the tunnel — fails the stated requirement |
| Survives tsx watch if tunnel is a sibling | `dev:tunnel` still dies on Ctrl+C; extra terminal is mandatory |
| | Default `bore` is a footgun |
| | `adoptOrKillStale` destroys a live tunnel if you start a second wrapper |

**Effort:** docs + default-provider fix only.  
**Verdict:** useful as a **developer workaround**, not the product answer.

### Option B — Host spawns a detached child, stop = kill PID

When Settings turns a provider on, Host `spawn`s `tunnel-process` (or the provider binary) with `detached: true`, `stdio` to a log file, `unref()`. State file stays the adoption channel. Stop = `process.kill(pid)` then clear the file. Host restart only **reads** the file; it does not parent the process.

On Windows, `detached` creates a new process group. That is enough for a normal console Host. If the Host is later wrapped in a kill-on-close Job (the Node service already does this for *its* children), the tunnel spawn must also break away from that Job, or stopping the Host task would take the tunnel down with it.

| Pros | Cons |
| --- | --- |
| Smallest code change; reuses `tunnel.json` + adoption | Kill-by-PID is crude (no drain, no “stop this provider only”) |
| Settings can on/off | A Host crash during spawn can leave orphans; a stale PID can be reused by an unrelated process |
| Survives Host rebuild; still runs as the interactive user, which Dev Tunnels needs | `tunnel-process.ts` currently **kills** leftovers instead of adopting them |
| | Does not survive OS reboot by itself |

**Effort:** small–medium (spawn/detach, stop path, PID liveness, tests, UI enablement).  
**Verdict:** acceptable **MVP** if we also invert `adoptOrKillStale` for the Host-owned case (adopt live matching provider; kill only mismatches / dead PIDs).

### Option C — Tunnel daemon with a control channel (recommended)

A long-lived **tunnel supervisor** process, not a fire-and-forget CLI child:

- One daemon per machine (or per Host data directory).
- Host is a **client**. Settings on/off, provider, local target, and persisted Dev Tunnel id are requests.
- Daemon owns provider child processes, restart backoff, and the state file.
- Discovery: state file in a **stable user-data path** (not `apps/host/data/tunnel.json` inside the checkout — a rebuild or `git clean` should not delete the live PID record).
- Control: loopback HTTP on a port recorded in the state file, with a random capability token in that file; or a named pipe `\\.\pipe\copilot-fleet-tunnel-<hostId>`. Either is better than SIGTERM of a guessed PID.
- Host `onClose` **must not** stop the daemon. Host `onReady` **connects** and asks “what is live?”. If SQLite says enabled and the daemon is down, Host **starts** the daemon (detached) and then asks it to host.
- Settings switch stays enabled. `external: true` becomes `managedBy: "daemon"` and is no longer a reason to disable the switch.
- `npm run tunnel` becomes “start or attach to the daemon in the foreground for logs”, not a second competing owner.
- `dev:tunnel` can stay as a convenience that starts daemon + host + node, but the daemon must **detach from concurrently** or concurrently will keep killing it.

| Pros | Cons |
| --- | --- |
| Matches the product story: Host rebuilds, tunnel stays, UI still owns on/off | More surface than Option B (control protocol, auth of the local token, single-instance lock) |
| Clean composition with a later login/boot task: the task runs **this daemon**, not the whole Host | Must define what happens if SQLite says off but daemon is still hosting (Host wins on connect) |
| One place for restart backoff, currently duplicated in `TunnelManager` | Windows named-pipe vs Unix socket vs loopback HTTP needs a pick |
| Can host several providers at once, which the supervisor already allows | |

**Effort:** medium. Most of `TunnelManager`’s spawn/parse/backoff moves into the daemon; the Host keeps desired state, adoption, backup/restore, and broadcast.  
**Verdict:** **recommended.** It is the same shape as today’s external tunnel, minus the “Host may not touch it” rule that blocks the UI.

### Option D — Provider-native services only

`cloudflared service install`, Tailscale always-on, a reserved ngrok domain. Host only stores `FLEET_PUBLIC_URL`. No Fleet-owned tunnel process.

| Pros | Cons |
| --- | --- |
| Best OS-reboot story for those providers | Dev Tunnels CLI has **no** first-class Windows service. Login token lives in the **user** secure store and expires after several days. Host tokens from `devtunnel token` expire on the order of **24 hours** and can only be refreshed by a real user identity |
| | Settings switch cannot represent “Fleet started this” vs “something else is forwarding 8787” |
| | Does not help the testing loop unless you already run those services |

**Effort:** docs + maybe a “use this URL” path.  
**Verdict:** keep as an **escape hatch** for production Cloudflare/Tailscale, not as the Dev Tunnels / Settings-switch design.

### Option E — Put the tunnel inside a Host Windows service

Register the Host as a boot task and let it parent the tunnel again.

| Pros | Cons |
| --- | --- |
| One process tree to think about | **Opposite** of the testing requirement: Host rebuild **kills** the tunnel |
| | Private Dev Tunnels cannot run as LOCAL SERVICE (see companion doc) |

**Verdict:** reject for this ask. The Host service is still worth doing; it must **not** be the tunnel’s parent.

## 6. Recommendation

**Build Option C**, with Option B as a sequenced first slice if you want a smaller PR:

1. **Slice 1 (B, tightened):** Settings on → detach `tunnel-process` with an explicit provider (never default bore). Settings off → stop via recorded PID **only if** the state file proves it is our process (command line / marker file, not PID alone). Host restart adopts. Invert leftover handling: matching live provider is adopted; only a different provider or a dead PID is cleared. Enable the UI switch for Host-detached tunnels. Keep true “another terminal started this and we do not own it” as a read-only badge if the marker does not match.
2. **Slice 2 (C):** replace PID kill with a loopback control channel and move spawn/backoff into the daemon. `npm run tunnel` attaches to that daemon.
3. **Slice 3 (companion doc):** the same daemon binary is what a login-time or boot-time task runs.

Do **not** keep the current rule “external ⇒ toggle disabled / setEnabled no-op”. That rule is why today’s `dev:tunnel` cannot satisfy “reboot Host, then close/open the tunnel again.”

## 7. Control-plane sketch (Option C)

```text
Browser  --POST /api/tunnel-->  Host (desired state in SQLite)
                                  |
                                  |  loopback HTTP or named pipe
                                  |  (token from state file)
                                  v
                             Tunnel daemon  (detached / optional Windows task)
                                  |
                                  +-- devtunnel host <persisted-id>
                                  +-- cloudflared ...
                                  `-- writes %APPDATA%\CopilotFleet\host\tunnel.json
                                         { provider, url, tunnelId, pid, control: { url, token } }
```

Invariants:

- SQLite is **desired** state. The daemon is **actual** state. Host ready reconciles: desired on + daemon down → start daemon; desired off + daemon up → stop; both on → adopt URL and broadcast if it changed.
- Backup/restore already refuses to replace an external tunnel that does not match. Keep that, but treat the Fleet daemon as **ours** so a restore can ask it to switch id/provider instead of telling the operator to kill a foreign terminal.
- Local target is always the Host’s `PORT`. Vite (5173) is never the tunnel target; that is already documented in ARCHITECTURE.md.
- Dev Tunnels `prepare` (`devtunnel create` / `port create`) can stay on the Host **or** move into the daemon; it needs the same user login either way. Do not run it as LOCAL SERVICE.

State file location: prefer `%APPDATA%\CopilotFleet\host\tunnel.json` (and the Unix XDG equivalent), overridable with the existing `FLEET_TUNNEL_STATE_FILE`. The checkout-relative `apps/host/data/tunnel.json` is why a clean/rebuild can desync PID tracking.

## 8. Risks and how to hold them

| Risk | Hold |
| --- | --- |
| PID reuse after crash | Marker (start time + exe path) or control-channel ping before kill |
| Two daemons | Absolute instance lock next to the state file (same pattern as Node `node.lock`) |
| Host `onClose` stops the tunnel | Explicit: `tunnel.stop()` only stops **in-process** children. Daemon is not a child. |
| `tsx watch` of Host during Slice 1 | Detached + unref so the watcher’s restart does not send SIGTERM to the tunnel |
| `concurrently` in `dev:tunnel` | Daemon must break away, or drop tunnel from the concurrently set and start it detached from Host |
| Default bore | Daemon and CLI default to `devtunnel` if unset, or refuse to start without an explicit eligible provider |
| Dev Tunnels login expired | Surface `devtunnel user show` failure on the Tunnel panel; do not silently mint a new unnamed tunnel (that is the cluster-split bug `shouldAdoptTunnelId` exists to prevent) |
| Job-object wrapping later | Document `CREATE_BREAKAWAY_FROM_JOB` as a requirement when Host becomes a scheduled task |

## 9. How this relates to the boot-service doc

- This doc: **who parents the tunnel** while you iterate on the Host.
- Companion: **who starts Host/Node/tunnel after the machine reboots**, without an Entra password.

If you only build this doc, testing gets a stable URL. If you only build a Host service that still parents the tunnel, testing keeps breaking the URL. Build the detached daemon first; register that same binary as a task second.

## 10. Decisions to confirm

Please mark these when you review:

1. **Option C (daemon + control channel)** as the target, with **Option B** as an optional first PR — or B-only?
2. Is “Host process restart during testing” the success bar, or must the first iteration also survive **OS reboot** (which forces the companion doc’s login vs boot identity choice)?
3. Should `npm run dev:tunnel` remain, once the Host can detach a daemon itself?
4. Default provider for the detached path: **devtunnel**, or require an explicit provider and fail closed?

No code until this file is accepted.
