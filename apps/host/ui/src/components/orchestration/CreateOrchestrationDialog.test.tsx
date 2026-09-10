import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { type DriClassification, type Placement, type Workspace } from "@fleet/protocol";
import { classifyDriRequest } from "../../../../src/dri/classifier.js";
import { api } from "../../hooks/useFleet";
import { fleetDarkTheme } from "../../theme";
import {
  CreateOrchestrationDialog,
  type CreateOrchestrationDialogProps,
} from "./CreateOrchestrationDialog";

vi.mock("../../hooks/useFleet", () => ({ api: vi.fn() }));
const workspaces: Workspace[] = [
  {
    id: "workspace",
    name: "Workspace",
    description: "",
    kind: "project",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];
const placements: Placement[] = [
  {
    id: "placement",
    workspaceId: "workspace",
    nodeId: "node",
    localPath: "C:\\synthetic",
  },
];
const objective =
  "Investigate ICM 123456789, analyze the HAR and telemetry, and determine root cause.";
function mount(online = true) {
  const onCreate = vi.fn<CreateOrchestrationDialogProps["onCreate"]>(async () => true);
  const onOpenChange = vi.fn();
  const view = render(
    <FluentProvider theme={fleetDarkTheme}>
      <CreateOrchestrationDialog
        open
        workspaces={workspaces}
        placements={online ? placements : []}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
      />
    </FluentProvider>,
  );
  return { onCreate, onOpenChange, unmount: view.unmount };
}
const typeRequest = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "What should be done?" }), {
    target: { value },
  });
const createButton = () =>
  screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  sessionStorage.clear();
  vi.mocked(api).mockImplementation(
    async (_url, options) =>
      classifyDriRequest(JSON.parse(String(options?.body))) as never,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("normal task workflow selection", () => {
  it("defaults to Auto with accessible Regular and DRI choices, without a provider mode", () => {
    mount();
    expect(
      (screen.getByRole("combobox", { name: "Workflow" }) as HTMLSelectElement).value,
    ).toBe("auto");
    for (const name of ["Auto", "Regular", "DRI investigation"])
      expect(screen.getByRole("option", { name })).toBeTruthy();
    expect(screen.queryByLabelText("Provider mode")).toBeNull();
    expect(createButton().disabled).toBe(true);
  });
  it("explains confident DRI, supports correction, and sends one normal Auto request", async () => {
    const { onCreate, onOpenChange } = mount();
    typeRequest(objective);
    expect((await screen.findByRole("status")).textContent).toContain(
      "Checking workflow",
    );
    await screen.findByRole("button", { name: "Use Regular" });
    expect(screen.getByRole("status").textContent).toContain(
      "Detected DRI investigation",
    );
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      workflow: "auto",
      objective,
      requestId: expect.any(String),
    });
    expect(JSON.stringify(onCreate.mock.calls[0])).not.toContain('"mode"');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
  it("never silently creates ambiguity and offers keyboard-accessible ICM confirmation", async () => {
    const { onCreate } = mount();
    typeRequest("Investigate incident 123456789.");
    const correction = await screen.findByRole("button", {
      name: "Use DRI investigation",
    });
    expect(screen.getByRole("alert").textContent).toContain("Confirm workflow");
    expect(createButton().disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
    correction.focus();
    expect(document.activeElement).toBe(correction);
    fireEvent.click(correction);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    expect(
      (screen.getByRole("textbox", { name: "ICM URL or ID" }) as HTMLInputElement).value,
    ).toBe("123456789");
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      workflow: "dri",
      dri: { icm: "123456789" },
    });
  });
  it("lets explicit Regular override detection and does not require DRI hints", async () => {
    const { onCreate } = mount();
    typeRequest(objective);
    fireEvent.click(await screen.findByRole("button", { name: "Use Regular" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ workflow: "regular", objective });
  });
  it("preserves regular Auto creation and online placement requirements", async () => {
    const { onCreate } = mount(false);
    typeRequest("Update the README with instructions for investigating ICM incidents.");
    await waitFor(() => expect(screen.queryByText("Checking workflow…")).toBeNull());
    expect(createButton().disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/No online node holds a workspace/)).toBeTruthy();
  });
  it("allows Host-only DRI with no online Node", async () => {
    const { onCreate } = mount(false);
    typeRequest(objective);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
  });
  it("reuses the same key after an uncertain response and guards double-submit", async () => {
    const { onCreate } = mount();
    onCreate.mockResolvedValueOnce(false);
    typeRequest(objective);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());
    fireEvent.click(createButton());
    await screen.findByText(/Task creation was not confirmed/);
    expect(onCreate).toHaveBeenCalledTimes(1);
    const first = onCreate.mock.calls[0]?.[0];
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]?.[0]).toEqual(first);
  });
  it("discards a stale DRI preview after the objective changes to a coding task", async () => {
    let resolveDri: ((value: DriClassification) => void) | undefined;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDri = resolve;
        }),
    );
    mount();
    typeRequest(objective);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    typeRequest("Update the README");
    await waitFor(() => expect(createButton().disabled).toBe(false));
    await act(async () => resolveDri?.(classifyDriRequest({ objective })));
    expect(screen.queryByRole("button", { name: "Use Regular" })).toBeNull();
  });
  it("retains only a hashed request key across remount/reconnect after an uncertain creation", async () => {
    const first = mount();
    first.onCreate.mockResolvedValueOnce(false);
    typeRequest(objective);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());
    await screen.findByText(/Task creation was not confirmed/);
    const requestId = first.onCreate.mock.calls[0]![0].requestId;
    const stored = sessionStorage.getItem("fleet.orchestration.pending.v1");
    expect(stored).toContain(String(requestId));
    expect(stored).not.toContain("123456789");
    expect(stored).not.toContain(objective);
    first.unmount();
    const second = mount();
    typeRequest(objective);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());
    await waitFor(() => expect(second.onCreate).toHaveBeenCalledTimes(1));
    expect(second.onCreate.mock.calls[0]![0].requestId).toBe(requestId);
    await waitFor(() =>
      expect(sessionStorage.getItem("fleet.orchestration.pending.v1")).toBeNull(),
    );
  });
  it("surfaces preview failure and allows an explicit correction instead of silent routing", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Host unavailable"));
    const { onCreate } = mount();
    typeRequest(objective);
    expect((await screen.findByRole("alert")).textContent).toContain("Host unavailable");
    expect(createButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow" }), {
      target: { value: "regular" },
    });
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ workflow: "regular" });
  });
});
