import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import {
  DriInvestigationSchema,
  DriLimitsSchema,
  RunSchema,
  type DriEvidence,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { api } from "../../hooks/useFleet";
import { useDri } from "../../hooks/useDri";
import { DriWorkbench } from "./DriWorkbench";

vi.mock("../../hooks/useFleet", () => ({ api: vi.fn() }));
vi.mock("../../hooks/useDri", () => ({ useDri: vi.fn() }));
const now = "2025-01-01T00:00:00.000Z";
const investigation = DriInvestigationSchema.parse({
  id: "dri-test",
  version: 1,
  revision: 7,
  generation: 2,
  runId: "run-test",
  leadSessionId: "",
  incident: {
    id: "42",
    url: "https://portal.microsofticm.com/imp/v5/incidents/details/42",
  },
  requestedProfile: "auto",
  profile: {
    id: "profile-test",
    profileId: "dms",
    profileVersion: "1.0.0",
    method: "auto",
    confidence: 0.98,
    evidenceIds: [],
    explanation: "Verified ICM owning service and component",
    revision: 1,
    decidedAt: now,
  },
  mode: "fixture",
  phase: "report",
  status: "stopped",
  limits: DriLimitsSchema.parse({}),
  question: "",
  hints: [],
  createdAt: now,
  updatedAt: now,
  lifecycleCause: "operator",
  limitation: "Stopped by operator",
});
const detail = {
  investigation,
  work: [],
  providers: [],
  run: RunSchema.parse({
    id: "run-test",
    workspaceId: "chats",
    name: "DRI investigation",
    objective: "Read-only evidence",
    state: "cancelled",
    createdAt: now,
    updatedAt: now,
  }),
};
const view = () => ({
  detail: undefined as typeof detail | undefined,
  page: undefined as ReturnType<typeof useDri>["page"],
  error: "",
  loading: false,
  reload: vi.fn(),
  first: vi.fn(),
  next: vi.fn(),
  atStart: true,
});
const mount = (initialId = "") =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <DriWorkbench initialId={initialId} />
    </FluentProvider>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  vi.mocked(useDri).mockReturnValue(view());
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === "/api/dri/profiles")
      return {
        availability: {
          fixtureEnabled: true,
          liveRegistration: "mcp_catalog",
          liveProvidersConfigured: false,
        },
        profiles: [
          { id: "generic", label: "Generic", version: "1.0.0" },
          { id: "dms", label: "DMS", version: "1.0.0" },
        ],
      } as never;
    return { items: [], nextCursor: null, revision: 0 } as never;
  });
});
describe("DRI workbench", () => {
  it("opens the routed investigation with its linked Run and a reloadable URL", () => {
    vi.mocked(useDri).mockReturnValue({ ...view(), detail });
    mount("dri-test");
    expect(useDri).toHaveBeenCalledWith("dri-test", "overview");
    expect(new URLSearchParams(window.location.search).get("dri")).toBe("dri-test");
    expect(screen.getByRole("link", { name: "run-test" })).toBeTruthy();
  });
  it("discovers live providers without a mode picker or configuration gate, and labels demos separately", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Create DRI Investigation" }));
    await screen.findByRole("option", { name: "DMS" });
    expect(screen.getByText(/Approved read-only MCP/)).toBeTruthy();
    expect(screen.queryByLabelText("Provider mode")).toBeNull();
    expect(screen.getByRole("button", { name: "Synthetic DRI demo" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start investigation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it("provides accessible creation, validates ICM and sends optional inputs without authority in prompts", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Create DRI Investigation" }));
    await screen.findByRole("option", { name: "DMS" });
    fireEvent.change(screen.getByLabelText("ICM URL or ID (required)"), {
      target: { value: "https://evil.invalid/42" },
    });
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("valid ICM"),
    );
    fireEvent.change(screen.getByLabelText("ICM URL or ID (required)"), {
      target: { value: "42" },
    });
    vi.mocked(api).mockResolvedValueOnce(investigation);
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/dri",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"icm":"42"'),
        }),
      ),
    );
    const body = vi
      .mocked(api)
      .mock.calls.find(
        ([url, options]) => url === "/api/dri" && options?.method === "POST",
      )?.[1]?.body;
    expect(JSON.parse(String(body))).toMatchObject({ mode: "live", icm: "42" });
  });
  it("uses fixtures only after a clearly labeled synthetic demo action", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic DRI demo" }));
    expect(screen.getByRole("status").textContent).toContain("Synthetic demo only");
    fireEvent.change(screen.getByLabelText("ICM URL or ID (required)"), {
      target: { value: "42" },
    });
    vi.mocked(api).mockResolvedValueOnce(investigation);
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/dri",
        expect.objectContaining({ body: expect.stringContaining('"mode":"fixture"') }),
      ),
    );
  });
  it("shows profile confidence, provider limitations, Run link, sections and version-qualified Resume", async () => {
    const current = { ...view(), detail };
    vi.mocked(useDri).mockReturnValue(current);
    mount();
    expect(screen.getByText(/98%/).textContent).toContain("Verified ICM");
    expect(screen.getByRole("link", { name: "run-test" })).toBeTruthy();
    expect(screen.getByText(/No providers configured/)).toBeTruthy();
    for (const name of [
      "Overview",
      "Timeline (UTC)",
      "Evidence",
      "Queries",
      "Hypotheses",
      "Similar incidents",
      "Changes / deployments",
      "Report",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Resume unfinished work" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/dri/dri-test/resume",
        expect.objectContaining({
          method: "POST",
          headers: { "if-match": '"7"' },
        }),
      ),
    );
    expect(current.reload).toHaveBeenCalled();
  });
  it("loads citation detail on demand and focuses its heading without rendering raw artifacts", async () => {
    const evidence: DriEvidence = {
      id: "evidence-12345678",
      investigationId: "dri-test",
      profileId: "dms",
      generation: 2,
      attempt: 1,
      invocationId: "query-test",
      createdAt: now,
      kind: "evidence",
      type: "har",
      providerId: "local.har",
      source: "har.analyze.v1",
      reference: "evidence:test",
      observedAt: now,
      identifiers: [],
      finding: "HTTP 503 at request 2",
      hypothesisIds: [],
      confidence: 0.8,
      completeness: "complete",
      limitation: "",
      producerAgentId: "agent-test",
      sensitivity: "redacted",
      redactionVersion: "dri-redaction-v1",
      provenance: { sourceVersion: "1", collectedAt: now, contentHash: "a".repeat(64) },
      dedupeKey: "test",
      signals: [],
    };
    window.history.replaceState(null, "", "/?dri=dri-test");
    vi.mocked(useDri).mockReturnValue({
      ...view(),
      detail,
      page: { items: [evidence], nextCursor: null, revision: 7 },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    vi.mocked(api).mockResolvedValueOnce(evidence);
    fireEvent.click(screen.getByRole("button", { name: "Evidence 12345678" }));
    const heading = await screen.findByRole("heading", { name: "Evidence 12345678" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByText(/Authorization|Bearer|cookie=/)).toBeNull();
  });
  it("exposes loading, retry and empty states", async () => {
    vi.mocked(useDri).mockReturnValue({
      ...view(),
      loading: true,
      error: "Page revision changed; restart pagination",
    });
    window.history.replaceState(null, "", "/?dri=dri-test");
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading investigation");
    expect(screen.getByRole("alert").textContent).toContain("revision");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(vi.mocked(useDri).mock.results[0]!.value.reload).toHaveBeenCalled();
  });
});
