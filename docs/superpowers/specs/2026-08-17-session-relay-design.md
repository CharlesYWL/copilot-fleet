# Session relay: pairing a working agent with a reviewing agent

**Date:** 2026-08-17
**Status:** Draft — exploration
**Scope:** Let one Session's output become another Session's prompt, so a worker/reviewer pair runs without an operator copying text between two cards.

## The question this answers

> Can ACP sessions talk to each other, or do I need something that orchestrates
> them and carries information between sessions?

They cannot, and you do. The orchestrator already exists — it is the Host — and
the pieces it needs are already in the protocol. What is missing is the rule
that says *these two sessions are connected*.

## Why ACP cannot do this itself

ACP is a 1:1 JSON-RPC channel between one client and one agent over stdio. The
whole method surface of `@agentclientprotocol/sdk@1.3` divides cleanly in two:

| Direction | Methods |
|-----------|---------|
| client → agent | `initialize`, `authenticate`, `logout`, `providers/*`, `session/new`, `session/load`, `session/fork`, `session/list`, `session/delete`, `session/resume`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`, `session/cancel`, `nes/*`, `document/did_*` |
| agent → client | `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/*` |

Nothing addresses a peer. There is no method by which session A names session B,
and no broadcast. `session/list` and `session/fork` look like exceptions but are
not: both are client-initiated and scoped to a single agent connection, so they
let a client enumerate or branch the conversations it already owns rather than
letting two agents reach each other.

Fleet then makes the separation physical. ARCHITECTURE.md rule 4 — "One Fleet
Session owns one Copilot ACP process" — means two sessions are two operating
system processes holding two unrelated stdio pipes, possibly on two different
machines. Even if ACP had a peer method, there is no shared connection to carry
it.

So agent-to-agent messaging is not a gap in the transport that can be patched at
the Node. It is a property of the topology, and the only place with a view of
more than one session is the Host. Both product documents already say so, as
non-goals rather than oversights: "Agent-to-agent DAGs" in ARCHITECTURE.md, and
"agent-to-agent messaging" in PRODUCT.md. This design fills in a seam the
architecture anticipated, on the side of the boundary that owns desired state.

## What the Host already has

Nothing below requires a protocol change, a new Node capability, or a Copilot
feature. Every piece is in place:

| Need | Existing mechanism |
|------|--------------------|
| See every session | `store.listSessions()` |
| Read a session's transcript | `store.listEvents(sessionId)` |
| Know a turn just ended | `turn_complete` event, `FleetService.handleEvent` |
| Put words into another session | `service.dispatch(nodeId, { type: "prompt", sessionId, prompt })` |
| Tell the operator what happened | `session_notice` broadcast, `system` events |

The Node emits, in this order, at the end of every turn (`apps/node/src/agents.ts`):

```text
turn_complete { stopReason }
state          { state: "idle", activity: "Ready for follow-up" }
```

`turn_complete` is the trigger. `handleEvent` (`apps/host/src/fleet-service.ts`)
is the single point every event passes through, on its way to the store and the
browsers. A relay hangs off that one function.

Delivery is the same `prompt` command `POST /api/sessions/:id/prompt` already
sends. `NodeCommandSchema` needs no new variant, which means a mixed-version
fleet keeps working with no capability gate — the thing that usually makes a
change like this expensive.

## Design options

### A. Host-side relay (recommended)

A stored rule joining two sessions:

```ts
type SessionLink = {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  trigger: "turn_complete";
  template: string;   // how the source transcript becomes a prompt
  maxHops: number;    // chain budget, see "Loops"
  enabled: boolean;
};
```

On `turn_complete` for `fromSessionId`, the Host renders `template` against that
session's recent events and dispatches the result to `toSessionId`.

Good, because it changes nothing outside the Host: no Node release, no protocol
version, no Copilot dependency. It works when the two sessions live on different
Nodes, because the Host addresses each by `nodeId` and never assumes they share a
machine. It survives a Host restart if the links are rows in SQLite next to the
sessions. And it is observable by construction — a relayed prompt lands in the
target's transcript as the same `system` event any typed prompt produces, so the
operator reads the handoff rather than inferring it.

Costs: it needs loop protection and a queue, both described below.

### B. Agent-initiated, via an MCP tool

Give the worker's Copilot process a `request_review` tool backed by an MCP server
that calls the Host API.

Attractive because the worker asks when it actually wants review, and the call
can block its turn until the answer arrives — which is a real review cycle rather
than a notification.

Expensive because it needs MCP configured per session on the Node, and because it
hands an agent process credentials to the Host API. Today the trust boundary runs
the other way: "Copilot credentials stay on the Node", and the Host never gives
an agent a way to command the fleet. Crossing that deserves its own design.

It also depends on the agent choosing to call the tool. For a reviewer that
should see *every* change, a rule the Host enforces beats an instruction the
worker may drop twenty turns into a long task.

### C. Shared workspace, operator-carried (available today)

Two sessions, one workspace, and you paste between them. Zero code. Worth stating
plainly because it is the fastest way to find out whether the worker/reviewer
split is useful for your work at all, before building A for it.

**Recommendation:** run C now; build A as the feature; keep B for when you want
the worker to be able to ask, rather than only to be reviewed.

## The filesystem hazard

This is the part that bites regardless of which option ships.

A Session's working directory comes from its Placement, and two sessions on the
same Placement share one directory. A reviewer pointed at a tree the worker is
still editing reads half-written files and mid-refactor states, and — because
Copilot writes as well as reads — may "fix" a file the worker has not finished
changing. Two agents editing one checkout corrupt each other's work in a way that
is hard to see and harder to attribute.

Three ways out, in order of preference:

1. **Review a diff, not a tree.** Put `git diff` output in the relayed prompt.
   The reviewer needs no filesystem access, so the race cannot occur, and the
   review is anchored to an exact revision instead of to whatever the tree
   happened to hold. Best default.
2. **Separate worktrees.** Two Placements on one Workspace with different
   `localPath`s — the model already allows this, since a Workspace can be
   available at several paths. The reviewer diffs the worker's branch. Note that
   git worktree lifecycle is an MVP non-goal, so the worktree is created by hand.
3. **Gate on the turn boundary.** Relay only while the worker is idle. This
   narrows the window rather than closing it: the worker resumes the moment its
   next prompt arrives.

Options 1 and 2 are safe. Option 3 alone is not.

## Loops

Worker → reviewer → worker → reviewer does not terminate, and each lap spends
tokens on both sides. An unbounded relay is the failure mode that turns this
feature into an incident, so the guards belong in the first version rather than
the second:

- **One direction by default.** The reviewer's output goes to the browser. A
  return path is opt-in.
- **Hop budget.** Count hops per chain and stop at `maxHops`; a relayed prompt
  carries the count that produced it.
- **Cooldown.** A minimum interval between relays on one link, so a session that
  ends turns rapidly cannot fan out.
- **Kill switch.** `enabled: false` on the link, reachable from the UI, taking
  effect without restarting either session.

## Queueing

`POST /api/sessions/:id/prompt` rejects with 409 unless the session is `idle`,
and the Node independently refuses a prompt that arrives mid-turn — returning a
non-fatal `command_result` rather than failing the session.

A relay must therefore hold a prompt aimed at a busy target and flush it when
that session's `state → idle` event arrives, rather than dispatching optimistically
and dropping the result. The existing refusal path is a safety net, not a
delivery mechanism: it tells an operator why their typed message did not land,
which is no help to an automated relay with nobody watching.

Holding at most one pending prompt per link is enough, and it should coalesce —
if the worker completes three turns while the reviewer is busy, the reviewer
wants the current state once, not three stale requests in a row.

## Suggested shape of the work

1. `SessionLink` table + CRUD routes, published to browsers in the snapshot.
2. Relay evaluation in `handleEvent`, behind hop/cooldown/enabled guards.
3. Pending-prompt queue keyed by target session, flushed on `state → idle`.
4. Prompt rendering: transcript slice or `git diff`, with provenance in the text.
5. UI: link a session to a reviewer, see the link, disable it.

Steps 1–3 are the feature. Step 4 is where its quality actually lives, and is
worth iterating on by hand — via option C — before it is fixed in code.

## Non-goals

- General agent-to-agent DAGs. This is one edge with a trigger, not a graph.
- Letting an agent address another agent directly. The Host stays the only thing
  that knows more than one session exists.
- Automatic worktree creation for the reviewer.
- Synchronous review, where the worker's turn blocks on the reviewer's verdict.
  That needs option B.
