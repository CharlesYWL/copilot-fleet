import { createContext, useContext, useEffect, useRef } from "react";

export const SettingsActivityContext = createContext(true);

export function useSettingsActive() {
  return useContext(SettingsActivityContext);
}

/** Load once per mount, then poll only while the retained section is visible. */
export function useSettingsPolling(
  refresh: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
) {
  const active = useSettingsActive();
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      if (activeRef.current) void refresh(controller.signal);
    }, intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);
}
