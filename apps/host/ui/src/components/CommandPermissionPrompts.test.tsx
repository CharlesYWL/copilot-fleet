import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandExecutionSchema, type CommandExecution } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { CommandPermissionPrompts } from "./CommandPermissionPrompts";

const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-09-17T12:00:00.000Z";
const target = {
  key: "machine:vol:file",
  path: "Q:\\app",
  machineId: "machine",
  volume: "vol",
  fileId: "file",
};
function request(patch: Partial<CommandExecution> = {}): CommandExecution {
  const input = {
    target: { placementId: "p1" },
    command: "git status --short",
    shell: "windows-powershell-5.1",
    reason: "Check workspace changes",
    timeoutMs: 30000,
    requestKey: "example",
    hostId: "h1",
    nodeId: "n1",
    leadSessionId: "lead-1",
    requestedPath: "Q:\\app",
    createdAt: at,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  return CommandExecutionSchema.parse({
    ...input,
    id,
    attemptId: "20000000-0000-4000-8000-000000000001",
    version: 2,
    requestDigest: "a".repeat(64),
    nodeName: "Build machine",
    updatedAt: at,
    state: "awaiting_approval",
    ownership: "not_started",
    descriptor: {
      ...input,
      executionId: id,
      attemptId: "20000000-0000-4000-8000-000000000001",
      hostTime: at,
      digest: "b".repeat(64),
      prepared: {
        cwd: "Q:\\app",
        checkout: target,
        repository: target,
        shellPath: "C:\\Windows\\powershell.exe",
        admissionVersion: 1,
        preparedAt: at,
        clockUncertaintyMs: 5000,
        hostClockOffsetMs: 0,
        permission: {
          reusable: true,
          commandKey: "git status",
          path: "Q:\\app",
          explanation: "Ordinary flags ignored",
          policyVersion: 1,
        },
      },
    },
    ...patch,
  });
}
const wrap = (executions: CommandExecution[], blocked = false) => (
  <FluentProvider theme={fleetDarkTheme}>
    <CommandPermissionPrompts executions={executions} connected blocked={blocked} />
  </FluentProvider>
);
beforeEach(() => {
  forgetCsrfToken();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url) === "/api/auth/csrf"
              ? { csrfToken: "proof" }
              : { execution: request({ state: "queued", version: 3 }) },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetCsrfToken();
});

