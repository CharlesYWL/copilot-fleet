import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import {
  RunPolicySchema,
  type FleetSession,
  type PrMaintenanceTaskStatus,
  type Run,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { buildRunViewModels } from "../../lib/orchestration-view";
import { TransferTasksDialog, transferTargetLabel } from "./TransferTasksDialog";

const ISO = "2026-01-01T12:00:00.000Z";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "r1",
  workspaceId: "w1",
  name: "Ship it",
  objective: "make the change",
  state: "running",
  leadSessionId: "full",
  placementId: "",
  policy: RunPolicySchema.parse({}),
  phases: ["Plan", "Review"],
  phaseIndex: 0,
  successCriteria: [],
  stopWhen: "",
  failureReason: "",
  pendingPrompt: "",
  settleSeq: 0,
  wakeSeq: 0,
  emptyWakeCount: 0,
  reviewSeq: 0,
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

const lead = (overrides: Partial<FleetSession> = {}): FleetSession => ({
  id: "full",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "node",
  state: "idle",
  name: "Orchestrator",
  initialPrompt: "coordinate the fleet",
  currentActivity: "",
  lastText: "",
  createdAt: ISO,
  updatedAt: ISO,
  agentSessionId: "",
  yolo: true,
  commands: [],
  configOptions: [],
  runId: "",
  runRole: "lead",
  readOnly: true,
  ...overrides,
});

const maintained: PrMaintenanceTaskStatus = {
  taskId: "kept",
  recordId: "record-1",
  stage: "waiting_review",
  prUrl: "https://github.com/example/repo/pull/7",
  manualControl: false,
};

const models = () =>
  buildRunViewModels({
    runs: [
      run({ id: "open", name: "Open task" }),
      run({ id: "closed", name: "Closed task", state: "completed" }),
      run({ id: "kept", name: "Maintained PR", state: "completed" }),
    ],
    stepsByRun: {},
    sessions: [],
    maintenance: [maintained],
  });

const older = lead({ id: "older", name: "Night shift", createdAt: ISO });
const newest = lead({
  id: "newest",
  name: "Fresh",
  createdAt: "2026-01-02T12:00:00.000Z",
  usage: { contextTokens: 20_000, contextWindow: 200_000 },
});

const show = (overrides: Partial<Parameters<typeof TransferTasksDialog>[0]> = {}) => {
  const props = {
    open: true,
    source: lead(),
    models: models(),
    targets: [older, newest],
    assignedCounts: { newest: 0, older: 2 },
    onClose: vi.fn(),
    onTransfer: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TransferTasksDialog {...props} />
    </FluentProvider>,
  );
  return props;
};

describe("transfer tasks dialog", () => {
  it("preselects the tasks that still need an orchestrator and the newest conversation", async () => {
    const props = show();
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Transfer tasks from Orchestrator")).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Select Open task",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Select Maintained PR",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Select Closed task",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(within(dialog).getByText("2 selected")).toBeTruthy();
    expect(
      within(dialog).getByRole("combobox", { name: "Receiving orchestrator" })
        .textContent,
    ).toContain("Fresh");

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "  Review is next.  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Transfer 2" }));

    await waitFor(() =>
      expect(props.onTransfer).toHaveBeenCalledWith({
        runIds: ["open", "kept"],
        toSessionId: "newest",
        note: "Review is next.",
      }),
    );
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("moves history too when it is chosen", async () => {
    const props = show();
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select all tasks" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Transfer 3" }));

    await waitFor(() =>
      expect(props.onTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ runIds: ["open", "closed", "kept"] }),
      ),
    );
  });

  it("stays open when nothing moved", async () => {
    const props = show({ onTransfer: vi.fn().mockResolvedValue(false) });

    fireEvent.click(screen.getByRole("button", { name: "Transfer 2" }));

    await waitFor(() => expect(props.onTransfer).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("transfers one task from its own page without a list", async () => {
    const props = show({ models: [models()[0]!], fixed: true });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Transfer “Open task”")).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Transfer task" }));

    await waitFor(() =>
      expect(props.onTransfer).toHaveBeenCalledWith({
        runIds: ["open"],
        toSessionId: "newest",
        note: "",
      }),
    );
  });

  it("offers a fresh conversation when nobody can take the work", () => {
    const onStartOrchestrator = vi.fn();
    show({ targets: [], onStartOrchestrator });

    expect(
      screen.getByText(/No other running orchestrator can take these tasks/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Transfer 2" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    expect(onStartOrchestrator).toHaveBeenCalled();
  });

  it("describes a target by how busy and how full it is", () => {
    expect(transferTargetLabel(newest, 0)).toMatch(
      /^Fresh · idle · 0 tasks · 10% context · started /,
    );
    expect(transferTargetLabel(older, 1)).toMatch(
      /^Night shift · idle · 1 task · started /,
    );
  });
});
