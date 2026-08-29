import { describe, expect, it } from "vitest";
import {
  EntraAuthenticationFailedError,
  EntraProviderUnavailableError,
  classifyEntraFailure,
} from "./entra.js";

/**
 * What Microsoft says when a sign-in does not work, in Fleet's words.
 *
 * Every one of these is an ordinary outcome — a code redeemed twice, a browser
 * left open too long, a tenant that blocks the flow, a Host with no route to
 * login.microsoftonline.com. None of them is a malfunction, so none may reach
 * the operator as a stack trace, a raw provider sentence, or a generic 500 in
 * the address bar. A programmer error is a different thing and stays one.
 */
describe("classifyEntraFailure", () => {
  const failure = (error: unknown) => classifyEntraFailure(error);

  it("reads a spent or expired authorization code as an expired sign-in", () => {
    const error = Object.assign(new Error("AADSTS54005: code already redeemed"), {
      errorCode: "invalid_grant",
    });
    const named = failure(error);
    expect(named).toBeInstanceOf(EntraAuthenticationFailedError);
    expect((named as EntraAuthenticationFailedError).code).toBe("expired");
  });

  it("reads a nonce or state mismatch as an expired sign-in", () => {
    expect(
      (
        failure(
          new Error("nonce_mismatch_error: nonce does not match"),
        ) as EntraAuthenticationFailedError
      ).code,
    ).toBe("expired");
    expect(
      (failure(new Error("state_mismatch_error")) as EntraAuthenticationFailedError).code,
    ).toBe("expired");
  });

  it("reads a token validation failure as an expired sign-in", () => {
    expect(
      (
        failure(
          new Error("invalid_token: id token failed validation"),
        ) as EntraAuthenticationFailedError
      ).code,
    ).toBe("expired");
  });

  it("reads the person saying no as a cancellation", () => {
    expect(
      (
        failure(
          Object.assign(new Error("AADSTS65004: user declined consent"), {
            errorCode: "access_denied",
          }),
        ) as EntraAuthenticationFailedError
      ).code,
    ).toBe("cancelled");
  });

  it("reads an unreachable directory as the provider being unavailable", () => {
    for (const message of [
      "getaddrinfo ENOTFOUND login.microsoftonline.com",
      "connect ECONNREFUSED 20.190.1.1:443",
      "network_error: fetch failed",
    ]) {
      expect(failure(new Error(message))).toBeInstanceOf(EntraProviderUnavailableError);
    }
  });

  it("reads a misconfigured registration as the provider being unavailable", () => {
    expect(
      failure(
        Object.assign(new Error("AADSTS700016: application not found"), {
          errorCode: "unauthorized_client",
        }),
      ),
    ).toBeInstanceOf(EntraProviderUnavailableError);
  });

  /*
   * The message is Microsoft's, and it lands in a redirect the operator sees.
   * Fleet keeps its own sentence for that; the provider's text is for the log.
   */
  it("never repeats provider text back to the browser", () => {
    const named = failure(
      new Error("AADSTS50126: Error validating credentials for user bob@contoso.com"),
    );
    const message = named instanceof Error ? named.message : String(named);
    expect(message).not.toContain("bob@contoso.com");
    expect(message).not.toContain("AADSTS50126");
  });

  it("leaves a programmer error exactly as it found it", () => {
    const bug = new TypeError("cannot read properties of undefined");
    expect(failure(bug)).toBe(bug);
  });
});
