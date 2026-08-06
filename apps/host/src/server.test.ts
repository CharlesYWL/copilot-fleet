import { describe, expect, it } from "vitest";
import { resolveEnrollmentToken } from "./server.js";

describe("production enrollment token", () => {
  it("rejects missing and default production tokens", () => {
    expect(() => resolveEnrollmentToken(undefined, "production")).toThrow(
      /ENROLLMENT_TOKEN/,
    );
    expect(() => resolveEnrollmentToken("change-me", "production")).toThrow(
      /ENROLLMENT_TOKEN/,
    );
  });

  it("allows an explicit non-default production token", () => {
    expect(resolveEnrollmentToken("production-secret", "production")).toBe(
      "production-secret",
    );
    expect(resolveEnrollmentToken(undefined, "test")).toBe("change-me");
  });
});
