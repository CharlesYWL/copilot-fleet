# Orchestrator agent backends

Status: reviewed with the owner; Copilot + Hermes implementation.
Scope: orchestrators (`runRole: "lead"`). Workers, reviewers, ordinary Chats,
and adopted Copilot conversations continue using Copilot ACP.

## Approved decisions

- **Auto means Copilot**, not whichever agent happens to be installed.
- The Host owns one fleet-wide preferred agent. It applies to new
  orchestrators only. Each session persists its actual backend and complete
  parameters; changing the preference never changes an existing session.
- **Ship a working Hermes adapter now**, superseding draft v2's Copilot-only
  placeholder milestone. Other agent kinds are not advertised or implemented.
- Keep one ACP session implementation, with an adapter interface and factory
  for differences in launch, startup configuration, permissions, usage, and
  context recovery. Do not duplicate transport and process-lifecycle code.
- Orchestrators remain unattended/YOLO. Copilot retains `--allow-all`;
  Hermes permission requests select `allow_always` when offered, otherwise
  `allow_once`. If no allow option exists, cancel and report it.
- Hermes uses an explicitly selected, manually configured profile, initially
  `fleet-orchestrator`. Fleet does not create profiles, clone personal state,
  configure providers, or copy credentials.
- **Only one active Hermes orchestrator per profile per Node.** Stop and resume
  reuse that profile's memory. Different profiles or Nodes may run concurrently.
  Do not also run a non-Fleet Hermes process against an occupied profile.
- Prefer an online workspace placement that advertises the requested backend
  and has capacity. If no online placement has Hermes installed, a **new**
  orchestrator uses Copilot and records a sequenced system event in its
  transcript. No extra Host notification is introduced.
- Profile conflicts, missing profiles, broken ACP dependencies, authentication
  failures, and other startup errors are explicit errors, not reasons to switch
  to Copilot. A stopped Hermes session never falls back on resume.
- Unknown usage stays unknown (`?`). Copilot credits and context reporting
  remain unchanged; Hermes reports its ACP estimates and never reads Copilot
  billing files or runs Copilot-specific status probes.

## Gaps closed during review

| Draft gap | Implementation contract |
| --- | --- |
| The goal promised other agents, but D7 shipped only Copilot | Ship Copilot and Hermes; defer other kinds |
| `agent`, `agentKind`, and `agentParams` overlapped | One discriminated `agentParams`; existing `agent` remains the Copilot custom-agent name |
| Assumed all agents offered `configOptions` | Hermes uses ACP `models`/`modes` and `session/set_model` / `session/set_mode` |
| Copilot fleet model, effort, Agency and context settings could leak | Apply them only to Copilot; Hermes starts with its profile settings |
| Profile sharing did not address concurrent memory writers | Host admission and Node slot reservation guard each profile |
| Fallback could change a saved conversation's identity | Resolve fallback only before creating a new session; persist the actual selection |
| Resume, MCP reconnect and archives could lose parameters | Preserve the full selection in SQLite, launch commands, replacements and Host backups |
| Usage reporting assumed Copilot's meaning of ACP token counts | Hermes context is labeled as an agent-reported estimate, separately from Copilot `/context` |
| Native retention and local recovery assumed every ID belonged to Copilot | Hermes recovery commands include its profile; automatic Copilot retention excludes Hermes |

## Protocol and persistence

`packages/protocol/src/index.ts` defines:

```ts
type AgentParams =
  | { kind: "copilot" }
  | { kind: "hermes"; profile: string };
```

Zod validates each variant strictly. Profile names are bounded, lowercase,
file-safe names, not paths, shell fragments, or arbitrary launch parameters.
Hermes remains responsible for validating that the selected profile exists
and is configured.

- `start_session` and `resume_session` carry optional `agentParams`. Missing
  means legacy Copilot. `start_session.startupNotice` carries a fallback notice
  for the Node to emit in normal event sequence.
- Both hello protocols carry optional `agentKinds`. Enrollment keeps its
  existing signed registration payload so older Hosts compute the same hash.
  The `agent-kinds` capability says the Node understands backend selection.
  Nodes without that capability are Copilot-only, regardless of extra fields.
  Copilot remains every Node's baseline.
  Unknown future kinds are accepted in discovery but are neither offered by the
  UI nor accepted as launch parameters; an additive catalog entry must not
  disconnect an otherwise compatible Node.
