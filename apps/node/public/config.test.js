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
