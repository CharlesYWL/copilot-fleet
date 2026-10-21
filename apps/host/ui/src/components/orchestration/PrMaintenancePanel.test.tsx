import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrMaintenanceApprovalSchema,
  PrMaintenanceBatchSchema,
  PrMaintenanceObservationSchema,
  PrMaintenanceProposalSchema,
  PrMaintenanceRegistrationSchema,
  RunPolicySchema,
  type FleetSession,
  type PrMaintenanceHoldKind,
  type PrMaintenanceRegistration,
  type Run,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import {
  actOnTaskMaintenance,
  authorizeTaskMaintenanceProposal,
  enableTaskMaintenance,
  getTaskMaintenance,
  prepareTaskMaintenance,
} from "../../lib/pr-maintenance";
import { buildRunViewModels } from "../../lib/orchestration-view";
import { taskOverview } from "../../lib/task-overview";
import { PrMaintenancePanel } from "./PrMaintenancePanel";
import { OrchestratorTaskDetail } from "./OrchestratorTaskDetail";
import { PrMaintenanceApprovalReview } from "./PrMaintenanceApprovalReview";

vi.mock("../../lib/pr-maintenance", () => ({
  getTaskMaintenance: vi.fn(),
  actOnTaskMaintenance: vi.fn(),
  enableTaskMaintenance: vi.fn(),
  authorizeTaskMaintenanceProposal: vi.fn(),
  prepareTaskMaintenance: vi.fn(),
}));
vi.mock("./ManagedWorktreePanel", () => ({ ManagedWorktreePanel: () => null }));

const at = "2026-09-17T10:00:00.000Z";
/** The task waits on a person for an unrelated review; PR maintenance must not care. */
const task: Run = {
  id: "task",
  workspaceId: "workspace",
  name: "Maintain invariant",
  objective: "Keep the existing API",
  state: "awaiting_human",
  leadSessionId: "lead",
  placementId: "placement",
  policy: RunPolicySchema.parse({}),
  phases: ["Repair"],
  phaseIndex: 0,
  successCriteria: [],
  stopWhen: "",
  failureReason: "",
  pendingPrompt: "",
  settleSeq: 0,
  wakeSeq: 0,
  emptyWakeCount: 0,
  reviewSeq: 1,
  createdAt: at,
  updatedAt: at,
};
const identity = {
  host: "github.com",
  repositoryId: "123",
  repository: "owner/repo",
  prNumber: 7,
  headRepositoryId: "123",
  headRepository: "owner/repo",
  headRef: "refs/heads/Fix",
  baseRepositoryId: "123",
  baseRepository: "owner/repo",
  baseRef: "refs/heads/main",
};
/** The fields a v1 and a v2 record share. */
const recordFields = {
  id: "maintenance",
  version: 4,
  generation: 1,
  identity,
  leadSessionId: "lead",
  taskId: task.id,
  workerSessionId: "worker",
  placementId: "placement",
  checkoutKey: "checkout",
  bindingGeneration: 1,
  eligibilityEvidence:
    "Helper v1 verified; Node credential and non-forcing publication verified",
  renewedAt: at,
  nextCheckAt: at,
  authorization: {
    id: "grant",
    operatorId: "person",
    issuedAt: at,
    headSha: "a".repeat(40),
    scope: {
      baseline: "Keep the API",
      verification: "Run regression tests",
      publicationAuthorized: true,
    },
    budgets: { repairBatches: 3, answerBatches: 3, mutationAttempts: 100 },
  },
  counters: {},
  createdAt: at,
  updatedAt: at,
};
/** An enabled, idle registration: nothing to do and nothing pending. */
const registration = (): PrMaintenanceRegistration =>
  PrMaintenanceRegistrationSchema.parse({
    ...recordFields,
    schemaVersion: 2,
    lifecycle: "active",
  });
const held = (kind: PrMaintenanceHoldKind = "paused"): PrMaintenanceRegistration => ({
  ...registration(),
  hold: {
    kind,
    reason: "Paused by the operator",
    actor: "operator",
    actorId: "person",
    at,
  },
});
const pendingDecision = (id = "decision", proposal = "Change the public API?") => ({
  id,
  version: 1,
  proposal,
  headSha: "a".repeat(40),
  scope: "API compatibility",
  state: "pending" as const,
});
const waiting = (id?: string, proposal?: string): PrMaintenanceRegistration => ({
  ...registration(),
  decision: pendingDecision(id, proposal),
});
const show = (run: Run = task) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <PrMaintenancePanel run={run} sessions={[]} onChange={vi.fn()} />
    </FluentProvider>,
  );

