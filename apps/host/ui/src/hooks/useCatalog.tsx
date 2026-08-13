import { createContext, useContext, useMemo, type ReactNode } from "react";
import { errorMessage, type FleetSession } from "@fleet/protocol";
import { ApiError, api, type ApiResult, type Notify } from "./useFleet";

/**
 * Every write the Settings screens can make.
 *
 * These used to be nine identical handlers in `App`, threaded through
 * `SettingsPanel` as nine props it only forwarded. Collecting them here means
 * the panels ask for what they need instead of the tree carrying it down.
 */

/** What stood in the way of an update, so the caller can offer to clear it. */
export type UpdateRefusal = {
  reason: string;
  blockedBy: FleetSession[];
};

export type CatalogOperations = {
  renameNode: (nodeId: string, name: string) => Promise<boolean>;
  deleteNode: (nodeId: string) => Promise<boolean>;
  /** Resolves to the refusal when live sessions are in the way. */
  updateNode: (
    nodeId: string,
    options?: { stopSessions?: boolean },
  ) => Promise<UpdateRefusal | undefined>;
  updateAllNodes: () => Promise<boolean>;
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
  updatePlacement: (
    placementId: string,
    changes: { localPath?: string; workspaceId?: string },
  ) => Promise<boolean>;
  deletePlacement: (placementId: string) => Promise<boolean>;
  reorderPlacements: (workspaceId: string, placementIds: string[]) => Promise<boolean>;
  reorderWorkspaces: (workspaceIds: string[]) => Promise<boolean>;
  reorderSessions: (sessionIds: string[]) => Promise<boolean>;
};

type CatalogDeps = {
  request: <T>(path: string, init?: RequestInit) => Promise<ApiResult<T>>;
  refresh: () => Promise<void>;
  notify: Notify;
};

const json = (body: unknown, method: "POST" | "PATCH"): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export function useCatalogOperations({
  request,
  refresh,
  notify,
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
      // Progress arrives over the socket as `node_update`, and the new revision
      // on the `hello` that follows the restart, so neither forces a re-read.
      updateNode: async (nodeId, options) => {
        try {
          await api(`/api/nodes/${nodeId}/update`, {
            method: "POST",
            body: JSON.stringify({ stopSessions: options?.stopSessions ?? false }),
          });
          return undefined;
        } catch (reason) {
          // A refusal that names the sessions in the way is an offer, not an
          // error: the caller asks whether to stop them. Anything else is a
          // genuine failure and gets the usual toast.
          const blockedBy =
            reason instanceof ApiError ? reason.body.blockedBy : undefined;
          if (Array.isArray(blockedBy)) {
            return {
              reason: errorMessage(reason),
              blockedBy: blockedBy as FleetSession[],
            };
          }
          notify(errorMessage(reason), "error");
          return { reason: errorMessage(reason), blockedBy: [] };
        }
      },
      updateAllNodes: async () =>
        (await request("/api/nodes/update", { method: "POST" })).ok,
      createWorkspace: (name, description) =>
        write("/api/workspaces", json({ name, description }, "POST")),
      updateWorkspace: (workspaceId, name, description) =>
        write(`/api/workspaces/${workspaceId}`, json({ name, description }, "PATCH")),
      deleteWorkspace: (workspaceId) =>
        write(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
      createPlacement: (workspaceId, nodeId, localPath) =>
        write("/api/placements", json({ workspaceId, nodeId, localPath }, "POST")),
      updatePlacement: (placementId, changes) =>
        write(`/api/placements/${placementId}`, json(changes, "PATCH")),
      reorderSessions: (sessionIds) =>
        write("/api/sessions/reorder", json({ sessionIds }, "POST")),
      reorderWorkspaces: (workspaceIds) =>
        write("/api/workspaces/reorder", json({ workspaceIds }, "POST")),
      reorderPlacements: (workspaceId, placementIds) =>
        write("/api/placements/reorder", json({ workspaceId, placementIds }, "POST")),
      deletePlacement: (placementId) =>
        write(`/api/placements/${placementId}`, { method: "DELETE" }),
    };
  }, [request, refresh, notify]);
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
