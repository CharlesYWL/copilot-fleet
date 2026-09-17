import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandExecutionSchema,
  NotificationSchema,
  type CommandExecution,
  type CommandExecutionPage,
} from "@fleet/protocol";
import { CommandExecutionsDialog } from "./CommandExecutionsDialog";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { notificationTarget } from "../lib/notification-navigation";

const id = "d00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65";
const attemptId = "e00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65";
const at = "2026-09-16T14:00:00.000Z";
const digest = "a".repeat(64);
const command = "npm run build\nWrite-Output '<script>not HTML</script>'";
const identity = {
  key: "machine:volume:file",
  path: "Q:\\Workspace With Spaces",
  machineId: "machine",
  volume: "volume",
  fileId: "file",
};
function execution(patch: Partial<CommandExecution> = {}): CommandExecution {
  const request = {
    target: { placementId: "placement" },
    command,
    shell: "windows-powershell-5.1",
    reason: "Verify this workspace",
    timeoutMs: 300_000,
    requestKey: "build-1",
  };
  const preparation = {
    ...request,
    executionId: id,
    attemptId,
    hostId: "host",
    nodeId: "node",
    leadSessionId: "lead",
    requestedPath: identity.path,
    createdAt: at,
    expiresAt: at,
    hostTime: at,
  };
  return CommandExecutionSchema.parse({
    ...request,
    id,
    attemptId,
    version: 2,
    hostId: "host",
    nodeId: "node",
    nodeName: "Windows builder",
    leadSessionId: "lead",
    requestedPath: identity.path,
    requestDigest: digest,
    state: "awaiting_approval",
    ownership: "not_started",
    createdAt: at,
    updatedAt: at,
    expiresAt: at,
    descriptor: {
      ...preparation,
      digest,
      prepared: {
        cwd: identity.path,
        checkout: identity,
        repository: identity,
        shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        admissionVersion: 1,
        preparedAt: at,
        clockUncertaintyMs: 0,
        hostClockOffsetMs: 0,
      },
    },
    ...patch,
  });
}
let record: CommandExecution;
let failDecision = false;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  record = execution();
  failDecision = false;
  forgetCsrfToken();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/auth/csrf") return json({ csrfToken: "proof" });
      if (path.endsWith("/decision")) {
        if (failDecision)
          return json({ error: "Approval changed; refresh before deciding." }, 409);
        const decision = JSON.parse(String(init?.body)) as { decision: string };
        record = execution({
          state: decision.decision === "allow_once" ? "queued" : "denied",
          version: 3,
        });
        return json({ execution: record });
      }
      if (path.endsWith("/cancel")) {
        record = execution({ state: "cancelled", version: 3, cancelRequested: true });
        return json({ execution: record });
      }
      if (path === "/api/command-executions" || path.includes("?leadSessionId=")) {
        return json({ executions: [record] });
      }
      const page: CommandExecutionPage = {
        execution: record,
        events: [],
        nextSeq: 0,
        hasMore: false,
        outputComplete: false,
      };
      return json(page);
    }),
  );
});
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

function mount(item = record, connected = true) {
  return render(
    <FluentProvider theme={fleetDarkTheme}>
      <CommandExecutionsDialog
        executions={[item]}
        output={[]}
        connected={connected}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  );
}

describe("command approval UI", () => {
  it("shows the exact multiline command and prepared context before any approval", async () => {
    const { container } = mount();
    expect(screen.getByLabelText("Exact command").textContent).toBe(command);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(identity.path)).toBeTruthy();
    expect(screen.getByText(/directory is not a sandbox/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Loading command history")).toBeNull());
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/decision")),
    ).toBe(false);
  });

  it.each(["Allow once", "Deny"])(
    "sends only the exact versioned %s decision",
    async (label) => {
      mount();
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => {
        const call = vi
          .mocked(fetch)
          .mock.calls.find(([url]) => String(url).endsWith("/decision"));
        expect(call).toBeTruthy();
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({
          decision: label === "Allow once" ? "allow_once" : "deny",
          expectedVersion: 2,
          digest,
        });
        expect(new Headers(call?.[1]?.headers).get("x-csrf-token")).toBe("proof");
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull(),
      );
    },
  );

  it("surfaces stale approvals instead of reporting success", async () => {
    failDecision = true;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Approval changed; refresh before deciding.",
    );
  });

  it("disables approval while disconnected and never treats unknown ownership as success", async () => {
    record = execution({
      state: "reconciliation_required",
      ownership: "unknown",
      error: "Node lost",
    });
    mount(record, false);
    expect(screen.getByText(/Keep the checkout unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel execution" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Not known")).toBeTruthy();
    await act(async () => {});
  });

  it("renders live output as inert text and exposes forced cleanup", async () => {
    record = execution({
      state: "interrupted",
      ownership: "quiescent",
      descendantCleanupForced: true,
      exitCode: 0,
    });
    const { container } = render(
      <FluentProvider theme={fleetDarkTheme}>
        <CommandExecutionsDialog
          executions={[record]}
          connected
          output={[
            {
              executionId: id,
              attemptId,
              sequence: 2,
              stream: "stdout",
              at,
              data: btoa("<img src=x onerror=alert(1)>"),
            },
          ]}
          onClose={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.getByLabelText("Command output").textContent).toContain("<img");
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByText(/Remaining child processes were forcibly stopped/),
    ).toBeTruthy();
    expect(screen.getByText(/gaps or lossy decoding/)).toBeTruthy();
    await act(async () => {});
  });

  it("keeps the execution history destination even after the lead was deleted", () => {
    const notification = NotificationSchema.parse({
      id: "notice",
      sourceKey: "command:approval",
      category: "permission",
      kind: "command_approval",
      severity: "warning",
      title: "Command approval",
      subject: { type: "command_execution", id, label: "Command" },
      navigation: { type: "command_execution", executionId: id, sessionId: "deleted" },
      createdAt: at,
      updatedAt: at,
    });
    expect(notificationTarget(notification, {}, [], [])).toEqual({
      kind: "command_execution",
      executionId: id,
    });
  });
});
