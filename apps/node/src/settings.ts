import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configDirectory } from "./config.js";

/**
 * Operator-editable settings, persisted separately from node.json so that
 * rotating a tunnel URL never risks rewriting the node's credentials.
 */
export const SettingsSchema = z.object({
  hostUrl: z.string().url(),
  nodeName: z.string().min(1).max(120),
  maxSessions: z.number().int().min(1).max(64),
  /** Empty means "find `copilot` on PATH". */
  copilotCommand: z.string(),
  permissionTimeoutMs: z.number().int().min(1_000).max(3_600_000),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Changing any of these requires a fresh hello frame to take effect. */
const RECONNECT_KEYS = ["hostUrl", "nodeName", "maxSessions"] as const;

export function needsReconnect(before: Settings, after: Settings): boolean {
  return RECONNECT_KEYS.some((key) => before[key] !== after[key]);
}

/**
 * How long an agent waits for a human decision before denying.
 *
 * Settings own this number: `agents.ts` used to read PERMISSION_TIMEOUT_MS a
 * second time with its own 30s default, so a node started without the variable
 * denied permissions half an hour earlier than .env.example promised.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 1_800_000;

/**
 * Environment variables seed the first run; once settings.json exists it wins,
 * because otherwise an edit made in the UI would silently revert to whatever
 * the .env file still says on the next restart.
 */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  return SettingsSchema.parse({
    hostUrl: env.FLEET_HOST_URL ?? "http://127.0.0.1:8787",
    nodeName: env.FLEET_NODE_NAME ?? hostname(),
    maxSessions: Number(env.FLEET_MAX_SESSIONS ?? 4),
    copilotCommand: env.FLEET_COPILOT_COMMAND ?? "",
    permissionTimeoutMs: Number(
      env.PERMISSION_TIMEOUT_MS ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    ),
  });
}

function settingsPath(): string {
  return join(configDirectory(), "settings.json");
}

export async function loadSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Settings> {
  const defaults = settingsFromEnv(env);
  try {
    const content = await readFile(settingsPath(), "utf8");
    // Merging over the defaults keeps older files readable after a new field
    // is introduced, instead of failing to parse and losing every setting.
    return SettingsSchema.parse({ ...defaults, ...JSON.parse(content) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(configDirectory(), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
}
