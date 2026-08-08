import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiResult } from "./useFleet";

/**
 * Every write the Settings screens can make.
 *
 * These used to be nine identical handlers in `App`, threaded through
 * `SettingsPanel` as nine props it only forwarded. Collecting them here means
 * the panels ask for what they need instead of the tree carrying it down.
 */
export type CatalogOperations = {
  renameNode: (nodeId: string, name: string) => Promise<boolean>;
  deleteNode: (nodeId: string) => Promise<boolean>;
  createWorkspace: (name: string, description: string) => Promise<boolean>;
  updateWorkspace: (
    workspaceId: string,
    name: string,
    description: string,
  ) => Promise<boolean>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  createPlacement: (
    workspaceId: string,
    nodeId: string,
    localPath: string,
  ) => Promise<boolean>;
  updatePlacement: (placementId: string, localPath: string) => Promise<boolean>;
  deletePlacement: (placementId: string) => Promise<boolean>;
};

type CatalogDeps = {
  request: <T>(path: string, init?: RequestInit) => Promise<ApiResult<T>>;
  refresh: () => Promise<void>;
};

const json = (body: unknown, method: "POST" | "PATCH"): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export function useCatalogOperations({
  request,
  refresh,
}: CatalogDeps): CatalogOperations {
  return useMemo(() => {
    /**
     * A write only lands in the Host's database; the snapshot this browser is
     * rendering is a separate copy, so a successful write is followed by a
     * re-read rather than by editing local state and hoping the two agree.
     */
    const write = async (path: string, init: RequestInit): Promise<boolean> => {
      const result = await request(path, init);
      if (result.ok) await refresh();
      return result.ok;
    };

    return {
      // A rename shows up on the next broadcast, so it does not force a re-read.
      renameNode: async (nodeId, name) =>
        (await request(`/api/nodes/${nodeId}`, json({ name }, "PATCH"))).ok,
      deleteNode: (nodeId) => write(`/api/nodes/${nodeId}`, { method: "DELETE" }),
      createWorkspace: (name, description) =>
        write("/api/workspaces", json({ name, description }, "POST")),
      updateWorkspace: (workspaceId, name, description) =>
        write(`/api/workspaces/${workspaceId}`, json({ name, description }, "PATCH")),
      deleteWorkspace: (workspaceId) =>
        write(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
      createPlacement: (workspaceId, nodeId, localPath) =>
        write("/api/placements", json({ workspaceId, nodeId, localPath }, "POST")),
      updatePlacement: (placementId, localPath) =>
        write(`/api/placements/${placementId}`, json({ localPath }, "PATCH")),
      deletePlacement: (placementId) =>
        write(`/api/placements/${placementId}`, { method: "DELETE" }),
    };
  }, [request, refresh]);
}

const CatalogContext = createContext<CatalogOperations | undefined>(undefined);

export const CatalogProvider = ({
  value,
  children,
}: {
  value: CatalogOperations;
  children: ReactNode;
}) => <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;

export function useCatalog(): CatalogOperations {
  const operations = useContext(CatalogContext);
  if (!operations) {
    throw new Error("useCatalog must be used inside a CatalogProvider");
  }
  return operations;
}
