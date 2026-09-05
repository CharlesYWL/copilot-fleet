/**
 * The config page, driven the way a browser drives it.
 *
 * This file is served to a browser as it is written — no bundler, no type
 * checker — so nothing else in the repository would notice it breaking. It is
 * loaded here against the real index.html, because the DOM ids it reaches for
 * are the contract between the two files and a hand-written fixture would let
 * them drift apart.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "index.html"), "utf8");
const markup = page.slice(page.indexOf("<body>") + 6, page.indexOf("</body>"));

const $ = (id) => document.getElementById(id);

const NODE_SETTINGS = {
  hostUrl: "http://127.0.0.1:8787",
  nodeName: "workstation-1",
  maxSessions: 10,
  copilotCommand: "",
  permissionTimeoutMs: 1_800_000,
  contextTier: "long_context",
  knownHostUrls: [],
};

/** What the node currently holds, and what it has been asked to change to. */
let stored;
let posted;
let connected;

const reply = (body) => Promise.resolve({ ok: true, json: async () => body });

const respond = (path, init) => {
  const status = {
    nodeId: "abcdef0123456789",
    version: "0.3.0",
    connected,
    activeSessions: 0,
    mockAgent: false,
    devTunnel: null,
  };
  if (path === "/api/config" && init?.method === "POST") {
    const body = JSON.parse(init.body);
    posted.push(body);
    stored = { ...stored, ...body };
    return reply({ settings: stored, status });
  }
  if (path === "/api/config") return reply({ settings: stored, status });
  if (path === "/api/logs") return reply({ entries: [] });
  if (path === "/api/fleet") return reply({ workspaces: [], placements: [] });
  if (path === "/api/sessions") return reply({ sessions: [] });
  throw new Error(`unexpected request: ${path}`);
};

/** Types into a field the way someone at the keyboard would. */
const type = (id, value) => {
  $(id).value = value;
  $(id).dispatchEvent(new Event("input", { bubbles: true }));
};

/** One turn of the five-second poll, with its fetches allowed to settle. */
const poll = () => vi.advanceTimersByTimeAsync(5_000);

async function startPage() {
  document.body.innerHTML = markup;
  vi.resetModules();
  await import("./config.js");
  // The page loads itself on import; wait for the first paint rather than
  // guessing how many microtasks that takes.
  await vi.waitFor(() => expect($("nodeName").value).toBe(stored.nodeName));
}

beforeEach(() => {
  stored = { ...NODE_SETTINGS };
  posted = [];
  connected = true;
  vi.stubGlobal("fetch", vi.fn(respond));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("node settings form", () => {
  it("keeps what was typed instead of the value the node reports", async () => {
    await startPage();
    type("maxSessions", "24");

    await poll();

    // The poll used to repaint the form with the node's own settings, so a
    // number typed here was replaced within five seconds and the field could
    // not be changed at all.
    expect($("maxSessions").value).toBe("24");
    expect(posted).toEqual([]);
  });

  it("still follows the node's status while the form is held", async () => {
    await startPage();
    type("hostUrl", "https://elsewhere.example.com");

    connected = false;
    await poll();

    expect($("conn").textContent).toBe("Not connected");
    expect($("hostUrl").value).toBe("https://elsewhere.example.com");
  });

  it("sends the edits only when Save is pressed", async () => {
    await startPage();
    type("maxSessions", "24");
    type("nodeName", "renamed");
    await poll();

    $("save").click();
    await vi.waitFor(() => expect($("msg").textContent).toBe("Saved."));

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ maxSessions: 24, nodeName: "renamed" });
    // Numbers go out as numbers: the settings schema rejects a string.
    expect(typeof posted[0].maxSessions).toBe("number");
    expect($("unsaved").textContent).toBe("");
    expect($("revert").disabled).toBe(true);

    // The form is the node's again once it has been saved.
    stored = { ...stored, nodeName: "renamed-by-the-host" };
    await poll();
    expect($("nodeName").value).toBe("renamed-by-the-host");
  });

  it("throws the edits away on Revert, changing nothing on the node", async () => {
    await startPage();
    type("maxSessions", "24");
    expect($("revert").disabled).toBe(false);
    expect($("unsaved").textContent).not.toBe("");

    $("revert").click();
    await vi.waitFor(() => expect($("maxSessions").value).toBe("10"));

    expect(posted).toEqual([]);
    expect($("revert").disabled).toBe(true);
    expect($("unsaved").textContent).toBe("");

    // And the poll owns the form again afterwards.
    stored = { ...stored, maxSessions: 6 };
    await poll();
    expect($("maxSessions").value).toBe("6");
  });

  it("holds on to the edits when the node rejects the save", async () => {
    await startPage();
    type("maxSessions", "24");

    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve({ ok: false, json: async () => ({ error: "Too many sessions" }) }),
    );
    $("save").click();
    await vi.waitFor(() => expect($("msg").textContent).toBe("Too many sessions"));

    // A rejected save is the moment the edits are least safe to discard.
    expect($("maxSessions").value).toBe("24");
    expect($("revert").disabled).toBe(false);
    await poll();
    expect($("maxSessions").value).toBe("24");
  });
});

