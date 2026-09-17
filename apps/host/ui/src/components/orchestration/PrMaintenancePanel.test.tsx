import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrMaintenanceRegistrationSchema,
  RunPolicySchema,
  type Run,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { actOnTaskMaintenance, getTaskMaintenance } from "../../lib/pr-maintenance";
import { PrMaintenancePanel } from "./PrMaintenancePanel";
import { OrchestratorTaskDetail } from "./OrchestratorTaskDetail";
import { buildRunViewModels } from "../../lib/orchestration-view";

vi.mock("../../lib/pr-maintenance", () => ({
  getTaskMaintenance: vi.fn(),
  actOnTaskMaintenance: vi.fn(),
  enableTaskMaintenance: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaskMaintenance).mockResolvedValue({
    records: [registration()],
    canAuthorize: true,
  });
});

describe("PR maintenance task controls", () => {
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
      (screen.getByRole("button", { name: "Enable PR maintenance" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
