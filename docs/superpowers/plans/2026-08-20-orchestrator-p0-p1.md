# Orchestrator P0+P1 Implementation Plan

> **Status: implemented 2026-08-21.** Every task below is done and verified —
> lint, typecheck, 767 tests, and a build all pass. Beyond the suite it was run
> on real processes: a real Host and a real Node over a real WebSocket, using
> `--mock-agent` so no Copilot login is needed. `audit → fix → test` completes,
> approving with the node down leaves steps `pending` rather than failing them,
> the run finishes as soon as the node returns, and a Host restart mid-flight
> mis-settles nothing.
>
> That end-to-end pass found two bugs the unit tests could not: the session pane
> auto-selected a run-owned worker the tree had already filtered out (offering a
> **Resume** that would restart it outside the run), and a refreshed browser
> showed every run as "0 steps" because finished runs never broadcast again.
> Both are fixed and covered by tests.
>
> What is *not* here, by design, is P2: the MCP facade, a model-driven Lead, and
> the live `awaiting_lead` wake path. The wake logic exists and is unit-tested;
> nothing drives it yet.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Host-side run engine that can execute a handwritten DAG (`audit → fix → test`) on mock-agent nodes, survive Host restart without mis-settling, and show Runs in the UI — with zero LLM and zero MCP.

**Revised 2026-08-21** after a three-way design review. Six things changed shape before any code was written, because all six live in the P0 schema, the pure function, or the store and cost a migration to add later: two-phase dispatch with a `starting` step state; `runs.placement_id` pinning; the parallel lock moved from workspace to **placement** with read-only categories exempt; `settleSeq` / `wakeSeq` monotonic counters replacing timestamp columns; a separate `startingTimeoutMs` plus a deadline sweeper, without which every timeout in the policy is dead code; and backup/restore coverage with a demotion rule on import. Spec §16 records the three P2 contracts, all now decided.

**Architecture:** `planNextActions` is a pure function over a snapshot of run/steps/sessions/nodes/placements. `OrchestratorEngine` ticks on session events and REST, then executes the returned actions. P1 uses `wakePolicy: "none"` so Lead-wake is unit-tested but not live. Spec: `docs/superpowers/specs/2026-08-20-orchestrator-synthesis-design.md`.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite (`node:sqlite`), React + Fluent UI v9, Vitest.

## Global Constraints

- Do not add members to `NodeCommandSchema` or `HostToNodeMessageSchema` (unknown `type` closes the Node with 1008).
- Do not add SessionEvent types; run progress is `run` / `run_steps` browser messages plus REST.
- Schema additions on `SessionSchema` / `SnapshotSchema` must use `.default("")` / `.default([])`.
- Store migrations: `CREATE TABLE IF NOT EXISTS` and `addColumnIfMissing` only. No `ON DELETE CASCADE`. `transaction()` is not reentrant.
- Completing a step requires `turn_complete` then `idle`, never `command_result.ok`. `command_result.ok` does exactly one thing: move the step from `starting` to `running`.
- Dispatch is two-phase and cannot be one transaction — SQLite cannot hold a WebSocket send. Write the receipt as `starting` and commit, then dispatch; a failed send rolls back to `pending`, and a Node lost before ACK is failed by the deadline sweeper. Never dispatch before the receipt lands.
- Dispatching a step sends only `start_session` (it already sends the first prompt).
- Timeouts and cancel-run send `stop`, not `cancel`. A run reaching a terminal state must `stop` every non-terminal session it owns, including idle-but-successful workers — non-terminal sessions hold a slot in `reservedSessionCount` forever otherwise.
- `offline` means unknown: `planNextActions` must not settle or finish.
- Idempotency uses the monotonic `settleSeq` / `wakeSeq` counters, never wall-clock strings.
- Parallelism is locked per **placement**, not per workspace: a workspace has one placement per node, and those are separate checkouts that cannot race. Same-placement writing steps (`implement` / `test`): v1 max 1, refused as `placement_busy`. Read-only categories (`review-*`, `explore`) do not count against the write lock.
- Once a run has a `placementId`, every later step reuses it; never re-pick.
- Placement pick leaves one slot of headroom (`reserved < maxSessions - 0` is wrong; require `reserved < maxSessions` AND `reserved + 1 < maxSessions` when maxSessions > 1, else `reserved < maxSessions` for maxSessions === 1). Spec: never fill `maxSessions`. Implementation: treat remaining capacity as `max(0, node.maxSessions - reservedSessionCount - 1)` except when `maxSessions === 1`, then remaining is `1 - reserved` (a single-slot node must still be usable).
- Tests: `npm test` (workspace vitest). Service files: `--project services`. UI: `--project ui`.
- Do not implement MCP, Lead sessions, `awaiting_lead` live path, or git worktrees in this plan.

## File map