describe("Copilot session history", () => {
  it("sorts, searches, and selects by stable session id", async () => {
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/sessions") {
        return reply({
          sessions: [
            {
              id: "stable-old",
              title: null,
              updatedAt: null,
              createdAt: null,
              status: "Available",
              workspaceName: "Legacy project",
              resumable: true,
              resumeReason: null,
              legacy: true,
            },
            {
              id: "stable-new",
              title: "Current work",
              updatedAt: "2026-08-28T23:00:00.000Z",
              createdAt: null,
              status: "Available",
              workspaceName: "Fleet",
              resumable: true,
              resumeReason: null,
              legacy: false,
            },
          ],
        });
      }
      return respond(path, init);
    });
    await startPage();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-session-id]")).toHaveLength(2),
    );

    const rows = document.querySelectorAll("[data-session-id]");
    expect([...rows].map((row) => row.dataset.sessionId)).toEqual([
      "stable-new",
      "stable-old",
    ]);
    rows[0]?.click();
    expect($("sessionStableId").textContent).toBe("stable-new");

    type("sessionSearch", "legacy");
    expect(
      [...document.querySelectorAll("[data-session-id]")].map(
        (row) => row.dataset.sessionId,
      ),
    ).toEqual(["stable-old"]);
  });

  it("prevents a repeated click from sending a duplicate resume", async () => {
    let finishResume;
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/sessions") {
        return reply({
          sessions: [
            {
              id: "stable-session",
              title: "Resume me",
              updatedAt: "2026-08-28T23:00:00.000Z",
              createdAt: null,
              status: "Available",
              workspaceName: "Fleet",
              resumable: true,
              resumeReason: null,
              legacy: false,
            },
          ],
        });
      }
      if (path === "/api/sessions/stable-session/resume" && init?.method === "POST") {
        return new Promise((resolve) => {
          finishResume = resolve;
        });
      }
      return respond(path, init);
    });
    await startPage();
    await vi.waitFor(() => expect($("sessionList").textContent).toContain("Resume me"));
    document.querySelector("[data-session-id]")?.click();

    $("resumeSession").click();
    $("resumeSession").click();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path]) => String(path).endsWith("/stable-session/resume")),
    ).toHaveLength(1);

    finishResume({
      ok: true,
      json: async () => ({ sessionId: "fleet-session", state: "starting" }),
    });
    await vi.waitFor(() => expect($("resumeSession").textContent).toBe("Resumed"));
    expect($("resumeSession").disabled).toBe(true);
  });

  it("paginates large histories without losing the selected session", async () => {
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/sessions") {
        return reply({
          sessions: [
            {
              id: "page-one",
              title: "First page",
              updatedAt: "2026-08-28T23:00:00.000Z",
              createdAt: null,
              status: "Available",
              workspaceName: "Fleet",
              resumable: true,
              resumeReason: null,
              legacy: false,
            },
          ],
          nextCursor: "opaque:2",
        });
      }
      if (path === "/api/sessions?cursor=opaque%3A2") {
        return reply({
          sessions: [
            {
              id: "page-two",
              title: "Second page",
              updatedAt: "2026-08-27T23:00:00.000Z",
              createdAt: null,
              status: "Available",
              workspaceName: "Fleet",
              resumable: true,
              resumeReason: null,
              legacy: false,
            },
          ],
        });
      }
      if (path === "/api/sessions/page-one/preview") {
        return reply({
          items: [{ role: "assistant", text: "retained preview" }],
          truncated: false,
        });
      }
      return respond(path, init);
    });
    await startPage();
    await vi.waitFor(() => expect($("sessionList").textContent).toContain("First page"));
    document.querySelector('[data-session-id="page-one"]')?.click();
    $("loadPreview").click();
    await vi.waitFor(() =>
      expect($("sessionPreview").textContent).toContain("retained preview"),
    );

    $("sessionMore").click();
    await vi.waitFor(() => expect($("sessionList").textContent).toContain("Second page"));

    expect(document.querySelectorAll("[data-session-id]")).toHaveLength(2);
    expect($("sessionStableId").textContent).toBe("page-one");
    expect($("sessionPreview").textContent).toContain("retained preview");
  });

  it("explains in the new-session dialog when placements cannot be loaded", async () => {
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/fleet") {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "Host unavailable" }),
        });
      }
      return respond(path, init);
    });
    await startPage();
    await vi.waitFor(() =>
      expect($("newSessionPlacement").dataset.unavailableReason).toBe("Host unavailable"),
    );
    $("newSessionDialog").showModal = () => {
      $("newSessionDialog").open = true;
    };

    $("newSession").click();

    expect($("newSessionMsg").textContent).toContain("Host unavailable");
  });

  it("ignores an older Fleet load that finishes after a newer successful load", async () => {
    let finishInitialFleet;
    let initialFleetParsed;
    const parsed = new Promise((resolve) => {
      initialFleetParsed = resolve;
    });
    let fleetLoads = 0;
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/fleet") {
        fleetLoads += 1;
        if (fleetLoads === 1) {
          return new Promise((resolve) => {
            finishInitialFleet = resolve;
          });
        }
        return reply({
          workspaces: [{ id: "ws-1", name: "Fleet" }],
          placements: [
            {
              id: "pl-1",
              workspaceId: "ws-1",
              workspaceName: "Fleet",
              localPath: "/repo",
            },
          ],
        });
      }
      if (path === "/api/workspaces" && init?.method === "POST") {
        return reply({ id: "ws-1", name: "Fleet" });
      }
      return respond(path, init);
    });
    await startPage();
    $("wsName").value = "Fleet";
    $("wsAdd").click();
    await vi.waitFor(() =>
      expect($("newSessionPlacement").querySelector('[value="pl-1"]')).toBeTruthy(),
    );

    finishInitialFleet({
      ok: false,
      json: async () => {
        initialFleetParsed();
        return { error: "stale failure" };
      },
    });
    await parsed;
    await Promise.resolve();

    expect($("newSessionPlacement").querySelector('[value="pl-1"]')).toBeTruthy();
    expect($("newSessionPlacement").dataset.unavailableReason).toBe("");
    expect($("wsMsg").textContent).not.toContain("stale failure");
  });

  it("ignores a context preview that arrives after selection changed", async () => {
    let finishOldPreview;
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (path === "/api/sessions") {
        return reply({
          sessions: ["old", "new"].map((id) => ({
            id,
            title: id,
            updatedAt: "2026-08-28T23:00:00.000Z",
            createdAt: null,
            status: "Available",
            workspaceName: "Fleet",
            resumable: true,
            resumeReason: null,
            legacy: false,
          })),
        });
      }
      if (path === "/api/sessions/old/preview") {
        return new Promise((resolve) => {
          finishOldPreview = resolve;
        });
      }
      if (path === "/api/sessions/new/preview") {
        return reply({
          items: [{ role: "assistant", text: "new selection context" }],
          truncated: false,
        });
      }
      return respond(path, init);
    });
    await startPage();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-session-id]")).toHaveLength(2),
    );
    const oldRow = document.querySelector('[data-session-id="old"]');
    oldRow?.click();
    $("loadPreview").click();
    document.querySelector('[data-session-id="new"]')?.click();
    $("loadPreview").click();
    await vi.waitFor(() =>
      expect($("sessionPreview").textContent).toContain("new selection context"),
    );

    let oldPreviewParsed;
    const parsed = new Promise((resolve) => {
      oldPreviewParsed = resolve;
    });
    finishOldPreview({
      ok: true,
      json: async () => {
        oldPreviewParsed();
        return {
          items: [{ role: "assistant", text: "stale context" }],
          truncated: false,
        };
      },
    });
    await parsed;
    await vi.waitFor(() =>
      expect($("sessionPreview").textContent).toContain("new selection context"),
    );
    expect($("sessionPreview").textContent).not.toContain("stale context");
  });
});
