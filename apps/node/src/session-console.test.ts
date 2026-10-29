import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { connect, Socket, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSchema, type BrowserMessage, type NodeCommand } from "@fleet/protocol";
import { NodeSessionConsole } from "./session-console.js";
import { SessionJournal } from "./session-journal.js";
import type { CommandRouter } from "./router.js";
import type { SessionFileReader } from "./session-files.js";

const directories: string[] = [];
const journals: SessionJournal[] = [];
const timestamp = "2026-10-15T12:00:00.000Z";
const sessionId = "worker";

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const prompt: NodeCommand = {
  type: "prompt",
  sessionId,
  commandId: "prompt-command",
  prompt: "Continue",
  attachments: [],
};
const stop: NodeCommand = { type: "stop", sessionId, commandId: "stop-command" };

type ConsoleInternals = { supported: boolean; status: string; detail: string };

const createConsole = () => {
  const directory = resolve(`.session-console-test-${randomUUID()}`);
  directories.push(directory);
  const journal = new SessionJournal(directory, { secure: false });
  journals.push(journal);
  journal.enable({
    hostId: "host",
    grantId: "grant",
    session: SessionSchema.parse({
      id: sessionId,
      workspaceId: "workspace",
      workspaceName: "Workspace",
      placementId: "placement",
      nodeId: "node",
      nodeName: "Node",
      state: "idle",
      initialPrompt: "Work",
      currentActivity: "Ready",
      lastText: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      agentSessionId: "native-session",
      runId: "run",
      runRole: "worker",
    }),
  });
  const route = vi.fn(async (command: NodeCommand) => ({
    commandId: command.commandId,
    ok: true,
  }));
  const router = { route, activeSessionIds: [], busySessionIds: [] };
  const sessionConsole = new NodeSessionConsole({
    journal,
    router: router as unknown as CommandRouter,
    files: {} as SessionFileReader,
    hostId: () => "host",
    nodeId: () => "node",
    send: () => true,
    onError: () => undefined,
  });
  const internals = sessionConsole as unknown as ConsoleInternals;
  internals.supported = true;
  internals.status = "online";
  return { journal, route, sessionConsole, internals };
};

