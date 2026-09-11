import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedWorktreeSchema, RunSchema } from "@fleet/protocol";
import { fleetDarkTheme } from "../../theme";
import { forgetCsrfToken } from "../../lib/auth";
import { ManagedWorktreePanel } from "./ManagedWorktreePanel";
import { CreateOrchestrationDialog } from "./CreateOrchestrationDialog";
import { GeneralPanel } from "../GeneralPanel";

const at = "2026-09-10T10:00:00.000Z";
const identity = (key: string, path: string) => ({
  key,
  path,
  machineId: "machine",
  volume: "volume",
  fileId: key,
});
const tree = ManagedWorktreeSchema.parse({
  id: "tree",
  runId: "run",
  taskKey: "task",
  sourcePlacementId: "source",
  workspaceId: "workspace",
  nodeId: "node",
  machineId: "machine",
  hostInstallationId: "host",
  nodeInstallationId: "installation",
  repository: identity("repository", "C:\\repo"),
  commonDirectory: identity("common", "C:\\repo\\.git"),
  managedRoot: identity("root", "C:\\trees"),
  checkout: identity("checkout", "C:\\trees\\task"),
  generation: 1,
  version: 4,
  path: "C:\\trees\\task",
  branchRef: "refs/heads/fleet/task",
  pinRef: "refs/fleet/pins/task",
  baseSha: "a".repeat(40),
  state: "ready",
  createdAt: at,
  updatedAt: at,
});
const run = RunSchema.parse({
  id: "run",
  workspaceId: "workspace",
  name: "task",
  objective: "done",
  state: "completed",
  createdAt: at,
  updatedAt: at,
  workspaceBinding: {
    requestedMode: "auto",
    effectiveMode: "managed",
    resolutionSource: "app_default",
    sourcePlacementId: "source",
    managedWorktreeId: "tree",
    generation: 1,
    baseSha: tree.baseSha,
    checkoutKey: "checkout",
    resolvedPath: tree.path,
    initialization: "ready",
  },
});
const target = {
  id: "source",
  workspaceId: "workspace",
  workspaceName: "project",
  nodeId: "node",
  nodeName: "Node",
  localPath: "C:\\repo",
};
const preview = {
  id: "preview",
  worktreeId: "tree",
  generation: 1,
  taskSha: "b".repeat(40),
  diffIdentity: "diff-identity",
  diff: "+ reviewed content\n",
  targetPlacementId: target.id,
  target: identity("repository", target.localPath),
  targetRef: "refs/heads/target",
  targetSha: tree.baseSha,
  taskDirty: false,
  targetDirty: false,
  alreadyIntegrated: false,
  observedAt: at,
};
const response = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
beforeEach(forgetCsrfToken);
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

function show(value = run) {
  return render(
    <FluentProvider theme={fleetDarkTheme}>
      <ManagedWorktreePanel run={value} />
    </FluentProvider>,
  );
}
const initialView = () => ({
  binding: run.workspaceBinding,
  worktree: tree,
  version: tree.version,
  operations: [],
  integrations: [] as Record<string, unknown>[],
  targets: [target],
});

