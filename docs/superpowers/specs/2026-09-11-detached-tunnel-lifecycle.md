# Detached tunnel lifecycle: a tunnel that outlives the Host

**Date:** 2026-09-11
**Status:** Brainstorm / options for review — no implementation
**Scope:** Run the tunnel as a process the Host does not own, so rebuilding or restarting the Host never rotates the public URL; and give the Host back the ability to adopt, stop and start that process.

## The question this answers

> Can we turn the tunnel on/off but dispatch it as a separate process, detached from the main session, so that when I restart the Host the tunnel survives — and when the Host comes back it picks the running tunnel up again and can still close/open it? `npm run dev:tunnel` exists but I am not sure it still works after the big changes.

Short answer: the bones of this already exist (`tunnel-process.ts` + `data/tunnel.json` + `readExternalTunnel`), it is **half-built**, and the half that is missing is exactly the half you are asking for — detachment and control. Below is what today actually does, the seven specific reasons it does not meet the bar, and three ways to close the gap.

---

## 1. What exists today

There are **two** tunnel paths in the tree, and they behave very differently.

### Path A — Host-managed child (the one you are actually running)

`TunnelManager.start()` in `apps/host/src/tunnel.ts:377`:

```ts
const child = spawn(spec.binary, spec.args(this.target, reusedId), {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
this.child = child;
```

The provider CLI is a **piped child of the Host process**. The Host parses its stdout for the URL. When the Host dies — `tsx watch` reload, Ctrl-C, rebuild — the child's stdio pipes break and the tunnel goes with it.

This is what is live on this machine right now: `devtunnel` is running as pid `33588`, and `apps/host/data/tunnel.json` **does not exist**. No external tunnel is in play.

Path A does have one real asset: for Dev Tunnels it persists a `tunnelId` (`persistedTunnelId.set`), and `shouldAdoptTunnelId` (`tunnel.ts:123`) adopts the cluster-qualified name the CLI reports. So the **URL is already stable across Host restarts for `devtunnel`** — the tunnel briefly drops and comes back at the same address. For `cloudflare` quick tunnels and `bore`, the URL rotates every single time.

### Path B — External tunnel process (`npm run tunnel`)

`apps/host/src/tunnel-process.ts` is a standalone wrapper. It spawns the provider, writes `data/tunnel.json`:

```json
{ "provider": "...", "url": "...", "tunnelId": "...", "pid": <provider pid> }
```

…and the Host *reads* that file via `readExternalTunnel()` (`external-tunnel.ts:41`), gated on `isProcessAlive(pid)`.

`npm run dev:tunnel` runs Path B alongside the Host under `concurrently`.

The header comment states the design intent plainly:

> ownership stays here, which keeps the process a **child of the terminal** rather than an orphan nobody is tracking.

That sentence is the whole problem. "Child of the terminal" is precisely what you want to stop being.

---

## 2. Why `dev:tunnel` does not give you what you want

Seven distinct defects, in rough order of how quickly they bite:

| # | Defect | Where | Consequence |
| --- | --- | --- | --- |
| 1 | **Default provider is `bore`, which is not installed on this machine** | `tunnel-process.ts:14` | `npm run tunnel` dies instantly unless you set `FLEET_TUNNEL_PROVIDER`. Verified: `bore` → NOT FOUND on PATH. |
| 2 | **`bore.controlPlaneEligible = false`** | `tunnel-providers.ts:218` | Even if `bore` ran, `refusedExternal()` makes the Host report `status: "error"` with `ineligibleProviderMessage`. The default config is a guaranteed error state. |
| 3 | **Not detached** | `tunnel-process.ts` | No `detached: true`, no `unref()`. It is a foreground child; `concurrently` and Ctrl-C take it down with everything else. |
| 4 | **`adoptOrKillStale` kills rather than adopts** | `external-tunnel.ts:75` | Despite the name, restarting the wrapper **SIGTERMs the live provider** and starts a new one. For any provider without a persisted id, that rotates the public URL — the exact thing you are trying to prevent. |
| 5 | **The Host can read but not control** | `tunnel.ts:295`, `tunnel.ts:466` | `setEnabled()` and `stop()` both early-return when an external tunnel is present ("Never signal a process this manager did not spawn"). So the UI toggle is dead for external tunnels — no close/open. |
| 6 | **The state file records the provider pid, not the wrapper pid** | `tunnel-process.ts:61` | There is no handle on the supervising wrapper, so there is nothing to ask for a *graceful* stop. Only the raw provider can be signalled. |
| 7 | **PID reuse is unguarded** | `external-tunnel.ts:59`, `:89` | Liveness is `process.kill(pid, 0)` and nothing else. After a machine reboot the recorded pid can belong to an unrelated process: the Host will advertise a dead URL, or `adoptOrKillStale` will **SIGTERM an innocent process**. This is a correctness bug today and a safety bug the moment the state file outlives a boot. |

