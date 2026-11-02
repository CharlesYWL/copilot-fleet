import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, initShell, showPanel } from "./ui.js";
import { fleetSessionLabel, initFleetSessions } from "./fleet-sessions.js";
import { initSessions } from "./sessions.js";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.html"),
  "utf8",
);
const page = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
const stylesheet = document.createElement("style");
stylesheet.textContent = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "config.css"),
  "utf8",
);
const reply = (body) => Promise.resolve({ ok: true, json: async () => body });

beforeEach(() => {
  document.head.append(stylesheet);
  document.body.innerHTML = page;
  vi.stubGlobal(
    "fetch",
    vi.fn((path) =>
      reply(
        path.startsWith("/api/fleet-sessions")
          ? {
              sessions: [
                { id: "one", name: "First", workspaceName: "Workspace", state: "idle" },
                {
                  id: "two",
                  name: "Second",
                  workspaceName: "Workspace",
                  state: "running",
                },
              ],
            }
          : { sessions: [] },
      ),
    ),
  );
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  stylesheet.remove();
  document.body.innerHTML = "";
});

describe("lazy Node session shell", () => {
  it.each([
    ["queued", "#8994ab"],
    ["starting", "#6c8cff"],
    ["running", "#6c8cff"],
    ["idle", "#8994ab"],
    ["cancelling", "#f7bf61"],
    ["offline", "#ff6b7a"],
    ["stopped", "#8994ab"],
    ["completed", "#4ad6a7"],
    ["failed", "#ff6b7a"],
  ])("shows the Host status color for unselected %s sessions", async (state, color) => {
    vi.mocked(fetch).mockImplementation(() =>
      reply({
        sessions: [{ id: "one", name: "First", workspaceName: "Workspace", state }],
      }),
    );
    initFleetSessions();
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    const row = document.querySelector('[data-fleet-session-id="one"]');
    expect(row.dataset.state).toBe(state);
    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(row.querySelector(".session-item-status").textContent).toBe(state);
    expect(getComputedStyle(row).getPropertyValue("--session-status-color")).toBe(color);
    expect(getComputedStyle(row).boxShadow).toContain("var(--session-status-color)");
  });

  it("keeps status colors when selection moves between sessions", async () => {
    initFleetSessions();
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    document.querySelector('[data-fleet-session-id="one"]').click();
    let selected = document.querySelector("#fleetSessionList .selected");
    expect(selected.dataset.fleetSessionId).toBe("one");
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(selected).getPropertyValue("--session-status-color")).toBe(
      "#8994ab",
    );

    document.querySelector('[data-fleet-session-id="two"]').click();
    selected = document.querySelector("#fleetSessionList .selected");
    expect(selected.dataset.fleetSessionId).toBe("two");
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(selected).getPropertyValue("--session-status-color")).toBe(
      "#6c8cff",
    );
    const previous = document.querySelector('[data-fleet-session-id="one"]');
    expect(previous.getAttribute("aria-pressed")).toBe("false");
    expect(getComputedStyle(previous).getPropertyValue("--session-status-color")).toBe(
      "#8994ab",
    );
  });

  it("labels and searches unnamed sessions using the initial prompt", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      reply({
        sessions: [
          {
            id: "unnamed-session",
            name: "",
            initialPrompt: "Investigate the regression\nAdditional instructions",
            workspaceName: "Workspace",
            state: "idle",
          },
        ],
      }),
    );
    initFleetSessions();
    await vi.waitFor(() =>
      expect($("fleetSessionList").textContent).toContain("Investigate the regression"),
    );
    expect($("fleetSessionList").querySelector(".session-item-title").textContent).toBe(
      "Investigate the regression",
    );
    $("fleetSessionSearch").value = "regression";
    $("fleetSessionSearch").dispatchEvent(new Event("input"));
    expect($("fleetSessionList").querySelector("[data-fleet-session-id]")).toBeTruthy();
  });

  it("uses Host-style truncation and falls back to an ID only without a name or prompt", () => {
    const base = { id: "1234567890abcdef", name: "" };
    expect(fleetSessionLabel({ ...base, name: " Named ", initialPrompt: "Prompt" })).toBe(
      "Named",
    );
    expect(fleetSessionLabel({ ...base, initialPrompt: "x".repeat(80) })).toBe(
      "x".repeat(72) + "…",
    );
    expect(
      fleetSessionLabel({ ...base, initialPrompt: "x".repeat(60) + " word one rest" }),
    ).toBe("x".repeat(60) + " word one…");
    expect(fleetSessionLabel({ ...base, initialPrompt: " \n " })).toBe("12345678");
  });

  it("places Move this node under Settings and keeps the Settings tab active there", () => {
    initShell();
    expect(
      document.querySelector('.section-nav [data-panel="transferPanel"]'),
    ).toBeNull();
    document.querySelector('.section-nav [data-panel="settingsPanel"]').click();
    $("settingsPanel").querySelector('[data-panel="transferPanel"]').click();
    expect($("transferPanel").classList.contains("active")).toBe(true);
    expect(
      document
        .querySelector('.section-nav [data-panel="settingsPanel"]')
        .classList.contains("active"),
    ).toBe(true);
    expect($("exportNode")).toBeTruthy();
    expect($("importNode")).toBeTruthy();
    $("transferPanel").querySelector('[data-panel="settingsPanel"]').click();
    expect($("settingsPanel").classList.contains("active")).toBe(true);
  });

  it("loads nothing on settings, then only metadata on entering Sessions", async () => {
    showPanel("settingsPanel");
    initSessions();
    initFleetSessions();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      document.querySelector(".app-shell").classList.contains("without-sessions"),
    ).toBe(true);
    showPanel("sessionPanel");
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      "/api/fleet-sessions?limit=50",
    ]);
    expect($("fleetChat").querySelector("iframe")).toBeNull();
    expect($("nativeSessions").open).toBe(false);
  });

  it("discovers native history only after expansion", async () => {
    initSessions();
    initFleetSessions();
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/sessions")).toBe(
      false,
    );
    $("nativeSessions").open = true;
    $("nativeSessions").dispatchEvent(new Event("toggle"));
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/sessions")).toBe(
        true,
      ),
    );
  });

  it("opens only the selected chat, reuses its document, and pauses it outside Sessions", async () => {
    initFleetSessions();
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    document.querySelector('[data-fleet-session-id="one"]').click();
    const frame = $("fleetChat").querySelector("iframe");
    expect(frame.getAttribute("src")).toBe("/session-console/index.html");
    const post = vi.spyOn(frame.contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: location.origin,
        source: frame.contentWindow,
        data: { type: "node-session-ready" },
      }),
    );
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "one" },
      location.origin,
    );
    document.querySelector('[data-fleet-session-id="two"]').click();
    expect($("fleetChat").querySelectorAll("iframe")).toHaveLength(1);
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "two" },
      location.origin,
    );
    showPanel("settingsPanel");
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "" },
      location.origin,
    );
    showPanel("sessionPanel");
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "two" },
      location.origin,
    );
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "" },
      location.origin,
    );
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "two" },
      location.origin,
    );
  });

  it("opens newly adopted Fleet IDs without rediscovering native history", async () => {
    initFleetSessions();
    await vi.waitFor(() => expect($("fleetSessionList").textContent).toContain("First"));
    document.dispatchEvent(
      new CustomEvent("node-fleet-session", { detail: "adopted-fleet-id" }),
    );
    const frame = $("fleetChat").querySelector("iframe");
    const post = vi.spyOn(frame.contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: location.origin,
        source: frame.contentWindow,
        data: { type: "node-session-ready" },
      }),
    );
    expect(post).toHaveBeenLastCalledWith(
      { type: "node-session", sessionId: "adopted-fleet-id" },
      location.origin,
    );
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/sessions")).toBe(
      false,
    );
  });
});