describe("accessible managed workspace controls", () => {
  it("persists the disabled General default with revision and idempotency metadata", async () => {
    let enabled = false;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
      if (init?.method === "POST")
        enabled = JSON.parse(String(init.body)).managedWorktreesEnabled;
      return response({
        yolo: false,
        agencyMode: false,
        agencyModeAvailable: false,
        autoResume: true,
        notificationLifecycleEnabled: true,
        model: "",
        reasoningEffort: "",
        managedWorktreesEnabled: enabled,
        managedWorktreesRevision: enabled ? 1 : 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );
    const toggle = await screen.findByRole<HTMLInputElement>("switch", {
      name: "Managed worktree isolation",
    });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      managedWorktreesEnabled: true,
      expectedRevision: 0,
      operationId: expect.any(String),
    });
    expect(
      screen.getByText(/existing tasks and live sessions never migrate/),
    ).toBeTruthy();
  });

  it("offers Auto, Legacy and Managed with capability feedback in normal task creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          managedWorktreesEnabled: true,
          placements: [{ placementId: "source", supported: true, online: true }],
        }),
      ),
    );
    const onCreate = vi.fn(async () => true);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <CreateOrchestrationDialog
          open
          workspaces={[
            {
              id: "workspace",
              name: "project",
              description: "",
              kind: "project",
              createdAt: at,
            },
          ]}
          placements={[target]}
          onOpenChange={vi.fn()}
          onCreate={onCreate}
        />
      </FluentProvider>,
    );
    await screen.findByText(/Effective mode: Managed/);
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace isolation" }));
    expect(screen.getByRole("option", { name: "Managed task worktree" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Legacy source checkout" }));
    fireEvent.change(screen.getByRole("textbox", { name: /What should be done/ }), {
      target: { value: "Implement the task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceMode: "legacy",
          operationId: expect.any(String),
        }),
      ),
    );
  });

  it("shows quarantined/unknown observations and disables unsafe actions until explicit reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          ...initialView(),
          binding: { ...run.workspaceBinding, initialization: "quarantined" },
          worktree: { ...tree, state: "quarantined" },
        }),
      ),
    );
    show();
    await screen.findByText(/Restored metadata is quarantined/);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Remove clean worktree" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reconcile worktree" })
        .disabled,
    ).toBe(false);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getByText(/including uncommitted changes/)).toBeTruthy();
  });

  it("previews an explicitly selected target, requires reviewed-SHA approval, and offers matching conflict abort", async () => {
    let view = initialView();
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
      if (init?.method !== "POST") return response(view);
      if (path.endsWith("integration-preview"))
        return response({ operation: { result: { preview } } });
      if (path.endsWith("integration-start")) {
        view = {
          ...view,
          integrations: [
            {
              id: "integration",
              state: "conflicted",
              preview,
              conflicts: ["same.txt"],
              error: "",
            },
          ],
        };
      } else if (path.endsWith("integration-abort")) {
        view = {
          ...view,
          integrations: [
            { id: "integration", state: "aborted", preview, conflicts: [], error: "" },
          ],
        };
      }
      return response({ operation: { result: { ok: true } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();
    await screen.findByText("C:\\trees\\task");
    fireEvent.change(screen.getByLabelText("Target checkout on the owning Node"), {
      target: { value: "source" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview integration" }));
    });
    await screen.findByLabelText("Reviewed task diff");
    fireEvent.click(screen.getByRole("button", { name: "Merge reviewed commit" }));
    const dialog = screen.getByRole("dialog");
    const start = within(dialog).getByRole<HTMLButtonElement>("button", {
      name: "Confirm integration start",
    });
    expect(start.disabled).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /I approve this exact task SHA/ }),
    );
    await act(async () => {
      fireEvent.click(start);
    });
    await screen.findByRole("list", { name: "Conflicting paths" });
    expect(screen.getByText("same.txt")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Abort merge" }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await screen.findByRole("heading", { name: "Abort this merge?" });
    const abortDialog = screen.getByRole("dialog");
    expect(abortDialog).not.toBe(dialog);
    expect(abortDialog.getAttribute("aria-hidden")).not.toBe("true");
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm integration abort" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Conflicting paths" })).toBeNull(),
    );
    const abort = fetchMock.mock.calls.find(([path]) =>
      path.endsWith("integration-abort"),
    )!;
    expect(JSON.parse(String(abort[1]!.body))).toMatchObject({
      integrationId: "integration",
      confirm: "ABORT MERGE integration",
      expectedVersion: 4,
    });
  });

  it("requires the exact abandonment phrase and restores focus when cleanup is cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response(initialView())),
    );
    show();
    await screen.findByText("C:\\trees\\task");
    const remove = screen.getByRole<HTMLButtonElement>("button", {
      name: "Remove clean worktree",
    });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(remove));
    fireEvent.click(screen.getByRole("button", { name: "Abandon ownership" }));
    const submit = screen.getByRole<HTMLButtonElement>("button", {
      name: "Confirm abandon",
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Type the exact abandonment confirmation" }),
      {
        target: { value: `ABANDON ${tree.branchRef} AT ${tree.path}; KEEP FILES` },
      },
    );
    expect(submit.disabled).toBe(false);
    expect(screen.getByText(/No files are deleted/)).toBeTruthy();
  });

  it("cancels stale focus restoration when another confirmation opens before the next frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response(initialView())),
    );
    show();
    await screen.findByText("C:\\trees\\task");
    fireEvent.click(screen.getByRole("button", { name: "Remove clean worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Abandon ownership" }));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Abandon Fleet ownership?" }),
    ).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