### The Windows-specific trap that will bite next

Two more things are true on Windows specifically and must be designed around, not discovered later:

- **`process.kill(pid, "SIGTERM")` on Windows is `TerminateProcess`.** There is no graceful signal. A sidecar can never run its own cleanup in response. Any "ask the tunnel to stop" design that relies on signals will always be a hard kill on your primary platform.
- **`detached: true` is not sufficient to escape a terminal.** Windows Terminal, VS Code and Cursor commonly place child processes in a **Job Object** with `KILL_ON_JOB_CLOSE`. Every process in that job dies when the terminal closes, detached or not. Node does not expose `CREATE_BREAKAWAY_FROM_JOB`. The reliable escapes are to have something *outside* your job create the process: `cmd /c start /b`, WMI `Win32_Process.Create`, or — best — a **Scheduled Task** (see §4, Approach C, and the companion doc).

---

## 3. Requirements

| ID | Requirement |
| --- | --- |
| **R1** | The tunnel survives Host exit: `tsx watch` reload, `npm run build`, Ctrl-C, crash. |
| **R2** | On start, the Host **discovers and adopts** a running tunnel instead of killing it or ignoring it. |
| **R3** | The Host can **stop and start** the adopted tunnel from the UI. Adoption is not read-only. |
| **R4** | The public URL does not change across a Host restart, and does not change across a *tunnel* restart where the provider supports a stable id. |
| **R5** | No orphan pile-up on the same local port, and **never** a signal sent to a process that is not ours. |
| **R6** | Closing the terminal that started the tunnel does not kill it (Windows job-object escape). |
| **R7** | *Stretch:* survives a machine reboot. This is the companion doc's territory — see `2026-09-11-boot-persistent-service.md`. |

Non-goals: changing the provider catalog, changing enrollment, making `bore` control-plane eligible.

---

## 4. Three approaches

### Approach A — Detached sidecar + richer state contract *(recommended first move)*

Keep `tunnel-process.ts` as the unit of work; upgrade it from "foreground wrapper" to "daemon", and upgrade the state file from "a pid" to "a control surface".

**A1. Actually detach.** A tiny `scripts/tunnelctl.mjs` launches the sidecar with `detached: true`, `stdio: ["ignore", <log fd>, <log fd>]`, then `unref()`s and exits. Logs go to `data/tunnel/<provider>.log` instead of the terminal, which is what makes stdio-free detachment possible. On Windows, launch through `cmd /c start /b` (or a Scheduled Task) to break out of the terminal's job object — R6.

**A2. Richer, forgery-resistant state.** Move from `data/tunnel.json` to `data/tunnel/<provider>.json`, one file per provider (the supervisor already runs one manager per provider, so a single shared file is a latent collision):

```jsonc
{
  "schema": 2,
  "provider": "devtunnel",
  "supervisorPid": 12345,       // the sidecar — who we ask to stop
  "providerPid": 12346,         // the CLI — who actually forwards traffic
  "supervisorStartedAt": 1757...,  // identity guard, see A3
  "bootId": "…",                // random per machine boot
  "targetPort": 8787,
  "url": "https://….devtunnels.ms",
  "tunnelId": "fleet-abc.usw2",
  "logPath": "…/tunnel/devtunnel.log",
  "desired": "on"               // control channel, see A4
}
```

