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
    ["starting", "Running"],
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
