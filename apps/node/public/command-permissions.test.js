import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommandPermissions } from "./command-permissions.js";

const page = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.html"),
  "utf8",
);
const markup = page.slice(page.indexOf("<body>") + 6, page.indexOf("</body>"));
const $ = (id) => document.getElementById(id);
const editor = () => $("commandPermissionEditor");
const save = () => $("commandPermissionSave").click();
const format = () => $("commandPermissionFormat").click();
const reload = () => $("commandPermissionsRefresh").click();
const message = () => $("commandPermissionsMessage").textContent;
const endpoint = "/api/command-permissions";
const initialEntries = [
  { command: "cd", path: "*" },
  { command: "Set-Location", path: "*" },
  { command: "git status", path: "C:\\project" },
  { command: "npm run build", path: "C:\\other", hostId: "foreign-host" },
];
const pattern = { command: "git *", path: "Q:\\Repos\\*", match: "pattern" };
let stored;
let posted;
let failure;

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => structuredClone(body),
});
const respond = async (url, init) => {
  if (url !== endpoint) throw new Error(`Unexpected request: ${url}`);
  if (init?.method !== "POST") return response(stored);
  const body = JSON.parse(init.body);
  posted.push(body);
  if (failure) return response({ error: failure.message }, failure.status);
  if (body.expectedVersion !== stored.version) {
    return response({ error: "Stale version" }, 409);
  }
  stored = { ...stored, version: stored.version + 1, entries: body.entries };
  return response(stored);
};
const type = (text) => {
  editor().value = text;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
  return text;
};
const draft = (entries = [...initialEntries, pattern]) => type(JSON.stringify(entries));
const poll = () => vi.advanceTimersByTimeAsync(5000);
const settled = () =>
  vi.waitFor(() =>
    expect($("commandPermissionForm").getAttribute("aria-busy")).toBe("false"),
  );
const start = async () => {
  initCommandPermissions();
  await settled();
};
const expectOneObjectPerLine = (entries) => {
  const lines = editor().value.split("\n");
  expect(lines[0]).toBe("[");
  expect(lines.at(-1)).toBe("]");
  expect(lines.slice(1, -1).map((line) => JSON.parse(line.replace(/,$/, "")))).toEqual(
    entries,
  );
};
const focusDraft = () => {
  editor().focus();
  editor().setSelectionRange(4, 11);
  editor().scrollTop = 90;
};
const expectDraft = (text) => {
  expect(editor().value).toBe(text);
  expect(document.activeElement).toBe(editor());
  expect(editor().selectionStart).toBe(Math.min(4, text.length));
  expect(editor().selectionEnd).toBe(Math.min(11, text.length));
  expect(editor().scrollTop).toBe(90);
};

