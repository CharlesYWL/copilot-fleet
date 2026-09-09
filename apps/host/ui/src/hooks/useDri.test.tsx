import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriInvestigation } from "@fleet/protocol";
import { api } from "./useFleet";
import { acceptDriRevision, useDri, type DriDetail } from "./useDri";

vi.mock("./useFleet", () => ({ api: vi.fn() }));
const detail = (id: string, revision: number) => ({
  investigation: { id, revision, generation: 1 } as DriInvestigation,
  providers: [],
  work: [],
  run: {} as DriDetail["run"],
});
afterEach(() => vi.resetAllMocks());
describe("bounded DRI hydration", () => {
  it("refuses older revisions but accepts a different investigation", () => {
    const current = detail("one", 4);
    expect(acceptDriRevision(current, detail("one", 3))).toBe(current);
    expect(acceptDriRevision(current, detail("two", 1)).investigation.id).toBe("two");
  });
  it("rejects stale responses after navigation and fetches only one bounded page", async () => {
    let release!: (value: DriDetail) => void;
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/api/dri/old")
        return new Promise<DriDetail>((resolve) => {
          release = resolve;
        }) as never;
      if (url === "/api/dri/new") return detail("new", 5) as never;
      return { items: [], nextCursor: null, revision: 5 } as never;
    });
    const hook = renderHook(({ id }) => useDri(id, "evidence"), {
      initialProps: { id: "old" },
    });
    hook.rerender({ id: "new" });
    await waitFor(() => expect(hook.result.current.detail?.investigation.id).toBe("new"));
    await act(async () => {
      release(detail("old", 99));
    });
    expect(hook.result.current.detail!.investigation.id).toBe("new");
    expect(api).toHaveBeenCalledWith(
      "/api/dri/new/evidence?limit=25&cursor=0",
      expect.anything(),
    );
  });
  it("restarts pagination when the investigation revision changes between pages", async () => {
    let revision = 1;
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/api/dri/one") return detail("one", revision) as never;
      return { items: [], nextCursor: 25, revision, generation: 1 } as never;
    });
    const hook = renderHook(() => useDri("one", "timeline"));
    await waitFor(() => expect(hook.result.current.page?.revision).toBe(1));
    revision = 2;
    act(() => hook.result.current.next());
    await waitFor(() => expect(hook.result.current.page?.revision).toBe(2));
    expect(hook.result.current.atStart).toBe(true);
    expect(api).not.toHaveBeenCalledWith(
      "/api/dri/one/timeline?limit=25&cursor=25&revision=2",
      expect.anything(),
    );
    expect(api).toHaveBeenCalledWith(
      "/api/dri/one/timeline?limit=25&cursor=0",
      expect.anything(),
    );
  });
});
