import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { HostMcpSettings } from "@fleet/protocol";
import { HostMcpCard } from "./HostMcpCard";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";
import { forgetCsrfToken } from "../lib/auth";
import { SettingsActivityContext } from "../hooks/useSettingsActivity";

const initial: HostMcpSettings = {
  revision: "a".repeat(64),
  suspended: false,
  servers: [
    {
      name: "figma",
      transport: "http",
      sourceDigest: "b".repeat(64),
      enabled: true,
      allNodes: true,
      toolCount: 5,
      readOnly: true,
    },
    {
      name: "mail",
      transport: "stdio",
      sourceDigest: "c".repeat(64),
      enabled: false,
      allNodes: false,
      toolCount: 0,
      readOnly: false,
    },
  ],
};
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
function show(
  data = initial,
  write = async () =>
    answer({
      ...initial,
      revision: "d".repeat(64),
      servers: initial.servers.map((server) => ({
        ...server,
        enabled: true,
        allNodes: true,
      })),
    }),
) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input) === "/api/auth/csrf") return answer({ csrfToken: "proof" });
    if (init?.method === "PUT") return write();
    return answer(data);
  });
  vi.stubGlobal("fetch", fetchMock);
  const failures: unknown[] = [];
  const options: unknown[] = [];
  const notify = vi.fn();
  const run = async (work: () => Promise<unknown>, option?: unknown) => {
    options.push(option);
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  const content = (active: boolean) => (
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <SettingsActivityContext.Provider value={active}>
          <HostMcpCard run={run} />
        </SettingsActivityContext.Provider>
      </NotificationContext.Provider>
    </FluentProvider>
  );
  const rendered = render(content(true));
  return {
    fetchMock,
    failures,
    options,
    notify,
    setActive: (active: boolean) => rendered.rerender(content(active)),
  };
}
const radio = (group: HTMLElement, name: string) =>
  within(group).getByRole("radio", { name }) as HTMLInputElement;
