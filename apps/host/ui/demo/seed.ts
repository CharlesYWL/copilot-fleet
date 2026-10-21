/**
 * The fleet a visitor lands in.
 *
 * Everything here is invented: three machines, a handful of projects, sessions
 * at different points in their lives, and an orchestrator part way through two
 * tasks. Timestamps are relative to page load so the demo always looks recent.
 */
import type {
  FleetNode,
  FleetSession,
  Notification,
  Placement,
  Run,
  RunNote,
  RunStep,
  SessionCommand,
  SessionConfigOption,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";

export const HOST_REVISION = "9159221cb144";

const now = Date.now();
export const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const COMMANDS: SessionCommand[] = [
  { name: "model", description: "Switch the model for this session", hint: "model" },
  { name: "compact", description: "Summarise the conversation to free up context" },
  { name: "usage", description: "Show token and premium-request usage" },
  { name: "clear", description: "Start a fresh conversation in this session" },
  { name: "review", description: "Review the current diff", hint: "focus" },
  { name: "plan", description: "Propose a plan before making changes", hint: "goal" },
];

export const configOptions = (model = "claude-sonnet-4.5"): SessionConfigOption[] => [
  {
    id: "model",
    name: "Model",
    description: "The model this session runs on",
    category: "model",
    currentValue: model,
    choices: [
      { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "" },
      { value: "claude-opus-4.5", name: "Claude Opus 4.5", description: "" },
      { value: "gpt-5", name: "GPT-5", description: "" },
      { value: "gpt-5-mini", name: "GPT-5 mini", description: "" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    description: "How long the model thinks before answering",
    category: "thought_level",
    currentValue: "medium",
    choices: [
      { value: "low", name: "Low", description: "" },
      { value: "medium", name: "Medium", description: "" },
      { value: "high", name: "High", description: "" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    description: "How the agent works",
    category: "mode",
    currentValue: "agent",
    choices: [
      { value: "agent", name: "Agent", description: "" },
      { value: "plan", name: "Plan", description: "" },
      { value: "autopilot", name: "Autopilot", description: "" },
    ],
  },
];

const health = (
  cpu: number,
  memUsedGb: number,
  memTotalGb: number,
  diskFreeGb: number,
) => {
  const at = ago(0.2);
  const gb = 1024 ** 3;
  return {
    cpu: { sampledAt: at, usagePercent: cpu },
    memory: {
      sampledAt: at,
      totalBytes: memTotalGb * gb,
      availableBytes: (memTotalGb - memUsedGb) * gb,
    },
    disk: {
      sampledAt: at,
      totalBytes: 1024 * gb,
      availableBytes: diskFreeGb * gb,
      scope: "home" as const,
    },
  };
};

export const seedNodes = (): FleetNode[] => [
  {
    id: "node-laptop",
    name: "charles-laptop",
    os: "win32",
    arch: "x64",
    version: "0.10.0",
    revision: HOST_REVISION,
    capabilities: ["copilot-acp", "managed-worktrees-v1", "usage-snapshots-v1"],
    agents: [{ name: "fleet-orchestrator", description: "Plans and delegates work" }],
    maxSessions: 4,
    activeSessions: 2,
    lastHeartbeat: ago(0.1),
    online: true,
    homeDir: "C:\\Users\\charles",
    health: health(23, 11, 32, 412),
    connection: { provider: "direct", hostUrl: "http://localhost:8787" },
    authProtocol: "mutual-auth-v1",
  },
  {
    id: "node-devbox",
    name: "devbox-west",
    os: "win32",
    arch: "x64",
    version: "0.10.0",
    revision: HOST_REVISION,
    capabilities: ["copilot-acp", "managed-worktrees-v1", "usage-snapshots-v1"],
    agents: [],
    maxSessions: 6,
    activeSessions: 3,
    lastHeartbeat: ago(0.1),
    online: true,
    homeDir: "C:\\Users\\charles",
    health: health(61, 38, 64, 220),
    connection: { provider: "devtunnel" },
    authProtocol: "mutual-auth-v1",
  },
  {
    id: "node-build",
    name: "build-01",
    os: "linux",
    arch: "x64",
    version: "0.10.0",
    revision: "4be71f0a9c23",
    capabilities: ["copilot-acp", "agent-kinds", "usage-snapshots-v1"],
    agents: [],
    agentKinds: [
      { kind: "copilot", version: "1.0.71" },
      { kind: "hermes", version: "0.4.2" },
    ],
    maxSessions: 8,
    activeSessions: 2,
    lastHeartbeat: ago(0.1),
    online: true,
    homeDir: "/home/charles",
    health: health(44, 21, 128, 760),
    connection: { provider: "devtunnel" },
    authProtocol: "legacy-secret",
  },
];

export const seedWorkspaces = (): Workspace[] => [
  {
    id: "chats",
    name: "Chats",
    description:
      "Questions and research that need no checkout. Sessions here run in each node's home directory.",
    createdAt: ago(60 * 24 * 30),
    kind: "chats",
  },
  {
    id: "ws-fleet",
    name: "copilot-fleet",
    description: "This project: the Fleet Host, Node and UI.",
    createdAt: ago(60 * 24 * 21),
    kind: "project",
  },
  {
    id: "ws-portal",
    name: "contoso-portal",
    description: "Customer portal web app (React + Fastify).",
    createdAt: ago(60 * 24 * 14),
    kind: "project",
  },
  {
    id: "ws-infra",
    name: "infra-pipelines",
    description: "CI/CD pipelines and deployment scripts.",
    createdAt: ago(60 * 24 * 7),
    kind: "project",
  },
];

export const seedPlacements = (): Placement[] => [
  {
    id: "pl-fleet-laptop",
    workspaceId: "ws-fleet",
    nodeId: "node-laptop",
    localPath: "Q:\\Repos\\copilot-fleet",
  },
  {
    id: "pl-fleet-devbox",
    workspaceId: "ws-fleet",
    nodeId: "node-devbox",
    localPath: "C:\\src\\copilot-fleet",
  },
  {
    id: "pl-portal-devbox",
    workspaceId: "ws-portal",
    nodeId: "node-devbox",
    localPath: "C:\\src\\contoso-portal",
  },
  {
    id: "pl-portal-build",
    workspaceId: "ws-portal",
    nodeId: "node-build",
    localPath: "/srv/repos/contoso-portal",
  },
  {
    id: "pl-infra-build",
    workspaceId: "ws-infra",
    nodeId: "node-build",
    localPath: "/srv/repos/infra-pipelines",
  },
  {
    id: "pl-chats-laptop",
    workspaceId: "chats",
    nodeId: "node-laptop",
    localPath: "C:\\Users\\charles",
  },
  {
    id: "pl-chats-devbox",
    workspaceId: "chats",
    nodeId: "node-devbox",
    localPath: "C:\\Users\\charles",
  },
  {
    id: "pl-chats-build",
    workspaceId: "chats",
    nodeId: "node-build",
    localPath: "/home/charles",
  },
];

type SessionSeed = {
  id: string;
  placementId: string;
  name: string;
  prompt: string;
  state: FleetSession["state"];
  minutesAgo: number;
  activity?: string;
  runId?: string;
  runRole?: FleetSession["runRole"];
  yolo?: boolean;
  favorite?: boolean;
  readOnly?: boolean;
  model?: string;
  credits?: number;
  context?: number;
};

const sessionSeeds: SessionSeed[] = [
  {
    id: "s-lead",
    placementId: "pl-fleet-laptop",
    name: "Reliability sprint",
    prompt: "Coordinate this week's reliability work across the fleet.",
    state: "idle",
    minutesAgo: 95,
    runRole: "lead",
    yolo: true,
    readOnly: true,
    model: "claude-opus-4.5",
    credits: 18.5,
    context: 42,
  },
  {
    id: "s-auth",
    placementId: "pl-portal-devbox",
    name: "Fix token refresh race",
    prompt:
      "Users get logged out when two tabs refresh the access token at the same time. Find the race and fix it.",
    state: "running",
    minutesAgo: 14,
    activity: "Running tests",
    favorite: true,
    credits: 6.25,
    context: 37,
  },
  {
    id: "s-migrate",
    placementId: "pl-fleet-devbox",
    name: "Migrate store to node:sqlite",
    prompt:
      "Replace better-sqlite3 with the built-in node:sqlite module and keep every test green.",
    state: "running",
    minutesAgo: 9,
    activity: "Waiting for permission",
    credits: 4.5,
    context: 29,
  },
  {
    id: "s-flaky",
    placementId: "pl-infra-build",
    name: "Flaky e2e on Linux",
    prompt: "The checkout e2e test fails 1 in 10 runs on Linux agents. Find out why.",
    state: "idle",
    minutesAgo: 40,
    credits: 3.75,
    context: 22,
  },
  {
    id: "s-research",
    placementId: "pl-chats-laptop",
    name: "",
    prompt:
      "Compare Dev Tunnels, Cloudflare Tunnel and Tailscale Funnel for exposing a dev server.",
    state: "idle",
    minutesAgo: 180,
    favorite: true,
    model: "gpt-5",
    credits: 1.5,
    context: 12,
  },
  {
    id: "s-docs",
    placementId: "pl-fleet-laptop",
    name: "Write onboarding guide",
    prompt: "Write docs/guide/getting-started.md for a first-time operator.",
    state: "completed",
    minutesAgo: 60 * 26,
    credits: 2.25,
    context: 18,
  },
  {
    id: "s-worker-investigate",
    placementId: "pl-portal-build",
    name: "Investigate retry storms",
    prompt: "Investigate why the portal client retries in lockstep after an outage.",
    state: "completed",
    minutesAgo: 70,
    runId: "run-retry",
    runRole: "worker",
    yolo: true,
    credits: 2.75,
    context: 25,
  },
  {
    id: "s-worker-implement",
    placementId: "pl-portal-devbox",
    name: "Implement jittered backoff",
    prompt: "Implement jittered exponential backoff in src/client/retry.ts.",
    state: "running",
    minutesAgo: 22,
    activity: "Editing src/client/retry.ts",
    runId: "run-retry",
    runRole: "worker",
    yolo: true,
    credits: 3.25,
    context: 33,
  },
];

export const sessionFromSeed = (seed: SessionSeed): FleetSession => {
  const placement = seedPlacements().find((entry) => entry.id === seed.placementId)!;
  const workspace = seedWorkspaces().find((entry) => entry.id === placement.workspaceId)!;
  const node = seedNodes().find((entry) => entry.id === placement.nodeId)!;
  return {
    id: seed.id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    placementId: placement.id,
    nodeId: node.id,
    nodeName: node.name,
    state: seed.state,
    name: seed.name,
    initialPrompt: seed.prompt,
    currentActivity: seed.activity ?? "",
    lastText: "",
    createdAt: ago(seed.minutesAgo),
    updatedAt: ago(Math.max(seed.minutesAgo - 5, 0.5)),
    lastActivityAt: ago(Math.max(seed.minutesAgo - 5, 0.5)),
    agentSessionId: `acp-${seed.id}`,
    agentParams: { kind: "copilot" },
    yolo: seed.yolo ?? false,
    commands: COMMANDS,
    configOptions: configOptions(seed.model),
    usage: {
      aiCredits: seed.credits ?? 1,
      context: {
        model: seed.model ?? "claude-sonnet-4.5",
        usedTokens: Math.round(((seed.context ?? 20) / 100) * 200_000),
        tokenLimit: 200_000,
        percentage: seed.context ?? 20,
        updatedAt: ago(1),
        estimated: false,
        source: "acp",
      },
    },
    runId: seed.runId ?? "",
    runRole: seed.runRole ?? "",
    favorite: seed.favorite ?? false,
    readOnly: seed.readOnly ?? false,
  };
};

export const seedSessions = (): FleetSession[] => sessionSeeds.map(sessionFromSeed);

/** Transcript events, written as the agent would have produced them. */
type Line =
  | ["user", string]
  | ["thought", string]
  | ["text", string]
  | ["tool", string, string, string, string?]
  | ["permission", string, string]
  | ["turn"]
  | ["system", string];

const transcripts: Record<string, Line[]> = {
  "s-auth": [
    [
      "user",
      "Users get logged out when two tabs refresh the access token at the same time. Find the race and fix it.",
    ],
    [
      "thought",
      "Two tabs refreshing at once suggests both send the same refresh token and the second one is rejected as reused. Let me look at the refresh path.",
    ],
    ["tool", "Search repository", "search", 'rg -n "refreshToken" src', "completed"],
    ["tool", "Read src/auth/session.ts", "read", "src/auth/session.ts", "completed"],
    ["tool", "Read src/auth/refresh.ts", "read", "src/auth/refresh.ts", "completed"],
    [
      "text",
      "Found it. `refresh.ts` rotates the refresh token on every call, and the identity provider revokes the whole token family when a rotated token is reused. Two tabs racing means the second tab presents the already-rotated token, which **revokes both sessions**.\n\nThe fix is to serialise refreshes across tabs with a `BroadcastChannel` lock, so only one tab refreshes and the others wait for its result.",
    ],
    [
      "tool",
      "Edit src/auth/refresh.ts",
      "edit",
      "src/auth/refresh.ts (+41 -9)",
      "completed",
    ],
    [
      "tool",
      "Edit src/auth/refresh.test.ts",
      "edit",
      "src/auth/refresh.test.ts (+58)",
      "completed",
    ],
    ["tool", "Run tests", "execute", "npm test -- auth", "in_progress"],
  ],
  "s-migrate": [
    [
      "user",
      "Replace better-sqlite3 with the built-in node:sqlite module and keep every test green.",
    ],
    [
      "thought",
      "node:sqlite's DatabaseSync has a near-identical synchronous API. The main differences are prepared statement binding and the lack of .pragma().",
    ],
    ["tool", "Search repository", "search", 'rg -n "better-sqlite3" apps', "completed"],
    [
      "tool",
      "Read apps/host/src/store.ts",
      "read",
      "apps/host/src/store.ts",
      "completed",
    ],
    [
      "text",
      'There are 3 call sites. I\'ll swap the import, replace `.pragma()` with `exec("PRAGMA ...")`, and update the transaction helper.',
    ],
    [
      "tool",
      "Edit apps/host/src/store.ts",
      "edit",
      "apps/host/src/store.ts (+18 -22)",
      "completed",
    ],
    [
      "permission",
      "Run npm uninstall better-sqlite3",
      "npm uninstall better-sqlite3 -w @fleet/host",
    ],
  ],
  "s-flaky": [
    ["user", "The checkout e2e test fails 1 in 10 runs on Linux agents. Find out why."],
    [
      "tool",
      "Read tests/e2e/checkout.spec.ts",
      "read",
      "tests/e2e/checkout.spec.ts",
      "completed",
    ],
    [
      "tool",
      "Run the test 20 times",
      "execute",
      "npx playwright test checkout --repeat-each=20",
      "completed",
    ],
    [
      "text",
      "Reproduced: **2 of 20** runs fail at the payment step. The test clicks *Pay* before the Stripe iframe has finished loading. On Linux agents fonts load slower, so the layout shifts and the click lands on the wrong element.\n\n```ts\n// before\nawait page.click('#pay');\n// after\nawait page.frameLocator('#card').locator('[name=cardnumber]').waitFor();\nawait page.getByRole('button', { name: 'Pay' }).click();\n```\n\nWith the fix, 50/50 runs pass. Want me to apply it?",
    ],
    ["turn"],
  ],
  "s-research": [
    [
      "user",
      "Compare Dev Tunnels, Cloudflare Tunnel and Tailscale Funnel for exposing a dev server.",
    ],
    [
      "thought",
      "The useful axes are: who can reach the URL, whether it is stable across restarts, and what setup each needs.",
    ],
    [
      "tool",
      "Fetch learn.microsoft.com/azure/developer/dev-tunnels",
      "fetch",
      "dev-tunnels overview",
      "completed",
    ],
    [
      "text",
      "| | Dev Tunnels | Cloudflare quick tunnel | Tailscale Funnel |\n| --- | --- | --- | --- |\n| Access | Private by default (Microsoft login) | Public URL | Public URL |\n| Stable URL | ✅ named tunnels | ❌ changes on restart | ✅ tailnet name |\n| Account | Microsoft / GitHub | None | Tailscale |\n| Best for | Corp dev boxes | Throwaway demos | Personal homelab |\n\n**Recommendation:** use Dev Tunnels for anything that exposes a control plane, because the URL alone grants nobody access.",
    ],
    ["turn"],
  ],
  "s-docs": [
    ["user", "Write docs/guide/getting-started.md for a first-time operator."],
    ["tool", "Read README.md", "read", "README.md", "completed"],
    [
      "tool",
      "Create docs/guide/getting-started.md",
      "edit",
      "docs/guide/getting-started.md (+184)",
      "completed",
    ],
    [
      "text",
      "Wrote the guide: prerequisites, starting the Host, connecting a Node with a one-time command, creating a workspace and placement, and starting the first session. It links to the security and remote-access guides for the details.",
    ],
    ["turn"],
  ],
  "s-lead": [
    ["user", "Coordinate this week's reliability work across the fleet."],
    [
      "text",
      "Ready. I can see **3 online Nodes** with 9 free session slots across `copilot-fleet`, `contoso-portal` and `infra-pipelines`.\n\nCreate a task from the board and I'll plan it, write success criteria, and dispatch workers.",
    ],
    ["turn"],
    [
      "system",
      'User: <fleet-task id="run-retry" name="Stop client retry storms" workspace="contoso-portal">\nAfter an outage every client retries in lockstep and knocks the API over again.\n</fleet-task>',
    ],
    [
      "thought",
      "Classic thundering herd. Investigate first, then implement jittered backoff, then review.",
    ],
    [
      "tool",
      "fleet_plan_task",
      "think",
      "Stop client retry storms · 3 phases · 3 criteria",
      "completed",
    ],
    [
      "text",
      "Planned **Stop client retry storms**: *Investigate → Implement → Review*. Dispatching the investigation to **build-01**.",
    ],
    ["tool", "fleet_dispatch", "execute", "investigate → build-01", "completed"],
    ["turn"],
    [
      "system",
      'User: <fleet-wake task="Stop client retry storms" phase="Investigate" (1/3) wakes=1/12>\nJust finished:\n- Investigate retry storms (investigate): succeeded\n</fleet-wake>',
    ],
    [
      "text",
      "The investigation confirms the client uses a fixed 2s retry with no jitter. Moving to **Implement** on **devbox-west**.",
    ],
    ["tool", "fleet_dispatch", "execute", "implement → devbox-west", "completed"],
    ["turn"],
    [
      "system",
      'User: <fleet-task id="run-ci" name="Cut CI time under 10 minutes" workspace="infra-pipelines">\nThe main pipeline takes 23 minutes. Get it under 10 without dropping coverage.\n</fleet-task>',
    ],
    [
      "text",
      "Planned **Cut CI time under 10 minutes**. All phases are done and the evidence is attached, so it's waiting for your sign-off on the task board.",
    ],
    ["turn"],
  ],
  "s-worker-investigate": [
    ["user", "Investigate why the portal client retries in lockstep after an outage."],
    ["tool", "Read src/client/retry.ts", "read", "src/client/retry.ts", "completed"],
    [
      "text",
      "`retry.ts` uses a fixed 2-second delay with no jitter, so every client that saw the outage retries at exactly the same moment. Recommendation: exponential backoff with full jitter, capped at 30s.",
    ],
    ["turn"],
  ],
  "s-worker-implement": [
    ["user", "Implement jittered exponential backoff in src/client/retry.ts."],
    ["tool", "Read src/client/retry.ts", "read", "src/client/retry.ts", "completed"],
    [
      "tool",
      "Edit src/client/retry.ts",
      "edit",
      "src/client/retry.ts (+22 -6)",
      "in_progress",
    ],
  ],
};

/** Raw events for one seeded session, sequenced from 1. */
export const seedEvents = (
  sessionId: string,
  startMinutesAgo: number,
): SessionEvent[] => {
  const lines = transcripts[sessionId] ?? [];
  const events: SessionEvent[] = [];
  let sequence = 1;
  const step = startMinutesAgo / Math.max(lines.length + 1, 1);
  lines.forEach((line, index) => {
    const createdAt = ago(startMinutesAgo - step * index);
    const push = (type: SessionEvent["type"], payload: Record<string, unknown>) =>
      events.push({
        eventId: `${sessionId}-e${sequence}`,
        sessionId,
        sequence: sequence++,
        type,
        payload,
        createdAt,
      });
    const [kind] = line;
    if (kind === "user") push("system", { text: `User: ${line[1]}` });
    else if (kind === "system") push("system", { text: line[1] });
    else if (kind === "thought") push("agent_thought", { text: line[1] });
    else if (kind === "text") push("agent_text", { text: line[1] });
    else if (kind === "turn") push("turn_complete", { stopReason: "end_turn" });
    else if (kind === "tool") {
      const toolCallId = `${sessionId}-tool-${index}`;
      push("tool", {
        toolCallId,
        title: line[1],
        kind: line[2],
        detail: line[3],
        status: line[4] ?? "completed",
      });
    } else if (kind === "permission") {
      push("permission", {
        requestId: `${sessionId}-perm-${index}`,
        title: line[1],
        toolCallId: `${sessionId}-ptool-${index}`,
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      });
    }
  });
  return events;
};

export const seedRuns = (): Run[] => [
  {
    id: "run-retry",
    workspaceId: "ws-portal",
    name: "Stop client retry storms",
    objective:
      "After an outage every client retries in lockstep and knocks the API over again. Add jittered exponential backoff so recovery is gradual.",
    state: "running",
    leadSessionId: "s-lead",
    placementId: "pl-portal-devbox",
    policy: {
      maxParallel: 3,
      maxSessions: 8,
      automaticManagedIntegrationRecovery: true,
      maxWakes: 12,
      maxOutputChars: 8000,
      yolo: true,
      onStepFailure: "wake",
      wakePolicy: "on_any_settle",
      stepTimeoutMs: 3_600_000,
      startingTimeoutMs: 120_000,
      staleAfterMs: 60_000,
    },
    phases: ["Investigate", "Implement", "Review"],
    phaseIndex: 1,
    successCriteria: [
      {
        id: "jitter-spreads-retries",
        scenario:
          "Simulating 1,000 clients failing at the same instant spreads their first retry over at least 10 seconds.",
        expectedEvidence: "npm test -- retry-distribution prints a spread >= 10s",
        essential: true,
      },
      {
        id: "backoff-capped",
        scenario:
          "After eight consecutive failures the delay between retries never exceeds 30 seconds.",
        expectedEvidence: "retry.test.ts 'caps the delay at 30s' passes",
        essential: true,
      },
      {
        id: "no-regression",
        scenario:
          "The existing client test suite passes unchanged after the backoff change.",
        expectedEvidence: "npm test -- client exits 0",
        essential: false,
      },
    ],
    stopWhen:
      "All essential criteria have passing test evidence and a reviewer has approved the diff.",
    failureReason: "",
    pendingPrompt: "",
    settleSeq: 1,
    wakeSeq: 1,
    emptyWakeCount: 0,
    reviewSeq: 0,
    createdAt: ago(90),
    updatedAt: ago(20),
  },
  {
    id: "run-ci",
    workspaceId: "ws-infra",
    name: "Cut CI time under 10 minutes",
    objective:
      "The main pipeline takes 23 minutes. Get it under 10 without dropping coverage.",
    state: "awaiting_human",
    leadSessionId: "s-lead",
    placementId: "pl-infra-build",
    policy: {
      maxParallel: 3,
      maxSessions: 8,
      automaticManagedIntegrationRecovery: true,
      maxWakes: 12,
      maxOutputChars: 8000,
      yolo: true,
      onStepFailure: "wake",
      wakePolicy: "on_any_settle",
      stepTimeoutMs: 3_600_000,
      startingTimeoutMs: 120_000,
      staleAfterMs: 60_000,
    },
    phases: ["Profile", "Parallelise", "Verify"],
    phaseIndex: 2,
    successCriteria: [
      {
        id: "under-ten-minutes",
        scenario:
          "Three consecutive runs of the main pipeline finish in under 10 minutes wall clock.",
        expectedEvidence: "Pipeline runs #4182, #4183, #4184 durations",
        essential: true,
      },
      {
        id: "coverage-unchanged",
        scenario: "Line coverage reported by the pipeline stays at or above 81.4%.",
        expectedEvidence: "Coverage summary from run #4184",
        essential: true,
      },
    ],
    stopWhen: "Three green runs under 10 minutes with unchanged coverage.",
    failureReason: "",
    pendingPrompt: "",
    settleSeq: 3,
    wakeSeq: 3,
    emptyWakeCount: 0,
    reviewSeq: 1,
    createdAt: ago(60 * 5),
    updatedAt: ago(35),
  },
];

const stepBase = {
  category: "",
  dependsOn: [] as string[],
  output: "",
  eventSeqFrom: 0,
  attempts: 1,
  dispatchedAt: "",
};

export const seedSteps = (): Record<string, RunStep[]> => ({
  "run-retry": [
    {
      ...stepBase,
      id: "step-investigate",
      runId: "run-retry",
      stepKey: "investigate",
      title: "Investigate retry storms",
      prompt: "Investigate why the portal client retries in lockstep after an outage.",
      category: "read",
      state: "succeeded",
      sessionId: "s-worker-investigate",
      placementId: "pl-portal-build",
      output:
        "Fixed 2s retry delay, no jitter. Recommend full-jitter exponential backoff capped at 30s.",
      phaseIndex: 0,
      position: 0,
      createdAt: ago(85),
      updatedAt: ago(70),
    },
    {
      ...stepBase,
      id: "step-implement",
      runId: "run-retry",
      stepKey: "implement",
      title: "Implement jittered backoff",
      prompt: "Implement jittered exponential backoff in src/client/retry.ts.",
      category: "write",
      dependsOn: ["investigate"],
      state: "running",
      sessionId: "s-worker-implement",
      placementId: "pl-portal-devbox",
      phaseIndex: 1,
      position: 1,
      createdAt: ago(25),
      updatedAt: ago(1),
      admission: {
        state: "running",
        code: "running",
        detail: "Running on devbox-west",
        nodeId: "node-devbox",
        nodeName: "devbox-west",
        localPath: "C:\\src\\contoso-portal",
        conflicts: [],
        resumable: false,
      },
    },
    {
      ...stepBase,
      id: "step-review",
      runId: "run-retry",
      stepKey: "review",
      title: "Review the backoff change",
      prompt: "Review the diff for correctness and test coverage.",
      category: "read",
      dependsOn: ["implement"],
      state: "pending",
      sessionId: "",
      placementId: "",
      phaseIndex: 2,
      position: 2,
      attempts: 0,
      createdAt: ago(25),
      updatedAt: ago(25),
    },
  ],
  "run-ci": [
    {
      ...stepBase,
      id: "step-profile",
      runId: "run-ci",
      stepKey: "profile",
      title: "Profile the pipeline",
      prompt: "Find where the 23 minutes go.",
      category: "read",
      state: "succeeded",
      sessionId: "",
      placementId: "pl-infra-build",
      output: "61% of wall time is the serial test stage; 18% is cold npm installs.",
      phaseIndex: 0,
      position: 0,
      createdAt: ago(290),
      updatedAt: ago(250),
    },
    {
      ...stepBase,
      id: "step-shard",
      runId: "run-ci",
      stepKey: "shard-tests",
      title: "Shard tests across 4 agents",
      prompt: "Split the test stage into 4 shards.",
      category: "write",
      state: "succeeded",
      sessionId: "",
      placementId: "pl-infra-build",
      output: "Test stage now runs as 4 parallel shards: 14m → 4m10s.",
      phaseIndex: 1,
      position: 1,
      createdAt: ago(240),
      updatedAt: ago(150),
    },
    {
      ...stepBase,
      id: "step-cache",
      runId: "run-ci",
      stepKey: "cache-deps",
      title: "Cache npm dependencies",
      prompt: "Add a dependency cache keyed on the lockfile.",
      category: "write",
      state: "succeeded",
      sessionId: "",
      placementId: "pl-infra-build",
      output: "Install step: 4m05s → 38s on a warm cache.",
      phaseIndex: 1,
      position: 2,
      createdAt: ago(240),
      updatedAt: ago(140),
    },
    {
      ...stepBase,
      id: "step-verify",
      runId: "run-ci",
      stepKey: "verify",
      title: "Verify three green runs",
      prompt: "Run the pipeline three times and report durations and coverage.",
      category: "read",
      dependsOn: ["shard-tests", "cache-deps"],
      state: "succeeded",
      sessionId: "",
      placementId: "pl-infra-build",
      output: "Runs #4182 8m51s, #4183 9m12s, #4184 8m47s. Coverage 81.6%.",
      phaseIndex: 2,
      position: 3,
      createdAt: ago(120),
      updatedAt: ago(36),
    },
  ],
});

export const seedNotes = (): Record<string, RunNote[]> => ({
  "run-retry": [
    {
      id: "note-retry-1",
      runId: "run-retry",
      phaseIndex: 0,
      summary: "Root cause confirmed: fixed delay with no jitter",
      kind: "progress",
      source: "orchestrator",
      body: "The investigation worker found a constant 2s retry delay. Every client retries at the same instant after an outage.",
      createdAt: ago(68),
    },
  ],
  "run-ci": [
    {
      id: "note-ci-1",
      runId: "run-ci",
      phaseIndex: 0,
      summary: "Serial test stage is 61% of wall time",
      kind: "progress",
      source: "orchestrator",
      body: "Profiling shows the test stage dominates; sharding is the biggest lever.",
      createdAt: ago(248),
    },
    {
      id: "note-ci-2",
      runId: "run-ci",
      phaseIndex: 2,
      summary: "All criteria met — ready for sign-off",
      kind: "review",
      source: "orchestrator",
      body: "Three consecutive runs finished in 8m51s, 9m12s and 8m47s. Coverage is 81.6% (baseline 81.4%).",
      createdAt: ago(35),
    },
  ],
});

export const seedNotifications = (): Notification[] => [
  {
    id: "n-review",
    sourceKey: "review:run-ci:1",
    category: "orchestration",
    kind: "orchestration_needs_review",
    severity: "warning",
    status: "active",
    title: "Cut CI time under 10 minutes needs your review",
    body: "All success criteria are met. Approve the task or send it back with a note.",
    subject: { type: "run", id: "run-ci", label: "Cut CI time under 10 minutes" },
    navigation: { type: "run", runId: "run-ci" },
    data: {},
    createdAt: ago(35),
    updatedAt: ago(35),
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
  },
  {
    id: "n-permission",
    sourceKey: "permission:s-migrate",
    category: "permission",
    kind: "permission_request",
    severity: "warning",
    status: "active",
    title: "Migrate store to node:sqlite is waiting for permission",
    body: "Run npm uninstall better-sqlite3",
    subject: { type: "session", id: "s-migrate", label: "Migrate store to node:sqlite" },
    navigation: { type: "session", sessionId: "s-migrate" },
    data: {},
    createdAt: ago(3),
    updatedAt: ago(3),
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
  },
  {
    id: "n-done",
    sourceKey: "completion:s-docs",
    category: "agent_lifecycle",
    kind: "agent_completion",
    severity: "info",
    status: "active",
    title: "Write onboarding guide finished",
    body: "The session completed its turn on charles-laptop.",
    subject: { type: "session", id: "s-docs", label: "Write onboarding guide" },
    navigation: { type: "session", sessionId: "s-docs" },
    data: {},
    createdAt: ago(60 * 26),
    updatedAt: ago(60 * 26),
    readAt: ago(60 * 25),
    dismissedAt: null,
    resolvedAt: null,
  },
];
