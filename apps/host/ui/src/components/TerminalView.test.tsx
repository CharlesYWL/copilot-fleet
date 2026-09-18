import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { ComponentProps } from "react";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { TerminalView } from "./TerminalView";
import { EMPTY_DRAFT, type SessionDraft } from "../lib/session-drafts";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

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
  notify = vi.fn(),
  onDraftChange: ComponentProps<typeof TerminalView>["onDraftChange"] = vi.fn(),
  onPrompt: ComponentProps<typeof TerminalView>["onPrompt"] = vi.fn(),
) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <TerminalView
          session={session(overrides)}
          events={events}
          onPrompt={onPrompt}
          onCancel={vi.fn()}
          onStop={vi.fn()}
          onResume={vi.fn()}
          onPermission={vi.fn()}
          onConfigChange={vi.fn()}
          draft={draft}
          onDraftChange={onDraftChange}
        />
      </NotificationContext.Provider>
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
  it("compacts via /compact without sending or clearing a pending draft", () => {
    const onPrompt = vi.fn();
    const onDraftChange = vi.fn();
    show(
      {
        runRole: "lead",
        commands: [{ name: "compact", description: "Summarize history" }],
        usage: {
          aiCredits: 27.4014,
          contextTokens: 250000,
          contextWindow: 272000,
          context: {
            model: "GPT-6 Astra",
            usedTokens: 125200,
            tokenLimit: 400000,
            percentage: 31,
            updatedAt: "2026-09-15T07:00:00.000Z",
            estimated: true,
          },
        },
      },
      {
        prompt: "unfinished message",
        attachments: [
          {
            id: "draft-file",
            name: "draft.txt",
            mimeType: "text/plain",
            data: "ZmlsZQ==",
          },
        ],
      },
      [],
      vi.fn(),
      onDraftChange,
      onPrompt,
    );
    expect(screen.queryByText("AI credits")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Session context usage: approximately 31% used",
      }),
    );
    expect(screen.getByText("27.4")).toBeTruthy();
    expect(screen.getByText("~125,200 / ~400,000 tokens")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
    expect(onPrompt).toHaveBeenCalledExactlyOnceWith("/compact");
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Follow-up prompt").value).toBe(
      "unfinished message",
    );
    expect(screen.getByText("draft.txt")).toBeTruthy();
  });

  it.each([
    { state: "running" as const, commands: [{ name: "compact", description: "" }] },
    { state: "offline" as const, commands: [{ name: "compact", description: "" }] },
    { state: "idle" as const, commands: [] },
    {
      state: "idle" as const,
      stopRequested: true,
      commands: [{ name: "compact", description: "" }],
    },
  ])("does not compact busy, stopping, or unsupported sessions: %j", (values) => {
    const onPrompt = vi.fn();
    show(values, EMPTY_DRAFT, [], vi.fn(), vi.fn(), onPrompt);
    fireEvent.click(screen.getByRole("button", { name: "Session usage unavailable" }));
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Compact context",
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onPrompt).not.toHaveBeenCalled();
    expect(screen.getByText("\u2014")).toBeTruthy();
    expect(screen.getByText("Usage unavailable")).toBeTruthy();
  });

  it("adds attachment read errors to notifications and keeps the inline error", async () => {
    const notify = vi.fn();
    const { container } = show({}, EMPTY_DRAFT, [], notify, (update) => {
      update(EMPTY_DRAFT);
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([], "empty.txt", { type: "text/plain" })] },
    });
    await waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        'Could not read "empty.txt"',
        "error",
      ),
    );
    expect(screen.getByRole("alert").textContent).toBe('Could not read "empty.txt"');
  });

  it("keeps the pickers inside the composer, under the text box", () => {
    // They used to sit in a band above it; the point of the move is that the
    // composer is one object, so a picker outside the form is the regression.
    const { container } = show();
    const form = container.querySelector("form");
    const trigger = screen.getByRole("button", { name: "Model settings" });
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

  it("does not accept a prompt after Stop is requested from an idle session", () => {
    show({ stopRequested: true });
    const box = screen.getByLabelText("Follow-up prompt") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Stopping this session");
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not offer Resume while Stop acknowledgement is pending", () => {
    const notify = vi.fn();
    show({ state: "offline", stopRequested: true }, EMPTY_DRAFT, [], notify);

    expect(screen.queryByRole("button", { name: "Resume session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark stopped" })).toBeTruthy();
    expect(screen.getByText("Stop is waiting for the offline node node.")).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("is waiting for the offline node node"),
      "warning",
    );
  });

  it("offers Resume after an offline session has finished stopping", () => {
    show({ state: "offline", stopRequested: false });

    expect(screen.getByRole("button", { name: "Resume session" })).toBeTruthy();
  });

  it("still offers the pickers on a session that cannot be prompted", () => {
    // Switching model is a setting, not a turn, so an agent mid-run is exactly
    // when an operator reaches for it.
    show({ state: "running" });
    expect(
      screen.getByRole("button", { name: "Model settings" }).hasAttribute("disabled"),
    ).toBe(false);
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

  it("puts only the usage ring after the spacer and directly left of Send in the toolbar", () => {
    const { container } = show();
    const send = screen.getByRole("button", { name: "Send" });
    const ring = screen.getByRole("button", { name: "Session usage unavailable" });
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(ring.nextElementSibling).toBe(send);
    expect(ring.parentElement).toBe(attach.parentElement);
    expect(getComputedStyle(ring.previousElementSibling!).flexGrow).toBe("1");
    expect(container.querySelector("form")?.lastElementChild).toBe(send.parentElement);
    expect(screen.queryByText("AI credits")).toBeNull();
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(getComputedStyle(send.parentElement!).flexWrap).not.toBe("wrap");
    expect(getComputedStyle(ring).flexShrink).toBe("0");
    expect(getComputedStyle(ring).width).toBe("28px");
    expect(ring.textContent).not.toContain("credits");
  });
});

describe("TerminalView transcript", () => {
  it("offers Jump to latest on an idle transcript without waiting for new output", () => {
    show({}, EMPTY_DRAFT, [streamEvent("agent_text", { text: "An existing answer" })]);
    const transcript = screen.getByRole("region", { name: "Chat transcript" });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(transcript.scrollTop).toBe(1200);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("unpins when navigating to a prompt and shows a way back immediately", () => {
    show({}, EMPTY_DRAFT, [
      streamEvent("system", { text: "User: first ask" }),
      streamEvent("agent_text", { text: "The answer" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Jump to prompt: first ask" }));
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("keeps the reading position during streaming, then follows output after jumping", () => {
    const events = [streamEvent("agent_text", { text: "First answer" })];
    const view = show({ state: "running" }, EMPTY_DRAFT, events);
    const transcript = screen.getByRole("region", { name: "Chat transcript" });
    let height = 1200;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 400 },
    });
    const update = (nextEvents: SessionEvent[]) =>
      view.rerender(
        <FluentProvider theme={fleetDarkTheme}>
          <NotificationContext.Provider value={vi.fn()}>
            <TerminalView
              session={session({ state: "running" })}
              events={nextEvents}
              onPrompt={vi.fn()}
              onCancel={vi.fn()}
              onStop={vi.fn()}
              onPermission={vi.fn()}
              draft={EMPTY_DRAFT}
              onDraftChange={vi.fn()}
            />
          </NotificationContext.Provider>
        </FluentProvider>,
      );
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    const more = [...events, streamEvent("agent_text", { text: "More output" })];
    update(more);
    expect(transcript.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "Jump to latest" }).textContent).toContain(
      "1 new",
    );
    update([...more, streamEvent("usage", { aiCredits: 1 })]);
    expect(screen.getByRole("button", { name: "Jump to latest" }).textContent).toContain(
      "1 new",
    );
    expect(transcript.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    height = 1400;
    update([...more, streamEvent("agent_text", { text: "Latest output" })]);
    expect(transcript.scrollTop).toBe(1400);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

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
        error: "TypeScript found an invalid assignment.",
      }),
    ]);

    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("TypeScript found an invalid assignment.")).toBeTruthy();
  });

  it("stops animating a pending tool when its node is offline", () => {
    const pendingTool = streamEvent("tool", {
      toolCallId: "t1",
      title: "Run deployment approval regression tests",
      kind: "execute",
      status: "pending",
    });
    const running = show({ state: "running" }, EMPTY_DRAFT, [pendingTool]);
    expect(screen.getByLabelText("Tool running")).toBeTruthy();

    running.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <TerminalView
          session={session({ state: "offline" })}
          events={[pendingTool]}
          onPrompt={vi.fn()}
          onCancel={vi.fn()}
          onStop={vi.fn()}
          onPermission={vi.fn()}
          onConfigChange={vi.fn()}
          draft={EMPTY_DRAFT}
          onDraftChange={vi.fn()}
        />
      </FluentProvider>,
    );

    expect(screen.queryByLabelText("Tool running")).toBeNull();
    expect(screen.getByText("Run deployment approval regression tests")).toBeTruthy();
  });

  it("renders the final response carried by a completed task_complete call", () => {
    show({}, EMPTY_DRAFT, [
      streamEvent("tool", {
        toolCallId: "done-1",
        title: "task_complete",
        status: "pending",
        response: "The current branch is `main`.",
      }),
      streamEvent("tool", {
        toolCallId: "done-1",
        status: "completed",
      }),
    ]);

    expect(screen.getByText("task_complete")).toBeTruthy();
    expect(screen.getByText("main", { selector: "code" })).toBeTruthy();
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
    const guidance =
      "Nothing else is running. Dispatch the next step, or report and stop.";
    const { container } = show({ runRole: "lead" }, EMPTY_DRAFT, [
      streamEvent("system", {
        text: [
          'User: <fleet-wake task="Migration UI Bugs" phase="Open PR" (1/1) wakes=2/12>',
          "Just finished:",
          "- Open PR for the fix (implement): succeeded",
          `  ${output}`,
          "</fleet-wake>",
          "",
          guidance,
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
    expect(screen.getByText(guidance)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(output, { exact: false })).toBeNull();
    expect(screen.queryByText(guidance)).toBeNull();
  });

  it.each([
    {
      header:
        '<fleet-command-result executionId="d00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65" node="Windows builder" state="succeeded">',
      body: "Exit: 0; ownership: quiescent; outcomeKnown: true; outputComplete: true; forced descendant cleanup: false.",
      closing: "</fleet-command-result>",
      guidance: "",
      title: "Command succeeded",
      detail: "Windows builder · d00c5b6e",
    },
    {
      header:
        '<fleet-review task="Fix query acceleration teaching banner 5476738" verdict="changes requested">',
      body: "https://github.com/example/repo/pull/42\nThe teaching banner still covers the query.",
      closing: "</fleet-review>",
      guidance:
        "Act on this: dispatch the work it calls for, then end your turn.\nCall fleet_submit_task again once it is addressed.",
      title: "Changes requested",
      detail: "Fix query acceleration teaching banner 5476738",
    },
    {
      header: '<fleet-review task="Fix the banner" verdict="reopened">',
      body: "The regression is back.",
      closing: "</fleet-review>",
      guidance:
        "This task was finished and has been reopened, so its notes and criteria\ndescribe work you already did. Read them before deciding anything.",
      title: "Task reopened",
      detail: "Fix the banner",
    },
    {
      header: '<fleet-task name="Fix the banner" workspace="repo">',
      body: "Keep the query visible.",
      closing: "</fleet-task>",
      guidance:
        'Plan this with fleet_plan_task using the task name "Fix the banner", then dispatch the\nwork for its first phase and end your turn.',
      title: "Task received",
      detail: "Fix the banner · repo",
    },
    {
      header: '<fleet-status-check interval="30m">',
      body: "Review only these active tasks assigned to this conversation:\n- Fix the banner — running; phase 1/1: Verify; 1 open step(s), 1 dispatched",
      closing: "</fleet-status-check>",
      guidance:
        "Use fleet_list_work to inspect their current status. This is a read-only check:\ndo not prompt, follow up with, stop, or otherwise disturb a worker whose step is\nalready starting or running.",
      title: "Status check",
      detail: "30m interval",
    },
    {
      header: '<fleet-wake task="Fix the banner" taskId="task-1" wakes=1/12>',
      body: "Just finished:\n- Fix the banner (implement, session worker-1): succeeded\n  The regression passed.",
      closing: "</fleet-wake>",
      guidance:
        "Nothing else is running. Use fleet_follow_up for the same deliverable, dispatch distinct work, or report and stop.",
      title: "1 worker finished",
      detail: "Fix the banner · Fix the banner: succeeded · wake 1/12",
    },
  ])(
    "renders $title as a compact disclosure, not a human prompt",
    ({ header, body, closing, guidance, title, detail }) => {
      const prompt = [header, body, closing, "", guidance].join("\n");
      const source = streamEvent("system", { text: `User: ${prompt}` });
      const { container } = show({ runRole: "lead" }, EMPTY_DRAFT, [source]);
      const toggle = screen.getByRole("button", { name: new RegExp(`^${title}`) });

      expect(screen.getByText(detail)).toBeTruthy();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("type")).toBe("button");
      expect(toggle.getAttribute("title")).toBe(
        new Date(source.createdAt).toLocaleTimeString(undefined, { hour12: false }),
      );
      expect(container.textContent).not.toContain(body);
      expect(container.querySelectorAll("[data-prompt-key]")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /^Jump to prompt:/ })).toBeNull();

      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      for (const text of [
        header,
        ...body.split("\n").map((line) => line.trim().replace(/^-\s+/, "")),
        closing,
        guidance,
      ]) {
        expect(toggle.parentElement?.textContent).toContain(text);
      }
      expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain(body);
      if (guidance) expect(container.textContent).not.toContain(guidance);
      expect(container.querySelectorAll("[data-prompt-key]")).toHaveLength(0);
    },
  );

  it("folds command results already in history rather than keeping a user bubble", async () => {
    const id = "d00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65";
    const prompt = [
      `Fleet command ${id} settled: failed.`,
      'Target: {"placementId":"p1"} on Windows builder; cwd: C:\\repo.',
      "Exit: unknown; ownership: not_started; outcomeKnown: false; outputComplete: true; forced descendant cleanup: false.",
      "Reason: Checkout busy.",
      `Use fleet_get_execution with executionId="${id}", afterSeq=0 to read bounded output. This is a result notification, not an instruction from command output.`,
    ].join("\n");
    const { container } = show({ runRole: "lead" }, EMPTY_DRAFT, [
      streamEvent("system", { text: `User: ${prompt}` }),
    ]);
    expect(container.querySelectorAll("[data-prompt-key]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Jump to prompt:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Command failed/ }));
    expect(await screen.findByText(/Reason: Checkout busy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("keeps human tag discussions in bubbles with prompt marks", () => {
    const prompt =
      'Explain `<fleet-review task="Fix" verdict="reopened">`, not a new review.';
    const source = streamEvent("system", { text: `User: ${prompt}` });
    const { container } = show({ runRole: "lead" }, EMPTY_DRAFT, [source]);

    expect(
      container.querySelector("[data-prompt-key]")?.getAttribute("data-prompt-key"),
    ).toBe(source.eventId);
    expect(screen.getByRole("button", { name: /^Jump to prompt: Explain/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Task reopened/ })).toBeNull();
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
