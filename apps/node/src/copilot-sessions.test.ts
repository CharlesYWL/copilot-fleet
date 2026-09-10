import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { CopilotSessionDiscovery } from "./copilot-sessions.js";

const capabilities: acp.InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { list: {} },
  },
};

function setup(options: {
  initialize?: acp.InitializeResponse;
  pages?: Record<string, acp.ListSessionsResponse>;
  replay?: acp.SessionUpdate[];
  loadError?: Error;
  deleteError?: Error;
  omitDelete?: boolean;
  now?: () => number;
  previewCharacters?: number;
  previewItems?: number;
}) {
  const list = vi.fn(async (cursor?: string) => {
    return options.pages?.[cursor ?? ""] ?? { sessions: [] };
  });
  const load = vi.fn(async () => {
    if (options.loadError) throw options.loadError;
  });
  const remove = vi.fn(async (_sessionId: string) => {
    if (options.deleteError) throw options.deleteError;
  });
  const initialize = vi.fn(async () => options.initialize ?? capabilities);
  const close = vi.fn();
  const openConnection = vi.fn(async (onUpdate: (update: acp.SessionUpdate) => void) => ({
    initialize,
    list,
    load: async (...args: Parameters<typeof load>) => {
      for (const update of options.replay ?? []) onUpdate(update);
      await load(...args);
    },
    ...(options.omitDelete ? {} : { delete: remove }),
    close,
  }));
  return {
    discovery: new CopilotSessionDiscovery({
      getCopilotCommand: () => "copilot",
      getContextTier: () => "default",
      openConnection,
      ...(options.now ? { now: options.now } : {}),
      ...(options.previewCharacters !== undefined
        ? { previewCharacters: options.previewCharacters }
        : {}),
      ...(options.previewItems !== undefined
        ? { previewItems: options.previewItems }
        : {}),
    }),
    list,
    load,
    remove,
    initialize,
    close,
    openConnection,
  };
}

const text = (
  sessionUpdate: "user_message_chunk" | "agent_message_chunk",
  value: string,
): acp.SessionUpdate =>
  ({
    sessionUpdate,
    content: { type: "text", text: value },
  }) as acp.SessionUpdate;

