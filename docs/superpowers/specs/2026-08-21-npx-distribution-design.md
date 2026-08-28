# NPX distribution for Host and Node

**Date:** 2026-08-21
**Status:** Accepted — 2026-08-27, by Charles. npm scope locked as `@copilot-fleet`; git update path aligned with the current `updater.ts` (fetch + reset onto `@{u}`, not pull).
**Scope:** Start a Host or a Node with `npx`, keep git-checkout `npm run` working, and let any mix of the two enroll, update, and reconnect on the existing protocol.
**Review follow-up (2026-08-27):** Copilot's review of the accepted spec found three blockers — `publishConfig.name` does not rename an npm package, the Node tarball was missing `agents/` and `public/`, and install-kind detection could walk out of the prefix into an ancestor checkout. All three are folded in below as locked decisions. **Second pass (2026-08-28):** the first two remain resolved; rewriting packed `@fleet/*` *dependency keys* to `@copilot-fleet/*` would leave compiled `import "@fleet/protocol"` unresolved (`ERR_MODULE_NOT_FOUND`). Packed deps keep those keys and alias them (`"@fleet/protocol": "npm:@copilot-fleet/protocol@<same version>"`). The tarball smoke test must launch the installed bin. **Third pass (2026-08-28, local pack):** there is no `bin/` directory — Node's bin file is `supervisor.mjs` at the package root; Host gets a shebang wrapper `host.mjs` there. Packed `files` is mandatory: root `.gitignore` has `dist/`, so an unrewritten protocol pack after `tsc` ships **0** dist files, and pointing Node's bin at `supervisor.mjs` without `files` drops Node dist from 69 files to 0. `npm:` aliases only work for registry deps, so a local smoke test cannot `npm install` the three tarballs together as-is; it must `file:`-install protocol under the `@fleet/protocol` key (or `overrides`) and then launch the bin. Publish protocol to the registry first. Still Accepted.

## The question this answers

> Operators currently clone the repo and run npm. How do we ship `npx` for both Host and Node, allow npx/npm Hosts to mix with npm/npx Nodes, support both in the Connect command, and keep auto-update / auto-reconnect honest?

## What today assumes

Every supported run path is a git workspace:

| Surface | Assumption |
| --- | --- |
| Connect card / README | `npm install && npm run build:node && npm run start:node -- …` from a clone |
| Revision | `git rev-parse` (`packages/protocol/src/runtime.ts`) |
| Staleness | Host SHA vs Node SHA (`nodeUpdateState`). Semver (`0.3.0`, read from `package.json`) is reported but not compared |
| Update | `git fetch --prune`, then `git reset --hard` onto `@{u}`, `npm install`, `npm run build:node`, then exit 75 (`apps/node/src/updater.ts`). Local commits and edits to tracked files are discarded; untracked files — `.env` included — survive |
| Supervisor | `cwd` is the repo root; child is `apps/node/dist/main.js` (`apps/node/supervisor.mjs`) |
| Host DB / `.env` | `apps/host/data` and the repo-root `.env` |
| Node identity | Already *not* in the checkout: `%APPDATA%\CopilotFleet` / `~/.config/copilot-fleet` |

A tarball or npx unpack has no `.git`. It reports `revision: ""`, shows **Unknown**, and `updateCheckout` fails with "not a git checkout". The protocol (hello, host-url sync, outbox, auto-resume) does not care how the binary arrived. Distribution, build identity, and the update/restart path are what break.

`npx` specifically:

- Unpacks under `~/.npm/_npx/<hash>/`, keyed by the requested spec. That directory is not a checkout and is fair game for `npm cache clean`.
- The npx process is the parent. When the bin exits, npx exits. Exit 75 without a supervisor in the bin means the machine is left with nothing running.
- `@fleet/node` already declares `"bin": { "copilot-fleet-node": "./dist/main.js" }` but `"private": true`, so the bin is not what a long-running npx Node needs — it skips the supervisor.

## Goal