describe("Node session console Host work admission", () => {
  it("accepts Host work when the console is online and no local control is ahead", async () => {
    const { sessionConsole, route } = createConsole();
    await expect(sessionConsole.hostCommand(prompt, 0)).resolves.toMatchObject({
      ok: true,
    });
    expect(route).toHaveBeenCalledWith(prompt);
  });

  it("names the console status and its detail when it is not online", async () => {
    const { sessionConsole, internals, route } = createConsole();
    internals.status = "syncing";
    internals.detail = "Synchronizing session history before accepting Host work";
    const result = await sessionConsole.hostCommand(prompt, 0);
    expect(result).toMatchObject({ ok: false, fatal: false });
    expect(result.error).toBe(
      "Node session console is syncing: Synchronizing session history before accepting Host work. Host work resumes once it is online and synchronized.",
    );
    expect(route).not.toHaveBeenCalled();
  });

  it("reports the epochs and unsynchronized counts when local control is ahead of the Host", async () => {
    const { sessionConsole, journal, route } = createConsole();
    journal.acceptOperation({
      id: randomUUID(),
      sessionId,
      action: "prompt",
      payload: { prompt: "Typed locally" },
    });
    const result = await sessionConsole.hostCommand(prompt, 0);
    expect(result).toMatchObject({
      ok: false,
      fatal: false,
      recovery: "console_resync",
    });
    expect(result.error).toBe(
      "Local control on this Node is ahead of the Host (Node control epoch 1, Host epoch 0; 1 local control change(s) and 0 event(s) not yet synchronized). Reconcile the Node so it can replay them to the Host.",
    );
    expect(route).not.toHaveBeenCalled();
  });

  it("lets stop through even while the console is not online", async () => {
    const { sessionConsole, internals, route } = createConsole();
    internals.status = "conflict";
    await expect(sessionConsole.hostCommand(stop, 0)).resolves.toMatchObject({
      ok: true,
    });
    expect(route).toHaveBeenCalledWith(stop);
  });

  it("blocks a session whose replacement grant was refused, leaving others and stop working", async () => {
    const { sessionConsole, journal, route } = createConsole();
    const stored = journal.get(sessionId)!;
    // A grant for a changed binding conflicts with the evidence the Node retains.
    const replacement = {
      hostId: "host",
      grantId: "grant-2",
      controlEpoch: 0,
      session: { ...stored.session, workspaceId: "another-checkout" },
    };
    let refusal = "";
    try {
      sessionConsole.grant(replacement as Parameters<typeof sessionConsole.grant>[0]);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).not.toBe("");
    sessionConsole.refuseGrant(sessionId, refusal);

    const resume: NodeCommand = { ...prompt, commandId: "after-refusal" };
    const result = await sessionConsole.hostCommand(resume, 0);
    expect(result).toMatchObject({ ok: false, fatal: false });
    expect(result.error).toContain("grant for this session was refused");
    expect(route).not.toHaveBeenCalledWith(resume);
    // Safety commands still reach a blocked session.
    await expect(sessionConsole.hostCommand(stop, 0)).resolves.toMatchObject({
      ok: true,
    });
    // Another session is not affected by this one's refusal.
    const other: NodeCommand = { ...prompt, sessionId: "other", commandId: "other" };
    await expect(sessionConsole.hostCommand(other, 0)).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("Node session console live viewers", () => {
  /**
   * A response with no socket keeps everything written to it buffered, and
   * `end()` cannot finish, so nothing ever closes it on its own.
   */
  const unfinishableViewer = () => new ServerResponse(new IncomingMessage(new Socket()));
  /**
   * A real connection whose client stopped reading, the way a background tab
   * stops reading its EventSource: once the kernel's buffers are full, what is
   * sent stays queued on the response.
   */
  const stalledViewer = async (sessionConsole: NodeSessionConsole) => {
    let accepted!: (response: ServerResponse) => void;
    const response = new Promise<ServerResponse>((resolve) => (accepted = resolve));
    const server = createServer((_request, reply) => {
      void sessionConsole.stream(sessionId, reply).then(() => accepted(reply));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = connect((server.address() as AddressInfo).port, "127.0.0.1");
    client.on("error", () => undefined);
    await once(client, "connect");
    client.write(
      `GET /api/fleet-sessions/${sessionId}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
    );
    client.pause();
    return {
      viewer: await response,
      close: () => {
        client.destroy();
        server.close();
      },
    };
  };
  const errorsOf = (response: ServerResponse) => {
    const errors: Error[] = [];
    response.on("error", (error) => errors.push(error));
    return errors;
  };
  /** A console with one viewer on the session, fed the way the Host feeds it. */
  const watchedConsole = async (
    open: (sessionConsole: NodeSessionConsole) => Promise<ServerResponse>,
  ) => {
    const { sessionConsole, internals, journal } = createConsole();
    // Opened from local history: the Host round trip in stream() is not what
    // these tests are about, and nothing here would answer it.
    internals.status = "offline";
    const viewer = await open(sessionConsole);
    const errors = errorsOf(viewer);
    // Host updates are forwarded to viewers only while online.
    internals.status = "online";
    const session = journal.get(sessionId)!.session;
    // A busy turn republishes the whole session with every event it streams.
    const update: BrowserMessage = {
      type: "session",
      session: { ...session, lastText: "x".repeat(64 * 1024) },
    };
    return { sessionConsole, viewer, errors, update };
  };
  const hasViewers = (sessionConsole: NodeSessionConsole) =>
    (sessionConsole as unknown as { viewers: Map<string, unknown> }).viewers.has(
      sessionId,
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a viewer that stopped reading, and its heartbeat never writes to it again", async () => {
    // Only the heartbeat's clock is fake; the connection is real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let connection: { close: () => void } | undefined;
    try {
      const { sessionConsole, viewer, errors, update } = await watchedConsole(
        async (console) => {
          const stalled = await stalledViewer(console);
          connection = stalled;
          return stalled.viewer;
        },
      );
      for (let sent = 0; sent < 1_000 && viewer.writableLength <= 1024 * 1024; sent += 1)
        sessionConsole.update(update);
      expect(viewer.writableLength).toBeGreaterThan(1024 * 1024);
      expect(viewer.destroyed).toBe(false);
      const closed = once(viewer, "close");
      sessionConsole.update(update);
      expect(viewer.destroyed).toBe(true);
      await closed;
      expect(hasViewers(sessionConsole)).toBe(false);

      // The heartbeat used to write after end() here and take the whole Node down.
      vi.advanceTimersByTime(60_000);
      expect(errors.map((error) => error.message)).toEqual([]);
    } finally {
      connection?.close();
    }
  });

  it("does not write to a viewer whose response has already finished", async () => {
    vi.useFakeTimers();
    const { sessionConsole, viewer, errors, update } = await watchedConsole(
      async (console) => {
        const viewer = unfinishableViewer();
        await console.stream(sessionId, viewer);
        return viewer;
      },
    );
    // Something else ended the response while the viewer was still registered.
    viewer.end();
    sessionConsole.update(update);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
