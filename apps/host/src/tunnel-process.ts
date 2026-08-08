import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TunnelProviderSchema } from "@fleet/protocol";
import { externalTunnelPath, adoptOrKillStale } from "./external-tunnel.js";
import { parseLocalTarget, providerSpecs } from "./tunnel-providers.js";

/**
 * Runs a tunnel as its own process so `tsx watch` reloads cannot take the
 * public URL down with them. The Host reads the URL from the file this writes;
 * ownership stays here, which keeps the process a child of the terminal rather
 * than an orphan nobody is tracking.
 */
const provider = TunnelProviderSchema.parse(
  process.env.FLEET_TUNNEL_PROVIDER ?? "bore",
);
const spec = providerSpecs[provider];
const target = parseLocalTarget(
  process.env.FLEET_TUNNEL_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`,
);
const statePath = externalTunnelPath();

const log = (message: string) =>
  console.log(`${new Date().toISOString()} [tunnel] ${message}`);

const writeState = (pid: number, url: string | undefined): void => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({ provider, url: url ?? "", pid }, null, 2),
  );
};

const clearState = (): void => {
  try {
    rmSync(statePath, { force: true });
  } catch {
    // Best-effort: a stale file only costs the Host one failed probe.
  }
};

log(`starting ${spec.binary} -> ${target.host}:${target.port}`);
adoptOrKillStale(statePath, log);

const child = spawn(spec.binary, spec.args(target), {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

/**
 * The recorded pid is the provider's, not this wrapper's: the provider is what
 * actually forwards traffic, so if this wrapper is SIGKILLed and leaves the
 * file behind, the Host's liveness probe still tracks whether the tunnel works.
 */
if (child.pid) writeState(child.pid, undefined);

let buffer = "";
let url: string | undefined;
const onChunk = (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  process.stdout.write(text);
  if (url) return;
  buffer += text;
  if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
  const found = spec.extractUrl(buffer);
  if (!found) return;
  url = found;
  if (child.pid) writeState(child.pid, url);
  log(`public URL ${url}`);
};

child.stdout.on("data", onChunk);
child.stderr.on("data", onChunk);

child.on("error", (error) => {
  log(`failed to start: ${error.message}`);
  clearState();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  log(`exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
  clearState();
  process.exit(code ?? 1);
});

const shutdown = () => {
  clearState();
  child.kill("SIGTERM");
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", clearState);
