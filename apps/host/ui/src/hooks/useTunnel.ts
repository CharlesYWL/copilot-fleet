import { useCallback, useEffect, useState } from "react";
import { errorMessage, type TunnelInfo, type TunnelProvider } from "@fleet/protocol";
import { api } from "./useFleet";

export type TunnelControls = {
  info: TunnelInfo | undefined;
  busy: boolean;
  error: string | undefined;
  setEnabled: (enabled: boolean, provider?: TunnelProvider) => Promise<void>;
};

/**
 * Tunnel status, polled while the panel is open.
 *
 * The tunnel is a child process whose state changes without anyone asking — it
 * can take seconds to publish a URL, and it can die on its own — so the panel
 * re-reads instead of waiting for an event the Host has no reason to send to
 * every browser.
 */
export function useTunnel(intervalMs = 2_000): TunnelControls {
  const [info, setInfo] = useState<TunnelInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setInfo(await api<TunnelInfo>("/api/tunnel"));
    } catch {
      // Keep the last good snapshot; the next poll retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  const setEnabled = useCallback(
    async (enabled: boolean, provider?: TunnelProvider) => {
      setBusy(true);
      setError(undefined);
      try {
        setInfo(
          await api<TunnelInfo>("/api/tunnel", {
            method: "POST",
            body: JSON.stringify({ enabled, ...(provider ? { provider } : {}) }),
          }),
        );
      } catch (reason) {
        setError(errorMessage(reason));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { info, busy, error, setEnabled };
}