An operator with Node.js 22.5+ and an authenticated Copilot CLI can paste one line from the Connect card, in any directory, and get a Node. The same for a Host. A clone remains the way to hack on the code (`npm run dev`). The fleet may be any mix of the two install kinds. Update and reconnect keep the contracts they have today: fail closed, same `nodeId`, same inventory/auto-resume.

## Non-goals

- A Host self-update button. The operator restarts an npx Host with `npx @copilot-fleet/host@latest`.
- `npm i -g` as a first-class Connect-card path.
- `npx github:org/repo` as a supported channel.
- Bundling `@fleet/protocol` into the app tarballs.
- Changing auto-resume, host-url sync, the exit-75 storm guard, or `argvForRestart`.
- Running `npx` under PM2/NSSM/systemd.
- Version-pinning the Node runtime prefix (`npx pkg@1.0.0` must not downgrade a newer prefix).
- Two Nodes on one machine (git + npx). The instance lock already forbids this.

## Decisions (locked)

| Topic | Choice |
| --- | --- |
| Install kinds | `git` \| `npm`. A property of a process, not of the fleet |
| Install-kind detection bound | Never walk above the running package's root: the workspace root that owns this `apps/*` package (git), or the runtime prefix (npm) |
| How `npx` Node stays alive across updates | Persistent runtime prefix + supervisor bin. Not the npx cache |
| How `npx` Host runs | From this invocation's unpacked package. No Host runtime prefix. Data is not in that package |
| What staleness compares | Git SHA, as today. Semver exists so npm has an install target |
| SHA for an npm process | Baked at build/publish into `dist/revision.json`; `buildRevision()` is live git SHA, else baked |
| `update_node` payload | Unchanged: `{ type, updateId }`. The Node picks git fetch + reset vs `npm install @latest` |
| npm update analog of the git fetch + reset | `@latest`, after the operator has updated the Host |
| Protocol addition | Optional `installKind` on hello / register / `FleetNode`. Older Hosts strip it |
| Capability | npm Nodes advertise `self-update` |
| Connect card | Two commands, toggle **npx** (default) \| **From a checkout** |
| npm package names | `@copilot-fleet/protocol`, `@copilot-fleet/host`, `@copilot-fleet/node` |
| npm org / scope | `@copilot-fleet` — confirmed by Charles, 2026-08-27 |
| Bins | `copilot-fleet` → `./host.mjs`; `copilot-fleet-node` → `./supervisor.mjs`. Both files sit at the package root. There is no `bin/` directory today and the pack step must not invent an empty one. |
| Node bin in the tree | Change `"bin": { "copilot-fleet-node": "./supervisor.mjs" }` in `@fleet/node` so git `npm run start:node` and npx share one entry. Pack rewrite must set that path even if the tree still points at `./dist/main.js`. |
| Packed `files` | Mandatory on every packed manifest. Protocol: `["dist"]`. Node: `["dist", "supervisor.mjs", "agents", "public"]`. Host: `["dist", "host.mjs"]`. `package.json` is always included. This is what includes gitignored `dist/` and excludes `src/` and tests. |
| Workspace names | Stay `@fleet/*`; the pack step rewrites only the packed `name`, never the tree |
| Publish manifests | Rewritten at pack time, never in the tree: `name` → `@copilot-fleet/*`; `@fleet/*` dependency **keys stay**; their specs become `npm:@copilot-fleet/<pkg>@<same version>`; `private` dropped; `publishConfig.access` `"public"`; Node/Host `bin` pointed at the shebang wrappers; `files` set as above. Do not rewrite `dist/` import specifiers |
| Node tarball contents | `dist/`, `supervisor.mjs`, `agents/`, `public/`, `package.json` — the runtime reads `packageRoot()/agents` and `packageRoot()/public` |
| Host tarball contents | `dist/` (including `dist/ui/`), `host.mjs`, `package.json` |
| Protocol tarball contents | `dist/`, `package.json` |
| Packed tarball smoke test | Pack all three. Local/CI cannot resolve `npm:` aliases (`npm` error: "aliases only work for registry deps"). Install in a clean directory with protocol under the **`@fleet/protocol` key** via `file:` (root dep or `overrides`), plus the host and node tarballs. Assert `agents/` and `public/` at the Node runtime paths, **and launch both bins** (Node `--help` / Host dry start that exits). `npm install node.tgz protocol.tgz` together is not enough: protocol's packed `name` is `@copilot-fleet/protocol`, so it does not satisfy the `@fleet/protocol` key, and the alias still hits the registry. |
| Publish order | Protocol to the registry first, then host and node. `npx @copilot-fleet/node` needs `@copilot-fleet/protocol` already published to resolve the alias. |
| Publish trigger | Git tags `v*`, versions bump together |
| Node identity | Existing config directory. Unchanged |
| Host data (npm) | User data directory, not next to the code |
| Host data (git) | Today's `apps/host/data` and repo-root `.env` |
| cwd `.env` for npm Node | Not read. Flags + `settings.json` + optional file in the config directory |
| Prefix on start | Upgrade to at least the launcher's version; never auto-downgrade |
| Hello `version` | `package.json` semver. Already landed: `packageVersion()` reads it and hello / register send it; nothing hardcodes `"0.1.0"` anymore |
| Unpublished git Host vs npm Node | SHA mismatch stays `stale`. Do not invent a match. Caption for any stale npm Node: it installed `@latest`, which only matches a Host built from that published commit |

