import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandExecutionSchema,
  NotificationSchema,
  PrMaintenanceApprovalSchema,
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
const maintenanceApproval = () =>
  PrMaintenanceApprovalSchema.parse({
    proposalId: "proposal",
    version: 2,
    taskId: "task",
    leadSessionId: "lead",
    mode: "repair",
    createdAt: at,
    identity: {
      host: "github.com",
      repositoryId: "123",
      repository: "owner/repo",
      prNumber: 17,
      headRepositoryId: "123",
      headRepository: "owner/repo",
      headRef: "refs/heads/fix",
      baseRepositoryId: "123",
      baseRepository: "owner/repo",
      baseRef: "refs/heads/main",
    },
  });
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

function mount(
  item = record,
  connected = true,
  others: CommandExecution[] = [],
  initialExecutionId?: string,
) {
  return render(
    <FluentProvider theme={fleetDarkTheme}>
      <CommandExecutionsDialog
        executions={[item, ...others]}
        output={[]}
        connected={connected}
        initialExecutionId={initialExecutionId}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  );
}

describe("command approval UI", () => {
  it("opens the waiting tab for a maintenance-only approval and routes directly to scope review", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ executions: [] }));
    const approval = maintenanceApproval();
    const review = vi.fn();
    const rendered = render(
      <FluentProvider theme={fleetDarkTheme}>
        <CommandExecutionsDialog
          executions={[]}
          output={[]}
          connected
          onClose={vi.fn()}
          maintenanceApprovals={[approval]}
          onReviewMaintenance={review}
        />
      </FluentProvider>,
    );
    expect(
      screen
        .getByRole("tab", { name: "Waiting approval (1)" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      await screen.findByRole("region", { name: "PR maintenance approval details" }),
    ).toBeTruthy();
    expect(screen.getByText("Bounded repairs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Authorize maintenance" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review maintenance scope" }));
    expect(review).toHaveBeenCalledWith(approval);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
    rendered.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <CommandExecutionsDialog
          executions={[]}
          output={[]}
          connected
          onClose={vi.fn()}
          maintenanceApprovals={[]}
          onReviewMaintenance={review}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole("tab", { name: "Waiting approval (0)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review maintenance scope" })).toBeNull();
  });

  it("keeps command permission actions separate when the waiting list also contains a PR", async () => {
    const approval = maintenanceApproval();
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <CommandExecutionsDialog
          executions={[record]}
          output={[]}
          connected
          onClose={vi.fn()}
          maintenanceApprovals={[approval]}
          onReviewMaintenance={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole("tab", { name: "Waiting approval (2)" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /PR maintenance · waiting approval/ }),
    );
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review maintenance scope" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Windows builder · awaiting approval/ }),
    );
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review maintenance scope" })).toBeNull();
    await act(async () => {});
  });

  it("filters maintenance approvals to the chosen lead and disables review while disconnected", async () => {
    const review = vi.fn();
    const own = maintenanceApproval();
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <CommandExecutionsDialog
          executions={[]}
          output={[]}
          connected={false}
          leadSessionId="lead"
          onClose={vi.fn()}
          maintenanceApprovals={[
            own,
            { ...own, proposalId: "other", leadSessionId: "other-lead" },
          ]}
          onReviewMaintenance={review}
        />
      </FluentProvider>,
    );
    await screen.findByText("Windows builder · awaiting approval");
    expect(screen.getByRole("tab", { name: "Waiting approval (2)" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /PR maintenance · waiting approval/ }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: /PR maintenance · waiting approval/ }),
    );
    expect(
      screen.getByRole("button", { name: "Review maintenance scope" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Review maintenance scope" }));
    expect(review).not.toHaveBeenCalled();
  });

  it("separates pending approvals from approved, denied, and completed requests", async () => {
    const others = [
      execution({
        id: "00000000-0000-4000-8000-000000000001",
        state: "running",
        command: "running command",
      }),
      execution({
        id: "00000000-0000-4000-8000-000000000002",
        state: "denied",
        command: "denied command",
      }),
      execution({
        id: "00000000-0000-4000-8000-000000000003",
        state: "succeeded",
        command: "finished command",
      }),
    ];
    mount(record, true, others);
    expect(
      screen
        .getByRole("tab", { name: "Waiting approval (1)" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(
        screen.getByRole("navigation", { name: "Waiting approval requests" }),
      ).getAllByRole("button"),
    ).toHaveLength(1);
    expect(screen.queryByText("finished command")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Request history (3)" }));
    expect(
      within(screen.getByRole("navigation", { name: "Command history" })).getAllByRole(
        "button",
      ),
    ).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    await act(async () => {});
  });

  it("opens a completed notification directly in history even with other requests pending", async () => {
    const finished = execution({
      id: "00000000-0000-4000-8000-000000000003",
      state: "failed",
      command: "finished command",
    });
    mount(record, true, [finished], finished.id);
    expect(
      screen
        .getByRole("tab", { name: "Request history (1)" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByLabelText("Exact command").textContent).toBe("finished command");
    await act(async () => {});
  });

  it("moves an approved request into history and focuses the next waiting request", async () => {
    const second = execution({
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-09-16T15:00:00.000Z",
      command: "next command",
    });
    mount(record, true, [second]);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Exact command").textContent).toBe("next command"),
    );
    expect(
      screen
        .getByRole("tab", { name: "Waiting approval (1)" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Request history (1)" })).toBeTruthy();
  });

  it("refreshes a real approval conflict without submitting the decision again", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/decision")) {
        record = execution({
          state: "failed",
          version: 8,
          approvalScope: "once",
          automaticApproval: false,
          error: "Checkout busy",
        });
        return json({ code: "approval_conflict", error: "Conflict" }, 409);
      }
      return original(url, init);
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText("Checkout busy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText(/approval has not been retried/)).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/decision")),
    ).toHaveLength(1);
  });

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

  it("gives short output a readable, non-shrinking, resizable panel", async () => {
    record = execution({ state: "succeeded", ownership: "quiescent", exitCode: 0 });
    mount();
    const output = screen.getByLabelText("Command output");
    const style = getComputedStyle(output);
    expect(style.minHeight).toBe("200px");
    expect(style.flexShrink).toBe("0");
    expect(style.overflowY).toBe("auto");
    expect(style.resize).toBe("vertical");
    output.focus();
    expect(document.activeElement).toBe(output);
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
