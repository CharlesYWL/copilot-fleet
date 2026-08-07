import { describe, expect, it } from "vitest";
import {
  resolveEnrollmentHostUrl,
  resolveEnrollmentToken,
  resolvePublicHostUrl,
} from "./server.js";

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

describe("public host url", () => {
  it("prefers the configured public url without a trailing slash", () => {
    expect(
      resolvePublicHostUrl("https://fleet.example.com/", "0.0.0.0", "8787"),
    ).toBe("https://fleet.example.com");
  });

  it("falls back to loopback because wildcard binds are not dialable", () => {
    expect(resolvePublicHostUrl(undefined, "0.0.0.0", "8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(resolvePublicHostUrl(undefined, "::", "9000")).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("keeps a concrete bind address", () => {
    expect(resolvePublicHostUrl(undefined, "192.168.1.5", "8787")).toBe(
      "http://192.168.1.5:8787",
    );
  });
});

describe("enrollment host url", () => {
  it("prefers the live tunnel url over the fallback", () => {
    expect(
      resolveEnrollmentHostUrl(
        "https://abc.trycloudflare.com/",
        "http://127.0.0.1:8787",
      ),
    ).toBe("https://abc.trycloudflare.com");
  });

  it("uses the fallback when the tunnel is down", () => {
    expect(resolveEnrollmentHostUrl(undefined, "http://192.168.1.5:8787")).toBe(
      "http://192.168.1.5:8787",
    );
  });
});
