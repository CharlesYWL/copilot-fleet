import { describe, expect, it } from "vitest";
import {
  SessionAccountingSchema,
  UsageReportQuerySchema,
  UsageSnapshotSchema,
} from "./usage.js";

describe("session accounting contracts", () => {
  const accounting = {
    nativeSessionId: "native-1",
    counterId: "native-1",
    source: "copilot-checkpoint",
    observedAt: "2026-10-19T12:00:00.000Z",
  };
  it("keeps unknown quantities absent and preserves explicit zero", () => {
    expect(SessionAccountingSchema.parse(accounting).totalTokens).toBeUndefined();
    expect(
      SessionAccountingSchema.parse({ ...accounting, aiCredits: 0, totalTokens: 0 }),
    ).toMatchObject({ aiCredits: 0, totalTokens: 0 });
  });
  it("rejects invalid consumption counters", () => {
    for (const totalTokens of [
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        SessionAccountingSchema.safeParse({ ...accounting, totalTokens }).success,
      ).toBe(false);
    }
    expect(
      SessionAccountingSchema.safeParse({ ...accounting, aiCredits: -1 }).success,
    ).toBe(false);
  });
  it("validates bounded snapshot identities", () => {
    expect(
      UsageSnapshotSchema.parse({
        id: "snapshot-1",
        sequence: 1,
        sessionId: "fleet-1",
        accounting,
      }),
    ).toMatchObject({ sequence: 1 });
    expect(
      UsageSnapshotSchema.safeParse({
        id: "snapshot-1",
        sequence: 0,
        sessionId: "fleet-1",
        accounting,
      }).success,
    ).toBe(false);
  });
  it("validates timezones and exclusive report boundaries", () => {
    expect(UsageReportQuerySchema.parse({}).groupBy).toBe("day");
    expect(
      UsageReportQuerySchema.safeParse({
        from: "2026-10-20T00:00:00Z",
        to: "2026-10-19T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(UsageReportQuerySchema.safeParse({ timeZone: "Not/AZone" }).success).toBe(
      false,
    );
    expect(UsageReportQuerySchema.safeParse({ groupBy: "sql" }).success).toBe(false);
  });
});
