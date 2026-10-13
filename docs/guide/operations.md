# Operations: updates, moves and recovery

[← README](../../README.md) · [Guide index](README.md)

Keep the Host and Nodes current, move them between machines, and recover sessions after a restart.

## Moving a Host or a Node to another machine

The fleet is two kinds of state, so there are two files — and one of them now
comes in two versions, because moving a Host's _data_ and moving its _identity_
are different operations with different risks.

**Host data (version 1)** — Settings → General → **Export fleet data**. The JSON
file holds workspaces, placements, nodes (identity hashes, not plaintext
secrets), sessions, transcripts, defaults, any legacy enrollment token, and
configured tunnel providers, enabled flags, and stable Dev Tunnel IDs. It is
**data only**: import on the new machine
**replaces** the catalog, but deliberately **preserves the security envelope of
the Host it lands in** — administrators, authentication mode and Entra
configuration, the Host signing key, the CSRF and lead-token keys, and password
mode all survive. A data restore can never return a secured Host to `unclaimed`
or silently hand it a different identity, which is exactly why it cannot move a
Host on its own.

**Host identity (portable, version 2)** — Settings → **Security** → **Move this
Host**. This is the file that moves a Host to a new machine intact. Its
security section — administrators, Entra configuration, the Host private key,
CSRF and lead-token keys, Node public keys, and whether mutual Node
authentication is enforced — is encrypted with a passphrase you supply (scrypt +
AES-256-GCM, minimum 14 characters, never persisted). Exporting it, and
importing it into an already claimed Host, both require a Microsoft
authorization-code sign-in from the last ten minutes; importing into a fresh
Host instead takes that Host's console claim code plus the passphrase, and
creates no session — an administrator signs in afterwards through the restored
configuration.
The portable archive already includes the Host data; **import this one file
for a Host move**, not a portable archive followed by a separate data archive.

A fleet that had already retired the shared Node secret restores that way too:
enforcement travels in the sealed section, and the fleet-wide enrollment token
it retired is not written back.

Restoring revokes every browser session and closes browser and Node sockets.
The data and security settings are applied together in one transaction.
**Stop the old Host before starting the moved
one**: two processes sharing one Host identity is a fingerprint two machines can
sign for, and Nodes cannot tell them apart.

**Keeping the same Dev Tunnel during a move**

New data and portable backups include the saved Dev Tunnel ID, including its
region suffix (for example, `fleet-ab123456.usw2`). They retain IDs even for a
disabled provider, and capture a live externally hosted tunnel's ID as well.
Restore restarts Host-managed tunnels with the archived IDs and enabled-provider
settings rather than leaving the destination's old tunnel running.

1. On the source, use a version that supports tunnel-ID backups and wait for
   Dev Tunnels to be ready before exporting the portable backup. Then stop the
   source Host and its separately started tunnel, if any.
2. On the destination, install `devtunnel` and run `devtunnel user login` with
   the account that owns or can host the original tunnel. Keep the same Host
   API `PORT` if existing URLs and Node forwards must continue to work.
   Provider login credentials and port configuration are not moved by the archive.
3. Open the destination Host on `localhost`, then import the portable backup.
   Do not restore through the tunnel being replaced. If a separately managed
   destination tunnel conflicts with the archive, Fleet asks you to stop it
   before restoring; it never kills a process owned by another terminal.
4. Sign in through the restored Microsoft configuration and check
   **Settings → Tunnel**. Existing Nodes can keep their old `--devtunnel=<id>`
   command and `node.json` identity once that tunnel is serving the moved Host.
   Their own Dev Tunnels account still needs permission to connect.

If provider setup fails after the data was restored, the response says so
explicitly and keeps the archived ID for retry. Fix the provider installation
or account, then retry from **Settings → Tunnel**; do not import the backup
again. An ID does not recreate a deleted tunnel, transfer its ownership, or make
an expired cloud resource usable.

Older backups remain readable, but have no source tunnel ID to recover. They
keep an existing destination ID where available; otherwise a new tunnel may be
created. Re-export from the updated source Host to preserve its original ID.
Fleet does not infer the ID from a public URL, because Dev Tunnels can use a
different name in the browser URL.

