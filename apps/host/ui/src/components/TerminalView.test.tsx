import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession } from "@fleet/protocol";
import { TerminalView } from "./TerminalView";
import { EMPTY_DRAFT, type SessionDraft } from "../lib/session-drafts";
import { fleetDarkTheme } from "../theme";

const session = (values: Partial<FleetSession> = {}): FleetSession => ({
  id: "s1",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "node",
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
  configOptions: [
    {
      id: "model",
      name: "Model",
      description: "",
      category: "model",
      currentValue: "opus",
      choices: [
        { value: "opus", name: "Claude Opus 5", description: "" },
        { value: "haiku", name: "Claude Haiku 4.5", description: "" },
      ],
    },
  ],
  ...values,
});

const show = (overrides: Partial<FleetSession> = {}, draft: SessionDraft = EMPTY_DRAFT) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TerminalView
        session={session(overrides)}
        events={[]}
        onPrompt={vi.fn()}
        onCancel={vi.fn()}
        onStop={vi.fn()}
        onPermission={vi.fn()}
        onConfigChange={vi.fn()}
        draft={draft}
        onDraftChange={vi.fn()}
      />
    </FluentProvider>,
  );

describe("TerminalView composer", () => {
  it("keeps the pickers inside the composer, under the text box", () => {
    // They used to sit in a band above it; the point of the move is that the
    // composer is one object, so a picker outside the form is the regression.
    const { container } = show();
    const form = container.querySelector("form");
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(form?.contains(trigger)).toBe(true);
    expect(form?.contains(screen.getByLabelText("Follow-up prompt"))).toBe(true);
  });

  it("tells the operator about slash commands from the box itself", () => {
    // The standalone hint line below the composer is gone, so the placeholder
    // is the only thing left that can say it.
    show();
    const box = screen.getByLabelText("Follow-up prompt");
    expect(box.getAttribute("placeholder")).toContain("/");
  });

  it("keeps a reachable send control after losing its label", () => {
    show();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("still offers the pickers on a session that cannot be prompted", () => {
    // Switching model is a setting, not a turn, so an agent mid-run is exactly
    // when an operator reaches for it.
    show({ state: "running" });
    expect(screen.getByRole("button", { name: "Model" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows the draft it was handed rather than an empty box", () => {
    // The composer no longer owns the text. Switching sessions unmounts this
    // view, so anything it kept to itself was gone the moment an operator
    // looked at another session — which is what made a half-written prompt
    // disappear on a click.
    show({}, { prompt: "half-written thought", attachments: [] });
    const box = screen.getByLabelText("Follow-up prompt") as HTMLTextAreaElement;
    expect(box.value).toBe("half-written thought");
  });
});
