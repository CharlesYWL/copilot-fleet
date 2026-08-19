# Choosing the orchestrator harness: Pi, Copilot, or something else

**Date:** 2026-08-18
**Status:** Draft — exploration
**Scope:** Whether the orchestrator described in `2026-08-18-fleet-orchestrator-design.md` should be a Copilot session, an external harness such as Pi, or a harness running *inside* Fleet through an ACP adapter.

## The question

> Can I use something like Pi Agent, or a similar harness with memory and
> self-developing skills, to do the orchestration work?

Yes. But the more useful answer is that **you do not have to decide yet**, and
the reason why is worth more than the answer.

## The reframe: the MCP server is the contract

The orchestrator design says the Host exposes the fleet as MCP tools —
`fleet_list_nodes`, `fleet_session_start`, `fleet_await`, `fleet_transcript`.

Every one of those is required no matter who orchestrates. Copilot needs them.
Pi needs them. Claude Code would need them. A harness that does not exist yet
will need them. They are the part that only you can build, because only the Host
knows which Nodes are free and which placements exist.

The harness, by contrast, is whatever process holds the MCP client. That makes it
**swappable, and therefore deferrable**. Build the tools first. Point Copilot at
them because Fleet already runs Copilot. If Pi turns out to be better, point Pi
at the same tools without touching them.

The failure mode to avoid is choosing a harness first and letting its shape
dictate the tool design. Design the tools against the fleet's domain — nodes,
placements, capacity, sessions — and any competent harness will drive them.

## What Pi actually is

Verified against the repo and npm, not marketing copy:

- **`@earendil-works/pi-coding-agent`**, v0.84.1 — "AI agent toolkit: unified LLM
  API, agent loop, TUI, coding agent CLI", ~93k stars, by Mario Zechner
  (`earendil-works/pi`). Not Inflection's Pi chatbot.