**A3. Kill the PID-reuse hazard (R5).** Liveness becomes *pid is alive* **AND** *its start time matches `supervisorStartedAt`* (`(Get-Process -Id n).StartTime` / `/proc/<pid>/stat` / `ps -o lstart`). Additionally, a `bootId` mismatch means the file predates this boot and every pid in it is meaningless — reap the file, never signal. This single change makes adoption safe; without it, adoption is a loaded gun.

**A4. Control without signals (R3, and the Windows signal problem).** The Host does not signal the sidecar. It writes `desired: "off"` into the state file; the sidecar polls its own file every ~500 ms and exits cleanly when `desired` flips. Restart is `tunnelctl start <provider>`, which the Host can invoke directly. Two properties this buys:

- Graceful stop works identically on Windows and POSIX.
- The Host never holds a handle to a process it did not spawn, so the "never signal a process this manager did not spawn" invariant in `tunnel.ts:466` is *preserved rather than violated* — it just stops being a reason to refuse.

  *(Alternative if polling feels crude: a loopback control endpoint — named pipe on Windows, unix socket elsewhere — with a token stored in the state file. Strictly better UX, strictly more code. The intent-file design can be swapped for it later without changing the Host-side API.)*

**A5. `adoptOrKillStale` → `adoptOrReap`.** Adopt when: same provider, same `targetPort`, same `bootId`, pid+start-time verified. Kill only when the state is stale or the target port disagrees. Rename it, because the current name says "adopt" and the code only kills.

**A6. `TunnelManager` gains an adopted mode.** `state()` already distinguishes `external: true`; add `controllable: true` and let `setEnabled(false)` route to the `desired` flip instead of early-returning. The UI toggle then works uniformly whether the tunnel is a child or a sidecar.

**A7. Fix the defaults.** `tunnel-process.ts` should default to a provider that is installed and control-plane eligible, or refuse to start with a clear message naming `FLEET_TUNNEL_PROVIDER`. Silently defaulting to `bore` — uninstalled *and* ineligible — is two dead ends in one line.

