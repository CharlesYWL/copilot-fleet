import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { announceSignedOut, forgetCsrfToken } from "../lib/auth";
import { TOUR_STORAGE_KEY, tourSteps } from "../lib/onboarding";
import { fleetDarkTheme } from "../theme";

const responses: Record<string, unknown> = {
  "/api/auth/status": {
    state: "microsoft-only",
    authenticated: true,
    passwordEnabled: false,
    entraConfigured: true,
    deviceFlowEnabled: false,
    claimCodeRequired: false,
    canSignIn: true,
    identity: { username: "owner@example.com", displayName: "Fleet owner" },
  },
  "/api/defaults": {
    yolo: false,
    autoResume: false,
    notificationLifecycleEnabled: true,
    model: "",
    reasoningEffort: "",
  },
  "/api/enrollment": {
    hostId: "host-1",
    hostUrl: "http://localhost:8787",
    hostFingerprint: "a".repeat(64),
    nodeAuthentication: { total: 0, mutualAuth: 0, legacy: 0 },
    mutualAuthenticationRequired: false,
  },
  "/api/tunnel": {
    primary: null,
    publicUrl: "http://localhost:8787",
    providers: [],
    tunnels: [],
  },
};

const show = (strict = false) => {
  const app = (
    <FluentProvider theme={fleetDarkTheme}>
      <App />
    </FluentProvider>
  );
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
};

const bubble = (title: string) => screen.findByRole("dialog", { name: title });
const next = async (title: string) => {
  const current = screen.getByRole("dialog");
  await act(async () => {
    fireEvent.click(
      within(current).getByRole("button", { name: /^(Show me around|Next)$/ }),
    );
  });
  return bubble(title);
};

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
  localStorage.clear();
  forgetCsrfToken();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const path = String(input);
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      return new Response(JSON.stringify(responses[path]), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  forgetCsrfToken();
  window.history.replaceState({}, "", "/");
});

describe("first-claim setup tour", () => {
  it("leaves ordinary sign-ins alone even in a new browser", async () => {
    show();
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/defaults")).toBe(
      false,
    );
  });

  it("starts once after claim under StrictMode and stays dismissed after a refresh", async () => {
    window.history.replaceState({}, "", "/?welcome=1&keep=yes#details");
    const view = show(true);
    const welcome = await bubble("Your Host is ready");
    expect(
      within(welcome).getByRole<HTMLButtonElement>("button", { name: "Back" }).disabled,
    ).toBe(true);
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#details");
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBe("welcome");

    fireEvent.click(within(welcome).getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("banner"));
    view.unmount();
    show();
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("walks the real pages, finishes, and can be replayed without provisioning anything", async () => {
    window.history.replaceState({}, "", "/?welcome=1");
    show();
    await bubble("Your Host is ready");
    for (const step of tourSteps.slice(1)) {
      await next(step.title);
      expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBe(step.id);
      await waitFor(() =>
        expect(document.querySelector("[data-tour-highlighted]")).not.toBeNull(),
      );
    }

    fireEvent.click(screen.getByRole("button", { name: "Finish tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBeNull();
    expect(document.querySelector("[data-tour-highlighted]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await bubble("Your Host is ready");
    expect(document.querySelectorAll(".fui-Toast")).toHaveLength(0);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
    ).toBe(true);
  });

  it("gets out of the way during navigation and retains unfinished forms", async () => {
    window.history.replaceState({}, "", "/?welcome=1");
    show();
    await bubble("Your Host is ready");
    await next("Make the Host reachable");
    fireEvent.click(screen.getByRole("tab", { name: "Workspaces" }));
    const name = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unfinished project" } });
    expect(await screen.findByRole("button", { name: "Resume tour" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume tour" }));
    await bubble("Make the Host reachable");
    expect(name.isConnected).toBe(true);
    await next("Connect a machine");
    await next("Name your project");
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
    expect(name.value).toBe("Unfinished project");
    await next("Point Fleet at the real directory");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await bubble("Name your project");
    expect(name.value).toBe("Unfinished project");
  });

  it("pauses for the actual session dialog and returns without starting a session", async () => {
    sessionStorage.setItem(TOUR_STORAGE_KEY, "session");
    show();
    await bubble("Start your first session");
    fireEvent.click(screen.getByRole("button", { name: "Open New session" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a session" });
    expect(screen.queryByRole("dialog", { name: "Start your first session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume tour" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await bubble("Start your first session");
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBe("session");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
    ).toBe(true);
  });

  it("can be put aside while the user does a step without losing their place", async () => {
    sessionStorage.setItem(TOUR_STORAGE_KEY, "workspace");
    show();
    await bubble("Name your project");
    fireEvent.click(screen.getByRole("button", { name: "Let me do this step" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-tour-highlighted]")).toBeNull();
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBe("workspace");
    const name = screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "My project" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume tour" }));
    await bubble("Name your project");
    expect(name.value).toBe("My project");
    await next("Point Fleet at the real directory");
  });

  it("remembers the current step across refreshes and clears it on sign-out", async () => {
    sessionStorage.setItem(TOUR_STORAGE_KEY, "placement");
    const view = show();
    await bubble("Point Fleet at the real directory");
    view.unmount();
    show();
    await bubble("Point Fleet at the real directory");

    act(() => announceSignedOut());
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses with Escape and removes the anchor highlight", async () => {
    window.history.replaceState({}, "", "/?welcome=1");
    show();
    const welcome = await bubble("Your Host is ready");
    fireEvent.keyDown(welcome, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("[data-tour-highlighted]")).toBeNull();
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBeNull();
  });
});