- **MCP client**: bundles `@modelcontextprotocol/sdk ^1.25.2`.
- **Skills**: implements the [Agent Skills standard](https://agentskills.io/specification)
  — the same `SKILL.md` format Claude Code and Codex use. It will load
  `~/.claude/skills` directly if you point `settings.json` at it.
- **Four modes**: interactive TUI, print/JSON (`pi -p`, `--mode json`), **RPC**
  (JSON over stdin/stdout), and **SDK** (embeddable).
- **15+ providers, hundreds of models**, switchable mid-session.
- **Self-modification** is the headline feature: "Ask Pi to build what you want…
  Have Pi manipulate itself in place, hit `/reload`, and keep going." It can
  author its own skills and extensions.
- **Deliberately minimal**: ships *without* sub-agents or plan mode. Those are
  example extensions.

That last point matters more than it looks. An orchestrator's delegation should
go through *your* fleet tools, not through a harness's built-in sub-agent
feature that knows nothing about Nodes or capacity. A harness that does not
already have opinions about delegation is the right starting material.

### Correcting one thing: Pi does not ship memory

The pitch is "extensions can inject messages before each turn, filter the message
history, implement RAG, or **build** long-term memory". That is a primitive, not
a feature. There is no memory extension among the shipped examples — a search of
`examples/extensions/` turns up `subagent`, not memory.

So "a harness with memory" is not something you would be adopting. It is
something you would still be building.

And you are better placed than Pi is, because **Fleet already has the memory
substrate**: a durable, ordered, queryable SQLite log of every event of every
session, already surviving Host restarts and already replayed to browsers. The
orchestrator design's `fleet_note_write` / `fleet_note_read` and
`fleet_transcript` are that substrate exposed as tools. Do not import someone
else's memory system to sit beside a better one you already own.

The same goes for compaction, which *is* a real Pi strength — the orchestrator
runs long and its context will fill. But Copilot compacts too, and an
orchestrator whose durable state lives in Host rows rather than in its own
context window is the design that survives compaction either way.

## Three places the orchestrator can run

### A. Copilot session inside Fleet — the previous design

Everything is already wired: transcript, cancel/stop, `state` machine,
auto-resume via `agentSessionId`, permission round-trips, browser UI, and
`set_config_option` for model and reasoning effort across 24 ids and 4 families.

Costs: Copilot's model list only, and Copilot's notion of skills and custom
agents rather than a portable one.

### B. Pi as an external process on the Host

Run `pi` beside the Host, pointed at the fleet MCP server. Works today with no
Fleet change at all — Pi is an MCP client and the Host would be an MCP server.

The cost is that the orchestrator stops being a Fleet Session. No card in the
grid, no transcript in the event store, no auto-resume, no cancel button, and a
second supervision and authentication story running next to the one Fleet
already has. You would be operating two control planes to run one fleet, and the
most interesting session in the system would be the one you cannot see.

Fine for a spike. Poor as a destination.

### C. Pi inside a Fleet Session, through `pi-acp`

**`pi-acp` exists**: npm `pi-acp`, currently **v0.0.33**, from
`svkozak/pi-acp`, binary `pi-acp`. It bridges ACP (JSON-RPC over stdio) to Pi's
RPC mode, so ACP clients such as Zed can drive Pi without modifying Pi.

Fleet is an ACP client. So this is the shape that gets both halves: Pi's
extensibility and provider range, *inside* Fleet's lifecycle, with the transcript
and the stop button and the auto-resume.

Two honest obstacles.

**1. Fleet hardcodes the launch arguments.** The command is configurable —
`copilotCommand`, or `FLEET_COPILOT_COMMAND` — but the arguments are not:

```ts
export function copilotLaunchArgs(yolo: boolean, contextTier?: ContextTier): string[] {
  const args = ["--acp", "--stdio"];
  if (yolo) args.push("--allow-all");
  if (contextTier) args.push("--context", contextTier);
  return args;
}
```

`pi-acp` would be handed `--acp --stdio` and reject it. Fleet's own code already
documents this exact failure: a Commander CLI "rejects an unknown option by
exiting 1 before it reads a byte of ACP", which stops every session on that
machine with the reason buried in a child process's stderr.

The fix is an **agent kind** — a named binary plus its argument builder plus its
capability quirks, chosen per placement or per session. Fleet already anticipates
this axis; "agent adapters other than Copilot CLI" is listed as an MVP non-goal,
which is a deferral rather than a refusal. It is a contained change: one lookup
where `copilotLaunchArgs` is called, and a field on the session.

**2. `pi-acp` is v0.0.33 and third-party.** It sits on the path of every
session that uses it. Fleet leans on specific ACP behaviour — `session/load`
replay suppression, `set_config_option` answering with the settled option list,
permission round-trips with fail-closed timeouts. Each is a thing to verify
against the adapter rather than assume. The probe script that established
Copilot's capabilities in the orchestrator design is the right tool: run the same
`initialize` and `session/new` against `pi-acp` and compare.

## What Pi buys, concretely

Worth it only if one of these is a real problem for you today:

| Capability | Why it might matter |
|---|---|
| 15+ providers, hundreds of models | Cross-family review stops being limited to what Copilot exposes. Cheap models on routine work, expensive ones only where they earn it. |
| Agent Skills standard | Orchestration policy as portable `SKILL.md` files, shared with Claude Code and Codex directories, versioned in git. |
| Extensions | Real control over context and compaction for a long-running orchestrator; per-turn message injection is exactly how you would feed it fleet state. |
| Tree-structured sessions, fork | Re-run a decision from a branch point instead of restarting a run. |
| Minimal by design | No built-in delegation to compete with your fleet tools. |
| Self-modification | It can write its own tooling — see the caution below. |

And what it costs: a second agent runtime to install, authenticate, and keep
current on **every Node**; a v0.0.33 adapter in the hot path; plus the arg
abstraction above.

## The self-development caution

This is the part to think hardest about.

An orchestrator that can spawn sessions, spend money, and **rewrite its own
instructions** is a different risk class from a coding agent that can do the
first two. Pi's own skills documentation says it plainly: "Skills can instruct
the model to perform any action and may include executable code the model
invokes. Review skill content before use."

If you adopt Pi for the orchestrator, adopt it with:

- **Skills in git, reviewed like code.** A skill that changes how the
  orchestrator spends money is a change to production behaviour.
- **Self-modification off in the orchestrator role**, or confined to writing
  proposals into a branch that a human merges. "Ask Pi to build it and `/reload`"
  is a wonderful loop on your laptop and an alarming one in a process holding
  `fleet_session_start`.
- **The run budget as the real backstop.** Guardrails enforced by the Host —
  session caps, wall clock, hop limits — cannot be edited by the thing they
  bound. Guardrails living in the orchestrator's own prompt or skills can.

That asymmetry is the argument for keeping every hard limit in the Host, which
the orchestrator design already does, and it holds regardless of harness.

## A dissenting view worth recording

omo has been through this. Its ROADMAP is explicitly skeptical of harness
abstraction: the industry "changes too fast", and premature adapter patterns
"across unstable interfaces" cause duplication. Their conclusion is not that
adapters are wrong, but that they are cheap to write on demand — "if an adapter
for a new harness is needed, an agent can write it in one shot."

Applied here: do not build a general harness abstraction. Build the fleet MCP
server, which is stable because it describes *your* domain, and write the one
adapter you actually need when you need it.

## Recommendation

1. **Build the fleet MCP server.** Required for every option. Harness-agnostic.
   Do not let the harness question block it.
2. **Run the first orchestrator on Copilot.** Zero new moving parts; it proves
   the tool surface and, more importantly, lets you read the model's judgement on
   real decisions before you invest in a second runtime.
3. **Put orchestration policy in portable `SKILL.md` files from day one**, even
   under Copilot. That is the piece worth migrating, and the Agent Skills format
   is already shared across harnesses.
4. **If Pi still looks worth it, add it as an agent kind** — option C — and
   probe `pi-acp` against Fleet's ACP expectations before trusting it. Note that
   this unlocks Pi as a *worker* with any provider too, which is plausibly worth
   more than Pi-as-orchestrator on its own.

The tell for when to move: you want a model Copilot does not offer, or you want
orchestration policy to live somewhere Copilot cannot read. Until one of those
bites, the harness is not the constraint — the tool surface and the judgement in
step 2 are.

## Non-goals

- A general multi-harness abstraction layer in Fleet.
- Importing a memory system. Fleet's event store is the substrate; expose it.
- Letting the orchestrator edit its own guardrails.
- Replacing Copilot for worker sessions before there is a reason to.
