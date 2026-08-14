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
  /**
   * Which context window agents on this machine are started with.
   *
   * Copilot persists a tier of its own in ~/.copilot/settings.json, which the
   * `--context` flag overrides. This setting is that flag, for the same reason
   * `--allow-all` is passed explicitly rather than left to the environment: a
   * fleet where one machine quietly runs a different window than the rest is
   * one where the same session behaves differently depending on where it
   * landed, with nothing on screen to say why.
   *
   * Long by default, but the tier only ever widens a window Copilot has a
   * wider variant for: measured against Copilot 1.0.80 the window a session
   * gets is the model's own — 264k on claude-opus-5, claude-sonnet-5 and
   * gemini-3.1-pro-preview, 400k on gpt-5.6-sol — and asking for the long tier
   * moved none of them. Asking costs nothing and is right when a model that
   * honours it appears, but the model picker is what actually decides how much
   * room a session has today.
   *
   * Applies to agents started from now on; sessions already running keep the
   * tier they were launched with, since it is fixed at spawn.
   */
  contextTier: z.enum(["default", "long_context"]).default("long_context"),
  /**
   * Addresses this node has reached the Host on before, newest first.
   *
   * Filled in when the Host announces that it moved: the address being replaced
   * is kept so a dial that never gets a welcome can fall back to it. Without
   * that, one announcement of a URL that turns out not to work from here — a
   * tunnel this machine's network blocks, a hostname it cannot resolve — would
   * strand the node with no way back except editing files on it by hand.
   */
  knownHostUrls: z.array(z.string()).default([]),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * The settings the config page owns.
 *
 * `knownHostUrls` is bookkeeping this process maintains, not a field anyone
 * types, and the page posts the whole form back — so leaving it in the schema
 * the page is parsed against would let every save wipe the fallbacks.
 */
export const EditableSettingsSchema = SettingsSchema.omit({ knownHostUrls: true });
export type EditableSettings = z.infer<typeof EditableSettingsSchema>;

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
 * the .env file still says on the next restart. Command-line flags outrank
 * both — see {@link settingsOverridesFromEnv}.
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
    contextTier: env.FLEET_CONTEXT_TIER ?? undefined,
  });
}

/**
 * Only the settings the caller actually specified.
 *
 * Command-line flags have to beat settings.json, and {@link settingsFromEnv}
 * cannot express that: it fills every field with a default, so merging its
 * result over the file would reset the settings the operator never mentioned.
 */
export function settingsOverridesFromEnv(env: NodeJS.ProcessEnv): Partial<Settings> {
  const overrides: Partial<Settings> = {};
  if (env.FLEET_HOST_URL !== undefined) overrides.hostUrl = env.FLEET_HOST_URL;
  if (env.FLEET_NODE_NAME !== undefined) overrides.nodeName = env.FLEET_NODE_NAME;
  if (env.FLEET_MAX_SESSIONS !== undefined) {
    overrides.maxSessions = Number(env.FLEET_MAX_SESSIONS);
  }
  if (env.FLEET_COPILOT_COMMAND !== undefined) {
    overrides.copilotCommand = env.FLEET_COPILOT_COMMAND;
  }
  if (env.PERMISSION_TIMEOUT_MS !== undefined) {
    overrides.permissionTimeoutMs = Number(env.PERMISSION_TIMEOUT_MS);
  }
  if (env.FLEET_CONTEXT_TIER !== undefined) {
    // Cast rather than validated here: every path into settings ends at
    // SettingsSchema.parse, which rejects an unrecognised tier with a message
    // naming the field. Quietly dropping it would start the node on a window
    // the operator did not ask for and say nothing.
    overrides.contextTier = env.FLEET_CONTEXT_TIER as Settings["contextTier"];
  }
  return overrides;
}

function settingsPath(): string {
  return join(configDirectory(), "settings.json");
}

/**
 * Effective settings, lowest precedence first: built-in defaults, environment,
 * settings.json, then `overrides` (command-line flags).
 */
export async function loadSettings(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Settings> = {},
): Promise<Settings> {
  const defaults = settingsFromEnv(env);
  try {
    const content = await readFile(settingsPath(), "utf8");
    // Merging over the defaults keeps older files readable after a new field
    // is introduced, instead of failing to parse and losing every setting.
    return SettingsSchema.parse({ ...defaults, ...JSON.parse(content), ...overrides });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return SettingsSchema.parse({ ...defaults, ...overrides });
    }
    throw error;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(configDirectory(), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
}