- `FleetSession.agentParams` records the actual backend. SQLite stores its
  complete JSON in `sessions.agent_params`. Legacy rows retain Copilot behavior.
- Fleet defaults use `orchestratorAgent`; `null` resets Auto. The preference is
  separate from session identity and travels in Host backups.
  Invalid persisted preferences log a warning and read as Auto until repaired
  in Settings. The stored value is retained; request validation and each
  session's actual backend remain strict.
- `nodes.agent_kinds` stores the latest discovery result and refreshes on hello.
- Context snapshots can identify `source: "acp"` and omit an unreported model.
  Missing metrics are never replaced with zero, a catalog limit, or another
  backend's readings.

## Node adapters

`apps/node/src/agent-kinds/types.ts` is the Node-side contract.
`createAgentKind` selects the implementation from the validated parameters.

The shared ACP session in `agents.ts` owns:

- one stdio connection and managed process tree per Fleet session;
- initialization, new/load, prompts, cancellation and verified cleanup;
- event sequencing and suppression of replayed historical output;
- HTTP MCP injection, including the per-session Fleet bearer header;
- ordinary permission forwarding and the adapter-selected YOLO policy;
- startup deadline, abort fencing and retention of unverified cleanup.

Copilot and Hermes both receive the current Node's `FLEET_NODE_ID` and, when
the local config page is listening, `FLEET_NODE_IDENTITY_URL`. These replace
inherited identity values on each launch/resume, including managed processes.
This runtime Node identity is separate from the future agent-persona and bundle
registration research below.

The Copilot adapter owns Agency resolution, launch flags, version and context
probes, picker recovery, custom-agent selection and CAPI rollover. Its usage
reporter owns the existing credit reader, polling and `/context` capture.
Copilot's unprompted-turn tracking stays enabled; it is not assumed for Hermes.

The Hermes adapter:

1. Resolves `hermes` from the executing Node's PATH.
2. Runs `hermes -p <profile> acp --check` as a bounded dependency/profile
   preflight. This does **not** claim to verify a model request or credentials.
3. Starts `hermes -p <profile> acp` over stdio.
4. Maps the reported model/mode choices onto Fleet's existing config controls.
   Changes use Hermes's actual ACP methods, not a successful-looking
   `set_config_option` call that does not change its model.
   Empty load responses are rejected: Hermes returns null for missing history,
   which the ACP SDK normalizes to an empty object. That is not a successful
   resume and must never produce an idle session or a replacement conversation.
5. Supplies Fleet HTTP MCP on both new and load. Hermes may expose MCP tools
   through its native lazy `tool_search` / `tool_describe` / `tool_call` surface.
6. Reports ACP context estimates. It does not request `/context`, fabricate AI
   credits, run Copilot config recovery, or apply Copilot CAPI error heuristics.

Discovery reports installation, not profile readiness. Missing installations
are not cached. The Node refreshes discovery before announcing each connection;
after changing PATH, restart the Node.
If a custom-agent catalog read rejects, it logs a warning and retains the last
successful catalog (empty before the first successful read). A successful empty
read replaces it, so removed agents do not persist indefinitely.

The router reserves a Hermes profile before awaiting startup. It also counts
slots awaiting process reconciliation, refuses identity/profile changes on a
live slot, and preserves parameters when replacing a process to restore MCP.

## Host scheduling and lifecycle

The orchestrator route selects the preferred backend and placement before
creating a session. Only installation unavailability permits the new-session
Copilot fallback. Lack of capacity or an occupied profile is a refusal.

Hermes always receives the full orchestrator briefing; it does not select
Fleet's packaged Copilot custom-agent persona. The Host remains authoritative
for task state, budgets, tools and wakes. Profile memory is supplementary.

Explicit resume and automatic reconnect use the stored selection, never the
current default. A missing backend blocks resume with an actionable message.
Host backup/restore retains both the preference and the independent actual
selection for every session.