## Approaches rejected

### A. Run from the npx cache; no remote update for npm Nodes

Cheap. It abandons Update all for every Node that was enrolled the new way, which is the feature that exists so a protocol change is not a tour of every machine.

### B. Persistent prefix + supervisor (this design)

`npx` is a launcher. Long-running code lives in a directory Fleet owns. The supervisor contract is the one already documented in README / ARCHITECTURE.md.

### C. Global `npm i -g` as the real install

Writable global prefix, nvm/fnm, and Windows elevation make a worse first-run than a user-owned prefix. Process managers may still point at the prefix; that is documented, not a Connect-card option.

## Architecture

The fleet does not grow a second protocol. Install kind only changes (1) where bits live, (2) how those bits are replaced, (3) which command the Connect card copies.

```text
  operator paste
        │
        ├─ npx @copilot-fleet/host ──▶ this unpack's dist/server.js
        │                              data → user data dir
        │
        └─ npx @copilot-fleet/node ──▶ supervisor (the bin)
                                       │
                                       ├─ git checkout?  spawn apps/node/dist/main.js
                                       │                 cwd = repo root
                                       │                 update = fetch + reset + install + build
                                       │
                                       └─ npm?           ensure prefix ≥ launcher version
                                                         spawn prefix/.../dist/main.js
                                                         update = npm install @latest in prefix

  both children ── hello { nodeId, revision: SHA, installKind } ──▶ Host
  Host compares SHA, sends update_node, settles on reconnect
```

### 1. Published packages

Three packages, because they are already three workspaces:

| Workspace | npm name | bin |
| --- | --- | --- |
| `@fleet/protocol` | `@copilot-fleet/protocol` | — |
| `@fleet/host` | `@copilot-fleet/host` | `copilot-fleet` → `./host.mjs` |
| `@fleet/node` | `@copilot-fleet/node` | `copilot-fleet-node` → `./supervisor.mjs` |

`npx @copilot-fleet/host` and `npx @copilot-fleet/node` run the only bin of each package.

Tarballs contain what the runtime reads, not only what `tsc` emits, and they are shaped by packed `files`, not by gitignore. Root `.gitignore` has `dist/`. Local `npm pack --dry-run` after `tsc`:

- `@fleet/protocol` ships **0** dist files and 8 `src/` files (including tests). `exports` pointing at `dist/` does not override gitignore.
- `@fleet/node` ships `dist/` today only because `"bin"` is `./dist/main.js`, which forces those files in; it also ships 45 `src/` files, 22 tests, `supervisor.mjs`, `agents/`, `public/`, and **no** `bin/` directory. Pointing `bin` at `./supervisor.mjs` without a `files` whitelist drops dist from 69 files to **0**.
- `@fleet/host` has no `bin` and no `files`.

