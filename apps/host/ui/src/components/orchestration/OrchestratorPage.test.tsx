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

const conversation = (overrides: Partial<FleetSession> = {}): FleetSession => ({
  id: "lead",
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
  agentSessionId: "copilot-lead-1",
  yolo: true,
  commands: [],
  configOptions: [],
  runId: "",
  runRole: "lead",
  readOnly: true,
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
      conversation={conversation()}
      models={list}
      summary={{ total: list.length, running: 0, needsYou: 0, dominantStage: "planning" }}
      mode={mode}
      onOpenRun={onOpenRun}
      onOpenWorker={vi.fn()}
      onOpenLead={vi.fn()}
      onNewRun={vi.fn()}
      onStopOrchestrator={vi.fn()}
      onResumeOrchestrator={vi.fn()}
      onDismissOrchestrator={vi.fn()}
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
        conversation={conversation()}
        models={[]}
        summary={{ total: 0, running: 0, needsYou: 0, dominantStage: undefined }}
        mode="stage"
        onOpenRun={vi.fn()}
        onOpenWorker={vi.fn()}
        onOpenLead={vi.fn()}
        onNewRun={onNewRun}
        onStopOrchestrator={vi.fn()}
        onResumeOrchestrator={vi.fn()}
        onDismissOrchestrator={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "New task" })[1]!);
    expect(onNewRun).toHaveBeenCalled();
  });

  it("keeps a stopped conversation available to resume or dismiss", () => {
    const onResumeOrchestrator = vi.fn();
    const onDismissOrchestrator = vi.fn();
    page("stage", vi.fn(), models([run({ state: "cancelled" })]), {
      conversation: conversation({ state: "stopped" }),
      onResumeOrchestrator,
      onDismissOrchestrator,
    });

    expect(screen.queryByRole("button", { name: "Stop orchestrator" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "New task" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resume orchestrator" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss orchestrator" }));

    expect(onResumeOrchestrator).toHaveBeenCalled();
    expect(onDismissOrchestrator).toHaveBeenCalled();
  });

  it("shows Stop progress and prevents repeated actions until acknowledgement", () => {
    page("stage", vi.fn(), undefined, {
      conversation: conversation({ state: "offline", stopRequested: true }),
    });

    const stopping = screen.getByRole("button", { name: "Stopping orchestrator" });
    expect(stopping.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "New task" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Resume orchestrator" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss orchestrator" })).toBeNull();
  });

  it("still offers Stop when the lead ended before its owned work", () => {
    page("stage", vi.fn(), undefined, {
      conversation: conversation({ state: "failed" }),
    });

    expect(screen.getByRole("button", { name: "Stop orchestrator" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss orchestrator" })).toBeNull();
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
      onReopen: vi.fn().mockResolvedValue(true),
      onDelete: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
    wrap(<OrchestratorTaskDetail {...props} />);
    return props;
  };

  it("offers archiving while a task is still live, and not the other two", () => {
    /*
     * The three are mutually exclusive on purpose. Archiving a live task stops
     * it and keeps what it found; a finished task is either wrong — reopen it —
     * or done with, and then keeping a record of it is the thing nobody wants.
     */
    detail();

    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "offers reopening and deleting once a task is %s",
    (state) => {
      detail({ model: models([run({ id: "r1", state })])[0]! });

      expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    },
  );

  it("will not reopen a task without saying what is still wanted", () => {
    // The orchestrator is woken to act on this, and "not done" is not something
    // anyone can act on — the same rule as sending a task back.
    const model = models([run({ id: "r1", state: "completed" })])[0]!;
    const props = detail({ model });

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const confirm = screen.getByRole("button", { name: "Reopen task" });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "the migration is still missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen task" }));

    expect(props.onReopen).toHaveBeenCalledWith("the migration is still missing");
  });

  it("deletes a finished task once, from its own confirmation", () => {
    const model = models([run({ id: "r1", state: "completed" })])[0]!;
    const props = detail({ model });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

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

  it("shows the person the same definition of done the orchestrator is held to", () => {
    /*
     * These are not decoration: fleet_submit_task refuses while an essential
     * one is unmet. Showing them here is what lets a person disagree with the
     * contract early, rather than discovering it at handover.
     */
    const model = models([
      run({
        id: "r1",
        stopWhen: "the auth suite is green",
        successCriteria: [
          {
            id: "logout-invalidates",
            scenario: "reusing a token after logout returns 401",
            expectedEvidence: "the auth suite's logout test passes",
            essential: true,
          },
          {
            id: "nice-message",
            scenario: "the error names the expired token",
            expectedEvidence: "the 401 body carries the token id",
            essential: false,
          },
        ],
      }),
    ])[0]!;
    detail({ model });

    expect(screen.getByText("What done means")).toBeTruthy();
    expect(screen.getByText(/Finished when the auth suite is green/)).toBeTruthy();
    expect(screen.getByText(/reusing a token after logout returns 401/)).toBeTruthy();
    // The evidence, not only the claim — a scenario with nothing to show it is
    // the vagueness criteria exist to replace.
    expect(screen.getByText(/the auth suite's logout test passes/)).toBeTruthy();
    expect(screen.getByText("optional")).toBeTruthy();
  });

  it("shows no definition of done for a task planned before there was one", () => {
    detail();

    expect(screen.queryByText("What done means")).toBeNull();
  });

  it("renders a handover as markdown, not as one paragraph of source", () => {
    /*
     * This note and two buttons are the whole review. Left as plain text the
     * orchestrator's structure arrives as literal `###` and `-`, which reads
     * worse than the prose it was meant to replace.
     */
    const model = models([run({ id: "r1", state: "awaiting_human" })])[0]!;
    detail({
      model,
      notes: [
        {
          id: "n1",
          runId: "r1",
          phaseIndex: 1,
          body: [
            "**The empty state uses a native 48px glyph.**",
            "",
            "### How it was proven",
            "- the new tests failed first, then passed 10/10",
          ].join("\n"),
          createdAt: ISO,
        },
      ],
    });

    const card = screen.getByText("Ready for you").closest("section")!;
    expect(within(card).getByRole("heading", { name: "How it was proven" })).toBeTruthy();
    expect(within(card).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(card).queryByText(/### How it was proven/)).toBeNull();
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

  it("dismisses a failed-step warning until another step fails", () => {
    const runId = "dismiss-failure";
    localStorage.removeItem(`fleet.ui.run.failed-step.${runId}`);
    const firstFailure = step("failed-1", {
      runId,
      state: "failed",
      updatedAt: "2026-01-01T12:01:00.000Z",
    });
    const resolvedLater = step("failed-2", {
      runId,
      state: "failed",
      updatedAt: "2026-01-01T12:02:00.000Z",
    });
    const firstModel = models([run({ id: runId })], {
      [runId]: [firstFailure, resolvedLater],
    })[0]!;
    const onDismissFailure = vi.fn();
    const props = {
      model: firstModel,
      notes: [],
      sessions: [],
      onBack: vi.fn(),
      onOpenLead: vi.fn(),
      onOpenWorker: vi.fn(),
      onReview: vi.fn().mockResolvedValue(true),
      onArchive: vi.fn().mockResolvedValue(true),
      onReopen: vi.fn().mockResolvedValue(true),
      onDelete: vi.fn().mockResolvedValue(true),
      onDismissFailure,
    };

    const firstView = wrap(<OrchestratorTaskDetail {...props} />);
    expect(screen.getByText("A step failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss failed step warning" }));
    expect(screen.queryByText("A step failed")).toBeNull();
    expect(onDismissFailure).toHaveBeenCalledOnce();

    firstView.unmount();
    const reopenedView = wrap(<OrchestratorTaskDetail {...props} />);
    expect(screen.queryByText("A step failed")).toBeNull();

    const fewerFailures = models([run({ id: runId })], {
      [runId]: [firstFailure],
    })[0]!;
    reopenedView.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorTaskDetail {...props} model={fewerFailures} />
      </FluentProvider>,
    );
    expect(screen.queryByText("A step failed")).toBeNull();

    const nextModel = models([run({ id: runId })], {
      [runId]: [
        firstFailure,
        step("failed-3", {
          runId,
          state: "failed",
          updatedAt: "2026-01-01T12:03:00.000Z",
        }),
      ],
    })[0]!;
    reopenedView.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorTaskDetail {...props} model={nextModel} />
      </FluentProvider>,
    );

    expect(screen.getByText("A step failed")).toBeTruthy();
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
     * so the confirmation has to say both halves: the workers stop, and their
     * resumable context stays with the record.
     */
    const props = detail();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/parked outside the active fleet/)).toBeTruthy();
    expect(within(dialog).getByText(/keeps its phases/)).toBeTruthy();
    expect(
      within(dialog).getByText(/resume one of its worker conversations/),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive task" }));
    expect(props.onArchive).toHaveBeenCalled();
  });

  it("does not offer archiving on a task that has already ended", () => {
    /*
     * It used to, on the grounds that a finished task's workers are the ones
     * cluttering the tree. Deleting clears those too, and it is the honest
     * choice at that point: archiving keeps a record, and the reason to keep
     * one is that the work is over — which is also when there is nothing left
     * to stop.
     */
    const model = models([run({ id: "r1", state: "completed" })])[0]!;
    detail({ model });

    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
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
