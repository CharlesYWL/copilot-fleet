import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { RunStepSchema, SessionSchema, type RunStepState } from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { stepStatusDescriptor } from "../../lib/run-step-status";
import { sessionStatusDescriptor } from "../../lib/session-status";
import { statusDescriptor } from "../../lib/status-visuals";
import { WorkerStepTimeline } from "./WorkerStepTimeline";
import { WorkerLinks } from "./WorkerLinks";

const timestamp = "2026-09-15T00:00:00.000Z";
const worker = SessionSchema.parse({
  id: "s1",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "node",
  state: "running",
  initialPrompt: "Implement the change",
  currentActivity: "",
  lastText: "",
  createdAt: timestamp,
  updatedAt: timestamp,
});
const step = (state: RunStepState) =>
  RunStepSchema.parse({
    id: "step1",
    runId: "r1",
    stepKey: "implement",
    title: "Implement status icons",
    prompt: "Implement the change",
    state,
    sessionId: worker.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

describe("dispatched work status", () => {
  it.each([
    ["pending", "Queued"],
    ["starting", "Starting"],
    ["running", "Running"],
    ["succeeded", "Done"],
    ["failed", "Failed"],
    ["skipped", "Skipped"],
    ["cancelled", "Cancelled"],
  ] as const)(
    "renders matching timeline and worker-link icons for %s",
    (state, label) => {
      const steps = [step(state)];
      render(
        <FluentProvider theme={fleetDarkTheme}>
          <WorkerStepTimeline
            steps={steps}
            phases={[]}
            sessions={[]}
            onOpenWorker={vi.fn()}
          />
          <WorkerLinks steps={steps} onOpenWorker={vi.fn()} />
        </FluentProvider>,
      );
      const icons = screen.getAllByRole("img", { name: label });
      expect(icons).toHaveLength(2);
      expect(icons[0]!.querySelector("svg")?.innerHTML).toBe(
        icons[1]!.querySelector("svg")?.innerHTML,
      );
      expect(icons[0]!.style.color).toBe(icons[1]!.style.color);
    },
  );

  it("reflects offline, stopping, and permission states without changing settled results", () => {
    const offline = { ...worker, state: "offline" as const };
    expect(stepStatusDescriptor("running", offline)).toEqual(
      sessionStatusDescriptor(offline),
    );
    expect(
      stepStatusDescriptor("running", { ...worker, stopRequested: true }).state,
    ).toBe("stopping");
    expect(stepStatusDescriptor("running", worker, true).state).toBe(
      "waiting-for-permission",
    );
    expect(stepStatusDescriptor("succeeded", offline, true)).toEqual(
      statusDescriptor("done"),
    );
    expect(stepStatusDescriptor("failed", worker).state).toBe("failed");
    expect(stepStatusDescriptor("cancelled", worker).state).toBe("stopped");
    expect(stepStatusDescriptor("pending", offline).state).toBe("queued");
  });

  it("does not infer a successful step from a worker finishing its turn", () => {
    expect(stepStatusDescriptor("running", { ...worker, state: "idle" }).state).toBe(
      "running",
    );
    expect(stepStatusDescriptor("running", { ...worker, state: "completed" }).state).toBe(
      "running",
    );
  });

  it("updates connectivity and still opens the worker transcript", () => {
    const onOpenWorker = vi.fn();
    const show = (offline: boolean) => (
      <FluentProvider theme={fleetDarkTheme}>
        <WorkerStepTimeline
          steps={[step("running")]}
          phases={[]}
          sessions={[{ ...worker, state: offline ? "offline" : "running" }]}
          onOpenWorker={onOpenWorker}
        />
      </FluentProvider>
    );
    const { rerender } = render(show(false));
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    rerender(show(true));
    expect(screen.getByRole("img", { name: "Offline" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Implement status icons/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(onOpenWorker).toHaveBeenCalledWith(worker.id);
    rerender(show(false));
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  });
});

describe("queued follow-up admission", () => {
  const queued = (admission: Record<string, unknown>) =>
    RunStepSchema.parse({
      ...step("pending"),
      attempts: 6,
      admission: {
        nodeId: "n1",
        nodeName: "CharlesDevBox4",
        localPath: "Q:\\Repos\\TridentWarehouse-UX",
        resumable: true,
        ...admission,
      },
    });

  it("says a same-checkout writer blocks the follow-up and names it", () => {
    const blocked = queued({
      state: "blocked",
      code: "checkout_busy",
      detail:
        'Q:\\Repos\\TridentWarehouse-UX on CharlesDevBox4 is in use by "Publish and link Ontology MSIT PR" (running).',
      conflicts: [
        {
          sessionId: "occupant",
          name: "Publish and link Ontology MSIT PR",
          state: "running",
          runId: "other",
          taskName: "Roll out Go Extension Ontology to PROD",
          role: "worker",
          sameTask: false,
        },
      ],
    });
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <WorkerStepTimeline
          steps={[blocked]}
          phases={[]}
          sessions={[{ ...worker, state: "stopped" }]}
          onOpenWorker={vi.fn()}
          onResumeNow={vi.fn()}
        />
      </FluentProvider>,
    );

    expect(screen.getByRole("img", { name: "Blocked" })).toBeTruthy();
    expect(screen.getByText(/is in use by/)).toBeTruthy();
    expect(
      screen.getByText(/Publish and link Ontology MSIT PR \(running\) · task/),
    ).toBeTruthy();
    expect(screen.getByText(/queued follow-up · attempt 6/)).toBeTruthy();
  });

  it("asks the Host to resume a queued follow-up and reopens a pending approval", () => {
    const onResumeNow = vi.fn();
    const onReviewApproval = vi.fn();
    const show = (admission: Record<string, unknown>) => (
      <FluentProvider theme={fleetDarkTheme}>
        <WorkerStepTimeline
          steps={[queued(admission)]}
          phases={[]}
          sessions={[{ ...worker, state: "stopped" }]}
          onOpenWorker={vi.fn()}
          onResumeNow={onResumeNow}
          onReviewApproval={onReviewApproval}
        />
      </FluentProvider>
    );
    const { rerender } = render(
      show({
        state: "queued",
        code: "node_headroom",
        detail: "CharlesDevBox4 is at Fleet's scheduling limit for writing work.",
        exception: "node_headroom",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume now" }));
    expect(onResumeNow).toHaveBeenCalledWith(expect.objectContaining({ id: "step1" }));

    rerender(
      show({
        state: "awaiting_approval",
        code: "resume_approval",
        detail: "Waiting for an authenticated operator to approve once or cancel.",
        exception: "node_headroom",
        requestId: "request-1",
      }),
    );
    expect(screen.getByRole("img", { name: "Awaiting approval" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
    expect(onReviewApproval).toHaveBeenCalledWith("request-1");

    rerender(
      show({
        state: "starting",
        code: "resuming",
        detail:
          "Resume sent to CharlesDevBox4; waiting for the Node to restore the conversation.",
      }),
    );
    expect(screen.getByRole("img", { name: "Starting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume now" })).toBeNull();
  });
});