Packed `files` is therefore mandatory: protocol `["dist"]`; Node `["dist", "supervisor.mjs", "agents", "public"]`; Host `["dist", "host.mjs"]`. Node: `builtinAgentDirectory()` is `packageRoot()/agents` (`apps/node/src/agent-catalog.ts`) and the config page is served from `packageRoot()/public` (`apps/node/src/config-assets.ts`), so a tarball without those directories is a Node with no built-in agents and a blank config page. Host: `dist/` includes `dist/ui/` (Vite `outDir`) plus `host.mjs`. Not `src/`, not tests, not a phantom `bin/` directory.

`publishConfig.name` is not how the packages get their npm names. npm ignores it — renaming through `publishConfig` is a pnpm 11.18+ feature, and this repo is npm workspaces with a `package-lock.json`. The workspaces keep their `@fleet/*` names. The pack step rewrites the manifest that goes into each tarball: `name` becomes the `@copilot-fleet/*` name, `private` is dropped, `publishConfig.access` is `"public"`, `files` is set as above, and bins are `copilot-fleet` → `./host.mjs` and `copilot-fleet-node` → `./supervisor.mjs`. `@fleet/*` **dependency keys stay**, because compiled JS still `import … from "@fleet/protocol"` (and `@fleet/protocol/runtime`); renaming the key would install `@copilot-fleet/protocol` under a folder the import cannot see and throw `ERR_MODULE_NOT_FOUND`. The packed spec is an npm alias, e.g. `"@fleet/protocol": "npm:@copilot-fleet/protocol@0.3.0"`. Do not rewrite import specifiers in `dist/`. `npm publish --dry-run` on an unrewritten `@fleet/host` (still `private`, still named `@fleet/host`) is the failing test the name/`private`/`access` rewrite exists to pass. The tree is never renamed.

`npm:` aliases only work for registry deps. A local smoke that `npm install`s `node.tgz` and `protocol.tgz` together still 404s on `@copilot-fleet/protocol`, because the protocol tarball's `name` is `@copilot-fleet/protocol` and does not occupy the `@fleet/protocol` key the Node import needs. The smoke test therefore `file:`-installs protocol **as** `@fleet/protocol` (a root dependency or `overrides`) alongside the host and node tarballs, asserts `agents/` and `public/` at the runtime paths, and launches both bins. Checking files alone would miss `ERR_MODULE_NOT_FOUND`. Once protocol is on the registry, `npx` resolves the alias for real; publish protocol first, then host and node.

If `@copilot-fleet/*` cannot be used, only the rewrite target changes. Bin names stay. Unscoped `npx copilot-fleet` is a later wrapper, not required for mixing.

### 2. Build identity

`version` is already semver from `package.json` — `packageVersion()` in `packages/protocol/src/runtime.ts` reads it, and the packages sit at `0.3.0` — and must move on every publish. It is not what the Nodes table compares.

`revision` remains a 12-character git SHA.

- A git process: `git rev-parse --short=12 HEAD` (today).
- An npm process: `dist/revision.json` written at build (`{ "revision": "<sha>" }`). `git` is not consulted in the prefix at all: `git rev-parse` walks up on its own, and a prefix that happens to sit under someone's checkout would answer with that ancestor's SHA.

One helper, used by Host and Node:

```ts
buildRevision() = installKind === "git" ? gitRevision() : readBakedRevision()
```

Empty SHA is still **Unknown**: an unpack that was not built in CI, or a Host too old to report one.

This is what makes a mix comparable. An npx Host published from commit `abc123cdef45` and a git Node on that commit are **Up to date**. Semver equality would not be, once `0.3.0` starts moving on only one side.

### 3. Install kind

Detected from the code's own tree (`import.meta.url`), never from `cwd`. `npx` is started from random directories; a parent `package.json` or an unrelated `.git` must not decide.

The walk is bounded, which today's `repoRoot()` is not. `repoRoot()` climbs until it finds a workspaces manifest; started from an npm prefix under `~/.local/share` or `%LOCALAPPDATA%`, that climb can leave the prefix, reach whatever git repository happens to contain the operator's home tooling, and adopt it. The process misclassifies as `git`, hellos with a stranger's SHA, and Update would `git reset --hard` a checkout that has nothing to do with Fleet. So detection never walks above the running package's root: for a checkout, the workspace root that contains this package as `apps/node` / `apps/host`; for npm, the runtime prefix.

