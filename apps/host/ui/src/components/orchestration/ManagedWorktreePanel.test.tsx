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
    baseRef: "refs/heads/main",
    aggregationState: "completed",
    aggregationPhase: "done",
    aggregationAttempt: 1,
    aggregationSummary:
      "Integrated into refs/heads/main and cleaned isolated workspaces.",
    aggregationTargetRef: "refs/heads/main",
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
  hasCommittedChanges: true,
  baseContainedByTarget: true,
  targetAdvancedFromBase: false,
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
  it("shows the automatic lifecycle normally and progressively discloses recovery controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response(initialView())),
    );
    show();

    await screen.findByText(/Integrated into main/);
    expect(screen.getByText("Workspace details").closest("details")?.open).toBe(false);
    expect(screen.getByText(/Integration and validation:/).textContent).toContain(
      "Complete",
    );
    expect(
      screen.getByRole("button", { name: "Preview integration" }).closest("details")
        ?.open,
    ).toBe(false);

    fireEvent.click(screen.getByText("Workspace details"));
    expect(screen.getByRole("button", { name: "Preview integration" })).toBeTruthy();
    expect(screen.getByText("Advanced recovery: manual integration")).toBeTruthy();
  });

  it("distinguishes the execution base from an uncreated no-change publication target", async () => {
    const noChanges = RunSchema.parse({
      ...run,
      workspaceBinding: {
        ...run.workspaceBinding!,
        integrationRemote: "origin",
        integrationTargetRef: "refs/heads/dev/sihanwang/sql-endpoints-object-overview",
        aggregationSummary:
          "No committed changes; verified task workspaces and cleaned them without merge integration.",
        aggregationTargetRef: "",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          ...initialView(),
          binding: noChanges.workspaceBinding,
        }),
      ),
    );

    show(noChanges);

    const workspaceHeading = await screen.findByRole("heading", {
      name: "Fleet workspace",
    });
    expect(workspaceHeading.nextElementSibling?.textContent).toContain(
      "execution base main (aaaaaaaaaaaa)",
    );
    expect(screen.getByText(/Publication target:/).textContent).toContain(
      "origin/dev/sihanwang/sql-endpoints-object-overview",
    );
    expect(screen.getByText(/Publication:/).textContent).toContain("Not required");
    expect(screen.getByText(/a no-change task never creates it/)).toBeTruthy();
  });

  it("offers one-click retry only when automatic integration needs attention", async () => {
    const blocked = RunSchema.parse({
      ...run,
      state: "blocked",
      workspaceBinding: {
        ...run.workspaceBinding,
        aggregationState: "attention",
        aggregationPhase: "integrate",
        aggregationCode: "dirty_or_unknown",
        aggregationSummary: "The integration target is dirty.",
      },
    });
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
      if (init?.method === "POST") return response({ run: blocked });
      return response({ ...initialView(), binding: blocked.workspaceBinding });
    });
    vi.stubGlobal("fetch", fetchMock);
    show(blocked);

    const retry = await screen.findByRole("button", { name: "Retry integration" });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path.endsWith("/retry-integration") && init?.method === "POST",
        ),
      ).toBe(true),
    );
  });

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
    await screen.findByText(
      /An isolated workspace will be created from project on Node at its current committed HEAD/,
    );
    expect(screen.getByText("Workspace details").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace isolation" }));
    expect(screen.getByRole("option", { name: "Isolated worktree" })).toBeTruthy();
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
    expect(screen.getByText(/deterministic composed workspace/)).toBeTruthy();
  });

  it("requires explicit consent before retrying a blocked task with Git hooks", async () => {
    const blocked = RunSchema.parse({
      ...run,
      state: "running",
      workspaceBinding: {
        ...run.workspaceBinding,
        initialization: "blocked",
        resolvedPath: "",
        checkoutKey: "",
        error:
          "V1 refuses active Git hooks in C:\\repo\\.husky\\_; remove or disable them.",
      },
    });
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
      if (init?.method === "POST")
        return response({ operation: { result: { ok: true } } });
      return response({
        binding: blocked.workspaceBinding,
        version: 0,
        operations: [],
        integrations: [],
        targets: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    show(blocked);
    const retry = await screen.findByRole("button", {
      name: "Allow Git hooks and retry",
    });
    fireEvent.click(retry);
    const confirmButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Confirm retry with hooks",
    });
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Type the exact Git hooks confirmation" }),
      { target: { value: "ALLOW REPOSITORY GIT HOOKS" } },
    );
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path.endsWith("/retry-with-hooks") &&
            JSON.parse(String(init?.body)).allowGitHooks === true &&
            JSON.parse(String(init?.body)).confirm === "ALLOW REPOSITORY GIT HOOKS",
        ),
      ).toBe(true),
    );
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
              validationState: "not_run",
              validationSummary: "",
              error: "",
            },
          ],
        };
      } else if (path.endsWith("integration-abort")) {
        view = {
          ...view,
          integrations: [
            {
              id: "integration",
              state: "aborted",
              preview,
              conflicts: [],
              validationState: "not_run",
              validationSummary: "",
              error: "",
            },
          ],
        };
      }
      return response({ operation: { result: { ok: true } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();
    await screen.findByText("C:\\trees\\task");
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

  it("labels a base-only task as no committed changes instead of already integrated", async () => {
    const noChanges = {
      ...preview,
      taskSha: tree.baseSha,
      diff: "",
      hasCommittedChanges: false,
      alreadyIntegrated: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
        if (init?.method === "POST" && path.endsWith("integration-preview"))
          return response({ operation: { result: { preview: noChanges } } });
        return response(initialView());
      }),
    );
    show();
    await screen.findByText("C:\\trees\\task");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview integration" }));
    });
    expect(
      await screen.findByRole("button", { name: "Record no committed changes" }),
    ).toBeTruthy();
    expect(screen.getByText(/Committed task changes: No/)).toBeTruthy();
    expect(screen.queryByText(/Already integrated/)).toBeNull();
  });

  it("reviews and explicitly approves the exact final integrated result", async () => {
    const awaiting = {
      ...run,
      state: "aggregating",
      workspaceBinding: {
        ...run.workspaceBinding!,
        aggregationState: "in_progress",
        aggregationPhase: "await_publish_approval",
        aggregationSummary:
          "The exact validated integrated result is ready for your review and publication approval.",
      },
    } as typeof run;
    const finalIntegration = {
      id: "integration",
      worktreeId: "tree",
      generation: 1,
      preview: {
        ...preview,
        targetRemote: "origin",
        targetRef: "refs/heads/dev/vicky/worktree-8f42c1",
      },
      approvedTaskSha: preview.taskSha,
      approvedDiffIdentity: preview.diffIdentity,
      strategy: "merge",
      state: "integrated",
      preState: "clean",
      resultSha: "c".repeat(40),
      mergeTree: "d".repeat(40),
      finalTree: "d".repeat(40),
      conflicts: [],
      validationState: "passed",
      validationSummary: "Tests and review passed.",
      validationStartedAt: at,
      validatedAt: at,
      publishState: "awaiting_approval",
      publicationBaseSha: "a".repeat(40),
      publicationDiff: "+ final integrated content\n",
      publicationFileCount: 14,
      publicationCommitCount: 3,
      publishedAt: "",
      error: "",
      createdAt: at,
      updatedAt: at,
    };
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "csrf" });
      if (init?.method === "POST" && path.endsWith("publish-branch"))
        return response({ approval: { approvalId: "approval" } });
      return response({
        ...initialView(),
        binding: awaiting.workspaceBinding,
        integrations: [finalIntegration],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    show(awaiting);

    expect(await screen.findByText("Ready to publish")).toBeTruthy();
    expect(screen.getByText("14 files changed")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Tests passed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText("+ final integrated content")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));
    });
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path.endsWith("publish-branch") && init?.method === "POST",
      ),
    ).toBe(true);
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