- Create: `apps/host/src/orchestrator/states.ts` — run/step transition tables
- Create: `apps/host/src/orchestrator/states.test.ts`
- Create: `apps/host/src/orchestrator/schedule.ts` — `planNextActions`
- Create: `apps/host/src/orchestrator/schedule.test.ts`
- Create: `apps/host/src/orchestrator/engine.ts` — tick + execute actions
- Create: `apps/host/src/routes/runs.ts`
- Create: `apps/host/ui/src/components/RunsPanel.tsx`
- Create: `apps/host/ui/src/components/RunsPanel.test.tsx`
- Modify: `packages/protocol/src/index.ts` — Run types, session fields, browser messages, snapshot, `HOST_YOLO_CAPABILITY`
- Modify: `packages/protocol/src/index.test.ts`
- Modify: `apps/host/src/store.ts` / `store.test.ts`
- Modify: `apps/host/src/fleet-service.ts` — `createAndStartSession`, `onSessionEvent`
- Modify: `apps/host/src/routes/sessions.ts` — call `createAndStartSession`
- Modify: `apps/host/src/server.ts` — register run routes + engine
- Modify: `apps/host/src/routes.test.ts`
- Modify: `apps/host/src/gateway/browser-socket.ts` only if snapshot assembly lives there; otherwise snapshot in `system.ts` / `fleet-service`
- Modify: `apps/host/ui/src/hooks/useFleet.ts` — handle `run` / `run_steps`, default `runs: []`
- Modify: `apps/host/ui/src/App.tsx`, `Sidebar.tsx`
- Modify: `ARCHITECTURE.md`, `PRODUCT.md`, `README.md`, `README.zh-CN.md`

---

### Task 1: Protocol types

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces: `RunState`, `RunStepState`, `RunRole`, `Run`, `RunStep`, `RunPolicy`, `HOST_YOLO_CAPABILITY`, `canTransitionRun`, `canTransitionRunStep`; `SessionSchema.runId` / `runRole`; `SnapshotSchema.runs`; browser messages `run` and `run_steps`

- [x] **Step 1: Write the failing tests**

Add to `packages/protocol/src/index.test.ts`:

```ts
import {
  HOST_YOLO_CAPABILITY,
  BrowserMessageSchema,
  SessionSchema,
  SnapshotSchema,
  canTransitionRun,
  canTransitionRunStep,
} from "./index.js";

it("exports host-yolo as a named capability", () => {
  expect(HOST_YOLO_CAPABILITY).toBe("host-yolo");
});

it("defaults runId and runRole on sessions", () => {
  const session = SessionSchema.parse({
    id: "s1",
    workspaceId: "w1",
    workspaceName: "w",
    placementId: "p1",
    nodeId: "n1",
    nodeName: "n",
    state: "idle",
    initialPrompt: "hi",
    currentActivity: "",
    lastText: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(session.runId).toBe("");
  expect(session.runRole).toBe("");
});

it("defaults runs on snapshots so old hosts do not break browsers", () => {
  const snap = SnapshotSchema.parse({
    nodes: [],
    workspaces: [],
    placements: [],
    sessions: [],
    hostRevision: "abc",
  });
  expect(snap.runs).toEqual([]);
});

it("accepts run browser messages", () => {
  const now = "2026-01-01T00:00:00.000Z";
  expect(
    BrowserMessageSchema.parse({
      type: "run",
      run: {
        id: "r1",
        workspaceId: "w1",
        name: "n",
        objective: "o",
        state: "running",
        leadSessionId: "",
        policy: {
          maxParallel: 3,
          maxSessions: 8,
          maxWakes: 12,
          maxOutputChars: 8_000,
          yolo: true,
          onStepFailure: "wake",
          wakePolicy: "none",
          stepTimeoutMs: 3_600_000,
          startingTimeoutMs: 120_000,
          staleAfterMs: 60_000,
        },
        failureReason: "",
        placementId: "",
        settleSeq: 0,
        wakeSeq: 0,
        emptyWakeCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    }).type,
  ).toBe("run");
});

it("allows awaiting_lead from running, not from planning", () => {
  expect(canTransitionRun("running", "awaiting_lead")).toBe(true);
  expect(canTransitionRun("planning", "awaiting_lead")).toBe(false);
  // Dispatch is two-phase: the receipt lands as `starting` before the command
  // goes out, so nothing may jump straight from pending to running.
  expect(canTransitionRunStep("pending", "starting")).toBe(true);
  expect(canTransitionRunStep("pending", "running")).toBe(false);
  expect(canTransitionRunStep("starting", "running")).toBe(true);
  expect(canTransitionRunStep("starting", "pending")).toBe(true); // send failed
  expect(canTransitionRunStep("starting", "failed")).toBe(true); // lost before ACK
  expect(canTransitionRunStep("succeeded", "running")).toBe(false);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project services packages/protocol/src/index.test.ts`
Expected: FAIL on missing exports / missing fields.

- [x] **Step 3: Add types next to `SessionSchema` in `packages/protocol/src/index.ts`**

Place `HOST_YOLO_CAPABILITY` with the other capability constants:

```ts
export const HOST_YOLO_CAPABILITY = "host-yolo";
```

Add after `FleetSession`:

```ts
export const RunStateSchema = z.enum([
  "planning",
  "awaiting_approval",
  "running",
  "awaiting_lead",
  "aggregating",
  "completed",
  "failed",
  "cancelled",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunStepStateSchema = z.enum([
  "pending",
  "starting",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export type RunStepState = z.infer<typeof RunStepStateSchema>;

export const RunRoleSchema = z.enum(["", "lead", "worker", "reviewer"]);
export type RunRole = z.infer<typeof RunRoleSchema>;

export const RunPolicySchema = z.object({
  maxParallel: z.number().int().positive().default(3),
  maxSessions: z.number().int().positive().default(8),
  maxWakes: z.number().int().positive().default(12),
  maxOutputChars: z.number().int().positive().default(8_000),
  yolo: z.boolean().default(true),
  onStepFailure: z.enum(["wake", "fail-fast", "continue"]).default("wake"),
  wakePolicy: z.enum(["on_any_settle", "none"]).default("none"),
  stepTimeoutMs: z.number().int().positive().default(3_600_000),
  /**
   * Bounds only the dispatch window (frame out, Copilot spawned, session/new),
   * which is a different order of magnitude from how long work takes. Letting
   * stepTimeoutMs cover it would hold the placement write lock for an hour on a
   * step that never started.
   */
  startingTimeoutMs: z.number().int().positive().default(120_000),
  staleAfterMs: z.number().int().positive().default(60_000),
});
export type RunPolicy = z.infer<typeof RunPolicySchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().min(1),
  state: RunStateSchema,
  leadSessionId: z.string().default(""),
  /** Pinned at the first side-effecting step; every later step reuses it. */
  placementId: z.string().default(""),
  policy: RunPolicySchema,
  failureReason: z.string().default(""),
  /**
   * Monotonic counters, not timestamps: the exactly-one-wake invariant rests on
   * this comparison, and TEXT clocks break it on same-millisecond settles,
   * clock skew, and restart.
   */
  settleSeq: z.number().int().nonnegative().default(0),
  wakeSeq: z.number().int().nonnegative().default(0),
  emptyWakeCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepKey: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  category: z.string().default(""),
  dependsOn: z.array(z.string()).default([]),
  state: RunStepStateSchema,
  sessionId: z.string().nullable().default(null),
  placementId: z.string().nullable().default(null),
  output: z.string().default(""),
  /** Envelope watermark: only events after this belong to this step. */
  eventSeqFrom: z.number().int().nonnegative().default(0),
  attempts: z.number().int().nonnegative().default(0),
  /** When the step entered `starting`; the dispatch deadline counts from here. */
  dispatchedAt: z.string().default(""),
  position: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RunStep = z.infer<typeof RunStepSchema>;
```

Add to `SessionSchema`:

```ts
runId: z.string().default(""),
runRole: RunRoleSchema.default(""),
```

Add to `SnapshotSchema` (find the existing object; do not remove fields):

```ts
runs: z.array(RunSchema).default([]),
```

Add to `HostBackupSchema` — **both must be `.default([])`** or every backup file written before this change stops parsing:

```ts
runs: z.array(RunSchema).default([]),
runSteps: z.array(RunStepSchema).default([]),
```

`run_notes` is a P2 table (it exists for the Lead), so `runNotes` joins the backup in that plan, the same way and with the same `.default([])`.

`HostBackupSessionSchema` is `SessionSchema.extend({ position })`, so `runId` / `runRole` follow automatically once they have defaults — nothing to add there.

Add two members to `BrowserMessageSchema` union:

```ts
z.object({ type: z.literal("run"), run: RunSchema }),
z.object({
  type: z.literal("run_steps"),
  runId: z.string().min(1),
  steps: z.array(RunStepSchema),
}),
```

Add transition helpers next to `canTransition`:

```ts
const runTransitions: Record<RunState, ReadonlySet<RunState>> = {
  // Approval is the entrance, not a mid-course gate: a run is created
  // awaiting_approval and only reaches planning once a human approves it.
  // `running` is also reachable directly, for the handwritten-DAG fixture:
  // there is no Lead there, so there is nothing to plan — the plan arrived
  // over REST.
  awaiting_approval: new Set(["planning", "running", "failed", "cancelled"]),
  planning: new Set(["running", "failed", "cancelled"]),
  running: new Set(["awaiting_lead", "aggregating", "completed", "failed", "cancelled"]),
  awaiting_lead: new Set(["running", "aggregating", "completed", "failed", "cancelled"]),
  aggregating: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const runStepTransitions: Record<RunStepState, ReadonlySet<RunStepState>> = {
  pending: new Set(["starting", "skipped", "cancelled"]),
  // `starting` is the window between the receipt landing and the Node's ACK.
  // It exists because a database transaction cannot hold a WebSocket send:
  // back to pending if the command never went out, failed if the Node was lost
  // before it answered.
  starting: new Set(["running", "pending", "failed", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return from === to || runTransitions[from].has(to);
}

export function canTransitionRunStep(from: RunStepState, to: RunStepState): boolean {
  return from === to || runStepTransitions[from].has(to);
}
```