```ts
git  = the bounded root is the monorepo layout — this package under `apps/`,
       workspaces manifest and `.git` at that root
npm  = anything else
```

An npm process never calls `gitRevision()` or `updateCheckout` against an ancestor directory. A clone nested inside another project still classifies as `git`: its own workspace root is the bound, and everything above it is never consulted.

Hello, register, and the snapshot's node object gain:

```ts
installKind?: "git" | "npm"
```

Omitted by old Nodes. Stripped by old Hosts (Zod objects strip unknown keys). The UI treats missing as: show no kind badge; SHA comparison unchanged.

### 4. Where state lives

**Node identity — already correct.** `node.json` and `settings.json` stay in:

- Windows: `%APPDATA%\CopilotFleet`
- Unix: `${XDG_CONFIG_HOME:-~/.config}/copilot-fleet`

Reconnect after an npx update is the same as reconnect after a git update: new process, same files, same `nodeId`.

**Node code (npm) — new.** A persistent npm prefix, not `~/.npm/_npx`:

- Windows: `%LOCALAPPDATA%\copilot-fleet\runtime\node`
- Unix: `${XDG_DATA_HOME:-~/.local/share}/copilot-fleet/runtime/node`
- Override: `FLEET_NODE_RUNTIME`

Layout: a prefix `package.json` plus `node_modules/@copilot-fleet/node`. The child is always

```text
<prefix>/node_modules/@copilot-fleet/node/dist/main.js
```

**Host data (npm) — must move.** SQLite, generated secrets, and `.env` cannot sit next to npx files.