An offline session or pending Stop still holds its Hermes profile because loss
of connectivity is not proof that its process exited. Request **Stop** first;
if the Node cannot return, independently verify that the old process has stopped
and then select **Mark stopped** on that conversation. This existing confirmation
clears the pending Stop and releases the profile. Dismissal is visibility-only
and is allowed only after the conversation stops; it must not bypass ownership
of a possibly running process. The reservation is Node-local, so it does not
block the same profile name on another Node.

Workers still use the existing Copilot path, including Agency, model/effort
defaults, context settings and permission behavior.

## Settings and session UI

**Settings > Orchestrator** contains the preferred agent, backend parameters
and the existing heartbeat schedule (moved from General, not reset).

The selector offers Auto/Copilot and detected Hermes installations. A saved
Hermes preference stays visible even when no Node currently offers it.
Agent and profile save together after validation; a failed save retains the
draft and displays the error. Visited settings tabs retain unsaved input.

The page explains installation versus readiness, Node-local memory, the
one-active-profile constraint, new-session-only fallback and profile setup.
General's model choices come only from Copilot sessions.

Session headers, information and usage identify the actual backend. Local
Hermes recovery includes the stored profile and native ID, with a warning to
stop the Fleet process first. An unreported credit or context metric is `?`,
not zero. Hermes estimates are not labeled as Copilot `/context` snapshots.

## Hermes setup

On each Node, as the OS user that runs Fleet:

```powershell
hermes profile create fleet-orchestrator --no-alias
hermes -p fleet-orchestrator acp --setup
hermes -p fleet-orchestrator acp --check
```

Skip creation if the profile already exists. Use the interactive setup to
configure the provider and model. No `--clone` is needed: a fresh profile
keeps personal configuration, skills and curated memories from being copied.
Some Hermes OAuth providers share root authentication; profiles are not a
credential-security sandbox.

A profile includes configuration, `SOUL.md`, skills, memories and native
session history. `AGENTS.md` normally supplies workspace-specific guidance.
Fleet supplies its own authoritative orchestrator briefing without overwriting
the profile's identity files. Memory is not synchronized across Nodes.

## Verification and boundaries

Coverage includes typed/legacy protocol parsing, discovered installations,
new-session fallback, preference versus actual identity, backup round-tripping,
sticky resume, profile reservation races, workers remaining on Copilot, both
Hermes picker methods, YOLO choices, truthful usage and settings retention.
Existing Copilot/Agency startup, cancellation, rollover and usage cases remain
regression coverage.

An installed-Hermes smoke exercise uses an isolated temporary profile and
local synthetic model/MCP endpoints to check real stdio startup, authenticated
HTTP MCP tool invocation, prompt completion, verified stop, load and follow-up.
This is not a claim that an operator's production provider is configured.

Automatic native-session retention remains Copilot-only. Hermes history and
profile deletion are managed with Hermes; Fleet never feeds Hermes IDs to
Copilot's deletion API. Session downloads retain workspace access, but only
Copilot IDs grant access to Copilot native state directories.
Per-worker agent selection, automatic profile creation,
cross-Node memory synchronization and additional agent kinds are out of scope.
Successful Hermes preflight caching and per-Node version display remain optional
follow-ups. For now, a fresh `acp --check` on each launch catches a removed or
reconfigured profile and repaired dependencies without cache invalidation rules.

