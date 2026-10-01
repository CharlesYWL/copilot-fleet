import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_LIMITS,
  type BrowserMessage,
  type CommandOutputEvent,
} from "@fleet/protocol";
import { useFleet } from "./useFleet";

class Socket {
  static current: Socket;
  onmessage: ((event: MessageEvent) => void) | undefined;
  close = vi.fn();
  constructor() {
    Socket.current = this;
  }
  send(message: BrowserMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}
const output = (sequence: number): CommandOutputEvent => ({
  executionId: "d00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65",
  attemptId: "e00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65",
  sequence,
  stream: "stdout",
  data: btoa("x".repeat(COMMAND_LIMITS.chunkBytes)),
  at: "2026-09-16T14:00:00.000Z",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live command output", () => {
  it("batches bursts, bounds the renderer buffer, and never creates session events", async () => {
    const { result } = renderHook(() => useFleet(vi.fn()));
    act(() => {
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        Socket.current.send({
          type: "command_execution_output",
          event: output(sequence),
        });
      }
      Socket.current.send({ type: "command_execution_output", event: output(100) });
    });
    expect(result.current.commandOutput).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.commandOutput.at(-1)?.sequence).toBe(100);
    expect(
      result.current.commandOutput.filter((entry) => entry.sequence === 100),
    ).toHaveLength(1);
    expect(
      result.current.commandOutput.reduce(
        (bytes, event) => bytes + event.data.length + 256,
        0,
      ),
    ).toBeLessThanOrEqual(COMMAND_LIMITS.queueBytes);
    expect(result.current.events).toEqual({});
  });

  it("rejects malformed new frames explicitly", () => {
    const notify = vi.fn();
    renderHook(() => useFleet(notify));
    act(() =>
      Socket.current.send({
        type: "command_execution_output",
        event: { ...output(1), data: "<script>" },
      }),
    );
    expect(notify).toHaveBeenCalledWith("Malformed live update", "error");
    expect(Socket.current.close).toHaveBeenCalledWith(1008, "Invalid message");
  });
});