const worker: FleetSession = {
  id: "worker",
  workspaceId: "workspace",
  workspaceName: "Repository",
  placementId: "placement",
  nodeId: "node",
  nodeName: "Node",
  state: "idle",
  name: "Original coder",
  initialPrompt: "Implement the task",
  currentActivity: "",
  lastText: "",
  createdAt: at,
  updatedAt: at,
  agentSessionId: "native-worker",
  yolo: false,
  commands: [],
  configOptions: [],
  runId: task.id,
  runRole: "worker",
  readOnly: false,
};
const proposal = () => {
  const record = registration();
  return PrMaintenanceProposalSchema.parse({
    id: "proposal",
    version: 1,
    leadSessionId: "lead",
    createdAt: at,
    updatedAt: at,
    registration: {
      taskId: task.id,
      workerSessionId: worker.id,
      identity: record.identity,
      scope: record.authorization.scope,
      budgets: record.authorization.budgets,
      headSha: record.authorization.headSha,
      eligibilityEvidence: record.eligibilityEvidence,
    },
  });
};

const observed = () => {
  const record = registration();
  const observation = PrMaintenanceObservationSchema.parse({
    identity: record.identity,
    attemptedAt: new Date().toISOString(),
    complete: true,
    checksComplete: true,
    reviewsComplete: true,
    snapshotId: "synthetic-snapshot",
    headSha: "a".repeat(40),
    state: "open",
    fingerprint: "synthetic-fingerprint",
    mergeability: "mergeable",
    evidence: "Synthetic fixture, not live provider evidence",
  });
  return {
    ...record,
    observation,
    lastAttempt: observation,
    readyFingerprint: observation.fingerprint,
  };
};

const batch = (
  state: "succeeded" | "partial" | "failed" | "cancelled" | "accepted" = "succeeded",
) =>
  PrMaintenanceBatchSchema.parse({
    id: `batch-${state}`,
    kind: "repair",
    sources: [
      {
        id: "source",
        revision: "one",
        groupKey: "feedback",
        evidence: "Synthetic feedback",
      },
    ],
    headSha: "a".repeat(40),
    prompt: "Keep the API",
    scope: "Keep the API",
    reservedMutations: 2,
    generation: 1,
    authorizationId: "grant",
    state,
    stepId: `step-${state}`,
    attempt: 1,
    executionSettled: state !== "accepted",
    createdAt: at,
    updatedAt: at,
  });

const serve = (...records: PrMaintenanceRegistration[]) =>
  vi.mocked(getTaskMaintenance).mockResolvedValue({ records, canAuthorize: true });

const phases = () => screen.getByRole("list", { name: "PR maintenance phases" });
const currentPhase = () =>
  [...phases().querySelectorAll('[aria-current="step"]')].map((node) => node.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  serve(held());
});

