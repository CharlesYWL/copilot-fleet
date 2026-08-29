import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_MESSAGE_PARAM,
  AUTH_ERROR_PARAM,
  AuthStatusSchema,
  DEFAULT_TUNNEL_PROVIDER,
  MAX_AUTH_ERROR_MESSAGE_LENGTH,
  TunnelProviderInfoSchema,
  authErrorRedirect,
  authStates,
  parseAuthError,
} from "./index.js";

describe("auth error transport", () => {
  it("names every state the front door can be in", () => {
    // The gate has to say which of these it is looking at; a boolean pair
    // cannot tell "no Entra configuration" from "nobody has claimed this".
    expect(authStates).toContain("entra-unconfigured");
    expect(authStates).toContain("unclaimed");
    expect(authStates).toContain("microsoft-only");
  });

  it("sends a failed callback back to the app rather than leaving JSON on screen", () => {
    const target = authErrorRedirect("not-authorized", "That account is not authorized.");
    const url = new URL(target, "http://localhost:8787");

    expect(url.pathname).toBe("/");
    expect(url.searchParams.get(AUTH_ERROR_PARAM)).toBe("not-authorized");
    expect(url.searchParams.get(AUTH_ERROR_MESSAGE_PARAM)).toBe(
      "That account is not authorized.",
    );
  });

  it("truncates a long message instead of pasting a provider's output into a URL", () => {
    const target = authErrorRedirect("provider-unavailable", "x".repeat(5_000));
    const message = new URL(target, "http://localhost").searchParams.get(
      AUTH_ERROR_MESSAGE_PARAM,
    );
    expect(message).toHaveLength(MAX_AUTH_ERROR_MESSAGE_LENGTH);
  });

  it("reads back only codes it knows, so a crafted link cannot invent a state", () => {
    expect(parseAuthError("?auth_error=not-authorized&auth_error_message=Nope")).toEqual({
      code: "not-authorized",
      message: "Nope",
    });
    expect(parseAuthError("?auth_error=administrator")).toBeUndefined();
    expect(parseAuthError("")).toBeUndefined();
  });

  it("keeps a message the page will render out of markup and to a bounded length", () => {
    const parsed = parseAuthError(
      `?auth_error=expired&auth_error_message=${encodeURIComponent("<img onerror=x>".repeat(80))}`,
    );
    expect(parsed?.message).not.toContain("<");
    expect((parsed?.message ?? "").length).toBeLessThanOrEqual(
      MAX_AUTH_ERROR_MESSAGE_LENGTH,
    );
  });
});

describe("auth status contract", () => {
  it("tells the page whether this origin can finish a loopback sign-in", () => {
    const status = AuthStatusSchema.parse({
      state: "unclaimed",
      authenticated: false,
      passwordEnabled: false,
      entraConfigured: true,
      deviceFlowEnabled: false,
      claimCodeRequired: true,
      canSignIn: true,
      codeLogin: {
        available: false,
        canonicalUrl: "http://localhost:8787",
      },
    });

    expect(status.codeLogin.available).toBe(false);
    expect(status.codeLogin.canonicalUrl).toBe("http://localhost:8787");
    expect(status.codeLogin.localForwardRequired).toBe(false);
  });

  it("defaults the endpoint hint so an older Host still parses", () => {
    const status = AuthStatusSchema.parse({
      state: "microsoft-only",
      authenticated: true,
      passwordEnabled: false,
      entraConfigured: true,
      deviceFlowEnabled: false,
      claimCodeRequired: false,
      canSignIn: true,
    });
    expect(status.codeLogin).toEqual({ available: true, localForwardRequired: false });
  });
});

describe("tunnel provider policy", () => {
  it("prefers the private provider for a Host nobody has claimed yet", () => {
    expect(DEFAULT_TUNNEL_PROVIDER).toBe("devtunnel");
  });

  it("carries whether a provider may expose the operator control plane", () => {
    const bore = TunnelProviderInfoSchema.parse({
      id: "bore",
      label: "bore",
      binary: "bore",
      binaryPresent: true,
      installHint: "",
      externalScheme: "http",
      access: "public",
      controlPlaneEligible: false,
    });
    expect(bore.controlPlaneEligible).toBe(false);
    expect(bore.externalScheme).toBe("http");
  });

  it("assumes an HTTPS public provider when a Host does not say", () => {
    const spec = TunnelProviderInfoSchema.parse({
      id: "ngrok",
      label: "ngrok",
      binary: "ngrok",
      binaryPresent: false,
      installHint: "",
    });
    expect(spec).toMatchObject({
      externalScheme: "https",
      access: "public",
      controlPlaneEligible: true,
    });
  });
});
