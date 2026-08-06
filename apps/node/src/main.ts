import "dotenv/config";
import { arch, platform } from "node:os";
import WebSocket from "ws";
import {
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  RegisterNodeSchema,
  tryParseJson,
  type NodeToHostMessage,
} from "@fleet/protocol";
import { AcpAgentFactory, MockAgentFactory } from "./agents.js";
import { loadCredentials, saveCredentials, type Credentials } from "./config.js";
import { CommandRouter } from "./router.js";

const VERSION = "0.1.0";
const hostUrl = process.env.FLEET_HOST_URL ?? "http://127.0.0.1:8787";
const nodeName = process.env.FLEET_NODE_NAME ?? platform() + "-node";
const maxSessions = Number(process.env.FLEET_MAX_SESSIONS ?? 4);

let credentials = await loadCredentials();
if (!credentials || credentials.hostUrl !== hostUrl || credentials.name !== nodeName) {
  credentials = await register();
  await saveCredentials(credentials);
}

const factory =
  process.env.FLEET_MOCK_AGENT === "1" ? new MockAgentFactory() : new AcpAgentFactory();
let socket: WebSocket | undefined;
let shuttingDown = false;
const router = new CommandRouter(factory, maxSessions, (event) => {
  send({ type: "event", event });
});

connect(credentials);

function connect(auth: Credentials): void {
  const url = new URL("/ws/node", auth.hostUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.on("open", () => {
    send({
      type: "hello",
      nodeId: auth.nodeId,
      secret: auth.secret,
      os: platform(),
      arch: arch(),
      version: VERSION,
      capabilities: ["copilot-acp", process.env.FLEET_MOCK_AGENT === "1" ? "mock" : "real"],
      maxSessions,
    });
  });
  socket.on("message", async (raw) => {
    const frame = tryParseJson(raw.toString());
    if (!frame.ok) {
      console.error("Rejected malformed Host message:", frame.error);
      socket?.close(1007, "Malformed JSON");
      return;
    }
    const parsed = HostToNodeMessageSchema.safeParse(frame.value);
    if (!parsed.success) {
      console.error("Rejected invalid Host message:", parsed.error.message);
      socket?.close(1008, "Invalid Host message");
      return;
    }
    if (parsed.data.type !== "command") return;
    const result = await router.route(parsed.data.command);
    send({
      type: "command_result",
      commandId: result.commandId,
      sessionId: parsed.data.command.sessionId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
  });
  socket.on("close", async () => {
    router.denyPendingPermissions();
    await router.stopAll();
    if (!shuttingDown) setTimeout(() => connect(auth), 2_000);
  });
  socket.on("error", (error) => {
    console.error("Host connection error:", error.message);
  });
}

function send(message: NodeToHostMessage): void {
  NodeToHostMessageSchema.parse(message);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

setInterval(() => {
  send({
    type: "heartbeat",
    activeSessionIds: router.activeSessionIds,
    sentAt: new Date().toISOString(),
  });
}, 5_000).unref();

async function register(): Promise<Credentials> {
  const enrollmentToken = process.env.FLEET_ENROLLMENT_TOKEN;
  if (!enrollmentToken) {
    throw new Error("FLEET_ENROLLMENT_TOKEN is required for first registration");
  }
  const body = RegisterNodeSchema.parse({
    enrollmentToken,
    name: nodeName,
    os: platform(),
    arch: arch(),
    version: VERSION,
    capabilities: ["copilot-acp"],
    maxSessions,
  });
  const response = await fetch(new URL("/api/nodes/register", hostUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Node registration failed (${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as { nodeId: string; secret: string };
  return { hostUrl, nodeId: result.nodeId, secret: result.secret, name: nodeName };
}

async function shutdown(): Promise<void> {
  shuttingDown = true;
  socket?.close();
  await router.stopAll();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