describe("PR maintenance task controls", () => {
  it("shows exactly one current phase for each state of the simplified loop", async () => {
    const reviewing: PrMaintenanceRegistration = {
      ...registration(),
      review: { id: "review", source: "manual", requestedAt: at },
    };
    const working: PrMaintenanceRegistration = {
      ...registration(),
      batches: [batch("accepted")],
    };
    const cases: [PrMaintenanceRegistration, string][] = [
      [registration(), "Idle"],
      [reviewing, "Reviewing"],
      [working, "Working"],
      [waiting(), "Waiting for Design Decision"],
      [{ ...working, lifecycle: "merged" }, "Merged"],
      [{ ...working, lifecycle: "closed" }, "Closed"],
    ];
    for (const [record, label] of cases) {
      serve(record);
      const rendered = show();
      await screen.findByRole("list", { name: "PR maintenance phases" });
      expect(currentPhase(), label).toEqual([label]);
      rendered.unmount();
    }
  });

  it("reports a hold beside the phase and offers one Resume that starts a review", async () => {
    serve(held("stopped"));
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(registration());
    show();
    expect(await screen.findByText("Idle · Stopped")).toBeTruthy();
    expect(currentPhase()).toEqual(["Idle"]);
    expect(screen.getByText("On hold:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review now" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Routine work" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume maintenance" }));
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.objectContaining({ id: "maintenance", version: 4 }),
        { action: "resume" },
      ),
    );
    expect(await screen.findByText(/A fresh review starts now/)).toBeTruthy();
  });

  it("requests a manual review without cached evidence while the task awaits an unrelated review", async () => {
    const record = registration();
    expect(record.observation).toBeUndefined();
    serve(record);
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(record);
    show();
    const review = await screen.findByRole("button", { name: "Review now" });
    expect((review as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/or use Review now/)).toBeTruthy();
    fireEvent.click(review);
    fireEvent.click(review);
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.objectContaining({ id: record.id, version: record.version }),
        { action: "review", requestId: expect.any(String) },
      ),
    );
    expect(await screen.findByText(/Review requested/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pauses an active job explicitly and never offers budget renewal", async () => {
    serve(registration());
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(held());
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Pause maintenance" }));
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ id: "maintenance" }),
        { action: "pause", reason: "Paused by the operator" },
      ),
    );
    expect(screen.queryByRole("button", { name: /Renew/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
  });

  it("records design direction once and resumes without a second approval", async () => {
    serve(waiting());
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(registration());
    show();
    const decision = await screen.findByRole("region", { name: "Design decision" });
    expect(within(decision).getByText("Change the public API?")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(decision).queryByRole("checkbox")).toBeNull();
    const record = within(decision).getByRole("button", {
      name: "Record direction and continue",
    });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(decision).getByRole("textbox", { name: "Your direction" }), {
      target: { value: " Keep the contract; restore validation only " },
    });
    fireEvent.click(record);
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.objectContaining({ id: "maintenance", version: 4 }),
        {
          action: "direction",
          decisionId: "decision",
          decisionVersion: 1,
          direction: "Keep the contract; restore validation only",
        },
      ),
    );
    expect(
      await screen.findByText(/Maintenance resumes with a fresh review/),
    ).toBeTruthy();
    expect(actOnTaskMaintenance).toHaveBeenCalledTimes(1);
  });

  it("never sends a draft written for decision A to a newly raised decision B", async () => {
    serve(waiting("decision-A", "Proposal A: preserve the existing contract"));
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(registration());
    const panel = (snapshotRevision: number) => (
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel
          run={task}
          sessions={[]}
          onChange={vi.fn()}
          snapshotRevision={snapshotRevision}
        />
      </FluentProvider>
    );
    const rendered = render(panel(1));
    fireEvent.change(await screen.findByRole("textbox", { name: "Your direction" }), {
      target: { value: "Instructions for A only" },
    });
    serve({
      ...waiting("decision-B", "Proposal B: replace the API"),
      version: 9,
    });
    rendered.rerender(panel(2));
    expect(await screen.findByText("Proposal B: replace the API")).toBeTruthy();
    const decision = screen.getByRole("region", { name: "Design decision" });
    expect(within(decision).getByRole("alert").textContent).toMatch(/decision changed/);
    const send = within(decision).getByRole("button", {
      name: "Record direction and continue",
    });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(actOnTaskMaintenance).not.toHaveBeenCalled();
    expect((within(decision).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Instructions for A only",
    );
    fireEvent.click(within(decision).getByRole("button", { name: "Discard draft" }));
    fireEvent.change(within(decision).getByRole("textbox"), {
      target: { value: "Replace it behind a flag" },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.objectContaining({ version: 9 }),
        expect.objectContaining({
          action: "direction",
          decisionId: "decision-B",
          direction: "Replace it behind a flag",
        }),
      ),
    );
  });

  it("keeps the task review separate from PR maintenance decisions", async () => {
    serve(waiting());
    const review = vi.fn().mockResolvedValue(true);
    const model = buildRunViewModels({
      runs: [task],
      stepsByRun: {},
      sessions: [],
    })[0]!;
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorTaskDetail
          model={model}
          notes={[]}
          sessions={[]}
          onBack={vi.fn()}
          onOpenLead={vi.fn()}
          onOpenWorker={vi.fn()}
          onReview={review}
          onArchive={vi.fn()}
          onReopen={vi.fn()}
          onDelete={vi.fn()}
        />
      </FluentProvider>,
    );
    const stage = screen.getByRole("region", { name: "Current task stage" });
    expect(
      await within(stage).findByRole("heading", {
        name: "PR: Waiting for Design Decision",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review result" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByText("Change the public API?")).toBeNull();
    expect(within(dialog).getByText(/does not change PR maintenance/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(review).toHaveBeenCalledExactlyOnceWith(true, ""));
  });

  it("derives the task overview from one maintenance status", () => {
    const model = (state: Run["state"]) =>
      buildRunViewModels({
        runs: [{ ...task, state }],
        stepsByRun: {},
        sessions: [],
      })[0]!;
    const view = (record: PrMaintenanceRegistration) => ({
      records: [record],
      canAuthorize: true,
    });
    // An idle PR never hides the task's own review.
    expect(taskOverview(model("awaiting_human"), [], view(registration()))).toMatchObject(
      {
        title: "Ready for your review",
        attention: true,
      },
    );
    expect(taskOverview(model("awaiting_human"), [], view(waiting()))).toMatchObject({
      title: "PR: Waiting for Design Decision",
      attention: true,
    });
    expect(taskOverview(model("completed"), [], view(held()))).toMatchObject({
      title: "PR: Idle · Paused",
      attention: true,
    });
    expect(
      taskOverview(
        model("completed"),
        [],
        view({ ...registration(), batches: [batch("accepted")] }),
      ),
    ).toMatchObject({ title: "PR: Working", attention: false });
    expect(
      taskOverview(model("completed"), [], {
        records: [registration()],
        canAuthorize: true,
        statusError: "Status unavailable",
      }),
    ).toMatchObject({ title: "PR maintenance status unavailable", attention: true });
  });

  it("keeps manual control and unknown delivery from enabling release", async () => {
    const record = held("manual_control");
    record.manualControl = {
      operatorId: "supervisor",
      takenAt: at,
      commands: [
        {
          id: "manual",
          digest: "input",
          kind: "prompt",
          operatorId: "supervisor",
          eventSeqFrom: 0,
          state: "unknown",
          createdAt: at,
        },
      ],
    };
    serve(record);
    show();
    expect(
      await screen.findByText(/a person is driving the retained worker/),
    ).toBeTruthy();
    expect(screen.getByText("Idle · Manual control")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Release maintenance" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Resume maintenance" })).toBeTruthy();
  });

  it("reports unknown effects as reconciling and holds release until they settle", async () => {
    const record = registration();
    record.batches = [
      {
        ...batch("partial"),
        effects: [
          {
            key: "pending-push",
            kind: "push",
            state: "uncertain",
            headSha: "a".repeat(40),
            actor: "worker",
            actionIdentity: "attempt",
            attempts: 1,
          },
        ],
      },
    ];
    serve(record);
    show();
    expect(await screen.findByText("Idle · Reconciling")).toBeTruthy();
    expect(screen.getByText(/Work or effects are still settling/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Release maintenance" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("counts only unique settled executed batches, not reservations or undispatched cancellations", async () => {
    const record = observed();
    record.counters = { ...record.counters, repairBatches: 29, answerBatches: 25 };
    record.batches = [
      batch("succeeded"),
      batch("partial"),
      batch("failed"),
      { ...batch("cancelled"), executionNotDispatched: true },
      {
        ...batch("cancelled"),
        id: "never-dispatched",
        stepId: undefined,
        attempt: undefined,
      },
      { ...batch("succeeded"), id: "duplicate-result" },
    ];
    serve(record);
    show();
    expect(await screen.findByText("3 settled worker batches")).toBeTruthy();
    expect(screen.getByText(/no limit; repeated no-progress work/)).toBeTruthy();
  });

  it("separates the current PR from collapsed terminal and released history", async () => {
    const active = observed();
    const merged: PrMaintenanceRegistration = {
      ...registration(),
      id: "old-merged",
      lifecycle: "merged",
      identity: { ...identity, prNumber: 6 },
    };
    const released: PrMaintenanceRegistration = {
      ...registration(),
      id: "old-released",
      ownershipReleasedAt: at,
      identity: { ...identity, prNumber: 5 },
    };
    serve(merged, active, released);
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    expect(within(region).getByRole("link").textContent).toBe("owner/repo #7");
    const history = screen.getByText("Prior PR jobs (2)").closest("details")!;
    expect(history.open).toBe(false);
    expect(within(history).getByText("Merged")).toBeTruthy();
    expect(within(history).getByText("Released")).toBeTruthy();
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(
      within(history).getAllByRole("button", { name: "Release maintenance" }),
    ).toHaveLength(1);
  });

  it("offers repair authorization for a retained legacy observation-only job", async () => {
    const record = registration();
    record.authorization.scope.publicationAuthorized = false;
    serve(record);
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    expect(within(region).getByText("Repair authorization required")).toBeTruthy();
    expect(
      (within(region).getByRole("button", { name: "Review now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Prepare repair authorization" }));
    await waitFor(() =>
      expect(prepareTaskMaintenance).toHaveBeenCalledWith(
        task.id,
        "https://github.com/owner/repo/pull/7",
      ),
    );
  });

  it("upgrades a v1 paused registration into one hold that a single Resume clears", async () => {
    const legacy = PrMaintenanceRegistrationSchema.parse({
      ...recordFields,
      schemaVersion: 1,
      lifecycle: "paused",
      pauseReason: "Session stop or cancellation requested",
    });
    expect(legacy).toMatchObject({ schemaVersion: 2, lifecycle: "active" });
    expect(legacy.hold?.kind).toBe("paused");
    serve(legacy);
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(registration());
    show();
    expect(await screen.findByText("Idle · Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume maintenance" }));
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.anything(),
        { action: "resume" },
      ),
    );
  });

  it("queues routine generated-artifact work on the current worker without a renewal dialog", async () => {
    const record = observed();
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(record);
    show();
    const input = await screen.findByRole("textbox", { name: "Routine work" });
    const button = screen.getByRole("button", { name: "Queue routine work" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, {
      target: {
        value: "Regenerate the API report from the accepted implementation.",
      },
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledExactlyOnceWith(
        task.id,
        expect.objectContaining({ id: record.id, version: record.version }),
        {
          action: "work",
          requestId: expect.any(String),
          direction: "Regenerate the API report from the accepted implementation.",
        },
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retries a lost routine-work response with the original request key, without hiding the error", async () => {
    const record = observed();
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    vi.mocked(actOnTaskMaintenance)
      .mockRejectedValueOnce(new Error("Response lost; review delivery before retry."))
      .mockResolvedValueOnce(record);
    show();
    fireEvent.change(await screen.findByRole("textbox", { name: "Routine work" }), {
      target: { value: "Regenerate the accepted API report." },
    });
    const button = screen.getByRole("button", { name: "Queue routine work" });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Response lost; review delivery before retry.",
    );
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    const first = vi.mocked(actOnTaskMaintenance).mock.calls[0]![2];
    fireEvent.click(button);
    await waitFor(() => expect(actOnTaskMaintenance).toHaveBeenCalledTimes(2));
    expect(vi.mocked(actOnTaskMaintenance).mock.calls[1]![2]).toEqual(first);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each([false, true])(
    "allows only repair-authorized proposals from Commands (repairs=%s)",
    async (repairs) => {
      const pending = proposal();
      pending.registration.scope.publicationAuthorized = repairs;
      const approval = PrMaintenanceApprovalSchema.parse({
        proposalId: pending.id,
        version: pending.version,
        taskId: task.id,
        leadSessionId: pending.leadSessionId,
        identity: pending.registration.identity,
        mode: "repair",
        createdAt: at,
      });
      vi.mocked(getTaskMaintenance).mockResolvedValue({
        records: [],
        proposal: pending,
        canAuthorize: true,
      });
      vi.mocked(authorizeTaskMaintenanceProposal).mockResolvedValue(registration());
      const authorized = vi.fn();
      render(
        <FluentProvider theme={fleetDarkTheme}>
          <PrMaintenanceApprovalReview
            approval={approval}
            currentApproval={approval}
            sessions={[worker]}
            connected
            snapshotRevision={0}
            onClose={vi.fn()}
            onAuthorized={authorized}
          />
        </FluentProvider>,
      );
      const button = await screen.findByRole("button", { name: "Authorize maintenance" });
      expect(button).toHaveProperty("disabled", true);
      expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
      if (!repairs) {
        expect(screen.getByText("Unsupported legacy proposal")).toBeTruthy();
        expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
        fireEvent.click(button);
        expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
        return;
      }
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(button);
      await waitFor(() =>
        expect(authorizeTaskMaintenanceProposal).toHaveBeenCalledExactlyOnceWith(
          task.id,
          {
            id: pending.id,
            version: pending.version,
          },
        ),
      );
      expect(authorized).toHaveBeenCalledOnce();
    },
  );

  it("never retargets an inbox approval when a newer proposal version arrives", async () => {
    const pending = proposal();
    const approval = PrMaintenanceApprovalSchema.parse({
      proposalId: pending.id,
      version: pending.version,
      taskId: task.id,
      leadSessionId: pending.leadSessionId,
      identity: pending.registration.identity,
      mode: "repair",
      createdAt: at,
    });
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      proposal: pending,
      canAuthorize: true,
    });
    const props = {
      approval,
      currentApproval: approval,
      sessions: [worker],
      connected: true,
      snapshotRevision: 0,
      onClose: vi.fn(),
      onAuthorized: vi.fn(),
    };
    const view = render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenanceApprovalReview {...props} />
      </FluentProvider>,
    );
    await screen.findByRole("button", { name: "Authorize maintenance" });
    fireEvent.click(screen.getByRole("checkbox"));
    view.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenanceApprovalReview
          {...props}
          currentApproval={{ ...approval, version: 2 }}
          snapshotRevision={1}
        />
      </FluentProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("changed or was already handled"),
    );
    expect(screen.queryByRole("button", { name: "Authorize maintenance" })).toBeNull();
    expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
  });

  it.each([
    { connected: false, canAuthorize: true },
    { connected: true, canAuthorize: false },
  ])("keeps inbox approval gated for %j", async ({ connected, canAuthorize }) => {
    const pending = proposal();
    const approval = PrMaintenanceApprovalSchema.parse({
      proposalId: pending.id,
      version: pending.version,
      taskId: task.id,
      leadSessionId: pending.leadSessionId,
      identity: pending.registration.identity,
      mode: "repair",
      createdAt: at,
    });
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      proposal: pending,
      canAuthorize,
    });
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenanceApprovalReview
          approval={approval}
          currentApproval={approval}
          sessions={[worker]}
          connected={connected}
          snapshotRevision={0}
          onClose={vi.fn()}
          onAuthorized={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Authorize maintenance" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
    expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
  });

  it("does not use a previously loaded approval after a failed status refresh", async () => {
    const pending = proposal();
    const approval = PrMaintenanceApprovalSchema.parse({
      proposalId: pending.id,
      version: pending.version,
      taskId: task.id,
      leadSessionId: pending.leadSessionId,
      identity: pending.registration.identity,
      mode: "repair",
      createdAt: at,
    });
    vi.mocked(getTaskMaintenance)
      .mockResolvedValueOnce({ records: [], proposal: pending, canAuthorize: true })
      .mockRejectedValue(new Error("Maintenance status unavailable"));
    const props = {
      approval,
      currentApproval: approval,
      sessions: [worker],
      connected: true,
      snapshotRevision: 0,
      onClose: vi.fn(),
      onAuthorized: vi.fn(),
    };
    const view = render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenanceApprovalReview {...props} />
      </FluentProvider>,
    );
    await screen.findByRole("button", { name: "Authorize maintenance" });
    fireEvent.click(screen.getByRole("checkbox"));
    view.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenanceApprovalReview {...props} snapshotRevision={1} />
      </FluentProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Maintenance status unavailable",
    );
    expect(screen.queryByRole("button", { name: "Authorize maintenance" })).toBeNull();
    expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
  });

  it("does not authorize a legacy observation proposal and offers repair preparation instead", async () => {
    const pending = proposal();
    Object.assign(pending.registration.scope, {
      publicationAuthorized: false,
      replies: true,
      resolveThreads: true,
      retryChecks: true,
      reviewers: ["synthetic-reviewer"],
    });
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      proposal: pending,
      canAuthorize: true,
    });
    vi.mocked(authorizeTaskMaintenanceProposal).mockResolvedValue(registration());
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel run={task} sessions={[worker]} onChange={vi.fn()} />
      </FluentProvider>,
    );
    const prepare = await screen.findByRole("button", {
      name: "Prepare repair authorization",
    });
    expect(
      screen.queryByRole("button", { name: "Review PR maintenance proposal" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Authorize read-only observation" }),
    ).toBeNull();
    fireEvent.click(prepare);
    await waitFor(() =>
      expect(prepareTaskMaintenance).toHaveBeenCalledWith(task.id, undefined),
    );
    expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://github.com/example/synthetic/pull/42"])(
    "asks the Orchestrator to prepare with optional PR URL %s, never JSON or authorization",
    async (url) => {
      vi.mocked(getTaskMaintenance).mockResolvedValue({
        records: [],
        canAuthorize: true,
      });
      vi.mocked(prepareTaskMaintenance).mockResolvedValue({
        status: "preparation_requested",
        taskId: task.id,
      });
      show();
      const button = await screen.findByRole("button", {
        name: "Ask Orchestrator to prepare",
      });
      expect(screen.queryByRole("textbox", { name: "Registration proposal" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Authorize maintenance" })).toBeNull();
      if (url)
        fireEvent.change(screen.getByRole("textbox", { name: "PR URL (optional)" }), {
          target: { value: ` ${url} ` },
        });
      fireEvent.click(button);
      await waitFor(() =>
        expect(prepareTaskMaintenance).toHaveBeenCalledWith(task.id, url),
      );
      expect(await screen.findByText(/Preparation requested/)).toBeTruthy();
      expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
      expect(enableTaskMaintenance).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-PR URL and requires an authenticated operator to prepare", async () => {
    vi.mocked(getTaskMaintenance).mockResolvedValue({ records: [], canAuthorize: true });
    show();
    const input = await screen.findByRole("textbox", { name: "PR URL (optional)" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    expect(
      (
        screen.getByRole("button", {
          name: "Ask Orchestrator to prepare",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Enter an exact HTTPS pull request URL.")).toBeTruthy();
    expect(prepareTaskMaintenance).not.toHaveBeenCalled();
  });

  it("keeps preparation disabled for non-operator credentials", async () => {
    vi.mocked(getTaskMaintenance).mockResolvedValue({ records: [], canAuthorize: false });
    show();
    const button = await screen.findByRole("button", {
      name: "Ask Orchestrator to prepare",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Node and MCP credentials cannot approve/)).toBeTruthy();
  });

  it("shows canonical ADO links and authorizes its prefilled proposal without JSON", async () => {
    const pending = proposal();
    pending.registration.identity = {
      ...pending.registration.identity,
      provider: "azure-devops",
      host: "dev.azure.com",
      organization: "sample-org",
      project: "Sample Project",
      projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      repository: "Sample Project/Repo Name",
      headRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      headRepository: "Sample Project/Repo Name",
      baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      baseRepository: "Sample Project/Repo Name",
    };
    const enabled = {
      ...registration(),
      identity: pending.registration.identity,
      lifecycle: "active" as const,
    };
    vi.mocked(getTaskMaintenance)
      .mockResolvedValueOnce({ records: [], proposal: pending, canAuthorize: true })
      .mockResolvedValue({ records: [enabled], canAuthorize: true });
    vi.mocked(authorizeTaskMaintenanceProposal).mockResolvedValue(enabled);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel run={task} sessions={[worker]} onChange={vi.fn()} />
      </FluentProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review PR maintenance proposal" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("textbox", { name: "Registration proposal" }),
    ).toBeNull();
    expect(within(dialog).getByText(/Azure DevOps/)).toBeTruthy();
    const url =
      "https://dev.azure.com/sample-org/Sample%20Project/_git/Repo%20Name/pullrequest/7";
    expect(within(dialog).getByRole("link").getAttribute("href")).toBe(url);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Authorize maintenance" }),
    );
    await waitFor(() =>
      expect(authorizeTaskMaintenanceProposal).toHaveBeenCalledWith(task.id, {
        id: pending.id,
        version: pending.version,
      }),
    );
    expect(
      (
        await screen.findByRole("link", { name: "Sample Project/Repo Name #7" })
      ).getAttribute("href"),
    ).toBe(url);
    expect(enableTaskMaintenance).not.toHaveBeenCalled();
  });

  it("reviews a prefilled proposal without copying JSON and authorizes only its captured reference", async () => {
    const pending = proposal();
    const enabled = { ...registration(), lifecycle: "active" as const };
    vi.mocked(getTaskMaintenance)
      .mockResolvedValueOnce({ records: [], proposal: pending, canAuthorize: true })
      .mockResolvedValue({ records: [enabled], canAuthorize: true });
    vi.mocked(authorizeTaskMaintenanceProposal).mockResolvedValue(enabled);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel
          run={{ ...task, state: "completed" }}
          sessions={[worker]}
          onChange={vi.fn()}
        />
      </FluentProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review PR maintenance proposal" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("textbox", { name: "Registration proposal" }),
    ).toBeNull();
    expect(within(dialog).getByText(/Original coder/)).toBeTruthy();
    const authorize = within(dialog).getByRole("button", {
      name: "Authorize maintenance",
    });
    expect(
      within(dialog).getByRole("checkbox", {
        name: "I authorize these bounded repairs and responses only. No merge, force-push or unapproved design changes.",
      }),
    ).toBeTruthy();
    expect((authorize as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(authorize);
    await waitFor(() =>
      expect(authorizeTaskMaintenanceProposal).toHaveBeenCalledWith(task.id, {
        id: "proposal",
        version: 1,
      }),
    );
    expect(enableTaskMaintenance).not.toHaveBeenCalled();
  });

  it("does not retarget an open authorization dialog when the Orchestrator revises the proposal", async () => {
    const pending = proposal();
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      proposal: pending,
      canAuthorize: true,
    });
    const onChange = vi.fn();
    const panel = (snapshotRevision: number) => (
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel
          run={{ ...task, state: "completed" }}
          sessions={[worker]}
          onChange={onChange}
          snapshotRevision={snapshotRevision}
        />
      </FluentProvider>
    );
    const rendered = render(panel(1));
    fireEvent.click(
      await screen.findByRole("button", { name: "Review PR maintenance proposal" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      canAuthorize: true,
      proposal: {
        ...pending,
        version: 2,
        registration: {
          ...pending.registration,
          scope: {
            ...pending.registration.scope,
            verification: "New verification command",
          },
        },
      },
    });
    rendered.rerender(panel(2));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    const authorize = within(dialog).getByRole("button", {
      name: "Authorize maintenance",
    });
    expect((authorize as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Run regression tests/)).toBeTruthy();
    fireEvent.click(authorize);
    expect(authorizeTaskMaintenanceProposal).not.toHaveBeenCalled();
  });

  it("refreshes maintenance-only snapshot revisions without a task timestamp change", async () => {
    const onChange = vi.fn();
    const panel = (snapshotRevision: number) => (
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel
          run={task}
          sessions={[]}
          onChange={onChange}
          snapshotRevision={snapshotRevision}
        />
      </FluentProvider>
    );
    const rendered = render(panel(1));
    await screen.findByText(/refs\/heads\/Fix/);
    const updated = {
      ...registration(),
      version: 9,
      lifecycle: "active" as const,
      lastSuccessAt: "2026-09-18T08:00:00.000Z",
    };
    let finishRefresh!: () => void;
    vi.mocked(getTaskMaintenance).mockReturnValue(
      new Promise<Awaited<ReturnType<typeof getTaskMaintenance>>>((resolve) => {
        finishRefresh = () => resolve({ records: [updated], canAuthorize: true });
      }),
    );
    rendered.rerender(panel(2));
    await waitFor(() => expect(getTaskMaintenance).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/refs\/heads\/Fix/)).toBeTruthy();
    await act(async () => finishRefresh());
    expect(await screen.findByText(updated.lastSuccessAt)).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({ records: [updated], canAuthorize: true });
  });

  it("shows exact ref, unknown observation and versioned resume without an actor field", async () => {
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(registration());
    show();
    expect(await screen.findByText(/refs\/heads\/Fix/)).toBeTruthy();
    expect(screen.getByText("Unknown — no successful observation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume maintenance" }));
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ id: "maintenance", version: 4 }),
        { action: "resume" },
      ),
    );
  });

  it("leaves stale authorization errors visible and does not replay them", async () => {
    vi.mocked(actOnTaskMaintenance).mockRejectedValue(
      new Error("Stale maintenance version; refresh and review again"),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Resume maintenance" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Stale maintenance version",
    );
    expect(actOnTaskMaintenance).toHaveBeenCalledTimes(1);
  });

  it("does not enable unknown prerequisites or unsupported managed bindings", async () => {
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [],
      canAuthorize: true,
      unsupportedReason: "Sealed managed results require a supported handoff",
    });
    show();
    expect(await screen.findByText(/Sealed managed results/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Ask Orchestrator to prepare",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("requires a release reason and preserves the captured registration version", async () => {
    const record = registration();
    vi.mocked(actOnTaskMaintenance).mockResolvedValue(record);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Release maintenance" }));
    const dialog = screen.getByRole("dialog");
    const release = within(dialog).getByRole("button", {
      name: "Release maintenance",
    }) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "No further maintenance needed" },
    });
    fireEvent.click(release);
    await waitFor(() =>
      expect(actOnTaskMaintenance).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ id: record.id, version: record.version }),
        { action: "release", reason: "No further maintenance needed" },
      ),
    );
  });
});
