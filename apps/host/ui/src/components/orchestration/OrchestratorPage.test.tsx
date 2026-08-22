import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import {
  RunPolicySchema,
  type FleetSession,
  type Run,
  type RunStep,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { buildRunViewModels, type RunViewModel } from "../../lib/orchestration-view";
import { OrchestratorPage } from "./OrchestratorPage";
import { OrchestratorTaskDetail } from "./OrchestratorTaskDetail";

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
  failureReason: "",
  pendingPrompt: "",
  settleSeq: 0,
  wakeSeq: 0,
  emptyWakeCount: 0,
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

const step = (id: string, overrides: Partial<RunStep> = {}): RunStep => ({
  id,
  runId: "r1",
  stepKey: id,
  title: id,
  prompt: "do it",
  category: "implement",
  dependsOn: [],
  state: "succeeded",
  sessionId: "",
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

/**
 * View models for the given runs, with a live session behind every dispatched
 * step.
 *
 * A step whose session is gone is the archived case, which has its own test;
 * everywhere else a dispatched step has something to open, and leaving the
 * session list empty would quietly make every link untestable.
 */
const models = (runs: Run[], stepsByRun: Record<string, RunStep[]> = {}) =>
  buildRunViewModels({
    runs,
    stepsByRun,
    sessions: Object.values(stepsByRun)
      .flat()
      .filter((step) => step.sessionId)
      .map((step) => ({ id: step.sessionId }) as FleetSession),
  });

const wrap = (node: React.ReactElement) =>
  render(<FluentProvider theme={fleetDarkTheme}>{node}</FluentProvider>);

const page = (
  mode: "stage" | "list" | "dependency",
  onOpenRun = vi.fn(),
  list = models([
    run({ id: "a", name: "Alpha task" }),
    run({ id: "b", name: "Beta task" }),
  ]),
  extra: Partial<Parameters<typeof OrchestratorPage>[0]> = {},
) => {
  wrap(
    <OrchestratorPage
      models={list}
      summary={{ total: list.length, running: 0, needsYou: 0, dominantStage: "planning" }}
      mode={mode}
      onOpenRun={onOpenRun}
      onOpenWorker={vi.fn()}
      onOpenLead={vi.fn()}
      onNewRun={vi.fn()}
      onStopOrchestrator={vi.fn()}
      {...extra}
    />,
  );
  return onOpenRun;
};

describe("orchestrator views", () => {
  it.each(["stage", "list", "dependency"] as const)(
    "opens the same task detail from the %s view",
    (mode) => {
      /*
       * Three arrangements of one list. If any of them opened something else —
       * an inspector, a dialog, a different route — the mode switch would stop
       * being a view and start being a mode of operation.
       */
      const onOpenRun = page(mode);

      const target =
        mode === "dependency"
          ? screen.getByRole("button", { name: /Open task/ })
          : screen.getByRole("button", { name: /Alpha task/ });
      fireEvent.click(target);

      expect(onOpenRun).toHaveBeenCalledWith("a");
    },
  );

  it("makes the list row's target a real button rather than a row pretending", () => {
    /*
     * The row used to carry `role="button"`, which tells a screen reader that a
     * table row is a button and takes the table's semantics with it — and left
     * no valid place to put the links to the sessions the task dispatched. A
     * real button answers the keyboard without the row hand-rolling it.
     */
    const onOpenRun = page("list");
    const target = screen.getByRole("button", { name: "Open Alpha task" });

    expect(target.tagName).toBe("BUTTON");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByRole("row", { name: /Open Alpha task/ })).toBeNull();

    fireEvent.click(target);
    expect(onOpenRun).toHaveBeenCalledWith("a");
  });

  it("opens a worker's transcript from a step in the dependency view", () => {
    // This button used to render enabled and do nothing, because the handler it
    // needed was optional and the page was never given one.
    const onOpenWorker = vi.fn();
    const list = models([run({ id: "a", name: "Alpha task" })], {
      a: [step("s1", { runId: "a", sessionId: "sess1", title: "Do the thing" })],
    });
    page("dependency", vi.fn(), list, { onOpenWorker });

    fireEvent.click(screen.getByRole("button", { name: /Do the thing/ }));

    expect(onOpenWorker).toHaveBeenCalledWith("sess1");
  });

  it.each(["stage", "list"] as const)(
    "links straight to a dispatched session from the %s view",
    (mode) => {
      /*
       * Every dispatched step is a real session with a real transcript. Before
       * this, reaching one meant opening the task first — a step for nothing
       * when the transcript is the thing being looked for.
       */
      const onOpenWorker = vi.fn();
      const onOpenRun = vi.fn();
      const list = models([run({ id: "a", name: "Alpha task" })], {
        a: [step("s1", { runId: "a", sessionId: "sess1", title: "Write the docs" })],
      });
      page(mode, onOpenRun, list, { onOpenWorker });

      fireEvent.click(screen.getByRole("button", { name: /Write the docs/ }));

      expect(onOpenWorker).toHaveBeenCalledWith("sess1");
      // Opening a worker is not opening the task, even though the chip sits
      // inside a card whose every other pixel opens the task.
      expect(onOpenRun).not.toHaveBeenCalled();
    },
  );

  it("does not offer a link for a step that never reached a machine", () => {
    const onOpenWorker = vi.fn();
    const list = models([run({ id: "a", name: "Alpha task" })], {
      a: [
        step("s1", { runId: "a", sessionId: "", title: "Queued work", state: "pending" }),
      ],
    });
    page("list", vi.fn(), list, { onOpenWorker });

    expect(screen.queryByRole("button", { name: /Queued work/ })).toBeNull();
  });

  it("collapses the rest behind a count that opens the task", () => {
    const onOpenRun = vi.fn();
    const list = models([run({ id: "a", name: "Alpha task" })], {
      a: [
        step("s1", { runId: "a", sessionId: "x1", title: "One" }),
        step("s2", { runId: "a", sessionId: "x2", title: "Two" }),
        step("s3", { runId: "a", sessionId: "x3", title: "Three" }),
        step("s4", { runId: "a", sessionId: "x4", title: "Four" }),
        step("s5", { runId: "a", sessionId: "x5", title: "Five" }),
      ],
    });
    page("list", onOpenRun, list, { onOpenWorker: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(onOpenRun).toHaveBeenCalledWith("a");
  });

  it("never shows a budget, which was a number only the machine cared about", () => {
    page("stage");
    expect(screen.queryByText(/wakes/i)).toBeNull();
    expect(screen.queryByText(/sessions \d+\//i)).toBeNull();
  });

  it("keeps the new-task action available with nothing dispatched", () => {
    const onNewRun = vi.fn();
    wrap(
      <OrchestratorPage
        models={[]}
        summary={{ total: 0, running: 0, needsYou: 0, dominantStage: undefined }}
        mode="stage"
        onOpenRun={vi.fn()}
        onOpenWorker={vi.fn()}
        onOpenLead={vi.fn()}
        onNewRun={onNewRun}
        onStopOrchestrator={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "New task" })[1]!);
    expect(onNewRun).toHaveBeenCalled();
  });

  it("puts what needs a person at the top of its column", () => {
    // Both derive to validation, so this is genuinely about order within one
    // column rather than about which column they land in.
    const list = models(
      [
        run({ id: "quiet", name: "Quiet task", state: "awaiting_lead" }),
        run({ id: "blocked", name: "Blocked task", state: "awaiting_human" }),
      ],
      { quiet: [step("s", { runId: "quiet" })] },
    );
    expect(list.map((model) => model.stage)).toEqual(["validation", "validation"]);
    page("stage", vi.fn(), list);

    const column = screen.getByRole("region", { name: /Validation/ });
    const cards = within(column).getAllByRole("button");
    expect(cards[0]?.getAttribute("aria-label")).toContain("Blocked task");
  });
});

describe("task detail", () => {
  const detail = (
    overrides: Partial<Parameters<typeof OrchestratorTaskDetail>[0]> = {},
  ) => {
    const model: RunViewModel = models(
      [run({ id: "r1", phases: ["Plan", "Review"], phaseIndex: 1 })],
      { r1: [step("s1", { sessionId: "sess1", title: "Do the thing" })] },
    )[0]!;
    const props = {
      model,
      notes: [],
      // The session behind the step exists, as it does while a task is live.
      // The archived case — a step outliving its session — is its own test.
      sessions: [{ id: "sess1" } as FleetSession],
      onBack: vi.fn(),
      onOpenLead: vi.fn(),
      onOpenWorker: vi.fn(),
      onReview: vi.fn().mockResolvedValue(true),
      onArchive: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
    wrap(<OrchestratorTaskDetail {...props} />);
    return props;
  };

  it("says a freshly opened task is waiting on the orchestrator, not on you", () => {
    /*
     * The record is written before the orchestrator is briefed, so a task with
     * no phases is normal rather than broken. Saying so is also what connects
     * the two entry points: the brief lives in the conversation.
     */
    const onOpenLead = vi.fn();
    const model = models([run({ id: "r1", phases: [] })])[0]!;
    detail({ model, onOpenLead });

    expect(screen.getByText(/Waiting for the orchestrator to plan this/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open the conversation" }));
    expect(onOpenLead).toHaveBeenCalled();
  });

  it("does not claim a planned task is waiting to be planned", () => {
    detail();
    expect(screen.queryByText(/Waiting for the orchestrator to plan this/)).toBeNull();
  });

  it("goes back to the task list", () => {
    const props = detail();
    fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("opens the orchestrator's conversation from the task", () => {
    const props = detail();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(props.onOpenLead).toHaveBeenCalled();
  });

  it("opens a worker's transcript from its step", () => {
    const props = detail();
    fireEvent.click(screen.getByRole("button", { name: /Do the thing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(props.onOpenWorker).toHaveBeenCalledWith("sess1");
  });

  it("says what archiving does before doing it", async () => {
    /*
     * The difference between this and deleting is the whole reason it is safe,
     * so the confirmation has to say both halves: the sessions go, the record
     * stays.
     */
    const props = detail();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/removed from the fleet/)).toBeTruthy();
    expect(within(dialog).getByText(/keeps its phases/)).toBeTruthy();
    expect(within(dialog).getByText(/cannot be resumed/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive task" }));
    expect(props.onArchive).toHaveBeenCalled();
  });

  it("offers archiving on a task that has already ended", () => {
    // A finished task's workers are exactly the ones sitting in the tree with
    // nothing left to do, so this is when clearing them away matters most.
    const model = models([run({ id: "r1", state: "completed" })])[0]!;
    detail({ model });
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("does not offer a transcript once its session is gone", () => {
    // Archiving removes the sessions but keeps the steps, so a step outlives
    // the thing its id points at.
    const model = models([run({ id: "r1" })], {
      r1: [step("s1", { sessionId: "sess-gone", title: "Do the thing" })],
    })[0]!;
    detail({ model, sessions: [] });

    fireEvent.click(screen.getByRole("button", { name: /Do the thing/ }));
    expect(screen.queryByRole("button", { name: "Open transcript" })).toBeNull();
    expect(screen.getByText(/cleared away/)).toBeTruthy();
  });

  it("will not send a task back with nothing to act on", async () => {
    const model = models([run({ id: "r1", state: "awaiting_human" })])[0]!;
    const props = detail({ model });

    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Send back" });

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(props.onReview).not.toHaveBeenCalled();
  });

  it("approves without asking for a reason", async () => {
    const model = models([run({ id: "r1", state: "awaiting_human" })])[0]!;
    const props = detail({ model });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(props.onReview).toHaveBeenCalledWith(true, "");
  });
});
