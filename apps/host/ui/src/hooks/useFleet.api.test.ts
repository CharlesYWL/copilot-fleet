import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./useFleet";
import { csrfToken, forgetCsrfToken } from "../lib/auth";

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const stale = () => answer({ error: "Missing or invalid CSRF token" }, 403);

/** A Host whose session — and so whose CSRF proof — moves on under the page. */
const host = (write: (proof: string | null) => Response) => {
  let session = "old-proof";
  const proofs: (string | null)[] = [];
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input) === "/api/auth/csrf") return answer({ csrfToken: session });
    // Read at send time: the caller may reuse its headers for the next attempt.
    const proof = new Headers(init?.headers).get("x-csrf-token");
    proofs.push(proof);
    bodies.push(init?.body);
    return write(proof);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    proofs,
    bodies,
    signInElsewhere: () => {
      session = "new-proof";
    },
  };
};

describe("api after a sign-in in another tab", () => {
  it("asks once more with the new session's proof", async () => {
    const fleet = host((proof) =>
      proof === "new-proof" ? answer({ saved: true }) : stale(),
    );
    await expect(csrfToken()).resolves.toBe("old-proof");
    fleet.signInElsewhere();

    await expect(
      api("/api/local-agent/config", { method: "PUT", body: '{"enabled":true}' }),
    ).resolves.toEqual({ saved: true });
    expect(fleet.proofs).toEqual(["old-proof", "new-proof"]);
    expect(fleet.bodies).toEqual(['{"enabled":true}', '{"enabled":true}']);
  });

  it("asks only once, and then reports the refusal", async () => {
    const fleet = host(stale);
    await expect(api("/api/thing", { method: "POST", body: "{}" })).rejects.toMatchObject(
      {
        status: 403,
        message: "Missing or invalid CSRF token",
      },
    );
    expect(fleet.proofs).toHaveLength(2);
  });

  it("does not repeat any other refusal", async () => {
    const fleet = host(() =>
      answer({ error: "Sign in with Microsoft again.", reauthRequired: true }, 403),
    );
    await expect(api("/api/thing", { method: "POST", body: "{}" })).rejects.toMatchObject(
      {
        status: 403,
        body: { reauthRequired: true },
      },
    );
    expect(fleet.proofs).toHaveLength(1);
  });

  it("does not resend a body it could not send twice, or a proof it was handed", async () => {
    const fleet = host(stale);
    await expect(
      api("/api/upload", { method: "POST", body: new Blob(["archive"]) }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      api("/api/thing", {
        method: "POST",
        body: "{}",
        headers: { "x-csrf-token": "given" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fleet.proofs).toEqual(["old-proof", "given"]);
  });

  it("never sends a proof with a read", async () => {
    const fleet = host(stale);
    await expect(api("/api/thing")).rejects.toMatchObject({ status: 403 });
    expect(fleet.proofs).toEqual([null]);
    expect(fleet.fetchMock.mock.calls.some(([input]) => input === "/api/auth/csrf")).toBe(
      false,
    );
  });
});