If the destination is also a Node, start that Node separately under its original
OS account/config directory. It can use the preserved tunnel, or connect directly
to the local Host with `npm run start:node -- --url=http://127.0.0.1:8787`
(substitute the actual API port). For the direct route, omit `--devtunnel` and
unset `FLEET_DEVTUNNEL_ID`. Keep the Node's existing `node.json`; restoring Host
history does not itself start a Node or move its Copilot session files.

Existing nodes reconnect with the `node.json` they already have, as long as they
can still reach the Host. A named hostname / `FLEET_PUBLIC_URL` / Tailscale Funnel
address is copied into the archive; a rotating quick-tunnel URL (`*.trycloudflare.com`,
free ngrok, bore) is not — those nodes would have to be retargeted by hand.

**Node** — the local config page (use the URL printed at startup; default
`http://127.0.0.1:8788`) → **Export identity**.
That file is `node.json` plus `settings.json` for this machine. Import on the new
box replaces this process's identity and reconnects. Placement paths stay whatever
the Host already stored for that node id; update them if the checkout lives
somewhere else. Copilot's own session files are not in the archive, so **Resume**
only works if those files are on the machine that runs the agent.

Node identity archives preserve persistent command-permission rules, including an
explicitly empty rule list, and their revision. Older archives without those fields
keep the legacy defaults; temporary session grants are not restored.

Both files contain secrets. Do not commit them.

## Recovering sessions after a restart

