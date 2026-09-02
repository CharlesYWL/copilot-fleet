import { describe, expect, it } from "vitest";
import type { FleetSession, Notification, Run, RunStep } from "@fleet/protocol";
import { notificationTarget } from "./notification-navigation";

const base = (navigation: Notification["navigation"]): Notification =>
  ({
    id: "n1",
    navigation,
    data: {},
  }) as Notification;

describe("notificationTarget", () => {
  const retainedRun = [{ id: "r1" } as Run];

  it("opens session and permission destinations in their actual session", () => {
    const sessions = [{ id: "s1" } as FleetSession, { id: "worker" } as FleetSession];
    expect(
      notificationTarget(base({ type: "session", sessionId: "s1" }), {}, sessions, []),
    ).toEqual({ kind: "session", sessionId: "s1" });
    expect(
      notificationTarget(
        base({ type: "permission_request", sessionId: "worker" }),
        {},
        sessions,
        [],
      ),
    ).toEqual({ kind: "session", sessionId: "worker" });
  });

  it("falls back from a deleted durable session to its run, node, or fleet", () => {
    const run = base({ type: "session", sessionId: "gone", runId: "r1" });
    expect(notificationTarget(run, {}, [], retainedRun)).toEqual({
      kind: "run",
      runId: "r1",
    });

    const node = base({ type: "permission_request", sessionId: "gone" });
    node.data = { nodeId: "node-1" };
    expect(notificationTarget(node, {}, [], [])).toEqual({
      kind: "node",
      nodeId: "node-1",
    });

    expect(
      notificationTarget(
        base({ type: "permission_request", sessionId: "gone" }),
        {},
        [],
        [],
      ),
    ).toEqual({ kind: "fleet" });
  });

  it("opens retained runs and sends deleted runs to the orchestrator board", () => {
    expect(
      notificationTarget(base({ type: "run", runId: "r1" }), {}, [], retainedRun),
    ).toEqual({ kind: "run", runId: "r1" });
    expect(notificationTarget(base({ type: "run", runId: "gone" }), {}, [], [])).toEqual({
      kind: "orchestrator",
    });
  });

  it("opens a retained dependency step's current worker and returns to its task", () => {
    const step = {
      id: "step-1",
      runId: "r1",
      sessionId: "worker-1",
    } as RunStep;
    const session = { id: "worker-1" } as FleetSession;

    expect(
      notificationTarget(
        base({ type: "run_step", runId: "r1", stepId: "step-1" }),
        { r1: [step] },
        [session],
        retainedRun,
      ),
    ).toEqual({
      kind: "session",
      sessionId: "worker-1",
      returnRunId: "r1",
    });
  });

  it("falls back to task detail after a dependency session is cleared", () => {
    expect(
      notificationTarget(
        base({
          type: "run_step",
          runId: "r1",
          stepId: "step-1",
          sessionId: "gone",
        }),
        {},
        [],
        retainedRun,
      ),
    ).toEqual({ kind: "run", runId: "r1" });
  });

  it("does not open a retained session for a deleted run step", () => {
    const session = { id: "worker-1" } as FleetSession;
    expect(
      notificationTarget(
        base({
          type: "run_step",
          runId: "gone",
          stepId: "step-1",
          sessionId: "worker-1",
        }),
        {},
        [session],
        [],
      ),
    ).toEqual({ kind: "orchestrator" });
  });

  it("supports the forward-compatible node destination without changing protocol", () => {
    const item = base({ type: "fleet" });
    item.data = { nodeId: "node-1" };
    expect(notificationTarget(item, {}, [], [])).toEqual({
      kind: "node",
      nodeId: "node-1",
    });
  });
});
