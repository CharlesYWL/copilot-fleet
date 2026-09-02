import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_LIFECYCLE_ENABLED,
  lifecycleDefaultForRole,
  resolveLifecyclePreference,
} from "./policy.js";

describe("notification lifecycle policy", () => {
  it("lets an explicit override win over role and application defaults", () => {
    expect(
      resolveLifecyclePreference({
        explicitOverride: true,
        runRole: "worker",
        applicationDefault: false,
      }),
    ).toMatchObject({ lifecycleEnabled: true, source: "explicit" });
    expect(
      resolveLifecyclePreference({
        explicitOverride: false,
        runRole: "lead",
        applicationDefault: true,
      }),
    ).toMatchObject({ lifecycleEnabled: false, source: "explicit" });
  });

  it("mutes worker and reviewer lifecycle notifications by role", () => {
    expect(lifecycleDefaultForRole("worker")).toBe(false);
    expect(lifecycleDefaultForRole("reviewer")).toBe(false);
    for (const runRole of ["worker", "reviewer"] as const) {
      expect(
        resolveLifecyclePreference({
          runRole,
          applicationDefault: true,
        }),
      ).toMatchObject({ lifecycleEnabled: false, source: "role" });
    }
  });

  it("lets standalone and lead sessions inherit the named application default", () => {
    expect(DEFAULT_NOTIFICATION_LIFECYCLE_ENABLED).toBe(true);
    for (const runRole of ["", "lead"] as const) {
      expect(
        resolveLifecyclePreference({
          runRole,
          applicationDefault: DEFAULT_NOTIFICATION_LIFECYCLE_ENABLED,
        }),
      ).toMatchObject({ lifecycleEnabled: true, source: "application" });
      expect(
        resolveLifecyclePreference({
          runRole,
          applicationDefault: false,
        }),
      ).toMatchObject({ lifecycleEnabled: false, source: "application" });
    }
  });
});