Update `yoloUnsupportedReason` in `apps/host/src/session-policy.ts` to use `HOST_YOLO_CAPABILITY` instead of the `"host-yolo"` literal (import from protocol). This is the one-line constant cleanup from the spec.

- [x] **Step 4: Run tests**

Run: `npx vitest run --project services packages/protocol/src/index.test.ts`
Expected: PASS. Also run `npm run typecheck` and fix any Snapshot literal missing `runs` (add `runs: []` wherever `emptySnapshot` or similar is constructed, especially `apps/host/ui/src/hooks/useFleet.ts`).

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts apps/host/src/session-policy.ts apps/host/ui/src/hooks/useFleet.ts
git commit -m "feat: add run protocol types and host-yolo capability constant"
```

---

### Task 2: `planNextActions` pure scheduler

**Files:**
- Create: `apps/host/src/orchestrator/schedule.ts`
- Create: `apps/host/src/orchestrator/schedule.test.ts`

**Interfaces:**
- Consumes: `Run`, `RunStep`, `FleetSession`, `FleetNode`, `Placement`, `HOST_YOLO_CAPABILITY`, `canTransitionRun`, `canTransitionRunStep` from `@fleet/protocol`; `reservedSessionCount` from `../session-policy.js`
- Produces: `planNextActions(input: ScheduleInput): ScheduleAction[]` and the `ScheduleAction` union

- [x] **Step 1: Write failing tests covering spec §12 invariants**

Create `apps/host/src/orchestrator/schedule.test.ts`. Include helpers that build a minimal world (one workspace, two nodes with `maxSessions: 4` and `host-yolo`, two placements, a running run with `wakePolicy: "none"`). Then these cases:

1. All sessions `offline` → no `settle_step`, `finish_run`, or `wake_lead`
2. Step `running`, session `running`, no `turnComplete` flag → no settle
3. Step already `succeeded` plus a late `turnComplete` → empty actions
4. `reservedSessionCount === maxSessions` → no `start_step`; also when `reserved === maxSessions - 1` and `maxSessions > 1` → no `start_step` (headroom)
5. Two pending writing steps needing the same placement, none running → only one `start_step`; a `review-quick` step alongside a running `implement` on the same placement → still started (read-only is exempt)
6. Two steps settle while Lead would be idle and `wakePolicy: "on_any_settle"` and `settleSeq > wakeSeq` → exactly one `wake_lead`
7. `wakePolicy: "none"` and all steps succeeded → `finish_run` completed, no `wake_lead`, plus `stop_session` for every non-terminal session the run owns
8. Cyclic `dependsOn` is not this function's job (rejected at plan submit); a pending step whose dependency is `failed` and `onStepFailure: "continue"` → `skip_step`
9. `start_step` prompt is the step prompt only (no second prompt action), and the step it targets goes to `starting`, never straight to `running`
10. A `running` step whose session is `idle` and `turnComplete: true` → `settle_step` succeeded with output taken from the provided `stepOutputs` map, not `session.lastText`
11. `run.placementId` already set → `start_step` reuses it and never ranks placements, even when a roomier node is online
12. A `starting` step older than the dispatch deadline on an **online** node → `settle_step` failed; the same step on an **offline** node → no action (offline is unknown)

`ScheduleInput` must carry `turnCompleteSessionIds: ReadonlySet<string>` and `stepOutputs: ReadonlyMap<string, string>` so the pure function does not read the database.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project services apps/host/src/orchestrator/schedule.test.ts`
Expected: FAIL cannot find module `./schedule.js`

- [x] **Step 3: Implement `apps/host/src/orchestrator/schedule.ts`**

