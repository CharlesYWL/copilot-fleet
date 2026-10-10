import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSchema, type TranscriptPage } from "@fleet/protocol";
import {
  connectSession,
  type SessionSnapshot,
  type SessionView,
} from "./session-connection";
import { nodeApi } from "./api";

class Stream {
  static instances: Stream[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    Stream.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const session = SessionSchema.parse({
  id: "selected",
  workspaceId: "w",
  workspaceName: "Workspace",
  placementId: "p",
  nodeId: "n",
  nodeName: "Node",
  state: "idle",
  name: "Session",
  initialPrompt: "Start",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  agentSessionId: "native",
});
const snapshot: SessionSnapshot = {
  session,
  permissions: [],
  messages: [],
  status: "online",
  offlineAllowed: false,
};
const page: TranscriptPage = {
  generation: "g1",
  revision: 1,
  start: 0,
  total: 1,
  prompts: [],
  blocks: [{ key: "b1", kind: "agent", text: "hello", createdAt: session.createdAt }],
};
const reply = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });
let connections: ReturnType<typeof connectSession>[] = [];

beforeEach(() => {
  Stream.instances = [];
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => reply(path.includes("transcript") ? page : snapshot)),
  );
});
afterEach(() => {
  connections.forEach((connection) => connection.close());
  connections = [];
  vi.unstubAllGlobals();
});

const open = () => {
  const views: SessionView[] = [];
  const notices: string[] = [];
  const connection = connectSession(
    "selected",
    (view) => views.push(view),
    (message) => notices.push(message),
  );
  connections.push(connection);
  const stream = Stream.instances.at(-1)!;
  return { connection, stream, views, notices };
};

