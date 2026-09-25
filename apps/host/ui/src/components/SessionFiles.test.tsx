import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { NotificationContext } from "../hooks/useAppNotifications";
import { downloadSessionFile } from "../lib/session-files";
import type * as SessionFilesModule from "../lib/session-files";
import { fleetDarkTheme } from "../theme";
import { MarkdownBody } from "./MarkdownBody";
import { SessionFilesProvider } from "./SessionFiles";
import { TerminalView } from "./TerminalView";

vi.mock("../lib/session-files", async (original) => ({
  ...(await original<typeof SessionFilesModule>()),
  downloadSessionFile: vi.fn(),
}));

const notify = vi.fn();

beforeEach(() => {
  vi.mocked(downloadSessionFile).mockReset();
  vi.mocked(downloadSessionFile).mockResolvedValue({
    path: "C:\\work\\report.docx",
    name: "report.docx",
    size: 1,
    modifiedAt: "2026-09-01T00:00:00.000Z",
  });
  notify.mockReset();
});

const markdown = (text: string, inSession = true) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        {inSession ? (
          <SessionFilesProvider sessionId="s1" nodeName="build-box">
            <MarkdownBody text={text} />
          </SessionFilesProvider>
        ) : (
          <MarkdownBody text={text} />
        )}
      </NotificationContext.Provider>
    </FluentProvider>,
  );

describe("file links in a transcript", () => {
  it("downloads a linked file from the session's machine instead of navigating", async () => {
    markdown("Wrote [the report](C:\\work\\report.docx).");
    const link = screen.getByRole("link", { name: "the report" });
    expect(link.getAttribute("href")).toBe(
      "/api/sessions/s1/files/download?path=C%3A%5Cwork%5Creport.docx",
    );
    expect(link.getAttribute("title")).toBe(
      "Download C:\\work\\report.docx from build-box",
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(downloadSessionFile).toHaveBeenCalledWith("s1", "C:\\work\\report.docx");
  });

  it.each([
    ["[deck](<C:\\My Files\\deck.pptx>)", "deck", "C:\\My Files\\deck.pptx"],
    ["[notes](docs/notes.md#intro)", "notes", "docs/notes.md"],
    ["[pdf](file:///home/me/out/summary.pdf)", "pdf", "/home/me/out/summary.pdf"],
  ])("resolves %s", (text, name, path) => {
    markdown(text);
    fireEvent.click(screen.getByRole("link", { name }));
    expect(downloadSessionFile).toHaveBeenCalledWith("s1", path);
  });

  it("makes an absolute path in inline code a download, but not one in a code block", () => {
    markdown(
      "Saved to `C:\\work\\out\\summary.pdf`.\n\n```\nC:\\work\\out\\summary.pdf\n```",
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]!.querySelector("code")?.textContent).toBe(
      "C:\\work\\out\\summary.pdf",
    );
    fireEvent.click(links[0]!);
    expect(downloadSessionFile).toHaveBeenCalledWith("s1", "C:\\work\\out\\summary.pdf");
  });

  it("does not nest a link inside a link whose text is a path", () => {
    markdown("[`C:\\work\\a.docx`](C:\\work\\a.docx)");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("leaves web links and unsafe links as they were", () => {
    markdown("[guide](https://example.com/guide) and [bad](javascript:alert(1))");
    const guide = screen.getByRole("link", { name: "guide" });
    expect(guide.getAttribute("href")).toBe("https://example.com/guide");
    // jsdom cannot navigate; stop it trying once the page has had its say.
    const stay = (event: Event) => event.preventDefault();
    window.addEventListener("click", stay);
    try {
      fireEvent.click(guide);
    } finally {
      window.removeEventListener("click", stay);
    }
    expect(downloadSessionFile).not.toHaveBeenCalled();
    expect(screen.getByText("bad").getAttribute("href") ?? "").not.toContain(
      "javascript",
    );
  });

  it("renders paths exactly as before where there is no session to resolve them", () => {
    markdown("[the report](C:\\work\\report.docx) and `C:\\work\\summary.pdf`", false);
    expect(screen.getByText("the report").getAttribute("href")).toBe("");
    expect(screen.getByText("C:\\work\\summary.pdf").closest("a")).toBeNull();
  });

  it("says why a download could not start", async () => {
    vi.mocked(downloadSessionFile).mockRejectedValueOnce(
      new Error("That file does not exist on this machine."),
    );
    markdown("[the report](C:\\work\\report.docx)");
    fireEvent.click(screen.getByRole("link", { name: "the report" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Could not download report.docx: That file does not exist on this machine.",
      ),
    );
  });
});

const session: FleetSession = {
  id: "s1",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "build-box",
  state: "idle",
  name: "Session",
  initialPrompt: "prompt",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  agentSessionId: "acp-1",
  yolo: false,
  commands: [],
  runId: "",
  runRole: "",
  readOnly: false,
  configOptions: [],
};

let sequence = 0;
const tool = (payload: Record<string, unknown>): SessionEvent => ({
  eventId: `e${++sequence}`,
  sessionId: "s1",
  sequence,
  type: "tool",
  payload: { toolCallId: `t${sequence}`, ...payload },
  createdAt: "2026-08-08T09:15:00.000Z",
});

const terminal = (events: SessionEvent[]) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <TerminalView
          session={session}
          placement={{
            id: "p1",
            workspaceId: "w1",
            nodeId: "n1",
            localPath: "C:\\work",
          }}
          events={events}
          onPrompt={vi.fn()}
          onCancel={vi.fn()}
          onStop={vi.fn()}
          onPermission={vi.fn()}
          draft={{ prompt: "", attachments: [] }}
          onDraftChange={vi.fn()}
        />
      </NotificationContext.Provider>
    </FluentProvider>,
  );

describe("downloads from a session view", () => {
  it("offers the file a finished edit wrote, and nothing for other steps", () => {
    terminal([
      tool({
        title: "Create report",
        kind: "edit",
        status: "completed",
        detail: "C:\\work\\report.md",
      }),
      tool({
        title: "Edit draft",
        kind: "edit",
        status: "in_progress",
        detail: "C:\\work\\draft.md",
      }),
      tool({
        title: "View notes",
        kind: "read",
        status: "completed",
        detail: "C:\\work\\notes.md",
      }),
    ]);
    const buttons = screen.getAllByRole("button", { name: /^Download .+\.md$/ });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Download report.md",
    ]);
    fireEvent.click(buttons[0]!);
    expect(downloadSessionFile).toHaveBeenCalledWith("s1", "C:\\work\\report.md");
  });

  it("downloads any path from the header, and keeps the dialog open to explain a refusal", async () => {
    terminal([]);
    fireEvent.click(screen.getByRole("button", { name: "Download a file" }));
    const input = await screen.findByRole("textbox", { name: /File on build-box/ });
    expect(screen.getByText(/relative to C:\\work/)).toBeTruthy();

    vi.mocked(downloadSessionFile).mockRejectedValueOnce(
      new Error("That file is outside the folders this session works in."),
    );
    fireEvent.change(input, { target: { value: "  ..\\secret.txt  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(downloadSessionFile).toHaveBeenLastCalledWith("s1", "..\\secret.txt");
    expect(await screen.findByText(/outside the folders/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "docs/report.docx" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(downloadSessionFile).toHaveBeenLastCalledWith("s1", "docs/report.docx");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: /File on build-box/ })).toBeNull(),
    );
  });
});
