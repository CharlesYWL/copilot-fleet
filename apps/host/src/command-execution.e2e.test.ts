import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticatedEnvelopeSchema,
  COMMAND_EXECUTION_CAPABILITY,
  CommandExecutionHostMessageSchema,
  CommandExecutionNodeMessageSchema,
  CommandExecutionPageSchema,
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  MUTUAL_AUTH_PROTOCOL,
  SessionEventSchema,
  terminalCommandExecutionStates,
  type CommandExecution,
  type CommandExecutionHostMessage,
  type CommandExecutionNodeMessage,
  type LeadPromptDelivery,
} from "@fleet/protocol";
import { AuthenticatedChannel } from "@fleet/protocol/node-auth";
import { CommandExecutionManager } from "../../node/src/command-execution-manager.js";
import { CommandJournal } from "../../node/src/command-journal.js";
import { nativeCommandSupervisor } from "../../node/src/command-supervisor-adapter.js";
import { readCommandProcessReceipt } from "../../node/src/command-supervisor.js";
import { LeadPromptJournal } from "../../node/src/lead-prompt-delivery.js";
import { NodeAdmission } from "../../node/src/node-admission.js";
import { RepositoryParticipation } from "../../node/src/repository-participation.js";
import { GitRunner } from "../../node/src/git-runner.js";
import { OPERATOR_COOKIE } from "./auth.js";
import { FleetAuth } from "./auth/service.js";
import { HostIdentityService } from "./auth/host-identity.js";
import { FleetService } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";
import { registerRequestGuard } from "./request-guard.js";
import { commandExecutionRoutes } from "./routes/command-executions.js";
import { FleetStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(nodeClockOffsetMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "fleet-command-e2e-"));
  const cwd = join(root, "workspace with spaces");
  const coordinator = join(root, "coordinator");
  await mkdir(cwd);
  await mkdir(coordinator);
  const git = new GitRunner();
  await git.run(cwd, [
    "-c",
    "init.templateDir=",
    "init",
    "--initial-branch=command-fixture",
  ]);
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        build:
          "node -e \"process.stdout.write('fixture-build-output');process.stderr.write('fixture-build-error');process.exit(7)\"",
      },
    }),
  );
  const app = Fastify({ logger: false });
  const databasePath = join(root, "host.db");
  const store = new FleetStore(databasePath);
  const hostId = new HostIdentityService(store).identity().hostId;
  const service = new FleetService(store, app.log, "fixture");
  const auth = new FleetAuth({
    store,
    announceClaimCode() {},
    warn() {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
  });
  const admin = store.insertAdministrator({
    tenantId: "fixture-tenant",
    objectId: "fixture-administrator",
    username: "operator@fixture.invalid",
    displayName: "Fixture administrator",
    addedVia: "claim",
  });
  const issued = auth.sessions.issue({
    administratorId: admin.id,
    authMethod: "microsoft-code",
  });
  const headers = {
    host: "localhost",
    cookie: `${OPERATOR_COOKIE}=${issued.token}`,
    "x-csrf-token": auth.sessions.csrfToken(issued.tokenHash),
  };
  registerRequestGuard(app, { store, auth, allowlist: {} });
  await app.register(commandExecutionRoutes, { service, auth });

  const targetNode = store.registerNode({
    name: "execution-fixture",
    os: "win32",
    arch: "x64",
    version: "fixture",
    capabilities: [COMMAND_EXECUTION_CAPABILITY],
    maxSessions: 1,
  }).node;
  const leadNode = store.registerNode({
    name: "lead-fixture",
    os: "win32",
    arch: "x64",
    version: "fixture",
    capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
    maxSessions: 1,
  }).node;
  const workspace = store.createWorkspace("command-fixture", "");
  const placement = store.createPlacement(workspace.id, targetNode.id, cwd);
  const leadPlacement = store.createPlacement(workspace.id, leadNode.id, coordinator);
  const lead = store.createSession(
    leadPlacement,
    "Inspect the workspace",
    false,
    "fixture lead",
    { runRole: "lead" },
  );
  store.transitionSession(lead.id, "starting");
  store.transitionSession(lead.id, "idle");
  store.appendEvent(
    SessionEventSchema.parse({
      eventId: randomUUID(),
      sessionId: lead.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "fixture-native-lead" },
      createdAt: new Date().toISOString(),
    }),
  );
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const frames: CommandExecutionHostMessage[] = [];
  let connected = true;

  function schedule(work: () => Promise<void>) {
    const task = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        errors.push(error);
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  // Fresh channel keys stand in for enrollment; every application frame is actually sealed/opened.
  function peer(
    nodeId: string,
    receive: (message: CommandExecutionHostMessage) => Promise<void>,
  ) {
    const keys = { hostToNode: randomBytes(32), nodeToHost: randomBytes(32) };
    const binding = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId,
      nodeId,
      connectionId: randomUUID(),
    };
    const host = new AuthenticatedChannel({ keys, binding, seals: "host-to-node" });
    const node = new AuthenticatedChannel({ keys, binding, seals: "node-to-host" });
    const raw = {
      OPEN: 1,
      readyState: 1,
      close() {
        this.readyState = 3;
      },
      send(text: string) {
        const opened = node.open(AuthenticatedEnvelopeSchema.parse(JSON.parse(text)));
        if (!opened.ok) throw new Error(`Fixture Node channel refused: ${opened.reason}`);
        const message = CommandExecutionHostMessageSchema.parse(
          JSON.parse(opened.plaintext),
        );
        frames.push(message);
        schedule(() => receive(message));
      },
    };
    const link = new SealedNodeLink(raw, host);
    service.attachNode(nodeId, link);
    store.setNodeOnline(nodeId, true, 0);
    return {
      link,
      send(message: CommandExecutionNodeMessage): boolean {
        if (!connected) return false;
        const opened = host.open(node.seal(JSON.stringify(message)));
        if (!opened.ok) throw new Error(`Fixture Host channel refused: ${opened.reason}`);
        const accepted = service.commands.handleNodeMessage(
          nodeId,
          CommandExecutionNodeMessageSchema.parse(JSON.parse(opened.plaintext)),
        );
        if (!accepted) {
          errors.push(
            new Error(`Host rejected fixture Node message: ${JSON.stringify(message)}`),
          );
        }
        return accepted;
      },
    };
  }

  const repositories = new RepositoryParticipation();
  await repositories.activate([cwd], true);
  const journal = new CommandJournal(join(root, "node-journal"));
  const admission = new NodeAdmission();
  const processResults: unknown[] = [];
  const prepare = vi.fn<typeof nativeCommandSupervisor.prepare>(async (input) => {
    const process = await nativeCommandSupervisor.prepare(input);
    void process.result.then((result) => processResults.push(result));
    return process;
  });
  const targetPeer = peer(targetNode.id, (message) => manager.handle(message));
  const manager = new CommandExecutionManager({
    journal,
    admission,
    repositories,
    supervisor: { ...nativeCommandSupervisor, prepare },
    connection: () => ({ sealed: true, negotiated: true, hostId, nodeId: targetNode.id }),
    send: targetPeer.send,
    now: () => Date.now() + nodeClockOffsetMs,
  });
  await manager.configure(true);
  service.commands.nodeReady(targetNode.id, {
    capabilities: [COMMAND_EXECUTION_CAPABILITY],
    commandExecution: manager.readiness,
  });
  const prompts: string[] = [];
  const deliveries: LeadPromptDelivery[] = [];
  const leadPeer = peer(leadNode.id, async (message) => {
    if (message.type !== "deliver_lead_prompt")
      throw new Error("Unexpected lead command");
    const accepted = leadJournal.accept(
      hostId,
      message.delivery,
      "fixture-native-lead",
      false,
    );
    if (accepted.invoke) {
      prompts.push(message.delivery.prompt);
      deliveries.push(message.delivery);
    }
  });
  const leadJournal = new LeadPromptJournal(join(root, "lead-journal"), (receipt) =>
    leadPeer.send({ type: "lead_prompt_receipt", receipt }),
  );
  service.commands.nodeReady(leadNode.id, {
    capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
  });

  async function flush() {
    while (pending.size) await Promise.all(pending);
    if (errors.length)
      throw new AggregateError(
        errors,
        `End-to-end transport failure: ${errors.map((error) => (error instanceof Error ? error.stack : String(error))).join("\n")}`,
      );
  }
  async function waitFor(
    id: string,
    predicate: (execution: CommandExecution) => boolean,
  ) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await flush();
      service.commands.tick();
      await flush();
      const execution = service.commands.get(id)!;
      if (predicate(execution)) return execution;
      if (
        execution.state === "reconciliation_required" ||
        execution.state === "expired"
      ) {
        throw new Error(
          `Fixture ${root}: ${JSON.stringify({
            state: execution.state,
            ownership: execution.ownership,
            error: execution.error,
            reasonCode: execution.reasonCode,
            receipt: journal.get(id)?.receipt,
          })}`,
        );
      }
      if (
        execution.state === "interrupted" ||
        (execution.state === "failed" && !execution.outcomeKnown)
      ) {
        const record = journal.get(id);
        const receipt = record
          ? await readCommandProcessReceipt(
              join(journal.directory, record.namespace, id, execution.attemptId),
            )
          : undefined;
        throw new Error(
          `Unexpected fixture outcome: ${JSON.stringify({ execution, receipt, processResults })}`,
        );
      }
      await delay(50);
    }
    throw new Error(
      `Fixture ${root} did not settle: ${JSON.stringify(service.commands.get(id))}`,
    );
  }
  async function request(command: string, requestKey = randomUUID()) {
    const execution = service.commands.request(lead.id, {
      target: { placementId: placement.id },
      command,
      shell: "windows-powershell-5.1",
      reason: "Disposable end-to-end fixture",
      requestKey,
      timeoutMs: 30_000,
    });
    return waitFor(execution.id, (item) => item.state === "awaiting_approval");
  }
  async function decision(
    execution: CommandExecution,
    value: "allow_once" | "deny",
    authenticated = true,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/command-executions/${execution.id}/decision`,
      ...(authenticated ? { headers } : {}),
      payload: {
        decision: value,
        expectedVersion: execution.version,
        digest: execution.descriptor!.digest,
      },
    });
  }
  function settleDelivery(execution: CommandExecution) {
    if (execution.deliveryId)
      leadJournal.settle(execution.deliveryId, "fixture-native-lead");
  }
  cleanups.push(async () => {
    let quiescent = false;
    try {
      await manager.cancelAll("Disposable fixture cleanup");
      quiescent = true;
      await flush();
    } finally {
      service.shutdown();
      await app.close();
      leadJournal.close();
      journal.close();
      store.close();
      if (quiescent) await rm(root, { recursive: true, force: true });
      else console.error(`Unresolved disposable fixture preserved at ${root}`);
    }
  });
  return {
    root,
    cwd,
    databasePath,
    app,
    store,
    service,
    manager,
    journal,
    admission,
    targetNode,
    targetPeer,
    lead,
    placement,
    prepare,
    headers,
    frames,
    prompts,
    deliveries,
    request,
    decision,
    waitFor,
    flush,
    settleDelivery,
    disconnect() {
      connected = false;
    },
    reconnect() {
      connected = true;
    },
  };
}

describe.skipIf(process.platform !== "win32")("real approved command end-to-end", () => {
  it("accepts local no-start refusal and retains history using Host receipt time", async () => {
    const f = await fixture(-45 * 86_400_000);
    const execution = await f.request("Write-Output must-not-start");
    expect(
      f.service.commands.handleNodeMessage(f.targetNode.id, {
        type: "command_execution_update",
        receipt: {
          executionId: execution.id,
          attemptId: execution.attemptId,
          digest: execution.descriptor!.digest,
          state: "succeeded",
          ownership: "quiescent",
          exitCode: 0,
          outcomeKnown: true,
          reason: "Unapproved success must be refused",
          descendantCleanupForced: false,
          settledAt: new Date().toISOString(),
          finalOutputSeq: 0,
          gaps: [],
        },
      }),
    ).toBe(false);
    const receivedAfter = Date.now();
    await f.manager.configure(false);
    await f.flush();
    const cancelled = f.service.commands.get(execution.id)!;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.ownership).toBe("not_started");
    expect(Date.parse(cancelled.settledAt!)).toBeGreaterThanOrEqual(receivedAfter);
    expect(Date.parse(f.journal.get(execution.id)!.receipt.settledAt!)).toBeLessThan(
      receivedAfter - 40 * 86_400_000,
    );
    expect(
      f.service.commands.nodeReady(f.targetNode.id, {
        capabilities: [],
        commandExecution: f.manager.readiness,
      }).commandExecutions,
    ).toBe(true);
    f.manager.inventory();
    await f.flush();
    expect(f.prepare).not.toHaveBeenCalled();
  }, 90_000);

  it("preserves normal lead attachments and exports restorable execution evidence", async () => {
    const f = await fixture();
    const attachments = [{ name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=" }];
    expect(
      f.service.dispatch(f.lead.nodeId, {
        type: "prompt",
        sessionId: f.lead.id,
        prompt: "Read the attached note",
        attachments,
      }).sent,
    ).toBe(true);
    await f.flush();
    f.service.commands.tick();
    await f.flush();
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.attachments).toEqual(attachments);
    const delivery = f.store.commands.prompt(f.deliveries[0]!.deliveryId)!;
    expect(delivery.receipt?.nativeSessionId).toBe("fixture-native-lead");
    expect(delivery.receipt?.attemptId).toMatch(/^[a-f0-9-]{36}$/);

    const pending = await f.request(
      "Write-Output 'requires a new approval after restore'",
    );
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    expect(
      backup.commandExecutionData?.executions.some((item) => item.id === pending.id),
    ).toBe(true);
    expect(
      backup.commandExecutionData?.prompts.some(
        (item) => item.delivery.deliveryId === delivery.delivery.deliveryId,
      ),
    ).toBe(true);
    const restored = new FleetStore(":memory:");
    try {
      restored.replaceHostBackup(backup);
      expect(restored.commands.get(pending.id)).toMatchObject({
        state: "expired",
        ownership: "not_started",
      });
      expect(restored.commands.prompt(delivery.delivery.deliveryId)?.state).toBe(
        "orphaned",
      );
      expect(() =>
        restored.commands.request(
          pending.leadSessionId,
          pending.requestKey,
          pending.requestDigest,
          Date.now(),
        ),
      ).toThrow();
    } finally {
      restored.close();
    }
    expect(f.prepare).not.toHaveBeenCalled();
  }, 90_000);
  it("requires actual browser authorization and never launches a denied command", async () => {
    const f = await fixture();
    const execution = await f.request(
      "Set-Content -LiteralPath denied-marker.txt -Value should-not-run",
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.decision(execution, "allow_once", false)).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/command-executions/${execution.id}/decision`,
          headers: { host: f.headers.host, cookie: f.headers.cookie },
          payload: {
            decision: "allow_once",
            expectedVersion: execution.version,
            digest: execution.descriptor!.digest,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.decision(execution, "deny")).statusCode).toBe(200);
    await f.waitFor(execution.id, (item) => item.state === "denied");
    expect(f.prepare).not.toHaveBeenCalled();
    await expect(readFile(join(f.cwd, "denied-marker.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.store.listSessions()).toHaveLength(1);
  }, 90_000);

  it("runs real Git and npm without a worker, persists raw output, deduplicates start and wakes another Node", async () => {
    const f = await fixture();
    const branch = await f.request("git branch --show-current");
    expect((await f.decision(branch, "allow_once")).statusCode).toBe(200);
    const completed = await f.waitFor(
      branch.id,
      (item) =>
        item.state === "succeeded" && item.delivery === "accepted" && item.outputComplete,
    );
    const pageResponse = await f.app.inject({
      url: `/api/command-executions/${branch.id}?format=raw`,
      headers: f.headers,
    });
    expect(pageResponse.statusCode).toBe(200);
    const page = CommandExecutionPageSchema.parse(pageResponse.json());
    expect(
      page.events.map((event) => Buffer.from(event.data, "base64").toString()).join(""),
    ).toContain("command-fixture");
    expect(completed.exitCode).toBe(0);
    expect(completed.ownership).toBe("quiescent");
    expect(f.prompts).toHaveLength(1);
    const start = f.frames.find(
      (message) =>
        message.type === "start_command_execution" &&
        message.descriptor.executionId === branch.id,
    );
    if (!start || start.type !== "start_command_execution")
      throw new Error("No start frame");
    f.targetPeer.link.send(JSON.stringify(start));
    await f.flush();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.settleDelivery(completed);

    const build = await f.request("npm run build");
    expect((await f.decision(build, "allow_once")).statusCode).toBe(200);
    const failed = await f.waitFor(
      build.id,
      (item) =>
        item.state === "failed" && item.delivery === "accepted" && item.outputComplete,
    );
    expect(failed.exitCode).toBe(7);
    const output = CommandExecutionPageSchema.parse(
      (
        await f.app.inject({
          url: `/api/command-executions/${build.id}?format=raw`,
          headers: f.headers,
        })
      ).json(),
    );
    const bytes = output.events
      .map((event) => Buffer.from(event.data, "base64").toString())
      .join("");
    expect(bytes).toContain("fixture-build-output");
    expect(bytes).toContain("fixture-build-error");
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.store.listSessions()).toHaveLength(1);
    expect(f.admission.active).toEqual([]);
    expect(f.prompts).toHaveLength(2);
    f.settleDelivery(failed);
  }, 120_000);

  it("recovers a lost terminal delivery without rerunning and cancels a real silent process", async () => {
    const f = await fixture();
    const execution = await f.request("Write-Output running; Start-Sleep -Seconds 30");
    expect((await f.decision(execution, "allow_once")).statusCode).toBe(200);
    await f.waitFor(
      execution.id,
      (item) => item.state === "running" && item.lastOutputSeq > 0,
    );
    f.disconnect();
    f.service.commands.cancel(execution.id);
    await f.flush();
    await expect.poll(() => f.manager.unsettled, { timeout: 30_000 }).toBe(false);
    expect(
      terminalCommandExecutionStates.has(f.journal.get(execution.id)!.receipt.state),
    ).toBe(true);
    expect(f.service.commands.get(execution.id)!.state).toBe("cancelling");
    f.reconnect();
    await f.manager.handle({
      type: "reconcile_command_executions",
      hostId: execution.hostId,
      executions: [
        { executionId: execution.id, attemptId: execution.attemptId, afterSeq: 0 },
      ],
    });
    const cancelled = await f.waitFor(execution.id, (item) => item.state === "cancelled");
    expect(cancelled.ownership).toBe("quiescent");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.admission.active).toEqual([]);
  }, 90_000);
});
