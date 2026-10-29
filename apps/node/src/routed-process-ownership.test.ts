import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_TIER_CONFIG_ID, type SessionEvent } from "@fleet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpAgentFactory, type AgentFactory, type EventSink } from "./agents.js";
import type { CheckoutLease } from "./checkout-locks.js";
import * as ownership from "./process-quiescence.js";
import type { RepositoryParticipation } from "./repository-participation.js";
import { CommandRouter } from "./router.js";

type Launch = { agent: number; grandchild: number; args: string[] };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const profile = [
  { id: "model", value: "claude-opus-5.5" },
  { id: "reasoning_effort", value: "high" },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("routed replacement with real process ownership", () => {
  it.each(["context", "mcp", "deferred-mcp"] as const)(
    "quiesces the owned tree before launching the saved profile on %s",
    async (route) => {
      const directory = join(process.cwd(), `.routed-ownership-${randomUUID()}`);
      mkdirSync(directory);
      const receipt = join(directory, "launches.jsonl");
      const fixture = join(directory, "agent.mjs");
      writeFileSync(
        fixture,
        `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("GitHub Copilot CLI 1.0.105");
else if (args.includes("--help")) console.log("--context --model --reasoning-effort");
else {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  appendFileSync(process.env.FLEET_OWNERSHIP_TEST, JSON.stringify({ agent: process.pid, grandchild: grandchild.pid, args }) + "\\n");
  const options = [
    { id: "allow_all", name: "Permissions", type: "select", currentValue: "off", options: [{value:"off",name:"Off"},{value:"on",name:"On"}] },
    ...[["model","--model"],["reasoning_effort","--reasoning-effort"]].map(([id,flag]) => ({
      id, name:id, type:"select", currentValue:args[args.indexOf(flag)+1],
      options:[{value:args[args.indexOf(flag)+1],name:id}]
    }))
  ];
  createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === "initialize"
      ? {protocolVersion:1,agentCapabilities:{loadSession:true}}
      : ["session/new","session/load"].includes(request.method)
        ? {sessionId:request.params.sessionId ?? "saved-native",configOptions:options}
        : request.method === "session/prompt" ? {stopReason:"end_turn"} : {configOptions:options};
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  });
}
`,
      );
      const windows = process.platform === "win32";
      const launcher = join(directory, windows ? "copilot.cmd" : "copilot");
      writeFileSync(
        launcher,
        windows
          ? `@"${process.execPath}" "${fixture}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
      );
      if (!windows) chmodSync(launcher, 0o755);
      vi.stubEnv("FLEET_OWNERSHIP_TEST", receipt);
      const launches = () =>
        readFileSync(receipt, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Launch);
      const order: string[] = [];
      const registered: number[] = [];
      const realTrack = ownership.trackProcessGroup;
      vi.spyOn(ownership, "trackProcessGroup").mockImplementation((child) => {
        registered.push(child.pid!);
        realTrack(child);
      });
      const lease = {
        revalidate: vi.fn(async () => {}),
        release: vi.fn(),
        requireReconciliation: vi.fn(),
        processPending: vi.fn(),
        processStarted: vi.fn((pid: number) => {
          expect(registered).toContain(pid);
          order.push("registered-start");
        }),
        processesQuiesced: vi.fn(() => order.push("ownership-proved")),
      };
      const actual = new AcpAgentFactory(60_000, launcher, "long_context", 30_000);
      let sink!: EventSink;
      let starts = 0;
      const factory: AgentFactory = {
        async start(id, cwd, eventSink, options) {
          if (starts++) {
            expect(order.slice(-3)).toEqual([
              "stop-enter",
              "ownership-proved",
              "stop-quiesced",
            ]);
            for (const pid of [launches()[0]!.agent, launches()[0]!.grandchild])
              expect(alive(pid)).toBe(false);
            expect(options?.config).toEqual(expect.arrayContaining(profile));
          }
          order.push("start");
          sink = eventSink;
          const agent = await actual.start(id, cwd, eventSink, options);
          const stop = agent.stop.bind(agent);
          vi.spyOn(agent, "stop").mockImplementation(async (announce) => {
            order.push("stop-enter");
            await stop(announce);
            order.push("stop-quiesced");
          });
          return agent;
        },
      };
      const events: SessionEvent[] = [];
      const router = new CommandRouter(
        factory,
        1,
        (event) => events.push(event),
        async (path) => path,
        () => "http://127.0.0.1:8787",
        undefined,
        undefined,
        {
          repositories: {
            participate: async () => ({
              leases: [lease as unknown as CheckoutLease],
              supervised: true,
            }),
          } as unknown as RepositoryParticipation,
        },
      );
      try {
        expect(
          await router.route({
            type: "resume_session",
            commandId: "resume",
            sessionId: "owned",
            localPath: directory,
            agentSessionId: "saved-native",
            sequenceOffset: 0,
            additionalDirectories: [],
            yolo: false,
            contextTier: "long_context",
            config: profile,
            mcpServers: [{ name: "fleet", url: "/mcp", headers: [] }],
            agent: "",
            readOnly: false,
          }),
        ).toMatchObject({ ok: true });
        expect(starts).toBe(1);
        if (route === "context") {
          expect(
            await router.route({
              type: "set_config_option",
              commandId: "context",
              sessionId: "owned",
              configId: CONTEXT_TIER_CONFIG_ID,
              value: "default",
            }),
          ).toMatchObject({ ok: true });
        } else if (route === "mcp") await router.refreshMcpSessions();
        else {
          const emit = (type: SessionEvent["type"], payload: Record<string, unknown>) =>
            sink({
              eventId: randomUUID(),
              sessionId: "owned",
              sequence: Math.max(...events.map((event) => event.sequence)) + 1,
              type,
              payload,
              createdAt: new Date().toISOString(),
            });
          emit("tool", {
            title: "fleet-fleet_list_work",
            status: "failed",
            error: "Tool does not exist",
          });
          emit("state", { state: "idle", activity: "Ready" });
          await vi.waitFor(() => expect(starts).toBe(2), { timeout: 20_000 });
          const slot = (
            router as unknown as { slots: Map<string, { ready: Promise<void> }> }
          ).slots.get("owned")!;
          await slot.ready;
        }
        expect(starts).toBe(2);
        expect(launches()).toHaveLength(2);
        for (const launch of launches()) {
          for (const [flag, value] of [
            ["--model", "claude-opus-5.5"],
            ["--reasoning-effort", "high"],
          ] as const)
            expect(launch.args[launch.args.indexOf(flag) + 1]).toBe(value);
        }
        expect(lease.processesQuiesced).toHaveBeenCalledOnce();
        expect(lease.release).not.toHaveBeenCalled();
        expect(lease.requireReconciliation).not.toHaveBeenCalled();
      } finally {
        await router.route({ type: "stop", commandId: "stop", sessionId: "owned" });
        if (lease.processStarted.mock.calls.length) {
          for (const launch of launches())
            for (const pid of [launch.agent, launch.grandchild])
              expect(alive(pid)).toBe(false);
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