```ts
import {
  HOST_YOLO_CAPABILITY,
  terminalSessionStates,
  type FleetNode,
  type FleetSession,
  type Placement,
  type Run,
  type RunState,
  type RunStep,
  type RunStepState,
} from "@fleet/protocol";
import { reservedSessionCount } from "../session-policy.js";

export type ScheduleInput = {
  run: Run;
  steps: readonly RunStep[];
  sessions: readonly FleetSession[];
  nodes: readonly FleetNode[];
  placements: readonly Placement[];
  turnCompleteSessionIds: ReadonlySet<string>;
  stepOutputs: ReadonlyMap<string, string>;
  nowMs: number;
};

export type ScheduleAction =
  | { type: "start_step"; stepId: string; placementId: string; prompt: string }
  | { type: "settle_step"; stepId: string; state: RunStepState; output: string }
  | { type: "skip_step"; stepId: string; reason: string }
  | { type: "stop_session"; sessionId: string; reason: string }
  | { type: "wake_lead"; runId: string; prompt: string }
  | { type: "finish_run"; state: RunState; reason: string };

export function remainingCapacity(node: FleetNode, reserved: number): number {
  if (node.maxSessions <= 1) return Math.max(0, node.maxSessions - reserved);
  return Math.max(0, node.maxSessions - reserved - 1);
}

export function planNextActions(input: ScheduleInput): ScheduleAction[] {
  // Implement:
  // 1. Ignore if run is terminal.
  // 2. For each running step: if session missing/terminal → settle failed (unless session offline → skip, wait).
  //    If session idle AND turnComplete → settle succeeded with stepOutputs.
  //    If nowMs - updatedAt > stepTimeoutMs and session not offline → emit
  //    stop_session, not settle; a later tick settles on the terminal event.
  // 2b. For each `starting` step: if nowMs - dispatchedAt > startingDeadlineMs
  //    and the node is online → settle failed ("no ACK"). If the node went
  //    offline, leave it: offline is unknown.
  // 3. Skip pending steps whose failed dependency cannot run (continue policy).
  // 4. If wakePolicy is none and every step is terminal: finish_run completed
  //    if any succeeded and none failed-unskipped under fail-fast; else failed.
  //    Before finishing, emit stop_session for every non-terminal session the
  //    run owns — an idle worker still holds a reservedSessionCount slot.
  // 5. If wakePolicy on_any_settle and settleSeq > wakeSeq: wake_lead
  //    (engine supplies the envelope). Pure function can return wake_lead with
  //    prompt "" and engine fills the envelope.
  // 6. Start at most maxParallel pending steps whose dependsOn are all succeeded,
  //    picking placement with remainingCapacity > 0 and yolo capability if
  //    needed. If run.placementId is set, reuse it and skip selection entirely.
  //    Refuse a second in-flight WRITING step (implement/test) on the same
  //    placementId; read-only categories (review-*, explore) are exempt and in
  //    fact must land on the placement of the step they review.
  //    Note: the returned action moves the step to `starting`, not `running`.
}
```

Fill in the function body so all tests in Step 1 pass. Detect cycles at submit time in Task 6, not here.

Placement picker details:

```ts
function pickPlacement(input: ScheduleInput, step: RunStep): string | undefined {
  const upstreamNodeIds = new Set(
    input.steps
      .filter((s) => step.dependsOn.includes(s.stepKey) && s.placementId)
      .map((s) => input.placements.find((p) => p.id === s.placementId)?.nodeId)
      .filter((id): id is string => Boolean(id)),
  );

  // Once the run is pinned, selection is over: every later step runs on the
  // same physical checkout. Re-picking is what makes a reviewer read a stale
  // tree, because a workspace has one placement per node and those are
  // separate directories.
  if (input.run.placementId) return input.run.placementId;

  // v1 write lock, scoped to the placement rather than the workspace: only a
  // writing category blocks, and only against another writing category on the
  // same placement.
  const writing = (category: string) => category === "implement" || category === "test";
  if (
    writing(step.category) &&
    input.steps.some(
      (s) =>
        (s.state === "running" || s.state === "starting") &&
        writing(s.category) &&
        s.placementId,
    )
  ) {
    return undefined; // placement_busy
  }

  const ranked = input.placements
    .filter((p) => p.workspaceId === input.run.workspaceId)
    .map((p) => {
      const node = input.nodes.find((n) => n.id === p.nodeId);
      if (!node?.online) return undefined;
      if (input.run.policy.yolo && !node.capabilities.includes(HOST_YOLO_CAPABILITY)) {
        return undefined;
      }
      const reserved = reservedSessionCount(input.sessions, node.id);
      const free = remainingCapacity(node, reserved);
      if (free < 1) return undefined;
      const affinity = upstreamNodeIds.has(node.id) ? 100 : 0;
      return { placementId: p.id, score: affinity + free, position: p.position };
    })
    .filter((row): row is { placementId: string; score: number; position: number } => Boolean(row))
    .sort((a, b) => b.score - a.score || a.position - b.position);
  return ranked[0]?.placementId;
}
```

- [x] **Step 4: Run tests**

Run: `npx vitest run --project services apps/host/src/orchestrator/schedule.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/host/src/orchestrator/schedule.ts apps/host/src/orchestrator/schedule.test.ts
git commit -m "feat: add deterministic orchestrator scheduler"
```

---

### Task 3: Store tables and mappers

**Files:**
- Modify: `apps/host/src/store.ts`
- Modify: `apps/host/src/store.test.ts`

**Interfaces:**
- Consumes: `RunSchema`, `RunStepSchema`, `RunPolicySchema`
- Produces: `createRun`, `getRun`, `listRuns`, `updateRun`, `deleteRun`, `replaceRunSteps`, `listRunSteps`, `updateRunStep`, `runFromRow`, `runStepFromRow`

Follow existing patterns: `this.statement(sql)`, `parseJsonList` for `depends_on`, ISO timestamps, `randomUUID()`, zod parse in mappers at the bottom of the file. `deleteRun` must be a public transactional method that calls non-transactional helpers; it does **not** stop sessions (engine does that first).

