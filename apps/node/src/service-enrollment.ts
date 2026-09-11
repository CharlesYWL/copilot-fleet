import { arch, homedir, platform } from "node:os";
import { config as loadEnv } from "dotenv";
import { gitRevision } from "@fleet/protocol/runtime";
import { catalogSummary, readAgentCatalog } from "./agent-catalog.js";
import { parseNodeArgs } from "./cli.js";
import { configDirectory, loadCredentials, saveCredentials } from "./config.js";
import { connectDevTunnel, type DevTunnelConnection } from "./devtunnel.js";
import { ensureNodeCredentials, keyEnrollmentTuple } from "./enrollment.js";
import { endpointsBehindLocalForward } from "./host-endpoints.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { NODE_CAPABILITIES } from "./node-capabilities.js";
import { envFilePath, packageVersion } from "./paths.js";
import {
  loadSettings,
  saveSettings,
  settingsOverridesFromEnv,
  type Settings,
} from "./settings.js";

const ENROLLMENT_KEYS = [
  "FLEET_ENROLLMENT_GRANT",
  "FLEET_ENROLLMENT_TOKEN",
  "FLEET_HOST_ID",
  "FLEET_HOST_FINGERPRINT",
] as const;

/** Only nonsecret flags without a settings.json home belong in a persistent task. */
export function serviceRuntimeArgs(argv: readonly string[]): string[] {
  const { env } = parseNodeArgs(argv);
  const port = env.FLEET_NODE_CONFIG_PORT;
  if (
    port !== undefined &&
    (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  ) {
    throw new Error("--config-port requires a port from 1 to 65535.");
  }
  const tunnel = env.FLEET_DEVTUNNEL_ID;
  if (tunnel !== undefined && (!tunnel.trim() || /[\0\r\n]/.test(tunnel))) {
    throw new Error("--devtunnel requires a nonempty tunnel ID.");
  }
  return [
    ...(tunnel !== undefined ? [`--devtunnel=${tunnel}`] : []),
    ...(port !== undefined ? [`--config-port=${port}`] : []),
  ];
}

export type PreparedService = { nodeId: string; runtimeArgs: string[] };

/**
 * Enroll once in the installer's existing user context, after the actual
 * scheduled-task auth probe. Grants stay in memory, never in a task or input file.
 */
export async function prepareNodeService(
  nodeArgs: readonly string[],
  options: {
    existingNode?: boolean;
    verifyContext: (settings: Settings) => Promise<void>;
    enroll?: typeof ensureNodeCredentials;
    connectTunnel?: typeof connectDevTunnel;
  },
): Promise<PreparedService> {
  loadEnv({ path: envFilePath(), quiet: true });
  const flags = parseNodeArgs(nodeArgs);
  if (flags.wantsHelp)
    throw new Error("Use npm run service -- node --help for service usage.");
  const runtimeArgs = serviceRuntimeArgs(nodeArgs);
  const env = { ...process.env, ...flags.env };
  if (env.FLEET_MOCK_AGENT === "1") {
    throw new Error(
      "Service installation requires real Copilot authentication, not --mock-agent.",
    );
  }
  if (options.existingNode) {
    if (ENROLLMENT_KEYS.some((key) => flags.env[key] !== undefined)) {
      throw new Error("Choose --existing-node or enrollment options, not both.");
    }
    for (const key of ENROLLMENT_KEYS) delete env[key];
  }
  const tuple = keyEnrollmentTuple(env);
  const stored = await loadCredentials();
  if (options.existingNode && !stored)
    throw new Error("No existing Node identity was found in this profile.");
  if (!stored && !tuple && !env.FLEET_ENROLLMENT_TOKEN) {
    throw new Error(
      "A new Node needs the complete enrollment command from the Host's Nodes page.",
    );
  }
  if (stored && flags.env.FLEET_HOST_URL === undefined)
    env.FLEET_HOST_URL = stored.hostUrl;
  let settings = await loadSettings(env, settingsOverridesFromEnv(flags.env));
  await options.verifyContext(settings);
  const lock = acquireInstanceLock(configDirectory());
  if (!lock.ok) throw new Error(`${lock.reason}. Stop that Node before installing.`);
  let tunnel: DevTunnelConnection | undefined;
  try {
    if (env.FLEET_DEVTUNNEL_ID) {
      tunnel = await (options.connectTunnel ?? connectDevTunnel)(env.FLEET_DEVTUNNEL_ID, {
        log: () => {},
        warn: () => {},
      });
      settings = endpointsBehindLocalForward(settings, tunnel.url);
    }
    // Read again under the instance lock; another process may have enrolled
    // while the authentication probe was running.
    const current = await loadCredentials();
    if (options.existingNode && !current)
      throw new Error("The existing Node identity disappeared during setup.");
    const catalog = await readAgentCatalog();
    const outcome = await (options.enroll ?? ensureNodeCredentials)({
      stored: current,
      settings,
      env,
      machine: {
        os: platform(),
        arch: arch(),
        version: packageVersion(),
        revision: gitRevision(),
        capabilities: NODE_CAPABILITIES,
        agents: catalogSummary(catalog),
        maxSessions: settings.maxSessions,
        homeDir: homedir(),
      },
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
    });
    if (outcome.persist) await saveCredentials(outcome.credentials);
    await saveSettings(settings);
    return { nodeId: outcome.credentials.nodeId, runtimeArgs };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    let message = error.message;
    for (const key of ["FLEET_ENROLLMENT_GRANT", "FLEET_ENROLLMENT_TOKEN"] as const) {
      const secret = env[key];
      if (secret) message = message.split(secret).join("[redacted]");
    }
    // The original error may contain the grant, so do not retain it as a cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(message);
  } finally {
    tunnel?.stop();
    lock.release();
  }
}
