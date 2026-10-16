import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSchema, type NodeCommand } from "@fleet/protocol";
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
});
