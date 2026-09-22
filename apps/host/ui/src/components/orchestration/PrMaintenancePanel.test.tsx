import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrMaintenanceRegistrationSchema,
  PrMaintenanceProposalSchema,
  PrMaintenanceObservationSchema,
  PrMaintenanceBatchSchema,
  PrMaintenanceIncidentSchema,
  RunPolicySchema,
  type FleetSession,
  type Run,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import {
  actOnTaskMaintenance,
  authorizeTaskMaintenanceProposal,
  enableTaskMaintenance,
  prepareTaskMaintenance,
  getTaskMaintenance,
} from "../../lib/pr-maintenance";
import { PrMaintenancePanel } from "./PrMaintenancePanel";
import { OrchestratorTaskDetail } from "./OrchestratorTaskDetail";
import { buildRunViewModels } from "../../lib/orchestration-view";

vi.mock("../../lib/pr-maintenance", () => ({
  getTaskMaintenance: vi.fn(),
  actOnTaskMaintenance: vi.fn(),
  enableTaskMaintenance: vi.fn(),
  authorizeTaskMaintenanceProposal: vi.fn(),
  prepareTaskMaintenance: vi.fn(),
}));
vi.mock("./ManagedWorktreePanel", () => ({ ManagedWorktreePanel: () => null }));

const at = "2026-09-17T10:00:00.000Z";
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
const registration = () =>
  PrMaintenanceRegistrationSchema.parse({
    schemaVersion: 1,
    id: "maintenance",
    version: 4,
    generation: 1,
    identity: {
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
    },
    leadSessionId: "lead",
    taskId: task.id,
    workerSessionId: "worker",
    placementId: "placement",
    checkoutKey: "checkout",
    bindingGeneration: 1,
    eligibilityEvidence:
      "Helper v1 verified; Node credential and non-forcing publication verified",
    lifecycle: "paused",
    pauseReason: "Design decision",
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
  });
const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <PrMaintenancePanel run={task} sessions={[]} onChange={vi.fn()} />
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
  const record = { ...registration(), lifecycle: "active" as const, pauseReason: "" };
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaskMaintenance).mockResolvedValue({
    records: [registration()],
    canAuthorize: true,
  });
});