describe("Host-triggered command approval", () => {
  it("opens from a pending live or restored request without visiting Node settings", () => {
    const view = render(wrap([]));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(wrap([request()]));
    expect(screen.getByRole("dialog", { name: "Allow command execution?" })).toBeTruthy();
    expect(screen.getByLabelText("Command awaiting approval").textContent).toBe(
      "git status --short",
    );
    expect(screen.getByText("Build machine")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["Allow once", "allow_once"],
    ["Allow during session", "allow_session"],
    ["Always allow on this Node", "allow_always"],
    ["Deny", "deny"],
  ])(
    "sends the exact %s decision through the operator endpoint",
    async (label, decision) => {
      render(wrap([request()]));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).endsWith("/decision"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        decision,
        expectedVersion: 2,
        digest: "b".repeat(64),
      });
      expect(new Headers(call?.[1]?.headers).get("x-csrf-token")).toBe("proof");
    },
  );
  it("keeps executable fingerprints available without obscuring the readable command", () => {
    const execution = request();
    const commandKey = `git status @sha256:${"a".repeat(64)}`;
    execution.descriptor!.prepared.permission!.commandKey = commandKey;
    render(wrap([execution]));
    expect(screen.getByText("git status").getAttribute("title")).toBe(commandKey);
    expect(screen.getByRole("dialog").textContent).not.toContain("@sha256:");
    expect(
      screen.getByText(/replacing the executable requires fresh approval/),
    ).toBeTruthy();
    expect(screen.getByText("Approve before")).toBeTruthy();
  });
  it("asks for approval before a bound helper deadline rather than the longer window", () => {
    const execution = request();
    const deadlineAt = "2098-12-31T23:00:00.000Z";
    execution.descriptor!.observationBudget = { deadlineAt, requests: 39 };
    render(wrap([execution]));
    expect(screen.getByText(new Date(deadlineAt).toLocaleString())).toBeTruthy();
    expect(screen.queryByText(new Date(execution.expiresAt).toLocaleString())).toBeNull();
  });
  it.each(["failed", "awaiting_approval"] as const)(
    "refreshes a conflicting popup to %s without retrying approval",
    async (state) => {
      vi.mocked(fetch).mockImplementation(async (url) => {
        const path = String(url);
        if (path === "/api/auth/csrf")
          return new Response(JSON.stringify({ csrfToken: "proof" }));
        if (path.endsWith("/decision"))
          return new Response(
            JSON.stringify({ code: "approval_conflict", error: "Conflict" }),
            { status: 409 },
          );
        return new Response(
          JSON.stringify({ execution: request({ state, version: 8 }) }),
        );
      });
      render(wrap([request()]));
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      if (state === "failed") {
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else {
        expect(await screen.findByText(/Review its refreshed details/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
        await waitFor(() => {
          const decisions = vi
            .mocked(fetch)
            .mock.calls.filter(([url]) => String(url).endsWith("/decision"));
          expect(decisions).toHaveLength(2);
          expect(JSON.parse(String(decisions[1]![1]?.body)).expectedVersion).toBe(8);
        });
      }
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/decision")),
      ).toHaveLength(state === "failed" ? 1 : 2);
    },
  );
  it("defers behind another dialog and does not repeatedly reopen a dismissed request", () => {
    const view = render(wrap([request()], true));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(wrap([request()]));
    fireEvent.click(screen.getByRole("button", { name: "Review later" }));
    view.rerender(wrap([request({ version: 3 })]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps different pending requests queued instead of overwriting the current one", () => {
    const other = request({
      id: "10000000-0000-4000-8000-000000000002",
      command: "npm run build",
    });
    render(wrap([request(), other]));
    expect(screen.getByText("2 requests waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review later" }));
    expect(screen.getByLabelText("Command awaiting approval").textContent).toBe(
      "npm run build",
    );
  });
  it("does not replace the command being reviewed when an older pending snapshot arrives", () => {
    const current = request();
    const view = render(wrap([current]));
    const older = request({
      id: "10000000-0000-4000-8000-000000000003",
      command: "npm run deploy",
      createdAt: "2026-09-16T12:00:00.000Z",
    });
    view.rerender(wrap([older, current]));
    expect(screen.getByLabelText("Command awaiting approval").textContent).toBe(
      current.command,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review later" }));
    expect(screen.getByLabelText("Command awaiting approval").textContent).toBe(
      "npm run deploy",
    );
  });
  it("keeps legacy Node requests Once-only when no reusable identity was supplied", () => {
    const execution = request();
    execution.descriptor!.prepared.permission = {
      reusable: false,
      path: "Q:\\app",
      policyVersion: 1,
      explanation: "This older Node supplied no reusable identity.",
    };
    render(wrap([execution]));
    expect(
      screen
        .getByRole("button", { name: "Allow during session" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Always allow on this Node" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Allow once" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  it("offers Session and Always for an exact script without promising flag or executable reuse", () => {
    const execution = request();
    execution.command = "cd C:\\Windows; Write-Output (Get-Location).Path";
    execution.descriptor!.prepared.permission!.commandKey = `exact-script:sha256:${"a".repeat(64)}`;
    render(wrap([execution]));
    expect(screen.getByText("Exact script")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Allow during session" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Always allow on this Node" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByText(/changing any text, including flags, asks again/),
    ).toBeTruthy();
    expect(screen.queryByText(/Recognized ordinary flags can change/)).toBeNull();
    expect(
      screen.queryByText(/replacing the executable requires fresh approval/),
    ).toBeNull();
    expect(
      screen.getByText(/Ordinary workspace commands can run alongside sessions/),
    ).toBeTruthy();
  });
  it("never displays already authorized automatic executions as permission prompts", () => {
    render(wrap([request({ state: "queued", automaticApproval: true })]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("surfaces a stale approval and does not discard the request as if approved", async () => {
    vi.mocked(fetch).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/csrf")
              ? { csrfToken: "proof" }
              : { error: "Permission changed; refresh request" },
          ),
          { status: String(url).endsWith("/csrf") ? 200 : 409 },
        ),
    );
    render(wrap([request()]));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Permission changed; refresh request",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {});
  });
});