Reference: Hermes ACP and profile contracts were checked against the installed
v0.21.5 CLI and upstream revision
[`2ec7703`](https://github.com/NousResearch/hermes-agent/tree/2ec7703012e5e356b8df383026397160ed9b0bed/acp_adapter),
including the [profile concurrency warning](https://github.com/NousResearch/hermes-agent/blob/2ec7703012e5e356b8df383026397160ed9b0bed/website/docs/user-guide/profiles.md).

## Agent identity and bundle registration (future, not this iteration)

Research notes for additional kinds and optional managed identity provisioning.
The registration proposed here is not implemented; an `ensureIdentity` hook
would require a separately approved change. The approved Copilot + Hermes
behavior above, including manual Hermes profile setup, remains authoritative.
Details marked "unverified" must be confirmed against a real install.

### What "agent / profile" means per kind

| Kind | Unit | Where it lives | Isolates | Shares |
| --- | --- | --- | --- | --- |
| Copilot | custom agent `*.agent.md` | `<cwd>/.github/agents/` (fleet installs per session) | prompt, tool list | memory, auth, config, history |
| Claude Code | subagent `*.md`; `claude --agent <name>` for main session | `.claude/agents/`, `~/.claude/agents/` | prompt, tools, model, permission mode, preloaded skills | CLAUDE.md hierarchy, settings, auth; full isolation needs separate `CLAUDE_CONFIG_DIR` (auth impact unverified) |
| Codex | `--profile` / `[profiles.x]` in config.toml | `~/.codex/config.toml` | config overrides only (model, approvals, sandbox, provider) | instructions, skills, sessions; full isolation needs separate `CODEX_HOME` |
| Hermes | profile (`hermes -p <name>`) | separate HERMES_HOME per profile | config, profile-local keys, memory, sessions, skills, cron, gateway | some OAuth providers share root authentication; not a credential-security sandbox |
| OpenClaw | agent (`openclaw agents add <id>`); named profiles `~/.openclaw-<p>` | workspace (AGENTS.md, SOUL.md, USER.md) + agentDir (auth, models, sqlite sessions) | workspace, auth, sessions, per-agent skill allowlist | shared `~/.openclaw/skills` root (filtered by allowlist) |
| Pi | none found | `~/.pi/agent` (settings, skills, AGENTS.md); project `.pi/skills`, `.agents/skills` | n/a | everything; isolation via agent-dir env override (unverified) |

Skills are converging on the `SKILL.md` folder format (Claude, Codex via
`.agents/skills`, Hermes, OpenClaw, Pi), so one fleet skill bundle can be
installed into every kind. Instructions differ in file name only
(`.agent.md`, subagent md, AGENTS.md, SOUL.md, Hermes persona/AGENTS.md).

Current copilot-fleet mechanism (apps/node/src/agent-catalog.ts): built-in
`apps/node/agents/*.agent.md` plus operator overrides in the Node config
`agents/` dir (operator wins by name), copied into `<cwd>/.github/agents/`
before `session/new` and hidden via `.git/info/exclude`, then selected with
the `_agent` picker. Skills (`apps/node/skills/pr-maintenance`) are only
referenced by path in the prompt (`withMaintenanceResources`), not installed.

### Proposed registration: Node-side, idempotent

Each Node has its own installs, so registration happens on the Node, not as
a one-time Host setup step.

1. One fleet bundle shipped in the Node package: orchestrator instructions
   (single markdown source) + `skills/` in SKILL.md format. Extends the
   existing `agents/` and `skills/` directories.
2. Adapter hook `ensureIdentity(bundle, version)`, run at Node start and
   before an orchestrator starts:
   - copilot: current behaviour (`.agent.md` into `.github/agents`).
   - claude: subagent `~/.claude/agents/fleet-orchestrator.md` (converted
     frontmatter) + `~/.claude/skills/fleet-*`, or a dedicated config dir.
   - codex: dedicated `CODEX_HOME` under the Node config dir with AGENTS.md +
     skills. Auth must be logged in there (friction point).
   - hermes: a future opt-in provisioner could create profile
     `fleet-orchestrator` if missing and copy skills as `fleet-*`. Current
     setup remains manual. Never overwrite memory or agent-learned skills.
   - openclaw: create agent `fleet-orchestrator` if missing; write
     AGENTS.md/SOUL.md; allowlist fleet skills.
   - pi: install skills into its global dir (or a dedicated one once the
     override is confirmed).
3. Record bundle version/hash per Node and kind; re-sync on upgrade. Only
   fleet-owned files (prefix `fleet-`) are touched; never the user's own
   skills, the agent's memory, or skills the agent created itself.
4. Report installed identity + bundle version in Node hello, so the
   Orchestrator settings page can show e.g. "Hermes: profile
   fleet-orchestrator, bundle v3" per Node.
5. Auth stays manual per Node (the operator logs each CLI in). Never copy
   credentials.

### Isolation and remaining trade-offs

- One shared identity per Node retains learning; one per orchestrator separates
  it. Hermes currently reuses a named profile serially, with only one active
  orchestrator per profile per Node. This research does not authorize concurrent
  Hermes writers; other backends' sharing behavior must be verified separately.
- Learned memory is per Node; an orchestrator placed on another Node does
  not carry it. Cross-Node memory sync is a separate, later problem.
