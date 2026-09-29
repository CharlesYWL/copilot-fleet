import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerResumeRequestSchema, type WorkerResumeRequest } from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { forgetCsrfToken } from "../../lib/auth";
import { WorkerResumePrompts } from "./WorkerResumePrompts";

const at = "2026-09-28T20:40:00.000Z";
const id = "30000000-0000-4000-8000-000000000001";

function resumeRequest(patch: Partial<WorkerResumeRequest> = {}): WorkerResumeRequest {
  return WorkerResumeRequestSchema.parse({
    id,
    version: 1,
    state: "awaiting_approval",
    runId: "8b9ae591-1056-4878-990f-fe5677b58b1f",
    taskName: "S03 - Miles action-log comparison prototype",
    stepId: "step-1",
    stepKey: "step-1",
    stepTitle: "Build isolated S03 action-log alternative",
    stepAttempt: 6,
    sessionId: "c2ed2f55-8aad-476e-bed8-457ac8739eb7",
    sessionName: "Build isolated S03 action-log alternative",
    agentSessionId: "copilot-worker-1",
    nodeId: "n1",
    nodeName: "CharlesDevBox4",
    placementId: "p1",
    localPath: "Q:\\Repos\\TridentWarehouse-UX",
    checkoutKey: "p1",
    queuedPrompt: "Revise the SAME S03 amendment PR for the closed-slice review.",
    promptDigest: "d".repeat(64),
    restriction: "node_headroom",
    restrictionDetail:
      "CharlesDevBox4 is at Fleet's scheduling limit for writing work: 1 of 2 slots are held.",
    risk: "Approving spends that reserved slot once: CharlesDevBox4 will run 2 of 2 writing sessions, its hard limit.",
    capacity: { kind: "writing", reserved: 1, limit: 2 },
    activeSessions: [
      {
        sessionId: "other-session",
        name: "Unrelated work",
        state: "running",
        runId: "",
        taskName: "",
        role: "",
        localPath: "Q:\\Repos\\SchemaTools",
        readOnly: false,
      },
    ],
    fingerprint: "f".repeat(64),
    reason: "The person asked for the S03 revision today.",
    requestedBy: { kind: "orchestrator", id: "lead-1" },
    requestedAt: at,
    expiresAt: "2099-01-01T00:00:00.000Z",
    updatedAt: at,
    ...patch,
  });
}

const wrap = (requests: WorkerResumeRequest[], focusRequestId?: string) => (
  <FluentProvider theme={fleetDarkTheme}>
    <WorkerResumePrompts requests={requests} connected focusRequestId={focusRequestId} />
  </FluentProvider>
);

let answer: { status: number; body: unknown };

beforeEach(() => {
  forgetCsrfToken();
  answer = {
    status: 200,
    body: { request: resumeRequest({ state: "launching", version: 2 }) },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url) === "/api/auth/csrf" ? { csrfToken: "proof" } : answer.body,
          ),
          {
            status: String(url) === "/api/auth/csrf" ? 200 : answer.status,
            headers: { "content-type": "application/json" },
          },
        ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetCsrfToken();
});

const decisionCall = () =>
  vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).includes("/api/worker-resume-requests/"));

describe("one-time resume exception approval", () => {
  it("shows what the approval binds to before anything launches", () => {
    render(wrap([resumeRequest()]));

    const dialog = screen.getByRole("dialog", {
      name: "Approve a one-time resume exception?",
    });
    expect(dialog.textContent).toContain("S03 - Miles action-log comparison prototype");
    expect(dialog.textContent).toContain("c2ed2f55-8aad-476e-bed8-457ac8739eb7");
    expect(dialog.textContent).toContain("CharlesDevBox4");
    expect(dialog.textContent).toContain("Q:\\Repos\\TridentWarehouse-UX");
    expect(screen.getByLabelText("Queued follow-up").textContent).toBe(
      "Revise the SAME S03 amendment PR for the closed-slice review.",
    );
    expect(screen.getByLabelText("Active sessions on this Node").textContent).toContain(
      "Unrelated work (running)",
    );
    expect(dialog.textContent).toContain("scheduling limit");
    expect(dialog.textContent).toContain("hard limit");
    expect(dialog.textContent).toContain("Orchestrator lead-1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["Approve once", "approve_once"],
    ["Cancel request", "cancel"],
  ])(
    "sends %s with the version and fingerprint it displayed",
    async (label, decision) => {
      render(wrap([resumeRequest()]));

      fireEvent.click(screen.getByRole("button", { name: label }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const [url, init] = decisionCall()!;
      expect(String(url)).toBe(`/api/worker-resume-requests/${id}/decision`);
      expect(JSON.parse(String(init?.body))).toEqual({
        decision,
        expectedVersion: 1,
        fingerprint: "f".repeat(64),
      });
    },
  );

  it("does not decide on Review later, and reopens when asked for by name", () => {
    const view = render(wrap([resumeRequest()]));

    fireEvent.click(screen.getByRole("button", { name: "Review later" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(wrap([resumeRequest()], id));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reports a stale decision instead of pretending it launched", async () => {
    answer = {
      status: 409,
      body: {
        error:
          "The sessions holding the Node's slots, the checkout or the worker changed since the request. Nothing was launched.",
        code: "stale",
        request: resumeRequest({ state: "stale", version: 2 }),
      },
    };
    render(wrap([resumeRequest()]));

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Nothing was launched");
  });
});
