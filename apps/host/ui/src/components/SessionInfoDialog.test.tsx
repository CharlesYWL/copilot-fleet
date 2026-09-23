import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import {
  NodeSchema,
  SessionSchema,
  ExecutionBindingSchema,
  type FleetSession,
  type Placement,
} from "@fleet/protocol";
import { SessionInfoDialog } from "./SessionInfoDialog";
import { SessionFocusDialog } from "./SessionFocusDialog";
import { EMPTY_DRAFT } from "../lib/session-drafts";
import { fleetDarkTheme } from "../theme";

const session = SessionSchema.parse({
  id: "fleet-id",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "devbox",
  state: "stopped",
  name: "Fix retries",
  initialPrompt: "Fix it",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  agentSessionId: "native-id",
});
const node = NodeSchema.parse({
  id: "n1",
  name: "devbox",
  os: "win32",
  arch: "x64",
  version: "0.5.0",
  capabilities: ["real"],
  maxSessions: 3,
  activeSessions: 0,
  lastHeartbeat: session.updatedAt,
  online: true,
});
const placement: Placement = {
  id: "p1",
  workspaceId: "w1",
  nodeId: "n1",
  localPath: "Q:\\Repos\\service",
};

const show = (overrides: Partial<FleetSession> = {}) => {
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SessionInfoDialog
        session={{ ...session, ...overrides }}
        node={node}
        placement={placement}
      />
    </FluentProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Session information" }));
};

describe("SessionInfoDialog", () => {
  it("shows and copies the managed execution directory rather than its source", async () => {
    const cwd = "Q:\\managed\\task checkout";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    show({
      executionBinding: ExecutionBindingSchema.parse({
        worktreeId: "task-worktree",
        generation: 1,
        sourcePlacementId: placement.id,
        cwd,
        checkoutKey: "task-checkout",
        leaseAttempt: "attempt",
      }),
    });
    await screen.findByRole("dialog", { name: "Session information" });
    expect(screen.getByText(cwd, { exact: true })).toBeTruthy();
    expect(screen.queryByText(placement.localPath, { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy working directory" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cwd));
    fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`'${cwd}'`)),
    );
  });

  it("shows both IDs and copies a native resume command without launching anything", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    show();
    expect(
      await screen.findByRole("dialog", { name: "Session information" }),
    ).toBeTruthy();
    expect(screen.getByText("devbox (online)")).toBeTruthy();
    expect(screen.getByText("win32 / x64")).toBeTruthy();
    expect(screen.getByText(placement.localPath, { exact: true })).toBeTruthy();
    expect(screen.getByText("native-id", { exact: true })).toBeTruthy();
    expect(screen.getByText("fleet-id", { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("copilot --resume='native-id'");
    expect(writeText.mock.calls[0]?.[0]).not.toContain("fleet-id");
    expect(screen.getByText(/same OS user/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Session information" })).toBeNull(),
    );
  });

  it("warns about active processes and distinguishes managed orchestration from local recovery", async () => {
    show({ state: "idle", runRole: "lead" });
    await screen.findByRole("dialog", { name: "Session information" });
    expect(screen.getByText("This session may still be running.")).toBeTruthy();
    expect(screen.getByText(/restore orchestration tools/)).toBeTruthy();
    expect(screen.getByText("Orchestrator")).toBeTruthy();
  });

  it("explains why local resume is unavailable before a native ID is known", async () => {
    show({ agentSessionId: "" });
    await screen.findByRole("dialog", { name: "Session information" });
    expect(screen.queryByRole("button", { name: "Copy resume command" })).toBeNull();
    expect(screen.getByText(/has not reported a native session ID/)).toBeTruthy();
  });

  it("receives node and placement context in the focused chat view", async () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionFocusDialog
          session={session}
          node={node}
          placement={placement}
          events={[]}
          open
          onOpenChange={vi.fn()}
          onPrompt={vi.fn()}
          onCancel={vi.fn()}
          onStop={vi.fn()}
          onDismiss={vi.fn()}
          onResume={vi.fn()}
          onRename={vi.fn()}
          onPermission={vi.fn()}
          onConfigChange={vi.fn()}
          draft={EMPTY_DRAFT}
          onDraftChange={vi.fn()}
        />
      </FluentProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Session information" }));
    await screen.findByRole("dialog", { name: "Session information" });
    expect(screen.getByText(placement.localPath, { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy resume command" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Chat transcript" })).toBeTruthy(),
    );
  });
});
