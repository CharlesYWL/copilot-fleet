import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalLoginUrl,
  fetchAuthStatus,
  forgetCsrfToken,
  readAuthError,
} from "./auth";

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("canonical login origin", () => {
  it("moves a 127.0.0.1 page to localhost, which is the registered reply name", () => {
    // Entra matches the reply URL by name and ignores the port, so the callback
    // always comes back to `localhost` — and the Lax transaction cookie set for
    // 127.0.0.1 would not be sent with it.
    expect(canonicalLoginUrl("http://127.0.0.1:8787/?tab=nodes")).toBe(
      "http://localhost:8787/?tab=nodes",
    );
    expect(canonicalLoginUrl("http://127.0.0.1/")).toBe("http://localhost/");
  });

  it("leaves every other origin alone, including one already canonical", () => {
    expect(canonicalLoginUrl("http://localhost:8787/")).toBeUndefined();
    expect(canonicalLoginUrl("https://fleet.example.com/")).toBeUndefined();
    expect(canonicalLoginUrl("http://192.168.1.5:8787/")).toBeUndefined();
  });
});

describe("auth status", () => {
  it("reads the Host's own account of itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          state: "unclaimed",
          authenticated: false,
          passwordEnabled: false,
          entraConfigured: false,
          deviceFlowEnabled: false,
          claimCodeRequired: true,
          canSignIn: true,
          codeLogin: { available: true },
        }),
      ),
    );

    await expect(fetchAuthStatus()).resolves.toMatchObject({
      state: "unclaimed",
      claimCodeRequired: true,
    });
  });

  it("treats an unreachable Host as signed out rather than as authenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const status = await fetchAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.unreachable).toBe(true);
  });
});

describe("auth error hand-back", () => {
  it("reads the reason a callback redirected, and clears it from the address bar", () => {
    window.history.replaceState(
      {},
      "",
      "/?auth_error=not-authorized&auth_error_message=No%20thanks&tab=nodes",
    );

    expect(readAuthError()).toEqual({
      code: "not-authorized",
      message: "No thanks",
    });
    // A refresh must not re-raise a failure the operator has already read, and
    // the rest of the query string is not ours to discard.
    expect(window.location.search).toBe("?tab=nodes");
    expect(readAuthError()).toBeUndefined();
  });

  it("ignores a code this build does not know", () => {
    window.history.replaceState({}, "", "/?auth_error=administrator");
    expect(readAuthError()).toBeUndefined();
  });
});