- [x] **Step 1: Write failing store tests**

In `apps/host/src/store.test.ts`, after the existing store fixture:

```ts
it("persists a run and its steps, then lists them", () => {
  // create workspace + run + two steps, listRunSteps ordered by position
});

it("survives addColumn defaults on existing session rows", () => {
  const session = store.listSessions()[0];
  expect(session.runId).toBe("");
  expect(session.runRole).toBe("");
});
```

Create a workspace first using the existing store helpers in that file.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project services apps/host/src/store.test.ts`
Expected: FAIL `createRun` is not a function

- [x] **Step 3: Implement schema + methods in `store.ts`**

In the constructor, after existing `addColumnIfMissing` calls:

```ts
this.addColumnIfMissing("sessions", "run_id", "TEXT NOT NULL DEFAULT ''");
this.addColumnIfMissing("sessions", "run_role", "TEXT NOT NULL DEFAULT ''");
this.db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    state TEXT NOT NULL,
    lead_session_id TEXT NOT NULL DEFAULT '',
    placement_id TEXT NOT NULL DEFAULT '',
    policy TEXT NOT NULL,
    failure_reason TEXT NOT NULL DEFAULT '',
    settle_seq INTEGER NOT NULL DEFAULT 0,
    wake_seq INTEGER NOT NULL DEFAULT 0,
    empty_wake_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_key TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    depends_on TEXT NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT,
    placement_id TEXT,
    output TEXT NOT NULL DEFAULT '',
    event_seq_from INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    dispatched_at TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, step_key)
  );
  CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_steps_session ON run_steps(session_id);
  CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
`);
```

Extend `createSession` INSERT/SELECT to include `run_id`, `run_role`. Add optional args `runId = ""`, `runRole = ""`. Update `sessionFromRow` to parse them through `SessionSchema`.

Implement CRUD. `replaceRunSteps` deletes existing steps for the run and inserts the new list in one transaction helper.

Extend `exportHostBackup` / `replaceHostBackup` with `runs` and `runSteps` (the schema side landed in Task 1). Two rules, both load-bearing:

- Export ordering mirrors the existing style: `runs ORDER BY created_at`, `run_steps ORDER BY run_id, position`.
- On import, a run may not come back believing it still has workers in flight. `sessionFieldsForHostImport` already forces every non-terminal session to `offline`, so any imported run in `running` or `awaiting_lead` lands on `awaiting_lead` (UI Needs You), and any step in `starting` or `running` lands on `failed` with reason `imported`. Restoring a run as `running` against sessions that are all `offline` would strand it: nothing will ever settle, and with no live node there is nothing to tick it.

Add a store test for that: export a run with a `running` step, `replaceHostBackup`, and assert the run is `awaiting_lead` and the step `failed`.

- [x] **Step 4: Run tests**

Run: `npx vitest run --project services apps/host/src/store.test.ts`
Expected: PASS. Fix any session INSERT column count mismatches.

- [x] **Step 5: Commit**

```bash
git add apps/host/src/store.ts apps/host/src/store.test.ts
git commit -m "feat: persist runs and run steps in sqlite"
```

---

### Task 4: Extract `createAndStartSession`

**Files:**
- Modify: `apps/host/src/fleet-service.ts`
- Modify: `apps/host/src/routes/sessions.ts`
- Modify: `apps/host/src/routes.test.ts` (should keep passing unchanged)

**Interfaces:**
- Produces:

```ts
createAndStartSession(input: {
  placement: Placement;
  prompt: string;
  yolo: boolean;
  name?: string;
  runId?: string;
  runRole?: string;
}):
  | { ok: true; session: FleetSession }
  | { ok: false; status: number; error: string; session?: FleetSession }
```

Logic is the current `POST /api/sessions` body: 404 placement already checked by caller, 409 offline/capacity/yolo, create row, `publishSession`, `dispatch` `start_session`, 503 if not sent.

Also add:

```ts
private readonly sessionListeners: Array<(s: FleetSession, e: SessionEvent) => void> = [];
onSessionEvent(fn: (s: FleetSession, e: SessionEvent) => void): void {
  this.sessionListeners.push(fn);
}
```

Call listeners at the end of `handleEvent`, after store append and publish.

- [x] **Step 1: Write a failing test in `fleet-service.test.ts`**

Assert `createAndStartSession` returns 409 when the node is at capacity (reuse existing service test harness).

- [x] **Step 2: Run it to verify fail / missing method**

Run: `npx vitest run --project services apps/host/src/fleet-service.test.ts`

- [x] **Step 3: Move the logic and switch the route**

`routes/sessions.ts` `POST /api/sessions` becomes: parse body, get placement, call `service.createAndStartSession`, map `{ok:false}` to `reply.code(status).send`.

