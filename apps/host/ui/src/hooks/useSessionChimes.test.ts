import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FleetSession, SessionEvent } from "@fleet/protocol";

const playChime = vi.fn();
vi.mock("../lib/chime", () => ({ playChime: (kind: string) => playChime(kind) }));

const { useSessionChimes } = await import("./useSessionChimes");

const session = (id: string, state: FleetSession["state"]): FleetSession =>
  ({ id, state }) as FleetSession;

const permission = (requestId: string): SessionEvent =>
  ({
    eventId: requestId,
    sessionId: "s1",
    sequence: 1,
    type: "permission",
    payload: { requestId, title: "Run something" },
    createdAt: "2026-08-08T00:00:00.000Z",
  }) as SessionEvent;

beforeEach(() => {
  playChime.mockClear();
  window.localStorage.clear();
});

describe("useSessionChimes", () => {
  it("stays silent on the first render, however many sessions there are", () => {
    renderHook(() => useSessionChimes([session("a", "idle"), session("b", "idle")], []));
    expect(playChime).not.toHaveBeenCalled();
  });

  it("sounds once when an agent finishes", () => {
    const { rerender } = renderHook(({ sessions }) => useSessionChimes(sessions, []), {
      initialProps: { sessions: [session("a", "running")] },
    });
    rerender({ sessions: [session("a", "idle")] });
    expect(playChime).toHaveBeenCalledExactlyOnceWith("done");
  });

  it("sounds once for a batch, not once per session", () => {
    const { rerender } = renderHook(({ sessions }) => useSessionChimes(sessions, []), {
      initialProps: {
        sessions: [session("a", "running"), session("b", "running")],
      },
    });
    rerender({ sessions: [session("a", "idle"), session("b", "idle")] });
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it("uses its own tone for a blocked agent", () => {
    const { rerender } = renderHook(({ pending }) => useSessionChimes([], pending), {
      initialProps: { pending: [] as SessionEvent[] },
    });
    rerender({ pending: [permission("r1")] });
    expect(playChime).toHaveBeenCalledExactlyOnceWith("permission");
  });

  it("does not repeat a permission that is still waiting", () => {
    const { rerender } = renderHook(({ pending }) => useSessionChimes([], pending), {
      initialProps: { pending: [] as SessionEvent[] },
    });
    rerender({ pending: [permission("r1")] });
    rerender({ pending: [permission("r1")] });
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it("announces a second request raised by the same turn", () => {
    const { rerender } = renderHook(({ pending }) => useSessionChimes([], pending), {
      initialProps: { pending: [] as SessionEvent[] },
    });
    rerender({ pending: [permission("r1")] });
    rerender({ pending: [permission("r1"), permission("r2")] });
    expect(playChime).toHaveBeenCalledTimes(2);
  });

  it("goes quiet when muted, and does not catch up when unmuted", () => {
    const { result, rerender } = renderHook(
      ({ sessions }) => useSessionChimes(sessions, []),
      { initialProps: { sessions: [session("a", "running")] } },
    );
    act(() => result.current.toggle());
    // The toggle itself sounds, so the operator hears what they just enabled.
    playChime.mockClear();
    expect(result.current.enabled).toBe(false);

    rerender({ sessions: [session("a", "idle")] });
    expect(playChime).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    playChime.mockClear();
    // Re-rendering with the same states must not replay what was missed.
    rerender({ sessions: [session("a", "idle")] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it("remembers being muted across a reload", () => {
    const first = renderHook(() => useSessionChimes([], []));
    act(() => first.result.current.toggle());
    expect(window.localStorage.getItem("fleet.sound")).toBe("off");

    const second = renderHook(() => useSessionChimes([], []));
    expect(second.result.current.enabled).toBe(false);
  });
});
