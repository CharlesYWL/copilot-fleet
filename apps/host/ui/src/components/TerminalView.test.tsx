import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
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
  runId: "",
  runRole: "",
  readOnly: false,
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

const show = (
  overrides: Partial<FleetSession> = {},
  draft: SessionDraft = EMPTY_DRAFT,
  events: SessionEvent[] = [],
) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TerminalView
        session={session(overrides)}
        events={events}
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

let sequence = 0;

const streamEvent = (
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
): SessionEvent => ({
  eventId: `e${++sequence}`,
  sessionId: "s1",
  sequence,
  type,
  payload,
  createdAt: "2026-08-08T09:15:00.000Z",
});

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

  it("sizes the box to its content instead of leaving it fixed", () => {
    // `resize="none"` means the operator cannot drag the box open, so a long
    // prompt was only ever visible two lines at a time. The height is written
    // inline from a measurement; what is checked here is that a height is set
    // at all and that it stops at the ceiling the stylesheet also names.
    show({}, { prompt: "one\ntwo\nthree\nfour\nfive", attachments: [] });
    const box = screen.getByLabelText("Follow-up prompt") as HTMLTextAreaElement;
    const height = Number.parseInt(box.style.height, 10);
    expect(Number.isNaN(height)).toBe(false);
    expect(height).toBeLessThanOrEqual(220);
  });
});

describe("TerminalView transcript", () => {
  it("draws a tool call as one line: what it did and what it ran on", () => {
    // The steps between an operator's prompt and the agent's answer outnumber
    // the answer several times over. Each used to be a bordered card with a
    // timestamp column, so a turn that touched ten files pushed its own
    // conclusion off the screen.
    show({}, EMPTY_DRAFT, [
      streamEvent("tool", {
        toolCallId: "t1",
        title: "Run node endpoint tests",
        kind: "execute",
        detail: "npx vitest run apps/node",
        status: "completed",
      }),
    ]);

    expect(screen.getByText("Run node endpoint tests")).toBeTruthy();
    expect(screen.getByText("npx vitest run apps/node")).toBeTruthy();
    // A status that means "it worked" is not news; only a failure is.
    expect(screen.queryByText("completed")).toBeNull();
  });

  it("says a failed tool failed rather than leaving it to colour alone", () => {
    show({}, EMPTY_DRAFT, [
      streamEvent("tool", {
        toolCallId: "t1",
        title: "Typecheck",
        kind: "execute",
        detail: "npm run typecheck",
        status: "failed",
      }),
    ]);

    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("folds reasoning to a preview the reader can open", async () => {
    const thought = `${"deliberating ".repeat(40)}end`;
    show({}, EMPTY_DRAFT, [streamEvent("agent_thought", { text: thought })]);

    const toggle = screen.getByRole("button", { name: /Thinking/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(thought)).toBeNull();

    toggle.click();
    expect(await screen.findByText(thought, { exact: false })).toBeTruthy();
  });

  it("keeps the agent's own words as prose, not as a step", () => {
    show({}, EMPTY_DRAFT, [
      streamEvent("system", { text: "User: fix the flake" }),
      streamEvent("agent_text", { text: "Fixed the flake in the retry helper." }),
    ]);

    expect(screen.getByText("fix the flake")).toBeTruthy();
    expect(screen.getByText("Fixed the flake in the retry helper.")).toBeTruthy();
  });

  it("folds an orchestrator wake to one line instead of a chat bubble", async () => {
    // A wake arrives down the prompt channel, so the transcript records it as
    // something the operator said. It is a whole transcript of everything that
    // settled, and as a bubble it buried the orchestrator's reply under it.
    const output = `${"the worker explained itself at length. ".repeat(30)}done`;
    const { container } = show({ runRole: "lead" }, EMPTY_DRAFT, [
      streamEvent("system", {
        text: [
          'User: <fleet-wake task="Migration UI Bugs" phase="Open PR" (1/1) wakes=2/12>',
          "Just finished:",
          "- Open PR for the fix (implement): succeeded",
          `  ${output}`,
          "</fleet-wake>",
        ].join("\n"),
      }),
    ]);

    expect(screen.queryByText(output, { exact: false })).toBeNull();
    // Not the operator's column, and not a mark on the prompt rail either.
    expect(container.querySelectorAll("[data-prompt-key]")).toHaveLength(0);

    const toggle = screen.getByRole("button", { name: /1 worker finished/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(await screen.findByText(output, { exact: false })).toBeTruthy();
  });

  it("gives every prompt a mark on the rail, and a way back to it", () => {
    // The rail replaces the scrollbar, so each prompt has to be addressable
    // from it: the marks are what a reader navigates a long session by.
    const { container } = show({}, EMPTY_DRAFT, [
      streamEvent("system", { text: "User: first ask" }),
      streamEvent("agent_text", { text: "done" }),
      streamEvent("system", { text: "User: second ask" }),
    ]);

    expect(container.querySelectorAll("[data-prompt-key]")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Jump to prompt: first ask" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Jump to prompt: second ask" }),
    ).toBeTruthy();
  });
});