describe("Copilot session retention", () => {
  const now = Date.parse("2026-09-10T00:00:00.000Z");
  const cutoff = now - 30 * 86_400_000;
  const removable: acp.InitializeResponse = {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: {}, delete: {} } },
  };
  const oldSession = {
    sessionId: "expired",
    cwd: "C:\\repo",
    updatedAt: new Date(cutoff).toISOString(),
  };
  const fixture = () =>
    setup({
      initialize: removable,
      pages: { "": { sessions: [oldSession] } },
      now: () => now,
    });

  afterEach(() => vi.useRealTimers());

  it.each([
    [{ delete: {} }, "unsupported_list"],
    [{ list: {} }, "unsupported_delete"],
    [{ list: {}, delete: null }, "unsupported_delete"],
    [{ list: null, delete: {} }, "unsupported_list"],
  ] as const)(
    "requires both public capabilities (%j)",
    async (sessionCapabilities, code) => {
      const { discovery, list, remove, close } = setup({
        initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities } },
      });
      const beforeDelete = vi.fn(async () => {});

      await expect(
        discovery.deleteInactiveSession("expired", cutoff, beforeDelete),
      ).rejects.toMatchObject({ code });
      expect(list).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(beforeDelete).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("refuses a connection without the advertised delete handler before stopping anything", async () => {
    const { discovery, close } = setup({ initialize: removable, omitDelete: true });
    const beforeDelete = vi.fn(async () => {});
    await expect(
      discovery.deleteInactiveSession("expired", cutoff, beforeDelete),
    ).rejects.toMatchObject({ code: "unsupported_delete" });
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses one fresh connection and includes the exact cutoff, without load or prompt", async () => {
    const { discovery, list, remove, load, close, openConnection } = fixture();
    const beforeDelete = vi.fn(async () => {
      expect(list).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
    });
    await discovery.deleteInactiveSession("expired", cutoff, beforeDelete);
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledExactlyOnceWith("expired");
    expect(load).not.toHaveBeenCalled();
    expect(openConnection).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends only public initialize/list/delete requests through the existing ACP transport", async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const kill = vi.fn();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      kill,
    });
    const requests: Array<{ id: number; method: string; params: unknown }> = [];
    let pending = "";
    child.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const message = JSON.parse(pending.slice(0, end)) as (typeof requests)[number];
        pending = pending.slice(end + 1);
        requests.push(message);
        const result =
          message.method === "initialize"
            ? removable
            : message.method === "session/list"
              ? { sessions: [oldSession] }
              : {};
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    });
    const spawnProcess = vi.fn(() => child);
    const discovery = new CopilotSessionDiscovery({
      getCopilotCommand: () => "fixture-copilot",
      getContextTier: () => "default",
      now: () => now,
      spawnProcess: spawnProcess as unknown as typeof spawn,
    });

    await discovery.deleteInactiveSession("expired", cutoff);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/list",
      "session/delete",
    ]);
    expect(requests[2]!.params).toEqual({ sessionId: "expired" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not trust stale listing or preview metadata for deletion", async () => {
    const { discovery, list, remove, close } = fixture();
    await discovery.list();
    expect(discovery.get("expired")).toBeDefined();
    list.mockResolvedValueOnce({
      sessions: [{ ...oldSession, updatedAt: new Date(now).toISOString() }],
    });
    const beforeDelete = vi.fn(async () => {});
    await expect(
      discovery.deleteInactiveSession("expired", cutoff, beforeDelete),
    ).rejects.toMatchObject({ code: "session_active" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    null,
    "",
    "invalid",
    "2026-06-31T00:00:00.000Z",
    "2026-07-01",
    new Date(cutoff + 1).toISOString(),
    new Date(now + 86_400_000).toISOString(),
  ])("refuses unverifiable or recent updatedAt %s", async (updatedAt) => {
    const { discovery, remove, close } = setup({
      initialize: removable,
      pages: {
        "": {
          sessions: [
            {
              sessionId: oldSession.sessionId,
              cwd: oldSession.cwd,
              ...(updatedAt === undefined ? {} : { updatedAt }),
            },
          ],
        },
      },
      now: () => now,
    });
    const beforeDelete = vi.fn(async () => {});
    await expect(
      discovery.deleteInactiveSession("expired", cutoff, beforeDelete),
    ).rejects.toMatchObject({ code: "session_active" });
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses future metadata even if a caller supplies a future cutoff", async () => {
    const { discovery, list, remove } = fixture();
    list.mockResolvedValueOnce({
      sessions: [{ ...oldSession, updatedAt: new Date(now + 1).toISOString() }],
    });
    await expect(
      discovery.deleteInactiveSession("expired", now + 86_400_000),
    ).rejects.toMatchObject({ code: "session_active" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("walks opaque cursors and deletes only the exact requested id", async () => {
    const { discovery, list, remove, openConnection, close } = setup({
      initialize: removable,
      pages: {
        "": {
          sessions: [{ ...oldSession, sessionId: "expired-other" }],
          nextCursor: "opaque:2",
        },
        "opaque:2": { sessions: [oldSession] },
      },
    });
    await discovery.deleteInactiveSession("expired", cutoff);
    expect(list.mock.calls).toEqual([[undefined], ["opaque:2"]]);
    expect(remove).toHaveBeenCalledExactlyOnceWith("expired");
    expect(openConnection).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats absence across all pages as success and still releases the local process", async () => {
    const { discovery, list, remove, close } = setup({
      initialize: removable,
      pages: {
        "": { sessions: [oldSession], nextCursor: "last" },
        last: { sessions: [] },
      },
    });
    const beforeDelete = vi.fn(async () => {});
    await discovery.deleteInactiveSession("missing", cutoff, beforeDelete);
    expect(list.mock.calls).toEqual([[undefined], ["last"]]);
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["repeat", "cycle", "empty"])("rejects %s pagination cursors", async (kind) => {
    const { discovery, list, remove, close } = setup({
      initialize: removable,
      pages: {
        "": { sessions: [], nextCursor: kind === "empty" ? "" : "page-2" },
        "page-2": {
          sessions: [],
          nextCursor: kind === "repeat" ? "page-2" : "page-3",
        },
        "page-3": { sessions: [], nextCursor: "page-2" },
      },
    });
    const beforeDelete = vi.fn(async () => {});
    await expect(
      discovery.deleteInactiveSession("missing", cutoff, beforeDelete),
    ).rejects.toMatchObject({
      code: "list_failed",
      message: expect.stringContaining("cursor"),
    });
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("invalidates all cached pages and preview metadata after successful cleanup", async () => {
    const { discovery, list } = fixture();
    await discovery.list();
    await discovery.deleteInactiveSession("expired", cutoff);
    expect(discovery.get("expired")).toBeUndefined();
    await expect(discovery.preview("expired")).rejects.toMatchObject({
      code: "session_not_found",
    });
    await discovery.list();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("reports connection failures and refuses an empty exact id without opening Copilot", async () => {
    const { discovery, openConnection, close } = fixture();
    await expect(discovery.deleteInactiveSession("", cutoff)).rejects.toMatchObject({
      code: "delete_failed",
    });
    expect(openConnection).not.toHaveBeenCalled();
    openConnection.mockRejectedValueOnce(new Error("Cannot open Copilot"));
    await expect(
      discovery.deleteInactiveSession("expired", cutoff),
    ).rejects.toMatchObject({
      code: "delete_failed",
      message: expect.stringContaining("Cannot open Copilot"),
    });
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["initialize", "list", "delete", "guard"] as const)(
    "reports %s failures and always closes the connection",
    async (operation) => {
      const { discovery, initialize, list, remove, close } = fixture();
      const beforeDelete = vi.fn(async () => {});
      const failure = new Error("injected failure");
      if (operation === "initialize") initialize.mockRejectedValueOnce(failure);
      if (operation === "list") list.mockRejectedValueOnce(failure);
      if (operation === "delete") remove.mockRejectedValueOnce(failure);
      if (operation === "guard") beforeDelete.mockRejectedValueOnce(failure);
      await expect(
        discovery.deleteInactiveSession("expired", cutoff, beforeDelete),
      ).rejects.toMatchObject({
        code:
          operation === "initialize" || operation === "list"
            ? "list_failed"
            : "delete_failed",
        message: expect.stringContaining("injected failure"),
      });
      if (operation !== "delete") expect(remove).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(["initialize", "list", "delete"] as const)(
    "times out %s without leaking the connection",
    async (operation) => {
      vi.useFakeTimers();
      const { discovery, initialize, list, remove, close } = fixture();
      if (operation === "initialize")
        initialize.mockReturnValueOnce(new Promise(() => {}));
      if (operation === "list") list.mockReturnValueOnce(new Promise(() => {}));
      if (operation === "delete") remove.mockReturnValueOnce(new Promise(() => {}));
      const result = expect(
        discovery.deleteInactiveSession("expired", cutoff),
      ).rejects.toMatchObject({
        code: operation === "delete" ? "delete_failed" : "list_failed",
        message: expect.stringContaining("timed out"),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
describe("CopilotSessionDiscovery", () => {
  it("reports a Copilot spawn failure instead of emitting an unhandled error", async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: vi.fn(),
    });
    const discovery = new CopilotSessionDiscovery({
      getCopilotCommand: () => "missing-copilot",
      getContextTier: () => "default",
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      }) as unknown as typeof spawn,
    });

    await expect(discovery.list()).rejects.toMatchObject({
      code: "list_failed",
      message: expect.stringContaining("Could not start Copilot"),
    });
  });

  it("preserves stable ids and optional current and legacy metadata", async () => {
    const { discovery } = setup({
      pages: {
        "": {
          sessions: [
            {
              sessionId: "stable-current",
              cwd: "C:\\repo",
              title: "Current",
              updatedAt: "2026-08-28T12:00:00.000Z",
            },
            { sessionId: "stable-legacy", cwd: "C:\\old" },
          ],
        },
      },
    });

    const result = await discovery.list();

    expect(result.sessions).toEqual([
      {
        id: "stable-current",
        cwd: "C:\\repo",
        additionalDirectories: [],
        loadSupported: true,
        title: "Current",
        updatedAt: "2026-08-28T12:00:00.000Z",
      },
      {
        id: "stable-legacy",
        cwd: "C:\\old",
        additionalDirectories: [],
        loadSupported: true,
      },
    ]);
  });

  it("passes opaque cursors and caches each metadata page briefly", async () => {
    const { discovery, list, openConnection } = setup({
      pages: {
        "": { sessions: [], nextCursor: "opaque:2" },
        "opaque:2": { sessions: [] },
      },
    });

    expect(await discovery.list()).toMatchObject({ nextCursor: "opaque:2" });
    await discovery.list();
    await discovery.list("opaque:2");

    expect(list.mock.calls).toEqual([[undefined], ["opaque:2"]]);
    expect(openConnection).toHaveBeenCalledTimes(2);
  });

  it("builds a bounded recent user/assistant preview from replayed text chunks", async () => {
    const { discovery, load } = setup({
      pages: {
        "": { sessions: [{ sessionId: "s1", cwd: "C:\\repo" }] },
      },
      replay: [
        text("user_message_chunk", "old"),
        text("agent_message_chunk", "answer"),
        text("user_message_chunk", "newer"),
        text("agent_message_chunk", "abcdefghij"),
      ],
      previewCharacters: 12,
      previewItems: 2,
    });
    await discovery.list();

    const preview = await discovery.preview("s1");

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", cwd: "C:\\repo" }),
      false,
    );
    expect(preview).toEqual({
      items: [
        { role: "user", text: "er" },
        { role: "assistant", text: "abcdefghij" },
      ],
      truncated: true,
    });
  });

  it("returns no preview items when the configured item limit is zero", async () => {
    const { discovery } = setup({
      pages: {
        "": { sessions: [{ sessionId: "s1", cwd: "/repo", title: "bounded" }] },
      },
      replay: [text("agent_message_chunk", "hidden")],
      previewItems: 0,
    });
    await discovery.list();

    await expect(discovery.preview("s1")).resolves.toEqual({
      items: [],
      truncated: true,
    });
  });

  it("classifies unsupported list capability failures", async () => {
    const initialize = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    } as const;
    const { discovery } = setup({ initialize });
    await expect(discovery.list()).rejects.toMatchObject({ code: "unsupported_list" });
  });

  it("still discovers sessions when this Copilot cannot load them", async () => {
    const { discovery } = setup({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {} } },
      },
      pages: { "": { sessions: [{ sessionId: "listed", cwd: "C:\\repo" }] } },
    });

    await expect(discovery.list()).resolves.toMatchObject({
      sessions: [{ id: "listed", loadSupported: false }],
    });
    await expect(discovery.preview("listed")).rejects.toMatchObject({
      code: "unsupported_load",
    });
  });

  it("classifies missing cached metadata and corrupt load failures explicitly", async () => {
    const missing = setup({}).discovery;
    await expect(missing.preview("unknown")).rejects.toMatchObject({
      code: "session_not_found",
    });

    const { discovery } = setup({
      pages: { "": { sessions: [{ sessionId: "broken", cwd: "C:\\repo" }] } },
      loadError: new Error("corrupt session"),
    });
    await discovery.list();
    await expect(discovery.preview("broken")).rejects.toMatchObject({
      code: "load_failed",
      message: expect.stringContaining("corrupt session"),
    });
  });
});