beforeEach(() => {
  document.body.innerHTML = markup;
  stored = {
    version: 7,
    rules: [
      {
        id: "private-id",
        commandKey: `git status @sha256:${"ab".repeat(32)}`,
        path: "C:\\project",
        hostId: "private-current-host",
        builtin: false,
      },
    ],
    entries: structuredClone(initialEntries),
  };
  posted = [];
  failure = null;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(respond));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("persistent allowlist editor", () => {
  it("loads only editable entries into an accessible multiline editor", async () => {
    expect(editor().readOnly).toBe(true);
    expect($("commandPermissionSave").disabled).toBe(true);
    expect(editor().placeholder).toContain("Loading saved allowlist");
    await start();
    expectOneObjectPerLine(initialEntries);
    expect(editor().readOnly).toBe(false);
    expect(editor().rows).toBe(18);
    expect(editor().labels[0].textContent).toContain("Persistent allowlist (JSON)");
    expect(editor().getAttribute("aria-describedby")).toContain(
      "commandPermissionInstructions",
    );
    expect(editor().value).not.toMatch(/private-|@sha256|builtin|commandKey/);
    expect(editor().value).toContain("foreign-host");
    expect($("commandPermissionAdd")).toBeNull();
    expect($("commandPermissionRules")).toBeNull();
    expect($("commandPermissions").querySelector('input[type="checkbox"]')).toBeNull();
    const copy = $("commandPermissions").textContent.replace(/\s+/g, " ");
    expect(copy).toContain("Only persistent permissions");
    expect(copy).toContain("Temporary approvals are not shown or changed");
    expect(copy).not.toMatch(/Once|During Orchestrator session|drain/i);
    expect(copy).toContain("Compound scripts");
    expect(copy).toContain("Any script text change asks again");
    expect(copy).toContain("Escape each Windows backslash");
    expect(
      JSON.parse(document.querySelector(".command-permission-example code").textContent),
    ).toEqual([
      { command: "cd", path: "*" },
      { command: "git status", path: "Q:\\Repos\\TridentWarehouse-UX" },
      pattern,
    ]);
    await poll();
    expect(posted).toEqual([]);
  });

  it("bulk adds and deletes only on explicit Save, preserving foreign Host scope", async () => {
    await start();
    const entries = [
      ...initialEntries.slice(2),
      pattern,
      { command: "git diff", path: "D:\\work with spaces", match: "command" },
    ];
    draft(entries);
    await poll();
    expect(posted).toEqual([]);
    expect($("commandPermissionsRefresh").textContent).toBe("Discard draft and reload");
    save();
    await settled();
    expect(posted).toEqual([{ expectedVersion: 7, entries }]);
    expect(message()).toBe("Allowlist saved.");
    expectOneObjectPerLine(entries);
    expect($("commandPermissionSave").disabled).toBe(true);
    expect($("commandPermissionsRefresh").textContent).toBe("Reload saved");
    expect($("commandPermissionsDraft").textContent).toBe("");
    expect(posted[0]).not.toHaveProperty("rules");
    await poll();
    reload();
    await settled();
    expect(JSON.parse(editor().value)).toEqual(entries);
    expect(posted).toHaveLength(1);
  });

  it("formats one object per line without posting, including escaped exact scripts", async () => {
    const script = {
      command: 'Write-Output "first"\nSet-Location "Q:\\Repos\\sample"; git status',
      path: "Q:\\Repos\\sample",
      match: "exact",
    };
    stored.entries.push(script);
    await start();
    expectOneObjectPerLine(stored.entries);
    expect(editor().value).toContain('Write-Output \\"first\\"\\nSet-Location');
    expect(editor().value).not.toContain("exact-script:sha256:");
    const entries = [...stored.entries, pattern];
    type(JSON.stringify(entries, null, 4));
    format();
    expectOneObjectPerLine(entries);
    expect(message()).toBe("JSON formatted. Nothing was saved.");
    await poll();
    expect(posted).toEqual([]);
    save();
    await settled();
    expect(posted[0]).toEqual({ expectedVersion: 7, entries });
    expect(stored.entries.at(-2)).toEqual(script);
  });

  it("warns about legacy references, preserving or deleting them without decoding hashes", async () => {
    const legacy = {
      legacyKey: `exact-script:sha256:${"ab".repeat(32)}`,
      path: "C:\\legacy",
      hostId: "legacy-host",
    };
    stored.entries.push(legacy);
    await start();
    expect($("commandPermissionsLegacy").hidden).toBe(false);
    expect($("commandPermissionsLegacy").textContent).toContain(
      "read-only authority reference",
    );
    expect(JSON.parse(editor().value).at(-1)).toEqual(legacy);
    draft([...stored.entries, pattern]);
    save();
    await settled();
    expect(posted[0].entries.at(-2)).toEqual(legacy);
    draft(stored.entries.filter((entry) => !entry.legacyKey));
    expect($("commandPermissionsLegacy").hidden).toBe(true);
    save();
    await settled();
    expect(posted[1].entries.some((entry) => entry.legacyKey)).toBe(false);
    await poll();
    expect($("commandPermissionsLegacy").hidden).toBe(true);
  });

  it.each([
    { legacyKey: "changed-key" },
    { path: "C:\\expanded-authority" },
    { hostId: "another-host" },
  ])("rejects changes to a legacy reference: %j", async (change) => {
    const legacy = { legacyKey: "opaque", path: "C:\\legacy", hostId: "foreign-host" };
    stored.entries = [legacy];
    await start();
    const text = draft([{ ...legacy, ...change }]);
    format();
    expect(message()).toContain("Keep the saved row unchanged or delete it");
    expect(editor().value).toBe(text);
    save();
    expect(posted).toEqual([]);
    expect(editor().value).toBe(text);
  });

  it.each([
    ["[", "Invalid JSON"],
    ['[{"command":"cd","path":"Q:\\Repos"}]', "escape Windows backslashes"],
    ['[{"command":"cd","path":"*"},]', "remove trailing commas"],
    ['{"command":"cd","path":"*"}', "Use a JSON array"],
    ["null", "Use a JSON array"],
    ["[null]", "Entry 1: use a command/path object"],
    ['[{"command":"cd"}]', "path must be a non-empty string"],
    ['[{"command":"","path":"*"}]', "command must be a non-empty string"],
    ['[{"command":"cd","path":"*","match":"session"}]', "match must be"],
    ['[{"command":"cd","path":"*","id":"private"}]', "only command, path, match, hostId"],
    ['[{"command":"cd","path":"*","hostId":4}]', "hostId must be a non-empty string"],
    ['[{"legacyKey":"invented","path":"*"}]', "read-only authority references"],
  ])("preserves invalid drafts and gives actionable errors: %s", async (text, error) => {
    await start();
    type(text);
    focusDraft();
    format();
    expect(message()).toContain(error);
    expectDraft(text);
    save();
    await poll();
    expect(message()).toContain(error);
    expect($("commandPermissionsMessage").getAttribute("role")).toBe("alert");
    expect(editor().getAttribute("aria-invalid")).toBe("true");
    expectDraft(text);
    expect(posted).toEqual([]);
  });

  it("holds a dirty document and its caret on unchanged polls, without saving", async () => {
    await start();
    const text = draft();
    focusDraft();
    await poll();
    expectDraft(text);
    expect($("commandPermissionSave").disabled).toBe(false);
    expect($("unsaved").textContent).toBe("");
    expect(posted).toEqual([]);
    save();
    await settled();
    expect(posted[0].expectedVersion).toBe(7);
  });

  it("adopts clean server changes but leaves an unchanged editor and caret alone", async () => {
    await start();
    const text = editor().value;
    focusDraft();
    await poll();
    expectDraft(text);
    stored.version++;
    stored.entries.push(pattern);
    await poll();
    expectOneObjectPerLine(stored.entries);
    expect($("commandPermissionSave").disabled).toBe(true);
    draft([]);
    save();
    await settled();
    expect(posted).toEqual([{ expectedVersion: 8, entries: [] }]);
    expect(editor().value).toBe("[]");
  });

  it("freezes a dirty baseline on server changes until explicit discard and reload", async () => {
    await start();
    const text = draft([pattern]);
    focusDraft();
    stored.version++;
    stored.entries = [{ command: "git log", path: "C:\\new" }];
    await poll();
    expectDraft(text);
    expect(message()).toContain("changed elsewhere");
    expect(message()).toContain("Discard draft and reload");
    expect($("commandPermissionSave").disabled).toBe(true);
    save();
    format();
    expect(message()).toContain("changed elsewhere");
    expect($("commandPermissionSave").disabled).toBe(true);
    const requests = vi.mocked(fetch).mock.calls.length;
    await poll();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requests);
    expect(posted).toEqual([]);
    const confirm = vi.spyOn(window, "confirm");
    reload();
    await settled();
    expect(confirm).not.toHaveBeenCalled();
    expectOneObjectPerLine(stored.entries);
    expect(message()).toBe("");
    expect(posted).toEqual([]);
    draft([...stored.entries, pattern]);
    save();
    await settled();
    expect(posted).toEqual([
      { expectedVersion: 8, entries: [{ command: "git log", path: "C:\\new" }, pattern] },
    ]);
  });

  it("does not unlock a conflict if the user returns to the original text", async () => {
    await start();
    const original = editor().value;
    draft();
    stored.version++;
    await poll();
    type(original);
    format();
    expect(message()).toContain("changed elsewhere");
    draft();
    save();
    expect($("commandPermissionSave").disabled).toBe(true);
    expect(posted).toEqual([]);
  });

  it.each([false, true])(
    "keeps edits entered after a read starts (manual reload: %s)",
    async (manual) => {
      await start();
      let finish;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      if (manual) {
        draft();
        reload();
      } else {
        await poll();
      }
      const text = draft([pattern]);
      focusDraft();
      finish(response({ ...stored, version: 8, entries: [] }));
      await settled();
      expectDraft(text);
      expect(message()).toContain("changed elsewhere");
      expect($("commandPermissionSave").disabled).toBe(true);
      expect(posted).toEqual([]);
    },
  );

  it("keeps edits entered during reload even when the server version is unchanged", async () => {
    await start();
    draft();
    let finish;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    reload();
    const text = draft([pattern]);
    focusDraft();
    finish(response(stored));
    await settled();
    expectDraft(text);
    expect(message()).toContain("Newer edits were kept");
    save();
    await settled();
    expect(posted).toEqual([{ expectedVersion: 7, entries: [pattern] }]);
  });

  it("requires explicit discard after a CAS conflict and never auto-retries", async () => {
    await start();
    const text = draft();
    focusDraft();
    stored.version++;
    stored.entries.push({ command: "git log", path: "C:\\new" });
    save();
    await settled();
    expect(message()).toContain("Stale version");
    expect(message()).toContain("Discard draft and reload");
    expectDraft(text);
    expect($("commandPermissionSave").disabled).toBe(true);
    await poll();
    expectDraft(text);
    expect(posted).toHaveLength(1);
    reload();
    await settled();
    expectOneObjectPerLine(stored.entries);
    expect(message()).toBe("");
    expect(posted).toHaveLength(1);
  });

  it.each([
    [400, "Entry 1: invalid command pattern"],
    [500, "Could not persist allowlist: disk full"],
  ])(
    "preserves failed saves (%s) and only retries on explicit Save",
    async (status, error) => {
      await start();
      const text = draft();
      focusDraft();
      failure = { status, message: error };
      save();
      await settled();
      expect(message()).toContain(error);
      expectDraft(text);
      await poll();
      expect(message()).toContain(error);
      expectDraft(text);
      expect(stored.entries).toEqual(initialEntries);
      expect(posted).toHaveLength(1);
      failure = null;
      save();
      await settled();
      expect(posted).toHaveLength(2);
      expect(posted[1].expectedVersion).toBe(7);
      expect(message()).toBe("Allowlist saved.");
    },
  );

  it("retains a draft on network failure without retrying the save", async () => {
    await start();
    const text = draft();
    focusDraft();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection lost"));
    save();
    await settled();
    await poll();
    expectDraft(text);
    expect(message()).toContain("Connection lost");
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("clears recovered read failures without clearing an unsaved document", async () => {
    await start();
    const text = draft();
    focusDraft();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection lost"));
    await poll();
    expect(message()).toContain("Connection lost");
    await poll();
    expect(message()).toBe("");
    expectDraft(text);
    expect(posted).toEqual([]);
  });

  it("prevents duplicate saves but preserves newer text and caret during the write", async () => {
    await start();
    draft();
    let finish;
    vi.mocked(fetch).mockImplementationOnce(
      (url, init) =>
        new Promise((resolve) => {
          finish = () => resolve(respond(url, init));
        }),
    );
    save();
    save();
    expect($("commandPermissionSave").disabled).toBe(true);
    expect($("commandPermissionsRefresh").disabled).toBe(true);
    expect(editor().readOnly).toBe(false);
    const text = draft([{ command: "git diff", path: "D:\\next" }]);
    focusDraft();
    const requests = vi.mocked(fetch).mock.calls.length;
    await poll();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requests);
    finish();
    await settled();
    expect(posted).toEqual([
      { expectedVersion: 7, entries: [...initialEntries, pattern] },
    ]);
    expectDraft(text);
    expect(message()).toContain("Newer edits are not saved");
    expect($("commandPermissionSave").disabled).toBe(false);
    await poll();
    expectDraft(text);
    save();
    await settled();
    expect(posted[1]).toEqual({
      expectedVersion: 8,
      entries: [{ command: "git diff", path: "D:\\next" }],
    });
  });

  it.each([200, 409, 500, 503])(
    "ignores late pre-save poll responses (%s)",
    async (status) => {
      await start();
      const oldSnapshot = structuredClone(stored);
      let finish;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await poll();
      draft();
      save();
      await settled();
      finish(response(status === 200 ? oldSnapshot : { error: "Old failure" }, status));
      await vi.advanceTimersByTimeAsync(0);
      expect(message()).toBe("Allowlist saved.");
      expectOneObjectPerLine([...initialEntries, pattern]);
      draft([pattern]);
      save();
      await settled();
      expect(posted[1]).toEqual({ expectedVersion: 8, entries: [pattern] });
    },
  );

  it("loads an empty array without inventing defaults or saving anything", async () => {
    stored.entries = [];
    await start();
    expect(editor().value).toBe("[]");
    expect($("commandPermissionSave").disabled).toBe(true);
    expect($("commandPermissionFormat").disabled).toBe(false);
    await poll();
    expect(posted).toEqual([]);
  });

  it.each(["missing entries", 404, 503])(
    "requires a Node upgrade instead of guessing editable entries: %s",
    async (mode) => {
      vi.mocked(fetch).mockResolvedValue(
        mode === "missing entries"
          ? response({ version: 7, rules: stored.rules })
          : response({ error: "Not supported" }, mode),
      );
      await start();
      expect(message()).toContain("Upgrade Node");
      expect(editor().value).toBe("");
      expect(editor().readOnly).toBe(true);
      expect($("commandPermissionSave").disabled).toBe(true);
      expect($("commandPermissionFormat").disabled).toBe(true);
      await poll();
      expect(posted).toEqual([]);
      vi.mocked(fetch).mockImplementation(respond);
      reload();
      await settled();
      expectOneObjectPerLine(initialEntries);
      expect(message()).toBe("");
    },
  );

  it("preserves the saved baseline and draft if a write needs an upgrade", async () => {
    await start();
    failure = { status: 503, message: "Runtime unavailable" };
    const text = draft();
    focusDraft();
    save();
    await settled();
    await poll();
    expectDraft(text);
    expect(message()).toContain("Upgrade Node");
    expect($("commandPermissionSave").disabled).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it.each([
    [
      "network failure",
      () => Promise.reject(new Error("Connection lost")),
      "Connection lost",
    ],
    [
      "HTTP error",
      () => Promise.resolve(response({ error: "Storage unavailable" }, 500)),
      "Storage unavailable",
    ],
    [
      "missing version",
      () => Promise.resolve(response({})),
      "Invalid command permissions",
    ],
    [
      "non-array entries",
      () => Promise.resolve(response({ version: 1, entries: {} })),
      "entries must be an array",
    ],
  ])("recovers from a read failure: %s", async (_name, reply, expected) => {
    vi.mocked(fetch).mockImplementation(reply);
    await start();
    expect(message()).toContain(expected);
    expect(editor().value).toBe("");
    expect($("commandPermissionSave").disabled).toBe(true);
    vi.mocked(fetch).mockImplementation(respond);
    reload();
    await settled();
    expectOneObjectPerLine(initialEntries);
    expect(message()).toBe("");
  });

  it("renders all editable values as text, never markup", async () => {
    stored.entries = [
      {
        command: "<img src=x onerror=alert(1)>",
        path: "C:\\<script>example</script>",
        hostId: "<svg onload=alert(1)>",
      },
    ];
    await start();
    expect($("commandPermissions").querySelector("img, script, svg")).toBeNull();
    expect(JSON.parse(editor().value)).toEqual(stored.entries);
    expect(posted).toEqual([]);
  });
});