- Windows: `%LOCALAPPDATA%\copilot-fleet\host\`
- Unix: `${XDG_DATA_HOME:-~/.local/share}/copilot-fleet/host\`
- Override: `FLEET_DATA_DIR`; `DATABASE_PATH` still wins when absolute

**Host data (git) — unchanged.** `apps/host/data/fleet.db` and repo-root `.env`.

A machine that once ran a git Host and later runs an npx Host is two Hosts unless `DATABASE_PATH` / `FLEET_DATA_DIR` is pointed at the old files. That is explicit, not automatic migration. Export/import already exists for a deliberate move.

**Host code (npm)** runs from the unpack of *this* `npx` invocation. There is no Host prefix. The Host does not self-update from the UI; the operator is at the keyboard. `npm cache clean` during a run is accepted as the same class of hazard as deleting a clone while `npm run host` is up.

First npx Host boot in production: if `ENROLLMENT_TOKEN` is unset, generate one, write the data-dir `.env`, print it once — the same shape as the generated operator password — and only then apply the existing "refuse `change-me` in production" check.

Tunnel binaries stay on PATH. They were never downloaded into the repo.

**npm Node `.env`:** load `$configDirectory/.env` if present. Do not load `cwd/.env`. A Connect-card paste in a random repo must not inherit that repo's `FLEET_HOST_URL`.

### 5. Supervisor

No second restart protocol. Exit 75, storm guard (five in twenty seconds), `FLEET_RESTART_MODE=exit`, `argvForRestart` dropping persisted flags — all stay.

The published Node bin *is* `supervisor.mjs` (today the private bin points at `dist/main.js`, which is why npx would skip the supervisor). Git `npm run start:node` / `npm run node` call the same file. Implementation moves the tree `bin` to `./supervisor.mjs` and the pack step writes that path; it does not create a `bin/` directory. The Host bin is a new `host.mjs` shebang wrapper that runs `dist/server/server.js` — Host has no bin today.

On start:

1. `git` — today's target (`tsx` when `--dev`, else `apps/node/dist/main.js`), `cwd` = repo root, `FLEET_RESTART_MODE=exit`.
2. `npm` — `ensureRuntimePackage`, then spawn the prefix `dist/main.js` with `FLEET_RESTART_MODE=exit`. Do not spawn `main.js` from the npx cache.

`ensureRuntimePackage`:

- Missing prefix → `npm install @copilot-fleet/node@<launcher version>` in the prefix.
- Prefix older than the launcher (semver) → install the launcher's version. So `npx @copilot-fleet/node@latest` moves the long-running tree, not only the cache.
- Prefix newer than the launcher → leave it. An older npx must not downgrade a Node that Host Update already moved.

On exit 75 the supervisor re-resolves the prefix entry and spawns again. It must not re-exec the cache copy of `main.js`; that copy is the version that started the supervisor, not the version just installed.

Windows: `npm` is still spawned as `npm.cmd` with `shell: true`, same as `updater.ts`.

### 6. Auto-update

`runSelfUpdate` already: refuse if a session is in the way (or stop them when told), report stages, replace code before tear-down, persist settings, then exit 75.

The "bring code up to date" step splits; everything around it does not.

| Kind | Replace code | Build | Restart |
| --- | --- | --- | --- |
| git | `git fetch --prune` + `git reset --hard @{u}` + `npm install` | `npm run build:node` | exit 75 |
| npm | `npm install @copilot-fleet/node@latest` in the prefix | none (tarball is prebuilt) | exit 75 |

npm stages: `checking` → `installing` → `restarting`. Do not emit `pulling` or `building`.

Already latest (same identity as `@latest`) → `{ action: "none" }`, no restart — same as an unchanged HEAD.

Install failure → `{ action: "failed" }`, process stays up — same as a failed build.

Identity of `@latest`: prefer npm's `gitHead` sliced to 12 characters, else the semver string compared against `package.json` of the installed package. The SHA that hello reports after restart is still the baked revision of what is now on disk.

Heartbeat: keep async `spawn`. `spawnSync` for `npm install` is the bug that made the Host close the socket mid-update.

`update_node` stays one message. Teaching the Host a target version would couple it to npm and still be wrong for git Nodes. The operational rule is the one git already has: **update the Host first, then Update nodes.** The git reset tracks the upstream branch; npm install tracks `@latest`. Neither is "the Host's exact SHA". A git Host on an unpublished commit will keep npm Nodes `stale` after a successful Update; that is shown as stale with the npm-Node caption in Protocol below, not as a failed update.

Busy-node behaviour, Update all skipping busy machines, and "stop these sessions and continue" stay as they are. An npm restart kills agents the same way a git restart does.

### 7. Auto-reconnect

No design change. Sequence after a successful npm update:

1. Child installs into the prefix while still connected.
2. Reports `restarting`, writes `settings.json`, exits 75.
3. Supervisor (the original npx process) spawns prefix `main.js`.
4. Child loads `node.json`, dials, hellos with the same `nodeId` and a new SHA.
5. Host `settleUpdateOnReconnect`, inventory, auto-resume.

Killing the npx terminal is the same as killing `npm run start:node`: sessions go offline until the operator starts it again. The supervisor does not survive reboot; PM2/NSSM should spawn the prefix `dist/main.js` with `FLEET_RESTART_MODE=exit`, never `npx`.

Host restart (Ctrl-C, then `npx @copilot-fleet/host@latest`): Nodes buffer, reconnect, follow `host_url`. Same as a git Host restart.

`argvForRestart` already drops `--url` / `--name` / `--max-sessions` so a config-page retarget is not reverted. That applies to the supervisor's child argv on the unsupported detached path; the supported path is `FLEET_RESTART_MODE=exit` and a child that reads `settings.json` on boot.

### 8. Connect command

Two pure builders. Same flags as today. No `$env:`, no bash continuations.

npx (any directory):

```bash
npx @copilot-fleet/node --url="https://fleet.example.com" --token="…"
```

Checkout (from a clone):

```bash
npm install
npm run build:node
npm run start:node -- --url="https://fleet.example.com" --token="…"
```

Dev Tunnel: login command unchanged and still separate; both start commands use `--devtunnel="<id>"` and never the private `*.devtunnels.ms` URL.

The Host URL field on the card feeds both strings. Default tab is npx.

### 9. Mix matrix

| Host | Node | Enroll paste | Node update |
| --- | --- | --- | --- |
| npx | npx | npx | `npm install @latest` in prefix |
| npx | git | checkout | `git fetch --prune` + `git reset --hard @{u}` |
| git | npx | npx | `npm install @latest` in prefix |
| git | git | checkout | `git fetch --prune` + `git reset --hard @{u}` |

Protocol, enrollment token, node secret, host-url announcements do not branch on this table.

## Protocol and store

- `installKind?: "git" | "npm"` on hello, register, `NodeSchema`, and the `nodes` table (empty default).
- `revision` continues to mean SHA. npm Nodes send the baked SHA, not `""`.
- `version` is `package.json` semver — already landed; both sides read it through `packageVersion()` and ship `0.3.0`. Not used for staleness.
- `nodeUpdateState` stays SHA equality plus `self-update`. No new state in the union.
- Stale npm Node caption, without changing the enum: "Behind the Host's commit. An npm Node installs @latest, which only matches a Host built from that published commit." Shown whenever `installKind === "npm"` and the state is `stale`. No probe of the registry to guess whether this Host is unpublished.

No new `update_node` fields. No new capability name.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| `npm install` in prefix fails | No exit 75; old child stays; row shows failed |
| `git fetch` / `git reset` / build fails | Unchanged |
| Supervisor killed during update | Node gone until operator starts it; sessions offline, resumable when it returns |
| `npx` without `@latest` after a prefix already exists | Supervisor upgrades prefix only if the *launcher* is newer; a stale cache launcher leaves a newer prefix running — correct |
| Host unpublished, Node npm, operator clicks Update | Installs `@latest`; if SHA still differs, row stays `stale` with the npm-Node caption above |
| Two npx Hosts, default data dirs | Second fails to bind the port. Same as two git Hosts |
| Git Host then npx Host on one machine | Different DB paths; empty npx Host unless pointed at the old files |
| `cwd/.env` in the paste directory | Ignored for npm Nodes |
| Node older than `self-update` | **Manual update**, unchanged |

## What does not change

- Enrollment, node secrets, instance lock, config page, host-url sync, outbox, auto-resume, busy-node update refusal.
- Tunnel providers, Connect-card Dev Tunnel login split, private-URL non-broadcast.
- `FLEET_RESTART_MODE=exit` for external supervisors.
- Development: `npm run dev` / `npm run host` / `npm run node` from a clone.

## Docs the operator sees

README leads with npx for running; clone stays the development path. Architecture "Keeping Nodes current" names two install kinds, one SHA, one exit 75. PM2 example points at the prefix `dist/main.js`, not at `npx`.

## Risks worth reviewing

1. **Prefix vs cache for the Host.** Asymmetry is deliberate (Host is foreground). A reviewer who wants Host prefix too is arguing durability against `npm cache clean` during a run, not update.
2. **`@latest` vs Host SHA as the npm update target.** Matching git-pull-origin is the consistency argument. Sending a target SHA in `update_node` would let an npx Node install a specific published build, but only when that SHA is on npm — extra protocol for a case the git path also does not solve.
3. **Never downgrade the prefix.** A pinned `npx @copilot-fleet/node@1.0.0` on a machine already at 1.2.0 still runs 1.2.0. Pinning belongs in `FLEET_NODE_RUNTIME` pointing at another directory, if anyone needs it later.
4. **Publish cadence.** Tags, not every main push. A git Host on main and an npm Node on the last tag will often be stale. That is the trade for not publishing broken main.
5. **`gitHead` on the registry.** npm sets it when publishing from a git checkout. If CI checks out a detached tag, confirm `gitHead` is still the tagged commit; otherwise fall back to semver for the "already latest" short-circuit, and still report baked SHA after restart.
6. **`npm:` aliases are registry-only.** Local `file:` tarballs cannot use `npm:@copilot-fleet/protocol@0.3.0`. The smoke test must occupy the `@fleet/protocol` key itself. Forgetting that looks like a packaging bug when it is npm's alias rule.