- [x] **Step 4: Run `npx vitest run --project services apps/host/src/routes.test.ts apps/host/src/fleet-service.test.ts`**

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/host/src/fleet-service.ts apps/host/src/fleet-service.test.ts apps/host/src/routes/sessions.ts
git commit -m "refactor: share session start between routes and orchestrator"
```

---

### Task 5: Engine + REST

**Files:**
- Create: `apps/host/src/orchestrator/engine.ts`
- Create: `apps/host/src/routes/runs.ts`
- Modify: `apps/host/src/server.ts`
- Modify: `apps/host/src/routes.test.ts`

**Interfaces:**
- Consumes: `planNextActions`, `createAndStartSession`, store run methods
- Produces: `OrchestratorEngine` with `tick(runId?: string)`, `submitPlan(runId, steps)`, `approve(runId)`, `cancel(runId)`

REST:

```text
GET    /api/runs
POST   /api/runs                 { workspaceId, name, objective, policy? }
GET    /api/runs/:id             { run, steps }
POST   /api/runs/:id/plan        { steps: [{ stepKey, title, prompt, dependsOn, category? }] }
POST   /api/runs/:id/approve
POST   /api/runs/:id/cancel
DELETE /api/runs/:id
```

Plan submit validates: unique `stepKey`, `dependsOn ⊆ keys`, topological sort (reject cycles with the keys on the cycle), max 20 steps. Sets `wakePolicy` to `"none"` for this fixture path if the client omitted it. Stores steps as `pending`. Approve moves `awaiting_approval → running` and ticks — the fixture skips `planning` because it has no Lead to do any planning; the P2 Lead path is the one that stops in `planning`.

`tick`: load snapshot, `planNextActions`, execute:
- `start_step`: write the receipt first — `updateRunStep` to `starting` with `placementId`, `dispatchedAt`, and `eventSeqFrom` set to the session's current event sequence — commit, and only then `createAndStartSession` with `runId` / `runRole: "worker"`. A send failure rolls the step back to `pending`; `command_result.ok` moves it `starting → running`. Pin `run.placementId` on the first writing step. Never dispatch inside the transaction: SQLite cannot hold a socket send.
- `settle_step` / `skip_step`: update step; `settleSeq++`
- `stop_session`: send `stop` (never `cancel`)
- `wake_lead`: no-op in P1 when `wakePolicy === "none"` (still unit-tested in schedule)
- `finish_run`: update run state

Deadlines: register `startRunDeadlineMonitor` next to `startPresenceMonitor` in `server.ts`, modelled on `apps/host/src/presence.ts` (`sweepInterval` + `timer.unref()`), and re-run overdue deadlines on boot. Without a clock nothing ever ticks during silence, so `stepTimeoutMs` and the `starting` deadline would be dead code and one Node power-loss would strand a step in `running` forever. This does not contradict the spec's "no polling": that rule constrains the Lead burning tokens on a busy-wait, not the Host owning a timer.

Cancel: `stop` every non-terminal worker session on the run, mark steps cancelled, run cancelled.

Cycle detection: Kahn's algorithm; if leftover nodes, they are the cycle.

- [x] **Step 1: Write route tests** (in `routes.test.ts`)

Happy path without a live Node agent: creating a run returns 201; submitting a cyclic plan returns 400 containing the step keys; submitting `audit → fix` with `dependsOn` returns 200; approve with no online node leaves steps `pending` (tick no-ops on capacity).

Add a second test that enrolls a node (existing `enroll` helper), creates workspace+placement via the catalog routes already used in this file, then: create run, POST plan of one step, approve, and assert the session row has `runId` and `runRole === "worker"`. `maxSessions` on enroll is currently 1 in the helper — that is enough for one step.

- [x] **Step 2: Run tests, expect fail (404 on /api/runs)**

Run: `npx vitest run --project services apps/host/src/routes.test.ts`

- [x] **Step 3: Implement engine + routes and register in `server.ts`**

```ts
await app.register(runRoutes, { service, engine });
```

Construct `engine` after `FleetService`, then `service.onSessionEvent(() => engine.tick())`. After `store.resetConnectivity()`, do **not** tick. First tick happens after `reconcileOfflineSessions` (hook the existing reconcile path in `fleet-service.ts` to call `engine.tick()` once inventory arrives).

Broadcast: `service` should `publish` `{ type: "run", run }` and `{ type: "run_steps", runId, steps }` after mutations. Add helpers on `FleetService` analogous to `publishSession`.

Include `runs: store.listRuns()` in the snapshot payload (`/api/snapshot`).

- [x] **Step 4: Run tests**

Run: `npx vitest run --project services apps/host/src/routes.test.ts apps/host/src/orchestrator/schedule.test.ts apps/host/src/store.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/host/src/orchestrator/engine.ts apps/host/src/routes/runs.ts apps/host/src/server.ts apps/host/src/routes.test.ts apps/host/src/fleet-service.ts
git commit -m "feat: wire orchestrator engine and run REST routes"
```

---

### Task 6: Runs UI

**Files:**
- Create: `apps/host/ui/src/components/RunsPanel.tsx`
- Create: `apps/host/ui/src/components/RunsPanel.test.tsx`
- Modify: `apps/host/ui/src/App.tsx`
- Modify: `apps/host/ui/src/components/Sidebar.tsx`
- Modify: `apps/host/ui/src/lib/session-groups.ts`
- Modify: `apps/host/ui/src/hooks/useFleet.ts`

**Interfaces:**
- Consumes: snapshot `runs`, live `run` / `run_steps` messages
- Produces: Sidebar view `"runs"`; panel lists runs and steps with status colors from `session-status.ts` palettes; clicking a step with `sessionId` selects that session (reuse `TerminalView`)

Spec: §10.1. Note that §10.2's Lead-session UI is P2 and out of scope here — with one exception below, which is not.

- [x] **Step 1: Write a failing UI test**

`RunsPanel.test.tsx`: render with one running run and two steps; assert the objective and both titles appear; assert a step button is present.

Also add a failing test to `Sidebar.test.tsx` (or `session-groups`' own test if one exists): a session with `runRole: "worker"` **must not** appear in the Agents tree, while a session with `runRole: ""` still does.

That filter belongs in this task even though Lead sessions arrive in P2, because P1 already creates worker sessions. Without it the operator's tree fills with rows they did not open and must not drive by hand — they already have a home, and it is the run, not the workspace.

- [x] **Step 2: Run**

Run: `npx vitest run --project ui apps/host/ui/src/components/RunsPanel.test.tsx apps/host/ui/src/components/Sidebar.test.tsx`
Expected: FAIL

- [x] **Step 3: Implement panel, extend `SidebarView` to `"session" | "settings" | "runs"`, handle browser messages in `useFleet` (patch `runs` array by id; replace steps in a `runStepsById` map keyed by runId).

Filter run-owned sessions out of the tree in `groupSessionsByWorkspace` (skip `session.runRole !== ""`), not in `Sidebar.tsx` — the grouping function is the one place **both** layouts read (`Sidebar` and `SessionGrid`), so one change covers the tree and the grid.

Keep the fetch simple: `GET /api/runs` returns `{ runs: Run[], stepsByRunId: Record<string, RunStep[]> }` so the panel has everything after a refresh.

- [x] **Step 4: Run UI tests plus `npm run typecheck`**

Expected: PASS.

`SessionGrid` calls the same `groupSessionsByWorkspace`, so it inherits the filter for free — but it decides its empty state from the raw `sessions.length`, so a fleet whose only sessions belong to runs would render neither tiles nor `EmptySessions`. Switch that guard to count grouped sessions.

- [x] **Step 5: Commit**

```bash
git add apps/host/ui apps/host/src/routes/runs.ts
git commit -m "feat: show fleet runs in the sidebar"
```

---

### Task 7: Docs + proof of concept

**Files:**
- Modify: `ARCHITECTURE.md` — remove "Agent-to-agent DAGs" from non-goals; add an Orchestration paragraph (Host owns the run graph; Node still owns processes; P1 is handwritten DAG; Lead/MCP is later)
- Modify: `PRODUCT.md` — add Run / RunStep to the domain model; note MCP/Lead as not in this slice
- Modify: `README.md` and `README.zh-CN.md` — short "Orchestrator (mock-agent)" section: create run, POST plan, approve, watch two mock nodes

- [x] **Step 1: Edit the three docs to match the spec's P0/P1, not P2**

- [x] **Step 2: Run `npm run verify`**

Expected: lint, format, typecheck, tests, build all pass.

- [x] **Step 3: Commit**

```bash
git add ARCHITECTURE.md PRODUCT.md README.md README.zh-CN.md
git commit -m "docs: describe host-side run orchestration"
```

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| Run / RunStep tables, session columns, backup/restore | 3 |
| `planNextActions`, offline, headroom, same-placement write lock 1, placement pinning, two-phase dispatch, wake_lead unit | 2 |
| `createAndStartSession` | 4 |
| REST `/api/runs`, handwritten plan, cycle reject, deadline sweeper | 5 |
| Browser `run` / `run_steps`, snapshot `runs` | 5–6 |
| Runs panel (§10.1), run-owned sessions kept out of the Agents tree | 6 |
| Docs | 7 |
| MCP, Lead, live `awaiting_lead`, fleet-wake envelope, SKILL.md | **out of scope — next plan** |
| Lead session UI (§10.2), Needs You (§10.3) | out of scope — P2 |
| Isolation / worktrees / fan-out | out of scope |

## Self-review notes

- Headroom vs `maxSessions === 1` is spelled out so a test node with `maxSessions: 1` (existing route helper) can still start one worker.
- `wake_lead` is implemented in the pure function and no-op'd in the P1 engine when `wakePolicy === "none"`.
- Snapshot `runs` was not in the spec; the plan adds it so a browser refresh does not depend on catching a live message.
