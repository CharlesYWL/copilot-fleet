import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./useFleet";
import {
  useNotificationPreference,
  type EffectiveNotificationPreference,
  type FleetRequest,
} from "./useNotificationPreference";

const preference = (
  sessionId: string,
  overrides: Partial<EffectiveNotificationPreference> = {},
): EffectiveNotificationPreference => ({
  sessionId,
  agentId: `agent-${sessionId}`,
  runRole: "lead",
  lifecycleEnabled: true,
  source: "application",
  explicitOverride: null,
  roleDefault: null,
  applicationDefault: true,
  ...overrides,
});

describe("useNotificationPreference", () => {
  it.each(["PUT", "DELETE"] as const)(
    "does not let a stale %s response replace the newly selected session",
    async (method) => {
      let resolveMutation!: (result: ApiResult<EffectiveNotificationPreference>) => void;
      const mutation = new Promise<ApiResult<EffectiveNotificationPreference>>(
        (resolve) => {
          resolveMutation = resolve;
        },
      );
      const requestMock = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith("/session-a") && init?.method === method) {
          return mutation;
        }
        if (path.endsWith("/session-a")) {
          return { ok: true as const, data: preference("session-a") };
        }
        return {
          ok: true as const,
          data: preference("session-b", { lifecycleEnabled: false }),
        };
      });
      const request: FleetRequest = async <T,>(path: string, init?: RequestInit) =>
        (await requestMock(path, init)) as ApiResult<T>;
      const { result, rerender } = renderHook(
        ({ sessionId }) => useNotificationPreference(sessionId, request),
        { initialProps: { sessionId: "session-a" } },
      );
      await waitFor(() => expect(result.current.preference?.sessionId).toBe("session-a"));

      let pending!: Promise<boolean>;
      act(() => {
        pending =
          method === "PUT"
            ? result.current.setLifecycleEnabled(false)
            : result.current.reset();
      });
      rerender({ sessionId: "session-b" });
      await waitFor(() => expect(result.current.preference?.sessionId).toBe("session-b"));

      await act(async () => {
        resolveMutation({
          ok: true,
          data: preference("session-a", {
            lifecycleEnabled: false,
            source: "explicit",
            explicitOverride: false,
          }),
        });
        expect(await pending).toBe(false);
      });
      expect(result.current.preference).toMatchObject({
        sessionId: "session-b",
        lifecycleEnabled: false,
      });
    },
  );
});