const openChooser = async () => {
  const button = await screen.findByRole("button", { name: "Choose MCPs…" });
  button.focus();
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "Choose MCPs to share" });
};
beforeEach(() => forgetCsrfToken());
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Host MCP forwarding dialog", () => {
  it("keeps only enabled names on the card and opens the independent radios in a dialog", async () => {
    const { fetchMock } = show();
    const card = screen.getByRole("region", { name: "Host MCP forwarding" });
    expect(await within(card).findByText("Shared: figma")).toBeTruthy();
    expect(within(card).queryByText("mail")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await openChooser();
    const figma = await screen.findByRole("radiogroup", { name: "figma forwarding" });
    const mail = screen.getByRole("radiogroup", { name: "mail forwarding" });
    expect(radio(figma, "Share with all nodes").checked).toBe(true);
    expect(radio(mail, "Off").checked).toBe(true);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(screen.getByText("fleet-host-figma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Shared: figma")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const restoredTrigger = await screen.findByRole("button", { name: "Choose MCPs…" });
    expect(JSON.parse(restoredTrigger.getAttribute("data-tabster")!)).toMatchObject({
      restorer: { type: 1 },
    });
  });

  it("saves only the selected MCP with a revision, CSRF, and reauthentication support", async () => {
    const { fetchMock, options, notify } = show();
    await openChooser();
    const mail = await screen.findByRole("radiogroup", { name: "mail forwarding" });
    fireEvent.click(radio(mail, "Share with all nodes"));
    await waitFor(() => expect(radio(mail, "Share with all nodes").checked).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      name: "mail",
      enabled: true,
      expectedRevision: initial.revision,
      sourceDigest: initial.servers[1]!.sourceDigest,
    });
    expect(new Headers(call[1]?.headers).get("x-csrf-token")).toBe("proof");
    expect(options).toEqual([{ refresh: false, resumeAfterReauth: true }]);
    expect(notify).toHaveBeenCalledWith("mail is shared with all nodes.", "success");
    expect(
      radio(
        screen.getByRole("radiogroup", { name: "figma forwarding" }),
        "Share with all nodes",
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Shared: figma, mail")).toBeTruthy();
  });

  it.each([409, 403])(
    "closes the chooser for a %s refusal without showing false success or stacking dialogs",
    async (status) => {
      const { failures, notify, options } = show(initial, async () =>
        answer(
          {
            error:
              status === 403
                ? "Sign in again."
                : "Host MCP settings changed. Refresh before saving.",
            ...(status === 403 ? { reauthRequired: true } : {}),
          },
          status,
        ),
      );
      await openChooser();
      const mail = await screen.findByRole("radiogroup", { name: "mail forwarding" });
      fireEvent.click(radio(mail, "Share with all nodes"));
      await waitFor(() => expect(failures).toHaveLength(1));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(await screen.findByText("Shared: figma")).toBeTruthy();
      expect(notify).not.toHaveBeenCalled();
      expect(options).toEqual([{ refresh: false, resumeAfterReauth: true }]);
      await openChooser();
      expect(
        radio(await screen.findByRole("radiogroup", { name: "mail forwarding" }), "Off")
          .checked,
      ).toBe(true);
    },
  );

  it("keeps Off available when a configured server or the catalog is unavailable", async () => {
    show({
      ...initial,
      catalogError: "Catalog unavailable",
      servers: [
        { ...initial.servers[0]!, unavailable: "No longer configured on the Host" },
      ],
    });
    const dialog = await openChooser();
    const group = await screen.findByRole("radiogroup", { name: "figma forwarding" });
    expect(radio(group, "Off").disabled).toBe(false);
    expect(radio(group, "Share with all nodes").disabled).toBe(true);
    expect(within(dialog).getByText("Catalog unavailable")).toBeTruthy();
  });

  it("prevents overlapping saves while the selected Host connection is being checked", async () => {
    let resolve!: (value: Response) => void;
    show(
      initial,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await openChooser();
    const mail = await screen.findByRole("radiogroup", { name: "mail forwarding" });
    fireEvent.click(radio(mail, "Share with all nodes"));
    await screen.findByText("Saving mail…");
    expect(radio(mail, "Off").disabled).toBe(true);
    expect(
      radio(screen.getByRole("radiogroup", { name: "figma forwarding" }), "Off").disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolve(answer(initial));
    await waitFor(() => expect(radio(mail, "Off").disabled).toBe(false));
  });

  it("explains an empty catalog and a suspended restore without claiming sharing", async () => {
    show({ revision: initial.revision, suspended: true, servers: [] });
    expect(await screen.findByText("No MCPs shared.")).toBeTruthy();
    await openChooser();
    expect(await screen.findByText(/No MCPs are configured on this Host/)).toBeTruthy();
    expect(screen.getByText(/Forwarding is suspended after a Host restore/)).toBeTruthy();
  });

  it("searches a 60-server catalog without filling the card or losing enabled selections", async () => {
    const servers = Array.from({ length: 60 }, (_, i) => ({
      ...initial.servers[1]!,
      name: `server-${String(i).padStart(2, "0")}`,
      enabled: i === 3 || i === 59,
      allNodes: true,
    }));
    const { fetchMock } = show({ ...initial, servers });
    const summary = await screen.findByText("Shared: server-03, server-59");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const dialog = await openChooser();
    const list = within(dialog).getByRole("region", { name: "Available Host MCPs" });
    expect(within(list).getAllByRole("radiogroup")).toHaveLength(60);
    const search = within(dialog).getByRole("searchbox", { name: "Search Host MCPs" });
    fireEvent.change(search, { target: { value: " SERVER-59 " } });
    expect(within(list).getAllByRole("radiogroup")).toHaveLength(1);
    expect(
      radio(within(list).getByRole("radiogroup"), "Share with all nodes").checked,
    ).toBe(true);
    expect(within(dialog).getByText("1 of 60 MCPs")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(within(dialog).getByText("No MCPs match your search.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(within(list).getAllByRole("radiogroup")).toHaveLength(60);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByText(summary.textContent!)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("hides its modal while Settings is inactive and preserves it when returning", async () => {
    const { setActive } = show();
    await openChooser();
    setActive(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    setActive(true);
    expect(
      await screen.findByRole("dialog", { name: "Choose MCPs to share" }),
    ).toBeTruthy();
  });
});
