import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCatalogOperations } from "./useCatalog";
import type { ApiResult } from "./useFleet";

type Call = [string, RequestInit | undefined];

function operations(ok = true) {
  const calls: Call[] = [];
  const request = async <T,>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
    calls.push([path, init]);
    return ok ? { ok: true, data: undefined as T } : { ok: false, error: "nope" };
  };
  const refresh = vi.fn(async () => {});
  const { result } = renderHook(() => useCatalogOperations({ request, refresh }));
  return { catalog: result.current, calls, refresh };
}

describe("useCatalogOperations", () => {
  it("creates a workspace and re-reads the fleet", async () => {
    const { catalog, calls, refresh } = operations();
    await expect(catalog.createWorkspace("fleet", "the repo")).resolves.toBe(true);
    expect(calls[0]?.[0]).toBe("/api/workspaces");
    expect(calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      name: "fleet",
      description: "the repo",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not re-read after a failed write", async () => {
    const { catalog, refresh } = operations(false);
    await expect(catalog.deletePlacement("pl-1")).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renames a node without a re-read, since the change is broadcast", async () => {
    const { catalog, calls, refresh } = operations();
    await catalog.renameNode("node-1", "laptop");
    expect(calls[0]?.[0]).toBe("/api/nodes/node-1");
    expect(calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends a placement update to the placement, not the workspace", async () => {
    const { catalog, calls } = operations();
    await catalog.updatePlacement("pl-1", "/srv/fleet");
    expect(calls[0]?.[0]).toBe("/api/placements/pl-1");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ localPath: "/srv/fleet" });
  });
});
