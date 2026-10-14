# Using the Fleet UI

[← README](../../README.md) · [Guide index](README.md)

Everyday session work: the overview, chats, attachments, downloads, slash commands, and alerts.

## What it looks like

Every agent in the fleet on one screen, grouped by the project it is working in.
Cards stream their transcript live, so a wall of them is readable without opening
anything.

![The Copilot Fleet overview: five sessions across three workspaces and two nodes, each card streaming its own transcript.](../screenshots/monitor-wall.png)

Open one and you get the whole conversation, the node it runs on, a composer that
takes slash commands and file attachments, and the agent's own Model and Mode
pickers along the bottom.

![A single session: prompts and responses in full, with the composer, model and mode pickers underneath.](../screenshots/session-detail.png)

> The screenshots above come from the deterministic `--mock-agent` demo described under
> [Exact proof of concept](getting-started.md#exact-proof-of-concept), so they can be reproduced on
> any machine without a Copilot login. A real node streams real Copilot output in
> exactly the same surfaces.

### Node health and session navigation

Status icons use the same meanings in the sidebar, session headers, and dispatched
work: a blue spinning ring means running, a green circled check means done/success,
a gray pause-circle means idle and ready for follow-up, and a red disconnected plug
means offline. A red error-circle means failed; amber marks permission or recovery
attention. Queued work uses a clock, stopped/cancelled work a stop square, and skipped
work a forward arrow. Hover labels and accessible names identify every icon.
With reduced motion enabled, running/stopping rings rotate more slowly rather than
appearing inactive; decorative attention pulses are disabled. A completed step keeps
its result even if its worker later becomes idle or offline.

**Settings → Nodes** keeps each machine on one row, with compact blue CPU,
green RAM, and purple disk meters in the **Health** column. Hover or focus a
metric for capacity, scope, and sampling details; clock icons and striped bars
mark readings that are not current. Disk capacity covers the volume containing
the Node user's home directory. Disk is not an
average of every drive or a measure of disk activity; a project on another
volume can have different free space. Updated Nodes sample approximately every
30 seconds and report through their existing connection. Each reading keeps
its own measurement time. Missing readings, stale readings, clock skew, and
offline Nodes are labelled rather than shown as fresh zeroes. Older Nodes keep
working without health telemetry, and health does not change scheduling.

The session header's **Session information** icon opens the same details dialog
in both the full chat and the focused overview chat. It shows the Node, platform,
workspace, working directory, model, status, timestamps, and both the Fleet
and native Copilot session IDs. Copy buttons provide the path, IDs, and a
shell-quoted local recovery command. Only the native Copilot ID can be passed
to `copilot --resume`; demo sessions and sessions without that ID have no recovery
command.

Managed sessions show and copy their bound execution directory, not the source
checkout. Legacy sessions without a binding use their current placement.

Run local recovery on the original Node as the same OS user, after stopping or
verifying the old process has exited. The command uses standard Copilot CLI and
the directory shown above: if either your launcher/configuration or that directory
has changed, use the corresponding original setup. Local recovery does not
reattach the CLI to Fleet or restore orchestration tools; use Fleet's **Resume**
to continue managed work.

Scroll back or select an earlier prompt to reveal **Jump to latest**, even on
an idle or ended chat with no new output. It takes you to the bottom, clears
the unread count, and resumes following streamed output. Reading older messages
never pulls you back down automatically.

## Chats

Not every question is about a checkout. **Chats** is a workspace the Host creates
for itself, pinned above your projects in the sidebar, for the sessions that only
need an agent and a machine: a question, a bit of reading, research on something
you have not written yet. Every node that reports a home directory gets a Chats
placement there automatically, so there is nothing to set up — pick **Chats** in
**New session** and it runs in that machine's home directory.

Because it is derived rather than filed, it is the one workspace you cannot edit:
it has no rename, no delete, and no placements to add, move or remove. If you
already had a project called Chats, it keeps everything but its label, which moves
to `Chats (2)` so the reserved name is free.

An orchestrator can use it too — see
[Chats as a destination](orchestration.md#chats-as-a-destination).

## Rows that fold themselves away

A workspace or node row folds shut once nothing under it is running — every
session on it stopped, finished, or offline while its machine is away — so the
tree stays as short as the work in front of you rather than growing with every
transcript kept for **Resume**.

It opens again the moment work turns up there: a session started on that machine,
or one coming back to life as its node reconnects. Only those changes move a row,
never the standing state, so a dormant branch opened by hand to read an old
transcript stays open until something under it actually happens.

Opening a worker transcript also selects its row in the sidebar, expands its workspace
and node, and scrolls the row into view. This includes **Open transcript** from a
task's **Dispatched Work**, even when returning to the same worker.

## Ordering and filing by dragging

The sidebar tree can be rearranged by hand at every level: workspace rows, node
rows, and the sessions under them. Drag a row above or below a sibling — the
pointer's half of the target row decides which, and a line appears at that edge —
and the order is stored, so it survives a reload and is the same in every browser
watching the Host.

Dropping _onto_ a row would only ever mean "take its place", which leaves no way
to say "put it last": there is no row after the last one to aim at. The
above/below distinction is what makes the end of a list reachable.

New workspaces, placements and sessions are added at the end rather than sorted
in by name or date, so an arrangement made by hand is not undone by the next
machine or run added. A fleet nobody has rearranged keeps the order it always
had.

Dropping a node row onto a _different_ workspace files that checkout under it
instead of reordering, taking its sessions along: they carry their own workspace
id so the sidebar can group history without a join, and leaving that behind
would file every past run under the project the checkout no longer belongs to.
That move is refused if the target workspace already has a placement on the same
machine, since a workspace can only be in one place on a given node.

In **Workspaces & placements**, the same drags work on the cards: placement rows
reorder within a card, node chips at the top can be dropped on a card to place
that machine there, and a card that cannot take what is being dragged says why on
the card rather than silently refusing.

Sessions only reorder among their own node's list. A session is a live agent
process on one machine, holding that machine's files, so there is nowhere else
for it to go.

## Alerts

A finished turn plays a short rising tone; an agent blocked on a permission
plays a lower one, twice. They are different on purpose: a fleet is watched out
of the corner of an eye, and "it needs you" should be distinguishable from "it
is done" without looking at the screen. The speaker button in the top bar mutes
them, and the choice is remembered.

Both are synthesised in the browser rather than shipped as audio files, so they
work on a Host that has never been online. Nothing sounds on the first view of
the fleet — opening a page onto ten finished sessions is not the same as
watching ten agents finish — and several sessions finishing together produce one
tone rather than a pile of them. A permission that is still waiting is announced
once, not on every refresh.

Permissions are also announced outside the page, with a tab-title count and a
desktop notification that survives until it is clicked, because a request blocks
its agent until the node's timeout expires.

## Navigating long conversations

The right-hand prompt rail shows up to 40 marks, or fewer when the transcript
pane is short. Small sessions keep a mark for every prompt; longer sessions
sample evenly across the whole history, keeping the first and last prompt
whenever at least two marks fit. Hover or focus a mark to preview the actual
prompt, and click it to jump there. The lit mark tracks the current turn, using
the preceding sampled prompt when that turn has no mark. Unsampled prompts stay
in the transcript and remain reachable by scrolling.

A conversation opens at its latest output with only its newest 200 entries;
scrolling up loads older ones, and a prompt mark loads whatever lies between.
Only entries near the visible part of the pane are rendered, which keeps long
conversations quick to open and to type in while they stream, but it also means
the browser's own find (Ctrl+F) only searches what is on screen. Measurements and
how to rerun them are in [chat-history-benchmarks.md](../chat-history-benchmarks.md).

Fleet-generated control messages, including task transfers, worker wake summaries and
task reviews, appear as compact expandable steps rather than user chat bubbles.
New complete `fleet-*` envelopes receive the same treatment without a UI allowlist;
ordinary prose mentioning a tag and workspace hints appended to human prompts do not.
Expand a step to read its full original message. These messages do not add
marks to the user-prompt rail.

Keep typing while a session works: **Queue message** saves the follow-up on the Host
until the session is idle. A compact **N queued messages** pill above the composer
expands into a scrollable list, including pending Fleet workflow messages.
**Cancel** withdraws an unsent message. **Send now** prioritizes it and interrupts
the current turn, waiting for the agent to become idle before delivery. Attachments
stay with their queued message. Workflow-owned requests and messages already being
delivered cannot be recalled. Delivery errors remain visible; uncertain delivery
is not automatically replayed. Queued messages survive a browser reload or Host restart.

Consecutive diagnostic messages, including Agency startup output, share one
**Output** label while keeping every line visible. Errors, prompts, and other
transcript entries stay separate.

## Attaching files and images

The composer takes files: paste a screenshot straight into the box, or use the
paperclip to pick some. Each one appears as a chip that can be removed until the
message is sent, and a prompt can carry up to six of them at 10 MB each.

Draft text and attachments stay in the composer until the Host accepts the send.
A failed request keeps them available for retry; edits made while sending are
not cleared by the earlier request.

Pasted images are numbered within the current draft (`image1.png`, `image2.png`,
and so on), preserving their image extension. File-picker uploads keep their names;
duplicates get a suffix before the extension, such as `report.pdf` and
`report (2).pdf`. Both files keep their own contents, and removing one does not
remove or rename the other. These names travel with the prompt and remain on the
sent attachment chips; nothing is overwritten on disk.

How a file reaches the agent depends on what it is. Images go over as ACP image
blocks; everything else is embedded as text, so the agent reads the contents
without needing the file to exist on its own disk — which matters because the
machine running the agent is usually not the machine the file came from. A
binary that is neither, like a zip, is named in the prompt rather than embedded:
decoding it as text would spend the context window on replacement characters and
can read as instructions.

Bytes travel with the prompt in one piece rather than through an upload endpoint.
The agent is often behind a tunnel, and handing it a URL to fetch would mean
giving the Node credentials and a route back to the Host for something already in
the operator's hand. The size ceilings are what keep that from becoming a
WebSocket frame large enough to stall the other sessions sharing the connection.

Only the name, type and size are recorded in the transcript. The event log is
stored on the Host and replayed to every browser watching a session, so keeping
the bytes there would turn a few pasted screenshots into a liability; the
attachment chips under a sent message are the trace that remains.

## Downloading files from a session

A session's files live on the machine that ran it, which is often not the one
your browser is on. The transcript turns the files an agent names into downloads
from that machine, so a report it wrote downloads the same way whether the Node
is this computer or one on the other side of a tunnel:

- **Links** to a file — a `file:///` URL, a drive or absolute path, or a path
  relative to the session's working directory — download instead of navigating
  away.
- **Inline code** that is nothing but an absolute path ending in an extension,
  such as `` `C:\work\report.docx` ``, downloads the same way.
- **Edit steps** that finished writing a file show a download button at the end
  of their row.
- **Download a file** (the arrow in the session header) takes any path, absolute
  or relative to the session's working directory, for files an agent only
  mentioned in passing.

A click checks the file first, so a missing or refused file is explained in a
notification instead of a failed download; the bytes then go to the browser's
own download manager, with its progress and cancel button.

Nodes only dial out, so the Host cannot fetch from one. It asks over the Node's
existing authenticated connection and streams the answer to the browser as it
arrives, 256 KiB at a time with a small window in flight, so a download shares
the connection with session events rather than queueing in front of them. A file
that changes mid-download fails instead of arriving spliced from two versions.
Files up to 512 MB can be relayed, and a Node sends up to three downloads at once.

The Node decides what a download may reach. The file, with links and junctions
resolved, must be inside the session's working directory, one of its additional
roots, an orchestrator's scratch directory, or the session's own Copilot state
folder (`~/.copilot/session-state/<id>`, where agents keep plans and artifacts).
Fleet's configuration directory, which holds the Node's private key, Copilot's
own configuration, and the Host's data directory are never read — not even from a
Chats session, whose working directory is the home folder that contains them. A
file saved anywhere else, such as a temp folder, cannot be downloaded; ask the
agent to copy it into the workspace. This is a policy for what the Host relays,
not a sandbox: the agent runs as the same account as the Node.

Downloads need a Node that uses mutual authentication rather than the legacy
shared secret, running a build that supports them; the Host says which is
missing. Files are always served as attachments and never rendered on the Host's
own origin, where a page an agent wrote would run with your session.

## Slash commands and session pickers

The composer offers Copilot's own slash commands: type `/` and a list appears,
filtered as you type. Arrow keys move the selection, Enter or Tab picks one, and
Escape closes the menu. A command that takes an argument (`/review`, `/research`)
leaves the caret waiting after it; one that does not (`/usage`, `/context`) runs
straight away. The list is whatever the agent reports for that session, including
skills and plugins, so a machine with extra skills installed shows them without
any change here.

Enter used to confirm an input-method composition does not send a prompt or
select a slash command.

One compact button combines **Model**, **Reasoning Effort**, and **Context window**.
Its upward-opening menu shows each setting's current value and a submenu of
choices. **Mode** remains separate where the operator controls it; a custom agent
remains beside the session title. Model and effort can change while work is running;
context changes require an idle session.

New Copilot sessions request
`--context long_context` by default, including Chats, Copilot orchestrators, workers, and
reviewers. Turn **Settings → General → Long context by default** off to use
`--context default` instead. A session's own selection survives stop/resume and
automatic recovery. The Host default takes precedence over the node-local context
setting; changing it does not interrupt existing sessions.

Changing the context picker requires an idle session and restarts only that
Copilot process, loading the same conversation with its history, current pickers,
workspace roots, permissions, and Fleet MCP tools intact. The menu explains the
restart and higher cost of extended context. Window sizes vary by model; a CLI
without `--context` support reports that limitation and does not offer the picker.
An accepted flag is not confirmation of a 1M window: some CLI versions drop the
tier in the ACP bridge at creation or model changes
([github/copilot-cli#4275](https://github.com/github/copilot-cli/issues/4275)).
Fleet preserves the request but never substitutes the catalog maximum for the
window Copilot actually reports.

Copilot CLI [1.0.95](https://github.com/github/copilot-cli/releases/tag/v1.0.95)
fixes `--context` for new and resumed ACP sessions. Live checks on 2026-10-13
confirmed this in both 1.0.95 and 1.0.97, but also confirmed the remaining
model-switch bug: `session/set_model` and `session/set_config_option` for `model`
reset the context tier to default. Startup model selections sent over ACP are
model switches too. In the probe, GPT-5.5 reported a 922k allowance at long-context
startup, 272k after switching away and back, and 922k again after restarting
with `--context long_context` and loading the same conversation. ACP still rejects
`contextTier` as a live config option. Restart/resume reapplies the requested tier;
Fleet continues to use ACP without a backend migration.

A small **context ring beside Send** opens on hover, focus, or click. Its popover
contains **AI credits**, **context details**, and **Compact**, without adding a
second composer row. The ring updates from Copilot's ACP `usage_update` even while a
turn is running or held open for background work. This is explicitly labeled
**Context input budget** and an estimate, not a full-window measurement. A fresh
local `/context` report replaces it when the ACP prompt request returns (including
compaction); an explicit `/context` also updates it.
These local status commands do not ask the model to answer. Values rounded by the
CLI are marked as estimates, its percentage is retained, and the popover shows the
report's model and local observation timestamp. Restarting or changing models
invalidates old readings until a new reading arrives. An unavailable or unreadable
`/context` report does not erase a valid ACP reading; failures are still reported.

Copilot's ACP `usage_update.size` is an **input/prompt budget**, not the full model window:
older `/context` reports showed the full window (for example, 400k versus a 272k
input budget), while 1.0.95 and 1.0.97 report the input allowance in `/context` too.
Fleet uses the allowance actually reported by the CLI and never infers it from a
model catalog or an assumed output reserve. ACP's used-token count is an earlier,
pre-response snapshot, so its source and timing remain distinct from the local
readback. A missing budget leaves a neutral ring, not a fake zero.

AI credits come from the session's cumulative
billing checkpoint (`totalNanoAiu / 1,000,000,000`), polled on its node; premium
requests are never relabeled as credits. Metrics not yet reported are shown as
unavailable, not zero. The latest readings persist across browser/Host reloads,
resume, and backup/restore. No account-wide quota or budget is shown.
If request-size recovery replaces the underlying Copilot conversation, the
usage readout resets to that new conversation rather than retaining old metrics.

Hermes orchestrators use their own model default from Settings → Orchestrator,
or their profile's choice when unset, and ACP-reported context estimates.
The usage popover identifies the agent and reporting source.
Hermes does not use Copilot's context-tier flags, `/context` parser or billing
files; unreported credits and other missing metrics display `?`, never zero.

**Compact** in the popover sends the agent's `/compact` command when it is offered and the session
is idle. It summarizes the live context without clearing the saved transcript or
your unsent draft and attachments.

Copilot also reports an **Allow All** picker, and the strip leaves it out.
Permission policy is decided once when the session is launched, with or without
`--allow-all`, and is already shown as the session's YOLO badge. Offering it
again as a dropdown can only disagree with that badge — and on a session already
started with `--allow-all`, setting it back to "off" is answered with success and
then ignored, so the control moves and snaps back. Note that YOLO does not imply
Copilot's Autopilot **Mode**: a session launched with `--allow-all` still reports
mode `agent`, so Mode stays on the strip as the only way to reach Plan or
Autopilot.

Picking a value the agent rejects is reported as a notice and leaves the session
alone; it does not end the run. Nodes advertise `session-config`, and the Host
refuses the request rather than sending it to an older node that would not
understand the frame.

**Model defaults are separate for work sessions and orchestrators.**
**Settings → General** sets the model and reasoning effort for Chats, workers,
reviewers and other work sessions. **Settings → Orchestrator** has separate
**Copilot model** and **Hermes model** dropdowns, plus Copilot reasoning effort.
Each dropdown learns only from sessions using that backend and saves its exact
model ID; matching display names do not make two backends' IDs interchangeable.
The raw ID is also available on each option's tooltip. An unavailable saved
choice stays visible and can be cleared even with no models currently reported.

On upgrade, the previously shared choices are copied once to the Copilot
orchestrator settings; Hermes stays on its profile's choice until configured.
All defaults survive Host restart and backup/restore. **Copilot's choice** and
**Hermes profile's choice** leave that setting to the backend instead of
inheriting another agent's or the work-session default. Defaults are applied
on start and resume, not to running agents; an unsupported model produces a
notice and leaves the backend's choice alone. Changing a session's own picker
does not change saved defaults. Resuming re-reads live values through
`session/load`, so the UI shows what the session is actually running on.

Choosing a model can change the other pickers, because not every model offers
every setting — switching to a model without reasoning levels removes the
Reasoning Effort control. The agent's whole option list is republished on every
change for that reason, so the bar never keeps a control the current model has
stopped offering.

### Experimental worker model routing

Open **Settings → General → Decision settings**, beside the default Copilot
model and effort pickers. Routing starts **Off** and applies only to new workers
started by `fleet_start_work`; ordinary Chats, leads, existing workers and
PR-maintenance continuations are not classified.

Add an ordered list of **Azure AI Foundry** deployments and/or direct
**TypeSafe** decision models. Each row has its own endpoint, deployment/model,
write-only API key and **Test connection** action. Multiple models on the same
provider are supported. Test uses a paid, sanitized sample, validates the typed
answer, and never starts a worker or enables routing. A successful draft test
can be saved without another call; the browser clears its password input and
the Host retains the tested key privately for up to 15 minutes until Save.
Provider/endpoint changes require a new key, not forwarding an existing key
to a different destination.

Create named **worker profiles** with descriptions, compatible automatic
categories and fixed Copilot model/effort pairs. Friendly model names come from
observed Copilot sessions; saved values are the exact ACP IDs, including any
provider prefix. Unobserved IDs are marked **Unverified**. Changing a profile's
model resets its effort choice. An explicit `profile` ID on `fleet_start_work`
is allowed in both active modes without changing the work's permissions.

**Shadow** records an automatic prediction but uses ordinary worker defaults;
explicit profiles still apply. **Route new workers** applies the selected
profile and requires at least one tested decision connection. Failed, invalid,
timed-out or below-threshold answers advance through the ordered connections.
The entire chain shares a five-second deadline by default (configurable up to
ten seconds); it does not wait five seconds for every model. Requests larger
than 32 KiB use ordinary defaults without truncating the worker's full brief.
If no decision qualifies, or the Node cannot apply the requested model/effort,
Fleet attempts ordinary worker defaults and reports the actual running values.
Older Nodes can ignore the optional fallback field and retain their existing
best-effort startup behavior; update Nodes for paired fallback support.

Task details show the profile, policy revision, source, provider attempts and
**requested/predicted versus running** settings. Snapshot-enabled workers keep
their own observed model/effort through follow-up, reconnect and conversation
rollover, including explicit session-picker changes. The decision provider is
never called again for that worker.

Keys stay in a separately protected Host credential directory, never in Node
commands, MCP policy views, transcripts or backups. Restoring a backup retains
profiles and worker selections but turns routing Off, drops connection
readiness and requires local keys, tests and a fresh opt-in. Orchestrators can
read profiles and propose Host-wide edits; only an operator can apply them.
Routing remains experimental: connection success and a high probability are
not proof of worker quality or cost savings.