describe("PR maintenance task controls", () => {
  it("explains normal session manual takeover without publication authorization or Release", async () => {
    const record = registration();
    record.authorization.scope.publicationAuthorized = false;
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: false,
    });
    show();
    expect(
      await screen.findByText(/Send a normal prompt to the retained worker/),
    ).toBeTruthy();
    expect(
      screen.getByText(/No Release or unattended publication grant is needed/),
    ).toBeTruthy();
    expect(
      screen.getByText(/pending design decisions still need explicit direction/),
    ).toBeTruthy();
  });

  it("shows persistent manual control and unknown delivery without enabling release", async () => {
    const record = registration();
    record.pauseReason = "manual_control";
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
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    show();
    expect(
      await screen.findByText(
        /Manual supervisor control — unattended maintenance is paused/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Manual delivery has no correlated receipt/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Release/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("authorizes a read-only proposal without claiming mutation rights even when response flags are true", async () => {
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
    expect(await screen.findByText("Read-only observation")).toBeTruthy();
    expect(screen.queryByText(/Bounded repairs on the retained worker/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Review PR maintenance proposal" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Read-only observation")).toBeTruthy();
    expect(
      within(dialog).getByText("Observation only; no mutation allowance."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Read-only findings only; no provider mutations."),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Push only to|Replies: yes|3 repairs/)).toBeNull();
    expect(
      within(dialog).queryByRole("checkbox", {
        name: /I authorize these bounded repairs/,
      }),
    ).toBeNull();
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "I authorize read-only PR observation only. No repairs, pushes, replies, thread resolution, reviewer requests, CI retries, merge or force-push.",
    });
    const authorize = within(dialog).getByRole("button", {
      name: "Authorize read-only observation",
    });
    expect((authorize as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(authorize);
    await waitFor(() =>
      expect(authorizeTaskMaintenanceProposal).toHaveBeenCalledWith(task.id, {
        id: pending.id,
        version: pending.version,
      }),
    );
  });

  it("keeps a retained read-only job visibly observation-only and hides mutation renewal", async () => {
    const record = observed();
    Object.assign(record.authorization.scope, { publicationAuthorized: false });
    record.observation.sources = [
      {
        id: "readonly-feedback",
        revision: "one",
        groupKey: "review",
        evidence: "Synthetic feedback",
      },
    ];
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    expect(
      within(region).getByText("Read-only observation").closest("details"),
    ).toBeNull();
    expect(
      within(region).getByText(
        /No repairs, pushes, replies, thread resolution, reviewer requests or CI retries are authorized/,
      ),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        "Observe the PR and report findings. Changes require a separately reviewed authorization.",
      ),
    ).toBeTruthy();
    expect(
      within(region).queryByRole("button", { name: "Renew maintenance budgets" }),
    ).toBeNull();
    expect(within(region).queryByText("Addressing feedback")).toBeNull();
    expect(screen.queryByText(/Bounded repairs on the retained worker/)).toBeNull();
    expect(
      within(region).getByText("Read-only observation; no mutation allowance."),
    ).toBeTruthy();
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
      pauseReason: "",
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
    const enabled = { ...registration(), lifecycle: "active" as const, pauseReason: "" };
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
      pauseReason: "",
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

  it("never retargets an open decision-A draft to newly arrived decision B", async () => {
    const first = registration();
    first.decision = {
      id: "decision-A",
      version: 1,
      proposal: "Proposal A: preserve the existing contract",
      headSha: "a".repeat(40),
      scope: "Existing contract",
      state: "pending",
    };
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [first],
      canAuthorize: true,
    });
    const review = vi.fn().mockResolvedValue(false);
    const detail = (updatedAt: string) => (
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorTaskDetail
          model={
            buildRunViewModels({
              runs: [{ ...task, updatedAt }],
              stepsByRun: {},
              sessions: [],
            })[0]!
          }
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
      </FluentProvider>
    );
    const rendered = render(detail(at));
    fireEvent.click(
      await screen.findByRole("button", { name: "Send back with instructions" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "What needs changing?" }),
      {
        target: { value: "Instructions for A only" },
      },
    );
    const second = {
      ...first,
      version: 9,
      decision: {
        ...first.decision,
        id: "decision-B",
        proposal: "Proposal B: replace the API",
      },
    };
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [second],
      canAuthorize: true,
    });
    rendered.rerender(detail("2026-09-18T08:00:00.000Z"));
    await screen.findByText(/decision-B v1/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Send back" }));
    expect(review).not.toHaveBeenCalled();
    expect(within(dialog).getByText(first.decision.proposal)).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/changed|review/i);
    expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Instructions for A only",
    );
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

  it.each([
    ["ready", "Ready · not merged"],
    ["triage", "Triaging feedback"],
    ["addressing", "Addressing feedback"],
    ["checks", "Waiting for checks"],
    ["review", "Waiting for review"],
    ["draft", "Draft PR"],
    ["conflict", "Merge conflict"],
    ["incomplete", "Check incomplete"],
    ["recovery", "Recovering access"],
    ["paused", "Paused"],
    ["hold", "Needs human direction"],
  ])("exposes exactly one current stage for %s", async (scenario, expected) => {
    const record = observed();
    if (scenario === "triage")
      record.observation.sources = [
        {
          id: "new-feedback",
          revision: "one",
          groupKey: "review",
          evidence: "Synthetic review",
        },
      ];
    if (scenario === "addressing") record.batches = [batch("accepted")];
    if (scenario === "checks") record.observation.checksComplete = false;
    if (scenario === "review") record.observation.reviewsComplete = false;
    if (scenario === "draft") record.lastAttempt.draft = true;
    if (scenario === "conflict") record.lastAttempt.mergeability = "conflicting";
    if (scenario === "incomplete")
      record.lastAttempt = { ...record.lastAttempt, complete: false, failure: "network" };
    if (scenario === "paused" || scenario === "hold")
      Object.assign(record, { lifecycle: "paused", pauseReason: "Review required" });
    if (scenario === "hold")
      record.decision = {
        id: "human",
        version: 1,
        state: "pending",
        proposal: "Change the API?",
        headSha: "a".repeat(40),
        scope: "API",
      };
    if (scenario === "recovery") {
      record.lastAttempt = {
        ...record.lastAttempt,
        complete: false,
        failure: "incomplete",
      };
      record.incidents = [
        PrMaintenanceIncidentSchema.parse({
          id: "synthetic-incident",
          sequence: 1,
          kind: "capability",
          error: "Provider helper unavailable",
          lastError: "Provider helper unavailable",
          observationKey: "synthetic-first",
          lastObservationKey: "synthetic-latest",
          createdAt: at,
          updatedAt: at,
          attempts: [],
        }),
      ];
    }
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    const current = region.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe(expected);
    expect(
      within(region).getByRole("list", { name: "Maintenance loop stages" }),
    ).toBeTruthy();
    expect(region.querySelector("details")?.open).toBe(false);
  });

  it("never reports historical readiness as current after a failed or partial observation", async () => {
    const record = observed();
    record.lastSuccessAt = record.observation.attemptedAt;
    record.lastAttempt = { ...record.observation, complete: false, failure: "network" };
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    expect(region.querySelector('[aria-current="step"]')?.textContent).toBe(
      "Check incomplete",
    );
    expect(
      within(region).getAllByText(
        /prior success is not current validation|historical success is not current validation/,
      ).length,
    ).toBeGreaterThan(0);
    expect(within(region).queryByText(/complete observation$/)).toBeNull();
  });

  it("separates current PR from collapsed terminal and released history without duplicate current stages", async () => {
    const active = observed();
    const merged = {
      ...registration(),
      id: "old-merged",
      lifecycle: "merged" as const,
      identity: { ...active.identity, prNumber: 6 },
    };
    const released = {
      ...registration(),
      id: "old-released",
      ownershipReleasedAt: at,
      identity: { ...active.identity, prNumber: 5 },
    };
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [merged, active, released],
      canAuthorize: true,
    });
    show();
    const region = await screen.findByRole("region", { name: "Current maintained PR" });
    expect(within(region).getByRole("link").textContent).toBe("owner/repo #7");
    const history = screen.getByText("Prior PR jobs (2)").closest("details")!;
    expect(history.open).toBe(false);
    expect(within(history).getAllByRole("region", { name: /Prior PR job/ })).toHaveLength(
      2,
    );
    fireEvent.click(within(history).getByText("Prior PR jobs (2)"));
    expect(within(history).getByRole("link", { name: "owner/repo #6" })).toBeTruthy();
    expect(within(history).getByRole("link", { name: "owner/repo #5" })).toBeTruthy();
    expect(within(history).getAllByText(/0 completed maintenance rounds$/)).toHaveLength(
      2,
    );
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(
      within(history).getAllByRole("button", { name: "Release maintenance" }),
    ).toHaveLength(1);
  });

  it("counts only unique settled executed batches, not reservations, cancellations before dispatch or provider iterations", async () => {
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
      batch("accepted"),
      { ...batch("succeeded"), id: "duplicate-result" },
    ];
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    show();
    expect(
      await screen.findByText("3 completed maintenance rounds · settled worker batches"),
    ).toBeTruthy();
  });

  it.each(["merged", "closed"] as const)(
    "keeps an unsettled %s owner visible with attention and exactly one current stage",
    async (lifecycle) => {
      const record = { ...registration(), lifecycle, pauseReason: "" };
      record.batches = [batch("accepted")];
      vi.mocked(getTaskMaintenance).mockResolvedValue({
        records: [record],
        canAuthorize: true,
      });
      show();
      const region = await screen.findByRole("region", { name: "Current maintained PR" });
      expect(region.closest("details")).toBeNull();
      expect(within(region).getByText("Needs attention:")).toBeTruthy();
      expect(
        within(region).getByText(/Ownership is retained until reconciliation completes/),
      ).toBeTruthy();
      expect(region.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
      expect(region.querySelector('[aria-current="step"]')?.textContent).toBe(
        lifecycle === "merged" ? "Merged" : "Closed",
      );
      expect(
        (
          within(region).getByRole("button", {
            name: "Release maintenance",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(screen.queryByText(/Prior PR jobs/)).toBeNull();
      expect(
        within(region).getByText(
          "0 completed maintenance rounds · settled worker batches",
        ),
      ).toBeTruthy();
    },
  );

  it.each(["effect-receipt", "incident-only"])(
    "blocks resume, release and renewal while %s effects remain unknown",
    async (source) => {
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
      if (source === "incident-only") {
        record.batches = [];
        record.incidents = [
          PrMaintenanceIncidentSchema.parse({
            id: "synthetic-effect-incident",
            sequence: 1,
            kind: "effects",
            error: "Provider reply outcome is ambiguous",
            lastError: "Provider reply outcome is ambiguous",
            observationKey: "synthetic-effect-first",
            lastObservationKey: "synthetic-effect-latest",
            createdAt: at,
            updatedAt: at,
          }),
        ];
      }
      vi.mocked(getTaskMaintenance).mockResolvedValue({
        records: [record],
        canAuthorize: true,
      });
      show();
      const region = await screen.findByRole("region", { name: "Current maintained PR" });
      expect(region.querySelector('[aria-current="step"]')?.textContent).toBe(
        "Reconciling unknown effects",
      );
      for (const name of [
        "Resume maintenance",
        "Release maintenance",
        "Renew maintenance budgets",
      ]) {
        expect(
          (within(region).getByRole("button", { name }) as HTMLButtonElement).disabled,
        ).toBe(true);
      }
    },
  );

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

  it("requires renewal confirmation and refuses a refreshed registration version", async () => {
    const onChange = vi.fn();
    const panel = (revision: number) => (
      <FluentProvider theme={fleetDarkTheme}>
        <PrMaintenancePanel
          run={task}
          sessions={[]}
          onChange={onChange}
          snapshotRevision={revision}
        />
      </FluentProvider>
    );
    const rendered = render(panel(1));
    fireEvent.click(
      await screen.findByRole("button", { name: "Renew maintenance budgets" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/does not broaden design or publication authority/),
    ).toBeTruthy();
    expect(actOnTaskMaintenance).not.toHaveBeenCalled();
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [{ ...registration(), version: 5 }],
      canAuthorize: true,
    });
    rendered.rerender(panel(2));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Authorize budget renewal",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(actOnTaskMaintenance).not.toHaveBeenCalled();
  });

  it("keeps the human hold off Approve and links bounded Send back to its version", async () => {
    const record = registration();
    record.decision = {
      id: "decision",
      version: 2,
      proposal: "Change the public API?",
      headSha: "a".repeat(40),
      scope: "API compatibility",
      state: "pending",
    };
    vi.mocked(getTaskMaintenance).mockResolvedValue({
      records: [record],
      canAuthorize: true,
    });
    const review = vi.fn().mockResolvedValue(true);
    const model = buildRunViewModels({ runs: [task], stepsByRun: {}, sessions: [] })[0]!;
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Send back with instructions" }),
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "What needs changing?" }), {
      target: { value: "Keep the contract; restore validation only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(
        false,
        "Keep the contract; restore validation only",
        {
          recordId: "maintenance",
          expectedVersion: 4,
          decisionId: "decision",
          decisionVersion: 2,
        },
      ),
    );
    expect(
      (screen.getByRole("button", { name: "Resume maintenance" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
