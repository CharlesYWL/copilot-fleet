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

  it("serializes mutations so the final selection is persisted last", async () => {
    type PendingMutation = {
      method: string;
      body: string | undefined;
      resolve: (result: ApiResult<EffectiveNotificationPreference>) => void;
    };
    const mutations: PendingMutation[] = [];
    const requestMock = vi.fn((path: string, init?: RequestInit) => {
      if (!init) {
        return Promise.resolve({
          ok: true as const,
          data: preference("session-a"),
        });
      }
      return new Promise<ApiResult<EffectiveNotificationPreference>>((resolve) => {
        mutations.push({
          method: init.method ?? "GET",
          body: typeof init.body === "string" ? init.body : undefined,
          resolve,
        });
      });
    });
    const request: FleetRequest = async <T,>(path: string, init?: RequestInit) =>
      (await requestMock(path, init)) as ApiResult<T>;
    const { result } = renderHook(() => useNotificationPreference("session-a", request));
    await waitFor(() => expect(result.current.preference).toBeDefined());

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.setLifecycleEnabled(false);
      second = result.current.setLifecycleEnabled(true);
    });
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ lifecycleEnabled: false }),
    });

    await act(async () => {
      mutations[0]!.resolve({
        ok: true,
        data: preference("session-a", {
          lifecycleEnabled: false,
          source: "explicit",
          explicitOverride: false,
        }),
      });
      expect(await first).toBe(false);
    });
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ lifecycleEnabled: true }),
    });

    await act(async () => {
      mutations[1]!.resolve({
        ok: true,
        data: preference("session-a", {
          lifecycleEnabled: true,
          source: "explicit",
          explicitOverride: true,
        }),
      });
      expect(await second).toBe(true);
    });
    expect(result.current.preference).toMatchObject({
      lifecycleEnabled: true,
      explicitOverride: true,
    });
  });

  it("clears a stale refresh loading state when a mutation supersedes it", async () => {
    let resolveRefresh!: (result: ApiResult<EffectiveNotificationPreference>) => void;
    let resolveMutation!: (result: ApiResult<EffectiveNotificationPreference>) => void;
    const refresh = new Promise<ApiResult<EffectiveNotificationPreference>>((resolve) => {
      resolveRefresh = resolve;
    });
    const mutation = new Promise<ApiResult<EffectiveNotificationPreference>>(
      (resolve) => {
        resolveMutation = resolve;
      },
    );
    const requestMock = vi.fn((_path: string, init?: RequestInit) =>
      init ? mutation : refresh,
    );
    const request: FleetRequest = async <T,>(path: string, init?: RequestInit) =>
      (await requestMock(path, init)) as ApiResult<T>;
    const { result } = renderHook(() => useNotificationPreference("session-a", request));
    await waitFor(() => expect(result.current.loading).toBe(true));

    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.setLifecycleEnabled(false);
    });
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveMutation({
        ok: true,
        data: preference("session-a", {
          lifecycleEnabled: false,
          source: "explicit",
          explicitOverride: false,
        }),
      });
      expect(await saved).toBe(true);
      resolveRefresh({
        ok: true,
        data: preference("session-a"),
      });
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.preference?.lifecycleEnabled).toBe(false);
  });
});
