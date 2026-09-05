import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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
  const close = vi.fn();
  const openConnection = vi.fn(async (onUpdate: (update: acp.SessionUpdate) => void) => ({
    initialize: async () => options.initialize ?? capabilities,
    list,
    load: async (...args: Parameters<typeof load>) => {
      for (const update of options.replay ?? []) onUpdate(update);
      await load(...args);
    },
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
