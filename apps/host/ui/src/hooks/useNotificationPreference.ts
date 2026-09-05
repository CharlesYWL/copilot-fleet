import { useCallback, useEffect, useRef, useState } from "react";
import type { RunRole } from "@fleet/protocol";
import type { ApiResult } from "./useFleet";

export type EffectiveNotificationPreference = {
  sessionId: string;
  agentId: string;
  runRole: RunRole;
  lifecycleEnabled: boolean;
  source: "explicit" | "role" | "application";
  explicitOverride: boolean | null;
  roleDefault: boolean | null;
  applicationDefault: boolean;
};

export type FleetRequest = <T>(path: string, init?: RequestInit) => Promise<ApiResult<T>>;

export function useNotificationPreference(
  sessionId: string | undefined,
  request: FleetRequest,
) {
  const [preference, setPreference] = useState<EffectiveNotificationPreference>();
  const [loading, setLoading] = useState(false);
  const ticket = useRef(0);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const session = useRef(sessionId);
  session.current = sessionId;

  const refresh = useCallback(async () => {
    const current = ++ticket.current;
    if (!sessionId) {
      setPreference(undefined);
      setLoading(false);
      return false;
    }
    setLoading(true);
    const result = await request<EffectiveNotificationPreference>(
      `/api/notifications/preferences/${encodeURIComponent(sessionId)}`,
    );
    if (ticket.current !== current) return false;
    setLoading(false);
    if (!result.ok) {
      setPreference(undefined);
      return false;
    }
    setPreference(result.data);
    return true;
  }, [request, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    (method: "PUT" | "DELETE", lifecycleEnabled?: boolean): Promise<boolean> => {
      if (!sessionId) return Promise.resolve(false);
      const targetSessionId = sessionId;
      const current = ++ticket.current;
      setLoading(false);
      const operation = mutationQueue.current.then(async () => {
        const result = await request<EffectiveNotificationPreference>(
          `/api/notifications/preferences/${encodeURIComponent(targetSessionId)}`,
          method === "PUT"
            ? {
                method,
                body: JSON.stringify({ lifecycleEnabled }),
              }
            : { method },
        );
        if (ticket.current !== current || session.current !== targetSessionId) {
          return false;
        }
        if (!result.ok) return false;
        setPreference(result.data);
        return true;
      });
      mutationQueue.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [request, sessionId],
  );

  const setLifecycleEnabled = useCallback(
    (lifecycleEnabled: boolean) => mutate("PUT", lifecycleEnabled),
    [mutate],
  );

  const reset = useCallback(() => mutate("DELETE"), [mutate]);

  return { preference, loading, refresh, setLifecycleEnabled, reset };
}
