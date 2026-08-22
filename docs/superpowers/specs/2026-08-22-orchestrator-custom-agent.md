# Orchestrator agent: custom agents and where the Lead should run

Date: 2026-08-22
Status: verified, and implemented — the Node ships a catalog and the Host asks
for `fleet-orchestrator` when it starts a lead
Verified against: GitHub Copilot CLI `1.0.81-7` on Windows, this fleet's `apps/node` ACP bridge

Two questions were asked:

1. Can the orchestrator be a **custom Copilot agent** — its own prompt, its own
   tool list — rather than an ordinary session steered by a briefing prompt?
2. Should the Lead's Copilot process be **embedded in the Host** rather than run
   on a Node?

The first is yes, with four mechanics that decide the design. The second is
technically possible and I recommend against it; the problem it solves is
already solved, and there is a cheaper way to get the rest.

---

## 1. Custom agents over ACP

Every claim below was produced by driving a real `copilot --acp --stdio` and
reading what it answered. None of it is from documentation.

### 1.1 The picker exists only when an agent file is discoverable

`session/new` returns `configOptions`. With no agent file anywhere near the
session's `cwd`, the list is:

```
[mode] mode, [model] model, [thought_level] reasoning_effort, [permissions] allow_all
```

Write `.github/agents/fleet-orchestrator.agent.md` into the `cwd` and the same
call answers with one more:

```
[_agent] agent = ""      options: ["", "fleet-orchestrator"]
```

So discovery is **cwd-relative**. The Lead runs in a scratch placement whose
directory Fleet owns, which makes this a natural place to put the file.

`~/.copilot/agents/` is the other documented location and works fleet-wide, but
it would also appear in the operator's own Copilot sessions on that machine.
Scratch keeps it to the sessions it is meant for.

### 1.2 The `--agent` launch flag does nothing in ACP mode

This is the finding that decides the implementation. Launching with

```
copilot --acp --stdio --agent fleet-orchestrator
```

produces the picker but leaves `currentValue` at `""`. The flag is accepted and
ignored. Naming an agent that does not exist is also silently accepted.

**The only route is `session/set_config_option`** on the `_agent` picker, after
`session/new`. Fleet already drives that method for model and mode.

### 1.3 Selecting it does put the agent's prompt in effect

An agent whose body said "reply with exactly one line: FLEET-ORCHESTRATOR-ACTIVE"
was selected over ACP and then prompted with "Say hello."

```
picker present: true | current: ""
after set  -> "fleet-orchestrator"
reply: "FLEET-ORCHESTRATOR-ACTIVE"
```

So the agent definition reaches the model. The picker is not cosmetic.

### 1.4 It survives `session/load`, unlike MCP servers

A second process loaded the same session and prompted it **without** re-selecting
the agent:

```
first turn  : agent ACTIVE
load reports configOptions: 5
after resume: agent STILL ACTIVE
```

Two things worth recording:

- The agent selection is **persisted with the session**. MCP servers are not —
  those must be re-supplied on `session/load`, which is why an auto-resumed Lead
  would otherwise wake with no tools.
- `session/load` **did** report `configOptions` here. The comment in
  `apps/node/src/agents.ts` says it never does. That comment describes a real
  observation on some machine and build, so the recovery path it justifies should
  stay — but "never" is too strong for 1.0.81-7.

### 1.5 `tools:` is a real gate, not a hint

Two sessions, same prompt — "Run the shell command: echo hello":

| | tool activity | what it said |
|---|---|---|
| no custom agent | `Echo hello to terminal` | "hello" |
| agent with `tools: ["str_replace_editor"]` | **none** | "I don't have a shell/bash execution tool available in this session" |

The tool never appeared. So the design's claim — that the agent definition is a
second enforcement point for *only the orchestrator gets fleet tools* — holds.

It is still second. The first gate remains that a worker is never handed the MCP
server at all, so it has nothing to ask for.

### 1.6 What this changes in Fleet

Small and contained:

- **Write the agent file** into the scratch placement before the Lead starts.
- **Plumb an `agent` through `StartAgentOptions`**, and call `set_config_option`
  after `session/new` and **before the first prompt**. Ordering is explicit
  today: `start_session` carries the first prompt, so the selection has to
  happen between the two rather than "some time after the session exists".
- **Move the stable half of the briefing into the agent file.** What the
  orchestrator *is* belongs there; what this task is stays a prompt. Today both
  arrive as prose in the same first message, and the durable half is re-sent and
  re-inferred on every wake.
- Resume needs nothing new for the agent, but still needs the MCP re-supply it
  already has.

---

## 2. Embedding the Copilot CLI in the Host

Technically possible. I recommend not doing it.

### 2.1 What it would actually cost

- The Host spawns processes today **only for tunnels**. It has no ACP bridge, no
  permission plumbing, no turn tracking, no resume. That is ~1,100 lines in
  `apps/node/src/agents.ts`, and `@fleet/host` does not depend on `@fleet/node`.
  Embedding means either duplicating that or inverting the dependency.
- **The Host is not a Node.** It has no `maxSessions`, no heartbeat, no
  placement row. Placement selection, capacity checks, the sidebar's
  workspace→node grouping and the overview all assume a session belongs to a
  Node. A Host-resident session is a special case in every one of them.
- **The Host may have no Copilot at all.** It is a server: possibly headless,
  possibly npx-distributed, possibly running as a service account with no GitHub
  auth. Requiring a working `copilot` on the Host changes its deployment story
  from "a web app" to "a web app that is also an agent machine".

### 2.2 The problem it would solve is already solved

The motivation is presumably that the orchestrator should not die when a machine
goes away. It does not:

- `offline` is **not** in `terminalSessionStates` — the Host treats an
  unreachable session as *unknown*, not *dead*.
- `offline` **is** in `resumableStates`, and auto-resume brings the session back
  with its conversation intact.

A Node going away parks the orchestrator. It does not lose it.

### 2.3 The cheaper way to get the rest

If the goal is "the orchestrator is always available, independent of anyone's
laptop", run **a Node on the Host machine**, over loopback. That needs no new
code at all: it is an ordinary Node that happens to be co-located, and the Node
already rebases the MCP URL onto its own `hostUrl`, so a loopback Node resolves
to a loopback MCP endpoint.

That gets Host-lifetime availability without making the Host an execution
environment, and without a second implementation of the ACP bridge to keep in
step with the first.

---

## 3. Recommendation

1. **Do the custom agent.** It is small, it is verified end to end, and it is the
   first real step toward the Sisyphus-style Lead in §17 of the synthesis design:
   a durable identity the orchestrator has, instead of a situation it re-derives
   from prose on every wake.
2. **Do not embed Copilot in the Host.** Co-locate a Node instead if
   always-on matters.

## 4. Open questions

- **Which tools should the orchestrator's `tools:` list actually name?** The gate
  works, so the list becomes a real security decision rather than documentation.
  It needs the fleet MCP tools plus whatever it genuinely needs locally — and
  the answer to "does the Lead need a shell at all" is now enforceable either way.
- **Does the agent file belong in scratch or in the node's user config?** Scratch
  keeps it invisible to the operator's own sessions; user config survives a
  scratch wipe. Scratch is the current recommendation.
- **What happens when a Node has no such file?** The picker is absent, so
  `set_config_option` fails. That should degrade to the briefing-prompt Lead we
  have today rather than refusing to start one.
