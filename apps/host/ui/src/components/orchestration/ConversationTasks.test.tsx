import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import {
  RunPolicySchema,
  type FleetSession,
  type Run,
  type RunStep,
  type SessionEvent,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { buildRunViewModels } from "../../lib/orchestration-view";
import { ConversationTasks } from "./ConversationTasks";

const ISO = "2026-01-01T12:00:00.000Z";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "r1",
  workspaceId: "w1",
  name: "Ship it",
  objective: "make the change",
  state: "running",
  leadSessionId: "lead",
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
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

const step = (overrides: Partial<RunStep> = {}): RunStep => ({
  id: "s1",
  runId: "r1",
  stepKey: "s1",
  title: "s1",
  prompt: "do it",
  category: "implement",
  dependsOn: [],
  state: "running",
  sessionId: "worker-1",
  placementId: "",
  output: "",
  eventSeqFrom: 0,
  attempts: 1,
  phaseIndex: 0,
  dispatchedAt: "",
  position: 0,
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

const models = (
  runs: Run[],
  stepsByRun: Record<string, RunStep[]> = {},
  waitingPermissions: SessionEvent[] = [],
) =>
  buildRunViewModels({
    runs,
    stepsByRun,
    sessions: Object.values(stepsByRun)
      .flat()
      .filter((entry) => entry.sessionId)
      .map((entry) => ({ id: entry.sessionId }) as FleetSession),
    waitingPermissions,
  });

const show = (overrides: Partial<Parameters<typeof ConversationTasks>[0]> = {}) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <ConversationTasks
        models={models([run({ id: "a", name: "Alpha task" })])}
        open
        onToggle={vi.fn()}
        onOpenRun={vi.fn()}
        onOpenWorker={vi.fn()}
        onNewRun={vi.fn()}
        {...overrides}
      />
    </FluentProvider>,
  );

describe("conversation tasks", () => {
  it("lists what this conversation has out on the fleet", () => {
    show({
      models: models([
        run({ id: "a", name: "Alpha task" }),
        run({ id: "b", name: "Beta task" }),
      ]),
    });

    const panel = screen.getByRole("complementary", { name: "Conversation tasks" });
    expect(within(panel).getByRole("button", { name: /Alpha task/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Beta task/ })).toBeTruthy();
  });

  it("scrolls instead of shrinking cards until their titles disappear", () => {
    show({
      models: models([
        run({ id: "a", name: "Alpha task" }),
        run({ id: "b", name: "Beta task" }),
      ]),
    });

    const panel = screen.getByRole("complementary", { name: "Conversation tasks" });
    const list = panel.querySelector("article")?.parentElement;
    const card = panel.querySelector("article");

    expect(list).not.toBeNull();
    expect(card).not.toBeNull();
    expect(getComputedStyle(list!).overflowY).toBe("auto");
    expect(getComputedStyle(card!).flexShrink).toBe("0");
  });

  it("filters tasks by text, status, and phase", () => {
    show({
      models: models([
        run({
          id: "a",
          name: "Alpha task",
          objective: "Update the frontend",
          phases: ["Plan", "Review"],
          phaseIndex: 0,
        }),
        run({
          id: "b",
          name: "Beta task",
          objective: "Repair the backend",
          state: "completed",
          phases: ["Build", "Ship"],
          phaseIndex: 1,
        }),
      ]),
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
      target: { value: "backend" },
    });
    expect(screen.queryByRole("button", { name: /Alpha task/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Beta task/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Filter tasks by status" }));
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    expect(screen.queryByRole("button", { name: /Alpha task/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Beta task/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Filter tasks by phase" }));
    fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    expect(screen.getByRole("button", { name: /Alpha task/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Beta task/ })).toBeNull();
  });

  it("explains when filters have no matches", () => {
    show();

    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
      target: { value: "missing" },
    });

    expect(screen.getByText("No tasks match these filters.")).toBeTruthy();
    expect(screen.getByText("0/1")).toBeTruthy();
  });

  it("opens a task from beside the conversation", () => {
    const onOpenRun = vi.fn();
    show({ onOpenRun });

    screen.getByRole("button", { name: /Alpha task/ }).click();

    expect(onOpenRun).toHaveBeenCalledWith("a");
  });

  it("says what a conversation with nothing dispatched is", () => {
    /*
     * An empty column reads as broken. A conversation that has asked for
     * nothing yet is the ordinary first state, and it is worth a sentence that
     * says which of the two it is.
     */
    show({ models: [] });
    const panel = screen.getByRole("complementary", { name: "Conversation tasks" });
    expect(within(panel).getByText(/Nothing dispatched/)).toBeTruthy();
  });

  it("folds away and can still be brought back", () => {
    /*
     * The handle is the whole point of keeping a rail: a panel whose only
     * control folded away with it is one an operator closes once and then
     * reports as missing.
     */
    const onToggle = vi.fn();
    const { rerender } = show({ onToggle });

    screen.getByRole("button", { name: "Hide this conversation's tasks" }).click();
    expect(onToggle).toHaveBeenCalled();

    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <ConversationTasks
          models={models([run({ id: "a", name: "Alpha task" })])}
          open={false}
          onToggle={onToggle}
          onOpenRun={vi.fn()}
          onOpenWorker={vi.fn()}
          onNewRun={vi.fn()}
        />
      </FluentProvider>,
    );

    const reopen = screen.getByRole("button", {
      name: "Show this conversation's tasks",
    });
    expect(reopen.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps saying how much is waiting on a person while folded", () => {
    const waiting = models(
      [run({ id: "a", name: "Alpha task" })],
      { a: [step({ runId: "a", sessionId: "worker-1" })] },
      [{ sessionId: "worker-1" } as SessionEvent],
    );
    show({ models: waiting, open: false });

    const panel = screen.getByRole("complementary", { name: "Conversation tasks" });
    expect(within(panel).getByTitle("1 waiting for you").textContent).toBe("1");
  });

  it("starts a task without leaving the conversation", () => {
    const onNewRun = vi.fn();
    show({ onNewRun });

    screen.getByRole("button", { name: "New task" }).click();

    expect(onNewRun).toHaveBeenCalled();
  });
});
