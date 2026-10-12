import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { CONTEXT_TIER_CONFIG_ID, SessionSchema } from "@fleet/protocol";
import { fleetDarkTheme } from "../../../host/ui/src/theme";
import { App } from "./App";
import { connectSession, type SessionView } from "./session-connection";

vi.mock("./session-connection", () => ({ connectSession: vi.fn() }));
vi.mock("../../../host/ui/src/components/SessionMessageQueue", () => ({
  SessionMessageQueue: () => null,
}));

let publish: (view: SessionView) => void;
let notify: (message: string) => void;
const close = vi.fn();
const session = SessionSchema.parse({
  id: "s1",
  workspaceId: "w",
  workspaceName: "Workspace",
  placementId: "p",
  nodeId: "n",
  nodeName: "Node",
  state: "idle",
  name: "Session",
  initialPrompt: "Start",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  agentSessionId: "native",
  configOptions: [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      description: "",
      currentValue: "interactive",
      choices: [
        { value: "interactive", name: "Interactive", description: "" },
        { value: "autopilot", name: "Autopilot", description: "" },
      ],
    },
  ],
});
const change = (sessionId: string, origin = location.origin) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source: window.parent,
        data: { type: "node-session", sessionId },
      }),
    );
  });
const view = (status: SessionView["status"] = "online", role = ""): SessionView => ({
  status,
  offlineAllowed: true,
  snapshot: {
    session: { ...session, runRole: role as typeof session.runRole },
    status,
    offlineAllowed: true,
    messages: [],
    permissions: [],
  },
});

beforeEach(() => {
  close.mockReset();
  vi.mocked(connectSession)
    .mockReset()
    .mockImplementation((_id, callback, notification) => {
      publish = callback;
      notify = notification;
      return { close, loadOlder: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Node shared chat entry", () => {
  const show = () =>
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <App />
      </FluentProvider>,
    );

  it("loads nothing until the shell selects a session, and tears down on leave and unmount", () => {
    const root = show();
    expect(connectSession).not.toHaveBeenCalled();
    change("foreign", "https://untrusted.example");
    expect(connectSession).not.toHaveBeenCalled();
    change("s1");
    expect(connectSession).toHaveBeenCalledWith(
      "s1",
      expect.any(Function),
      expect.any(Function),
    );
    change("");
    expect(close).toHaveBeenCalledTimes(1);
    change("s2");
    root.unmount();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("renders the Host permission banner read-only and omits mode escalation", () => {
    show();
    change("s1");
    act(() =>
      publish({
        ...view(),
        pendingPermission: {
          eventId: "e",
          sessionId: "s1",
          sequence: 1,
          type: "permission",
          createdAt: session.createdAt,
          payload: { requestId: "r", title: "Run build", options: [] },
        },
      }),
    );
    expect(screen.getByText(/Approve this request in the Fleet Host/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
  });

  it("shows asynchronous command refusals as dismissible alerts without disabling the session", () => {
    show();
    change("s1");
    act(() => publish(view()));
    act(() => notify("The agent refused this prompt."));
    expect(screen.getByRole("alert").textContent).toContain(
      "The agent refused this prompt.",
    );
    expect(
      screen.getByRole("textbox", { name: "Follow-up prompt" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not erase a streamed refusal when the accepted HTTP response arrives later", async () => {
    let finish!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ok: true, status: 200, json: async () => ({}) });
          }),
      ),
    );
    show();
    change("s1");
    act(() => publish(view()));
    const prompt = screen.getByRole("textbox", {
      name: "Follow-up prompt",
    }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Continue" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    act(() => notify("The agent refused the accepted command."));
    await act(async () => finish());
    await waitFor(() => expect(prompt.value).toBe(""));
    expect(screen.getByRole("alert").textContent).toContain(
      "The agent refused the accepted command.",
    );
  });

  it("allows an offline eligible worker, but disables leads and syncing/conflicted sessions", () => {
    show();
    change("s1");
    act(() => publish(view("offline", "worker")));
    expect(
      screen.getByRole("textbox", { name: "Follow-up prompt" }).hasAttribute("disabled"),
    ).toBe(false);
    act(() => publish(view("offline", "lead")));
    expect(
      screen.getByRole("textbox", { name: "Follow-up prompt" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Stop session" }).hasAttribute("disabled"),
    ).toBe(true);
    act(() => publish(view("conflict", "worker")));
    expect(
      screen.getByRole("textbox", { name: "Follow-up prompt" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("retains unsent drafts while the shell leaves and reopens a session", () => {
    show();
    change("s1");
    act(() => publish(view()));
    fireEvent.change(screen.getByRole("textbox", { name: "Follow-up prompt" }), {
      target: { value: "Keep this draft" },
    });
    change("");
    change("s1");
    act(() => publish(view()));
    expect(
      (screen.getByRole("textbox", { name: "Follow-up prompt" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep this draft");
  });

  it("sends the protocol's fleet_context_tier ID through the shared context picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    );
    show();
    change("s1");
    const next = view();
    next.snapshot!.session = {
      ...session,
      configOptions: [
        {
          id: CONTEXT_TIER_CONFIG_ID,
          name: "Context window",
          description: "",
          category: "context",
          currentValue: "long_context",
          choices: [
            { value: "long_context", name: "Long", description: "" },
            { value: "default", name: "Default", description: "" },
          ],
        },
      ],
    };
    act(() => publish(next));
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Context window: Long" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [path, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(path).toBe("/api/fleet-sessions/s1/config");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      configId: "fleet_context_tier",
      value: "default",
      operationId: expect.any(String),
    });
  });
});
