# Plan: Pluggable ACP agent for the Orchestrator session

Status: draft v2 for review (owner decisions folded in).
Scope: only the orchestrator (runRole "lead") session. Workers stay on
Copilot ACP unchanged.

## Goal

Let the Orchestrator run on any ACP-speaking agent (Copilot, Claude Code,
Codex, Hermes, OpenClaw, Pi Agent) instead of always `copilot --acp --stdio`.
Motivation: agents like Hermes keep persistent memory/skills and improve over
long-running use, which suits a long-lived orchestrator.

Add a dedicated "Orchestrator" settings page with a "Preferred agent" picker
whose options are auto-detected from the Nodes' environments.

## Decisions (from owner)

- D1 Auto = Copilot. Copilot is the agent every Node installs, so "Auto"
  always resolves to Copilot. Picking another agent in settings is persisted
  on the Host (fleet defaults) and applies to every orchestrator created
  after that. Existing orchestrators keep the agent they were started with.
- D2 Orchestrator only, fleet-wide. One preferred agent for the fleet, used
  only for the orchestrator. Per-Node / worker agent choice is a later
  feature; the design must not block it, but must not build it now.
- D3 YOLO maps per agent. Each agent kind declares how "yolo" is expressed
  (launch flag, ACP config option, or Node-side auto-approve of
  `session/request_permission`). Orchestrators are always yolo.
- D4 Workers: out of scope.
- D5 Usage reporting maps per agent. Each agent kind declares how usage
  (context window, tokens, credits/cost) is obtained. Copilot keeps its
  current method; others get their own adapter or report "unknown" (shown as
  "?" in the UI), never a fabricated number.
- D6 Structure: define the interface copilot-fleet needs from an agent, plus
  a factory that builds the right implementation per agent kind with its own
  params.
- D7 This iteration ships Copilot only. Build the interface, factory,
  protocol fields, persisted setting and settings page, but the only adapter
  and the only dropdown option is Copilot. The dropdown is the placeholder
  for later kinds. Hermes/OpenClaw/Pi/Claude/Codex ACP commands are
  investigated only when that kind is actually being added.
- D8 Fallback: Copilot is the default. If the preferred agent is unavailable
  on the chosen Node, start on Copilot and post a system event saying so
  (no hard failure). A per-Node "preferred agent" setting may come later.
- D9 Agent params are typed: a discriminated union in protocol keyed by
  kind (`{ kind: "copilot" }` now; e.g. `{ kind: "hermes", profile }`
  later), validated by zod, not a free string map.
- D10 YOLO auto-approve picks "allow always" when offered (else allow once).

## Current state (what is Copilot-coupled)

Launch / transport (Node)
- apps/node/src/agents.ts: `copilotLaunchArgs()` (~L1800) hardcodes
  `--acp --stdio [--allow-all] [--context tier]`; spawn goes through
  `resolveCopilotLaunch()` in apps/node/src/copilot-launch.ts (copilot vs.
  agency).
- The ACP client itself is generic (`@agentclientprotocol/sdk`): initialize,
  session/new, session/load, prompt, set_config_option, mcpServers injection
  (`mcpServers()` ~L601). This is what makes swapping feasible.

Copilot-only behaviour inside the same class:
- Version gate `MIN_COPILOT_ACP_AUTH_VERSION`, `--help` probe for `--context`.
- `allow_all` config recovery (`configRecoveryRequest`).
- Custom agent selection via the `_agent` picker (`selectCustomAgent`) using
  apps/node/agents/fleet-orchestrator.agent.md. The Host already sends the
  full briefing when the Node has no such agent (`hasAgent: false`,
  routes/orchestrators.ts ~L520), so other agents degrade correctly.