describe("selected session transport", () => {
  it("waits for the subscription before requesting only the selected snapshot and newest page", async () => {
    const { stream, views } = open();
    expect(fetch).not.toHaveBeenCalled();
    expect(stream.url).toBe("/api/fleet-sessions/selected/stream");
    stream.onopen?.();
    await vi.waitFor(() => expect(views.at(-1)?.transcript).toBeDefined());
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      "/api/fleet-sessions/selected",
      "/api/fleet-sessions/selected/transcript?limit=200",
    ]);
  });

  it("buffers in-flight deltas and permissions without overwriting them with the snapshot", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementation((path) =>
      path.toString().includes("transcript")
        ? new Promise((resolve) => {
            finish = (value) => resolve(value as Response);
          })
        : (reply(snapshot) as Promise<Response>),
    );
    const { stream, views } = open();
    stream.onopen?.();
    stream.emit({
      type: "event",
      event: {
        eventId: "permission",
        sessionId: "selected",
        sequence: 2,
        type: "permission",
        createdAt: session.createdAt,
        payload: { requestId: "request", title: "Run command", options: [] },
      },
      transcript: {
        generation: "g1",
        revision: 2,
        change: { index: 0, block: { ...page.blocks[0], text: "hello world" } },
      },
    });
    finish({ ok: true, status: 200, json: async () => page });
    await vi.waitFor(() => expect(views.at(-1)?.transcript?.revision).toBe(2));
    expect(views.at(-1)?.transcript?.blocks[0]?.text).toBe("hello world");
    expect(views.at(-1)?.pendingPermission?.eventId).toBe("permission");
  });

  it("surfaces selected-session command refusals without resetting the transcript", async () => {
    const { stream, views, notices } = open();
    stream.onopen?.();
    await vi.waitFor(() => expect(views.at(-1)?.transcript).toBeDefined());
    const before = views.at(-1);
    stream.emit({
      type: "session_notice",
      sessionId: "selected",
      message: "The agent refused this prompt.",
    });
    expect(notices).toEqual(["The agent refused this prompt."]);
    expect(views.at(-1)).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(2);
    stream.emit({
      type: "session_notice",
      sessionId: "another-session",
      message: "Not this chat",
    });
    expect(notices).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces command refusals immediately while the initial transcript is loading", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementation((path) =>
      path.toString().includes("transcript")
        ? new Promise((resolve) => {
            finish = (value) => resolve(value as Response);
          })
        : (reply(snapshot) as Promise<Response>),
    );
    const { stream, views, notices } = open();
    stream.onopen?.();
    stream.emit({
      type: "session_notice",
      sessionId: "selected",
      message: "Configuration change was refused.",
    });
    expect(notices).toEqual(["Configuration change was refused."]);
    expect(views.at(-1)?.transcript).toBeUndefined();
    finish({ ok: true, status: 200, json: async () => page });
    await vi.waitFor(() => expect(views.at(-1)?.transcript?.revision).toBe(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches a reset projection and ignores stale responses after close", async () => {
    const { stream, connection, views } = open();
    stream.onopen?.();
    await vi.waitFor(() => expect(views.at(-1)?.transcript).toBeDefined());
    stream.emit({ type: "transcript_reset", sessionId: "selected" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    connection.close();
    expect(stream.close).toHaveBeenCalled();
    for (const [, init] of vi.mocked(fetch).mock.calls.slice(-2)) {
      expect(init?.signal?.aborted).toBe(true);
    }
    const count = views.length;
    stream.emit({ type: "connection", status: "offline", offlineAllowed: true });
    await Promise.resolve();
    expect(views).toHaveLength(count);
  });

  it("does not restore writable state when the browser stream drops during hydration", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementation((path) =>
      path.toString().includes("transcript")
        ? new Promise((resolve) => {
            finish = (value) => resolve(value as Response);
          })
        : (reply(snapshot) as Promise<Response>),
    );
    const { stream, views } = open();
    stream.onopen?.();
    stream.onerror?.();
    finish({ ok: true, status: 200, json: async () => page });
    await Promise.resolve();
    await Promise.resolve();
    expect(views.at(-1)?.status).toBe("syncing");
    expect(views.at(-1)?.offlineAllowed).toBe(false);
    expect(views.at(-1)?.snapshot).toBeUndefined();
  });

  it("fetches older pages only when requested and aborts them on teardown", async () => {
    vi.mocked(fetch).mockImplementation(
      (path) =>
        reply(
          path.toString().includes("transcript")
            ? { ...page, start: 400, total: 401 }
            : snapshot,
        ) as Promise<Response>,
    );
    const { stream, connection, views } = open();
    stream.onopen?.();
    await vi.waitFor(() => expect(views.at(-1)?.transcript?.start).toBe(400));
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    void connection.loadOlder();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe(
      "/api/fleet-sessions/selected/transcript?before=400&limit=200",
    );
    connection.close();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });

  it("retries a failed stream before hydrating instead of silently enabling unwatched controls", async () => {
    const { stream, connection } = open();
    stream.onerror?.();
    await connection.reload();
    expect(stream.close).toHaveBeenCalled();
    expect(Stream.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    Stream.instances.at(-1)!.onopen?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

describe("Node mutation transport", () => {
  it("uses JSON, no Host sign-in/CSRF, and a stable operation ID after an uncertain result", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost"));
    const path = "/api/fleet-sessions/retry/prompt";
    const init = {
      method: "POST",
      body: JSON.stringify({ prompt: "continue", attachments: [] }),
    };
    await expect(nodeApi(path, init)).rejects.toThrow("connection lost");
    await nodeApi(path, init);
    const requests = vi.mocked(fetch).mock.calls;
    expect(requests).toHaveLength(2);
    const first = JSON.parse(requests[0]![1]!.body as string);
    const second = JSON.parse(requests[1]![1]!.body as string);
    expect(second.operationId).toBe(first.operationId);
    expect(new Headers(requests[1]![1]?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(requests[1]![1]?.headers).has("x-csrf-token")).toBe(false);
  });
});
