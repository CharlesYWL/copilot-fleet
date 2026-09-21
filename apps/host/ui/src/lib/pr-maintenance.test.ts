import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../hooks/useFleet";
import {
  authorizeTaskMaintenanceProposal,
  prepareTaskMaintenance,
} from "./pr-maintenance";

vi.mock("../hooks/useFleet", () => ({ api: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("maintenance operator requests", () => {
  it.each([undefined, "", "  "])(
    "prepares without inventing registration fields for %s",
    async (prUrl) => {
      await prepareTaskMaintenance("task/one", prUrl);
      expect(api).toHaveBeenCalledWith("/api/runs/task%2Fone/pr-maintenance", {
        method: "POST",
        body: JSON.stringify({ action: "prepare" }),
      });
    },
  );

  it("prepares only the optional trimmed PR URL", async () => {
    await prepareTaskMaintenance(
      "task",
      " https://github.com/example/synthetic/pull/42 ",
    );
    expect(api).toHaveBeenCalledWith("/api/runs/task/pr-maintenance", {
      method: "POST",
      body: JSON.stringify({
        action: "prepare",
        prUrl: "https://github.com/example/synthetic/pull/42",
      }),
    });
  });

  it("authorizes only the stored proposal reference, never a client registration or agent identity", async () => {
    await authorizeTaskMaintenanceProposal("task", { id: "proposal", version: 3 });
    expect(api).toHaveBeenCalledWith("/api/runs/task/pr-maintenance", {
      method: "POST",
      body: JSON.stringify({
        action: "authorize_proposal",
        proposalId: "proposal",
        expectedVersion: 3,
      }),
    });
  });
});