| Pros | Cons |
| --- | --- |
| Smallest delta on code that already exists | Still a bespoke daemon to maintain |
| Unblocks the dev loop this week | Intent-file polling adds up-to-500 ms stop latency |
| `tunnelctl` becomes a clean seam that B or C can slot behind | Per-boot `bootId` plumbing is new surface |
| Fixes a live safety bug (#7) regardless of which approach wins | |

---

### Approach B — A real tunnel daemon the Host is merely a client of

Pull tunnels out of the Host entirely. One long-lived `fleet-tunneld` owns every provider, exposes a loopback API (`GET /tunnels`, `POST /tunnels/:provider {enabled}`), and the Host becomes a consumer with no spawn logic at all.

| Pros | Cons |
| --- | --- |
| Cleanest separation; Host restarts are genuinely irrelevant | Largest change; deletes/rewrites `TunnelManager` |
| R3 falls out naturally — it is an API, not a file poke | A new locally-listening surface that must be bound to loopback **and** token-guarded |
| One daemon is the obvious thing to register as a boot service (R7) — converges with the companion doc | Two services to install, version and update instead of one |
| Multi-provider state lives in one place instead of N files | Protocol/version skew between Host and daemon becomes a real concern |

This is where the architecture probably wants to end up. It is not where it should go first.

---

### Approach C — Delegate the process lifetime to the OS

Do not write a daemon. Register the tunnel as a **per-user Scheduled Task** (Windows) / **launchd LaunchAgent** (macOS) / **`systemd --user` unit** (Linux). "On" is `schtasks /Run /TN CopilotFleetTunnel`; "off" is `schtasks /End`. The task still writes the state file so the Host can read the URL.

| Pros | Cons |
| --- | --- |
| Least code by a wide margin | URL discovery still needs the state-file contract from A2/A3 — this does not replace that work |
| The OS handles restart-on-crash, and R6 is free (Task Scheduler starts processes outside your terminal's job object) | `schtasks /End` is a hard kill — same graceful-stop problem, now without a sidecar to fix it |
| R7 is free — same mechanism gives boot persistence | On/off latency is seconds, not milliseconds |
| Identical mechanism to the Node/Host service work, so one thing to learn | Install/uninstall UX per platform; needs the preflight work from the companion doc |

**The convergence worth noticing:** on Windows, the most reliable way to get a process that is genuinely independent of your terminal *is* a Scheduled Task. That is the same machinery the companion doc needs for boot-persistent Host/Node. One mechanism, three uses — tunnel, Node, Host.

---

## 5. Recommendation

**Do A now, design it so C can take over process lifetime later, keep B as the destination.**

Concretely:

- **P0 — unblock the dev loop (hours).** Fix the `bore` default (#1/#2). Add `detached: true` + `unref()` + file logging + the Windows job-object escape (#3, R1/R6). Change `adoptOrKillStale` to adopt on a match (#4, R2). You get "rebuild the Host all day without touching the tunnel" from this step alone.
- **P1 — make adoption safe and controllable (days).** Schema-2 state file with `supervisorPid` + start-time + `bootId` (#6/#7, R5). `desired` intent channel and `TunnelManager` adopted-mode so the UI toggle works (#5, R3).
- **P2 — lifetime to the OS (optional).** Have `tunnelctl install` register the Scheduled Task / LaunchAgent / user unit. Because P1 defined the state contract, the Host does not change at all — R7 for free.
- **P3 — extract the daemon (only if multi-provider control gets messy).** B.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Adopting a tunnel pointed at a *different* local port silently splits the fleet | `targetPort` is in the state file and is part of the adopt predicate (A5) |
| PID reuse causes the Host to kill an unrelated process | Start-time + `bootId` verification (A3). **This is already a live bug — worth fixing even if nothing else here ships.** |
| Two sidecars race for the same provider/port | Per-provider state file written with `wx`, plus the adopt predicate |
| A detached sidecar becomes an untracked orphan the operator cannot see | File logging at a known path, plus the state file being the single discovery point; `tunnelctl status` lists them |
| Stable-URL expectations differ per provider | Already true today: `devtunnel`/`tailscale` are stable, `cloudflare` quick tunnels and `bore` are not. Surface this in the UI rather than pretending detachment fixes it |
| Detached sidecar keeps running after the repo is deleted/moved | `bootId` + a heartbeat timestamp; `tunnelctl` reaps sidecars whose checkout is gone |

## 7. Open questions

1. Should the sidecar host **all enabled providers** in one process, or one sidecar per provider? (One-per-provider matches `TunnelSupervisor`'s existing shape and keeps failures isolated; one-process is fewer moving parts.)
2. Is 500 ms stop latency acceptable, or is the named-pipe/unix-socket control channel worth building up front?
3. Should `data/tunnel/` live in the checkout at all? A detached, boot-surviving tunnel arguably belongs in `%APPDATA%\CopilotFleet` / `~/.config/copilot-fleet` alongside the node identity, so it survives `git clean`.
4. When the Host starts and finds an adopted tunnel whose provider is **not** the one the operator has enabled in settings — adopt, refuse, or stop it?

---

## Appendix — how to get a surviving tunnel *today*, unchanged

`npm run dev:tunnel` will fail out of the box because of defects #1/#2. Until P0 lands, run the tunnel in **its own terminal** with an installed, eligible provider, and run the Host separately:

```powershell
# terminal 1 — the tunnel, on a provider that is installed and control-plane eligible
$env:FLEET_TUNNEL_PROVIDER = "devtunnel"   # or "cloudflare"; NOT "bore"
$env:PORT = "8787"
npm run tunnel

# terminal 2 — rebuild/restart this as often as you like
npm run host
```

Caveats that still apply, and that P0/P1 are meant to remove:

- Closing terminal 1 — or the whole window — still takes the tunnel down (#3, R6).
- Restarting terminal 1 **kills and replaces** the provider (#4), so on `cloudflare` the URL rotates. On `devtunnel` it does not, because the tunnel id is persisted.
- The Host's tunnel toggle will not control it (#5); it is read-only.
- If the machine reboots while `data/tunnel.json` still exists, the Host may adopt a stale pid (#7).