- `SessionCreditReader` (reads Copilot's session files for AI credits).
- `/context` capture + `parseContextUsage` (Copilot slash-command output).
- CAPI "request too large" rollover (`isCapiRequestTooLarge`).
- `UNPROMPTED_QUIET_MS` heuristics tuned for Copilot background turns.

Protocol / Host
- `start_session` command (packages/protocol) has `yolo`, `agencyMode`,
  `contextTier`, `mcpServers`, `agent`, but no "which agent kind".
- Node capability string `"copilot-acp"` (node-capabilities.ts).
- `UpdateDefaultsSchema` holds fleet defaults incl.
  `orchestratorHeartbeatSchedule` (orchestrator settings live in General).
- Orchestrator creation: routes/orchestrators.ts ~L515
  `createAndStartSession({ runRole: "lead", yolo: true, readOnly: true })`.
- Fleet tools reach the orchestrator through an HTTP MCP server with a scoped
  token (orchestrator/mcp-routes.ts). Agent-agnostic, provided the agent
  accepts ACP `mcpServers` of type http.

## Design

### 1. The interface copilot-fleet needs (Node) — apps/node/src/agent-kinds/

The existing ACP session class keeps the protocol plumbing (connection,
prompt, cancel, permissions broker, event emission). Everything that differs
per agent moves behind one interface, provided by a per-kind adapter:

```ts
// packages/protocol: shared id, so Host, Node and UI agree on the names
export const AgentKindSchema = z.enum([
  "copilot", "claude", "codex", "hermes", "openclaw", "pi",
]);

// apps/node/src/agent-kinds/types.ts
export interface AgentKindAdapter {
  readonly kind: AgentKind;
  readonly label: string;

  /** Is it installed here, and where? Not cached when missing. */
  detect(env: NodeJS.ProcessEnv): Promise<AgentInstall | undefined>;

  /** Pre-flight checks (e.g. Copilot min version / login). Throws with a readable message. */
  preflight(install: AgentInstall): Promise<void>;

  /** Command + args to start the ACP server on stdio. */
  launch(install: AgentInstall, opts: LaunchOptions): { command: string; args: string[]; env?: Record<string, string> };

  /** D3: how yolo is expressed for this kind. */
  readonly yolo: YoloStrategy;

  /** D5: how usage is obtained for this kind. */
  usage(ctx: UsageContext): UsageReporter;

  /** Hooks for kind-specific session behaviour; all optional. */
  afterSessionStart?(session: AcpSessionHandle): Promise<void>; // Copilot: select _agent, recover pickers
  isContextOverflow?(error: unknown): boolean;                   // Copilot: CAPI too large -> rollover
  readonly unpromptedQuietMs?: number;                          // default UNPROMPTED_QUIET_MS
}

type YoloStrategy =
  | { type: "launch-flag"; args: string[] }              // copilot: --allow-all
  | { type: "config-option"; id: string; value: string } // agent exposes a mode picker
  | { type: "auto-approve" };                            // Node answers request_permission with allow

interface UsageReporter {
  start(): void;                                        // begin polling / subscribing
  onAcpUpdate?(update: acp.SessionNotification): void;  // agents that report usage in ACP updates
  stop(): Promise<void>;
}
// Emits SessionUsage; any field it cannot know is left undefined -> UI shows "?".
```

`LaunchOptions` = `{ yolo, contextTier?, agencyMode? }`; kind-specific
settings come from the typed `AgentParams` given to the factory (D9).

### 2. The factory

```ts
// apps/node/src/agent-kinds/index.ts
export function createAgentKind(params: AgentParams): AgentKindAdapter // switch on params.kind
export async function detectAgentKinds(env): Promise<DetectedAgent[]> // for Node hello
```

Adapters shipped in this iteration (D7):
- copilot.ts: existing behaviour moved verbatim: `resolveCopilotLaunch`
  (incl. agency), `--acp --stdio`, `--context`, version gate, yolo =
  launch-flag `--allow-all`, usage = SessionCreditReader + `/context` parser,
  afterSessionStart = `selectCustomAgent` + `recoverConfigOptions`,
  isContextOverflow = CAPI check. Must be a pure move: no behaviour change.
- test-only fake adapter (in tests) to prove the seam: auto-approve yolo,
  "?" usage, no afterSessionStart.

Later adapters (not in this iteration; commands, yolo and usage mapping to be
investigated when each is added): claude, codex, hermes (likely a `profile`
param for memory isolation), openclaw, pi. Adding one = one adapter file, one
params variant in the protocol union, one dropdown entry.

Session class changes (agents.ts): replace direct Copilot calls with calls to
the adapter; the permission broker gets one new branch: if
`yolo.type === "auto-approve"`, answer every request with the agent's
"allow always" option (fallback "allow once") without surfacing it to the
Host (D10). Unused by Copilot today, covered by the fake adapter test.

### 3. Protocol changes (backward compatible)

- `AgentKindSchema = z.enum(["copilot"])` for now; widen as adapters land.
- `AgentParamsSchema`: `z.discriminatedUnion("kind", [z.object({ kind:
  z.literal("copilot") })])` (D9). Kind lives inside params, so a single
  field `agent: AgentParams` carries both.
- `start_session` / resume: optional `agentKind` / `agentParams`. Absent =
  copilot, so old Hosts and Nodes behave exactly as today. (Name must not
  clash with the existing `agent` field, which is the Copilot custom-agent
  name.)
- Node hello: `agentKinds: [{ kind, version? }]` from `detectAgentKinds`,
  plus capability `"agent-kinds"`. Keep `"copilot-acp"`.
- Fleet defaults (`UpdateDefaultsSchema` + store): `orchestratorAgent:
  AgentParams | undefined` (undefined = Auto = copilot, D1).
- FleetSession record: persist `agentKind` (+ params) so stop/resume and
  Node-reboot resume use the same agent.
- `SessionUsage`: fields a kind cannot know stay undefined; UI shows "?".

### 4. Host wiring

- routes/orchestrators.ts create: resolve `orchestratorAgent` (Auto ->
  copilot). Prefer a placement whose Node advertises that kind; if none,
  start on Copilot and emit a system event "Preferred agent X unavailable on
  <node>, started with Copilot" (D8). Old Nodes without "agent-kinds" are
  treated as copilot-only.
- Pass `hasAgent: false` for non-Copilot kinds so the full briefing is sent.
- Resume uses the session's stored `agentKind`, never the current default.

### 5. UI: Orchestrator settings page

- New `OrchestratorPanel.tsx`, registered in SettingsPanel.tsx and
  SettingsNavigation.
- Contents:
  - Preferred agent dropdown. This iteration: one option, "Copilot
    (default)". Driven by a UI list keyed by `AgentKind`, so new kinds only
    add an entry; later each option shows which Nodes have it.
  - Params section rendered per kind (empty for Copilot).
  - Note: "Applies to new orchestrators. Existing ones keep their agent."
  - Heartbeat schedule, moved here from GeneralPanel.
- Session header / usage bar: show the agent kind; unknown usage as "?".

### 6. Memory / self-improvement (future Hermes/OpenClaw)

- Hermes memory is per profile, not per ACP session; its adapter should take
  a dedicated profile param so fleet learnings stay out of the user's
  personal profile.
- The Host briefing stays authoritative. Task state comes from the fleet MCP
  tools, not the agent's memory.

## Phasing (this iteration)

1. Protocol: `AgentKindSchema`, `AgentParamsSchema`, optional fields on
   start/resume/hello/session, defaults. No behaviour change.
2. Node: `AgentKindAdapter` + factory; move Copilot code into copilot.ts
   (pure refactor, existing tests green). Detection + hello.
3. Node: auto-approve ("allow always") branch + fake-adapter tests.
4. Host: resolve preferred agent, placement preference, Copilot fallback with
   system event, sticky resume.
5. UI: Orchestrator settings page (Copilot-only dropdown), heartbeat move,
   "?" usage.
6. Verify: npm run lint, typecheck, test, build; manual orchestrator create,
   dispatch, heartbeat, stop/resume on Copilot shows no regression.

Future: one phase per new agent kind (investigate its ACP command, yolo,
usage, `session/load` support; if no loadSession, resume starts fresh with
`transferEnvelope` from orchestrator/briefing.ts).

## Agent identity and bundle registration (future, not this iteration)

Research notes for when non-Copilot kinds are added. Nothing here is built
now; the interface should leave room for an `ensureIdentity` hook.
Details marked "unverified" must be confirmed against a real install.

### What "agent / profile" means per kind

| Kind | Unit | Where it lives | Isolates | Shares |
| --- | --- | --- | --- | --- |
| Copilot | custom agent `*.agent.md` | `<cwd>/.github/agents/` (fleet installs per session) | prompt, tool list | memory, auth, config, history |
| Claude Code | subagent `*.md`; `claude --agent <name>` for main session | `.claude/agents/`, `~/.claude/agents/` | prompt, tools, model, permission mode, preloaded skills | CLAUDE.md hierarchy, settings, auth; full isolation needs separate `CLAUDE_CONFIG_DIR` (auth impact unverified) |
| Codex | `--profile` / `[profiles.x]` in config.toml | `~/.codex/config.toml` | config overrides only (model, approvals, sandbox, provider) | instructions, skills, sessions; full isolation needs separate `CODEX_HOME` |
| Hermes | profile (`hermes -p <name>`) | separate HERMES_HOME per profile | config, .env/keys, memory, sessions, skills, cron, gateway | nothing |
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
   - hermes: create profile `fleet-orchestrator` if missing; copy skills as
     `fleet-*`. Never overwrite memory or agent-learned skills.
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

### Trade-offs to decide later

- One shared `fleet-orchestrator` identity per Node (learning accumulates;
  concurrent orchestrators share memory) vs one per orchestrator (isolated,
  but learning does not accumulate). Recommendation: shared.
- Learned memory is per Node; an orchestrator placed on another Node does
  not carry it. Cross-Node memory sync is a separate, later problem.

## Open questions for reviewer

1. Is keeping one session class with adapter hooks enough, or should the
   Copilot-specific rollover / quiet-turn logic become a separate class?
2. Fallback event: system event on the orchestrator session only, or also a
   Host notification?
