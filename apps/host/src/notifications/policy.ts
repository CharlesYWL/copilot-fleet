import type { FleetSession, RunRole } from "@fleet/protocol";

export const NOTIFICATION_LIFECYCLE_DEFAULT_SETTING =
  "defaults.notificationLifecycleEnabled";
export const DEFAULT_NOTIFICATION_LIFECYCLE_ENABLED = true;

export type LifecyclePreferenceSource = "explicit" | "role" | "application";

export type LifecyclePreferenceResolution = {
  lifecycleEnabled: boolean;
  source: LifecyclePreferenceSource;
  explicitOverride: boolean | null;
  roleDefault: boolean | null;
  applicationDefault: boolean;
};

/**
 * Dependency agents stay quiet unless explicitly enabled. Top-level sessions
 * inherit the application default so one fleet-wide switch still has meaning.
 */
export function lifecycleDefaultForRole(runRole: RunRole): boolean | undefined {
  return runRole === "worker" || runRole === "reviewer" ? false : undefined;
}

export function resolveLifecyclePreference(input: {
  explicitOverride?: boolean | undefined;
  runRole: RunRole;
  applicationDefault: boolean;
}): LifecyclePreferenceResolution {
  const roleDefault = lifecycleDefaultForRole(input.runRole);
  if (input.explicitOverride !== undefined) {
    return {
      lifecycleEnabled: input.explicitOverride,
      source: "explicit",
      explicitOverride: input.explicitOverride,
      roleDefault: roleDefault ?? null,
      applicationDefault: input.applicationDefault,
    };
  }
  if (roleDefault !== undefined) {
    return {
      lifecycleEnabled: roleDefault,
      source: "role",
      explicitOverride: null,
      roleDefault,
      applicationDefault: input.applicationDefault,
    };
  }
  return {
    lifecycleEnabled: input.applicationDefault,
    source: "application",
    explicitOverride: null,
    roleDefault: null,
    applicationDefault: input.applicationDefault,
  };
}

/** Copilot's durable conversation id, scoped by the Fleet session id in storage. */
export function stableNotificationAgentId(
  session: Pick<FleetSession, "id" | "agentSessionId">,
): string {
  return session.agentSessionId || session.id;
}