![Reconnect on reboot, as a sequence: the Host marks every unsettled session offline, the Node's hello reports which sessions it still holds and which are mid-turn, and only the ones it no longer has settle as failed-but-resumable and are re-attached through ACP session/load.](../reconnect-on-reboot.png)

A dropped transport says nothing about the agent behind it, so the Host asks
rather than assumes. The Node reports its inventory **and** which of those
sessions are mid-turn, which is what stops a returning session from landing on
`idle` while its agent still has a prompt in flight.

Sessions survive both processes going down. The Host keeps them in its SQLite
file and the node keeps its identity in `node.json`, so after both come back:

1. The Host marks everything it had running `offline` ("Host restarted").
2. The reconnecting node reports which sessions it still has. A restarted node
   has none, so the rest settle as "Node reconnected without this session".
3. **Resume** re-attaches through Copilot's `session/load`, and the transcript
   continues where it stopped rather than starting over.

A session in that state is shown as **resumable** rather than failed, stays in
the sidebar, and is skipped by **Clear ended** — that button only removes
sessions with nothing left to re-attach to. Use **Dismiss** on a session to drop
a resumable one deliberately.

By default the Host re-attaches those sessions itself as soon as the node is
back, so a restart does not leave a row of buttons to click. It takes only the
sessions settled by _that_ reconnect, newest first, and stops at the node's
capacity — so a restart never resurrects conversations abandoned days ago, and a
resume that fails is left for a person instead of retried every heartbeat.
Re-attaching sends no prompt: the agent lands on idle waiting for input, so
nothing runs until you ask it to. Turn it off under **Settings → General** if
you would rather press Resume yourself.

If Copilot reports that a saved conversation is too large for the CAPI Responses
request limit, Fleet replaces only the Copilot conversation while retaining the
same Fleet session, task, checkout and files. It continues in a fresh conversation
with a bounded handoff containing the original assignment, recent agent output
and latest request. Attachments are named but not copied into that recovery
prompt. The new Copilot session ID is persisted, so later resumes do not reload
the oversized history.

Three things have to hold for that to work: the Host's `DATABASE_PATH` file is
intact, the node starts with the same `node.json` identity, and Copilot on that
machine still has the agent session on disk. A session that died before its agent
ever started has nothing to re-attach to — it settles as "it never reached the
agent" and offers no Resume.

A node keeps its agents running while the Host is away and buffers the events
they produce, so a Host restart mid-turn no longer costs that part of the
transcript. If the outage outlasts the buffer the Host records the gap and keeps
going; it never refuses the events that follow, because a session that cannot
report its own state again is a session nobody can use.

## Automatic session retention

By default Fleet automatically deletes **idle or ended sessions after at least
30 days without activity**, including orchestrator conversations. The Host checks
at startup, after a Node has reconciled its inventory and buffered events, and
every six hours. It does not revive expired conversations just to clean them up.

Set `FLEET_SESSION_RETENTION_DAYS` on the **Host** to a whole number of days
from 30 to 36500, or `0` to disable new cleanup. Restart the Host after changing
it. Nodes follow that Host policy; no per-Node timer or setting is needed.
Favorites, running/queued/starting/cancelling sessions, unfinished tasks (including
human review), and recently updated task history are protected. An orchestrator
is also retained while its workers are active, recently used, or favorited.

Activity means opening a conversation, sending a prompt, resuming it, editing
its name/favorite or live options, and actual agent/tool output. Heartbeats,
Host restarts, inventory reconciliation and internal history replay do not
reset that clock. The Node independently checks for current work and recent
local/Copilot activity before deleting anything.

**Deletion is permanent on both sides:** the Node stops an eligible idle process
and uses Copilot's public ACP `session/list` and `session/delete` APIs for that
specific Fleet conversation. Only after its acknowledgement does the Host remove
the session, transcript and per-session preferences. Completed task outputs and
notes remain, without dangling session links. Workspaces, checkouts, credentials,
and unrelated Copilot sessions are never swept.

Offline Nodes are unknown, not inactive. Their sessions remain until they
reconnect. Older Node agents, a Copilot build without the required ACP
capabilities, missing activity metadata, or a failed deletion defer cleanup and
produce a diagnostic instead of falling back to deleting files. Requests and
retries survive Host restarts; a deletion already in progress finishes even if
new cleanup is subsequently disabled. While it is pending, the session and its
associated task cannot be resumed or edited.

Fleet still needs this policy even though Copilot CLI owns conversation storage:
the CLI cannot retire Fleet's SQLite history or understand its orchestrator/task
relationships. Fleet decides **which** sessions may expire; Copilot remains
responsible for deleting its own data through its supported API.

## Keeping nodes up to date

![Updating a node, as a flowchart: a busy node is refused, the checkout is reset hard onto its tracking branch, an unchanged HEAD skips the restart, install and build both run before anything is torn down, and only a successful build reaches exit 75 and a supervisor restart. Every other exit leaves the machine on the code it already had.](../update-node.png)

The shape of that diagram is the whole feature: there is exactly one path that
ends in a restart, and every guard that fails leaves the machine running what it
was already running.

The Nodes tab compares each machine's commit with the Host's and marks it **Up
to date**, **Update available**, or **Manual update**. **Update** on a row — or
**Update all** above the table — tells those machines to `git fetch --prune`,
`git reset --hard` onto the branch they track, `npm install --include=dev`,
`npm run build:node`, and restart into the new build. Progress appears in the row
as it happens.

Build dependencies are included even when the Node runs as a production login
service. An unchanged checkout only skips the build when the running process
also reports that commit; retrying after a failed install/build rebuilds and
restarts instead of falsely reporting "Already up to date".

The Host waits for the restart and verifies the returning revision against the
Node's announced build. Reconnecting during install/build is not success, and a
missing or incorrect revision after restart is reported as a failure. Older
Nodes without an announced build must at least return on a different known
revision.

The shared release version is declared only in the root `package.json`; Host,
Node, and protocol are private, unversioned workspaces. Host and Node report that
root version, and their internal `@fleet/protocol: "*"` dependency resolves to the
local workspace through the lockfile. A version bump changes the root manifest
and generated lockfile, not three separate package versions.

The current checkout updater compares commits, not release versions: multiple
development commits can share one version. Exact-release bundles and independent
freshness/protocol-compatibility checks are planned in the
[versioned-release spec](../superpowers/specs/2026-09-14-versioned-node-releases.md),
not implemented by this version-declaration change.

What it will not do:

- **Update a machine that is running sessions without being told to.** A restart
  takes every agent on that node with it, so a busy node is refused — but the
  refusal names the sessions in the way, and **Update** then offers to stop them
  and go ahead. Each keeps its transcript and can be resumed afterwards.
  **Update all** never does this: it skips busy machines rather than deciding
  for you across the fleet.
- **Keep local work on a node.** The checkout is reset hard onto the branch it
  tracks, so local commits and local edits to tracked files are discarded — the
  remote is what that machine is meant to be running, and `--ff-only` used to
  mean one stray commit froze a machine behind the fleet until someone logged
  into it. Untracked files are left alone, so the `.env` naming the Host
  survives. A node is a deployment; do the work somewhere else.
- **Move a machine off the branch it is on.** The reset target is the branch's
  own upstream, not `origin/main`, and a branch with no upstream stops with that
  as the reason.
- **Restart into a build that does not compile.** `npm run build:node` runs
  before anything is torn down; if it fails the node stays up on the code it
  already had and reports the error.
- **Update a node whose agent predates this feature.** It has no `update_node`
  in its copy of the message union and would close the connection on receiving
  one, so it is marked _Manual update_ and skipped. Update those machines by
  hand once — with the three commands under Windows Node — and every update
  after that can be done from the Host.

A node reports `""` for its commit when its directory is not a git checkout — a
tarball deploy, say. Those show as **Unknown** rather than being guessed at, and
are left out of **Update all**.

### How a node restarts itself

`npm run node` and `npm run start:node` both put a small supervisor in front of
the node (`apps/node/supervisor.mjs`). The node never replaces itself: it exits
with status 75 to ask for a restart, and the supervisor — which had nothing to
do with the update and is therefore still alive — starts the new build in the
same terminal. Nothing is detached and no window appears.

`npm run service -- node start` uses this same production supervisor. Updating
does not reinstall the scheduled task or replace the Node identity/settings.
If an older service is already stuck after moving its checkout, stop it, run
`npm install --include=dev` and `npm run build:node` in the updated checkout, then
run `npm run service -- node start` once to load the fixed updater.

This exists because a process cannot reliably replace itself on Windows. The
version that tried spawned a detached successor, which arrives with a console
window of its own and has to win a race for the instance lock. Under `tsx watch`
it lost that race every time: the pull changed the source, the watcher restarted
its own child, and the successor found the lock taken and exited — which looked
like a terminal flashing open and vanishing, with the node coming back only by
the watcher's accident.

`npm run dev:watch -w @fleet/node` still runs the node under `tsx watch` for
iterating on node code. Do not use it for a machine you rely on: **a watcher does
not restart a child that exits**, so an update under one leaves the machine with
nothing running.

The supervisor restarts on status 75 and nothing else — a node that crashes
exits with the code it crashed with, so a broken build is visible instead of
looping. It also gives up if the node asks to restart five times in twenty
seconds.

### Restarting under a process supervisor

The built-in supervisor does not survive a reboot and will not restart a node
that crashes. A machine you rely on is better run under something that does —
PM2, NSSM, a systemd unit.

Set `FLEET_RESTART_MODE=exit` and an update stops the process instead of
launching a successor, leaving the restart to the supervisor. Point it at
`apps/node/dist/main.js` directly, not at `supervisor.mjs`; two supervisors is
one more than the job needs.

```bash
# PM2, on any platform
FLEET_RESTART_MODE=exit pm2 start apps/node/dist/main.js --name copilot-fleet-node -- --url=https://fleet.example.com
pm2 save
```

```powershell
# Windows, as a service, with NSSM
nssm install copilot-fleet-node "C:\Program Files\nodejs\node.exe" "Q:\Repos\copilot-fleet\apps\node\dist\main.js"
nssm set copilot-fleet-node AppDirectory Q:\Repos\copilot-fleet
nssm set copilot-fleet-node AppEnvironmentExtra FLEET_RESTART_MODE=exit
nssm start copilot-fleet-node
```

An update exits 75 in this mode too. PM2 and NSSM restart on any exit, so that
is already what you want; a unit file that restarts only on failure needs
`RestartForceExitStatus=75` or `Restart=always`.

## Keeping the Host up to date

**Settings → General → Update Host** does for the Host what **Update** does for
a node: `git fetch --prune`, `git reset --hard` onto the branch the checkout
tracks, `npm install --include=dev` and `npm run build` — the whole build, since
the Node started beside the Host runs from the same checkout — and then restarts
the Host and that Node **the way they were started**:

| Started with                                  | Restarted with                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:tunnel`          | the same command, in the same terminal, with the same arguments                        |
| `npm start`                                   | `npm start`, in the same terminal, with the same arguments                             |
| `npm run service -- host+node install` (etc.) | `npm run service -- host+node restart` (`host restart` if the Node task is not in use) |

The card shows the commit the Host is on and the restart command, then each
stage as it happens. The Host drops off while it restarts; the page reconnects
by itself and reports how the update ended. Reload it afterwards to load the new
interface.

Once the restarted Host records the outcome, a slow restart command or delayed
browser snapshot cannot turn it back into an in-progress update.

The steps and the safety property are the Node's, from the same code
(`@fleet/protocol/updater`): nothing is restarted until the build has
succeeded, and a checkout already on the newest commit is not restarted at all.
Under `npm start` and the login service a failed build therefore leaves the Host
and its Node running what they already had. Under `npm run dev` the Host's own
file watcher still reloads source as soon as the reset rewrites it — that is what
the watcher is for — so a failed build there can leave the Host on new source
with old dependencies until you fix the checkout. In addition, the Host will not:

- **Discard uncommitted work.** A Host's checkout is often somebody's working
  copy too, so uncommitted changes to tracked files refuse the update — checked
  when you click and again just before the reset, and a checkout git cannot
  read counts as dirty (untracked files such as `.env` survive a reset and do
  not count). Local commits that are not on the tracked branch are dropped from
  it, as on a node; the reflog still has them.
- **Stop this machine's sessions without asking.** Restarting the Host restarts
  the Node beside it, so while that Node is running sessions the update is
  refused with their names, and the card offers to stop exactly those and go
  ahead; one started in the meantime is named in a fresh refusal. Until the
  restart, new sessions on this machine are refused rather than started only to
  be stopped. Sessions on other machines keep running through the Host's restart.
- **Update beside another update.** Whichever update is resetting and rebuilding
  a checkout holds `.fleet-update.lock` in it, touching it as it works, so the
  Host and the Node beside it never run theirs at the same time, even across a
  restart.
- **Claim a restart it cannot see.** Starting a command or a scheduled task proves
  nothing about what runs in it, so success is recorded by the restarted Host
  itself: once it is listening, on the commit the update built, with this
  machine's Node back on that commit too. A Host or Node that comes back on
  anything else, a Node that does not come back within three minutes, or an
  updater that stops reporting is recorded as a failure.

How it restarts depends on who can survive the restart. Under `npm run dev` the
file watcher restarts the Host as soon as the reset rewrites its source, so the
Host never runs the update itself: the launcher in front of `npm run dev`,
`npm run dev:tunnel` and `npm start` does, and then stops everything it started
and runs the command again. A login-service Host cannot restart its own task
from inside it, so it registers a one-off scheduled task for your Windows user,
`CopilotFleetSelfUpdate-…`, which updates, runs the restart and deletes itself;
its output is kept in `self-update.log` beside the Host database. Progress in
both cases is recorded in `self-update.json` there, which is how the restarted
Host knows how the update went.

Tunnels enabled in **Settings → Tunnel** are restored after a Host update.
If Dev Tunnels setup fails while its service or CLI sign-in is unavailable, the
saved switch and tunnel ID are retained and setup retries automatically with
backoff (up to one minute between attempts). The failure stays visible in
Settings; switching the tunnel off cancels retries. A missing CLI or a provider
refused by the Host's access policy still switches that provider off.

Restarting `npm run dev:tunnel` restarts its separately managed tunnel with
everything else, as stopping and starting it by hand would: a Dev Tunnel keeps its address, but a
quick tunnel (Cloudflare, free ngrok) comes back on a new one. The launcher
itself is not replaced by an update; changes to it take effect the next time you
start the command.

A Host started any other way — `npm run host`, `npm run start:host`, a
`*:bare` script — has nothing waiting to start it again, so **Update Host** is
disabled and says so. So is a Host that was already running when you pulled this
feature: restart it once with one of the commands above.
