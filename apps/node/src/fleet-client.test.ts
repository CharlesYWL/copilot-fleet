import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NODE_ID_HEADER,
  NODE_PROOF_NONCE_HEADER,
  NODE_PROOF_SIGNATURE_HEADER,
  NODE_PROOF_TIMESTAMP_HEADER,
  NODE_SECRET_HEADER,
} from "@fleet/protocol";
import { createIdentityKeyPair, verifyNodeHttpProof } from "@fleet/protocol/node-auth";
import { FleetClient, ownPlacements, type PlacementLike } from "./fleet-client.js";

const placements: PlacementLike[] = [
  { id: "p1", workspaceId: "w1", nodeId: "me", localPath: "/a" },
  { id: "p2", workspaceId: "w2", nodeId: "other", localPath: "/b" },
  { id: "p3", workspaceId: "w3", nodeId: "me", localPath: "/c" },
];

describe("ownPlacements", () => {
  it("keeps only the placements that live on this machine", () => {
    // The page edits absolute paths, and a path is only meaningful on the
    // machine it belongs to; showing another node's rows invites pointing it
    // at a directory that does not exist there.
    expect(ownPlacements(placements, "me").map((item) => item.id)).toEqual(["p1", "p3"]);
  });

  it("returns nothing when this node owns no placement", () => {
    expect(ownPlacements(placements, "unknown")).toEqual([]);
  });

  it("never matches on an empty node id", () => {
    // A node that has not enrolled yet has no id; treating "" as a wildcard
    // would expose the whole fleet's placements on an unidentified box.
    const orphan: PlacementLike[] = [
      { id: "p4", workspaceId: "w4", nodeId: "", localPath: "/d" },
    ];
    expect(ownPlacements(orphan, "")).toEqual([]);
  });
});

describe("FleetClient credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const capture = () => {
    const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers ?? {}),
          body: typeof init?.body === "string" ? init.body : "",
        });
        // Shaped to satisfy either schema, so a test can assert what was sent
        // without also standing up a Host's replies.
        const single = {
          id: "w1",
          name: "fleet",
          description: "",
          workspaceId: "w1",
          nodeId: "node-1",
          localPath: "/a",
          state: "starting",
          agentSessionId: "",
        };
        const method = (init?.method ?? "GET").toUpperCase();
        const body =
          method !== "GET"
            ? single
            : new URL(input).pathname === "/api/placements"
              ? [single]
              : [];
        return new Response(JSON.stringify(body), {
          status: 200,
        });
      }),
    );
    return calls;
  };

  it.each(["legacy", "keyed"])(
    "uses %s credentials on every relayed endpoint",
    async (auth) => {
      const calls = capture();
      const keys = createIdentityKeyPair();
      const client = new FleetClient({
        hostUrl: () => "http://127.0.0.1:8787",
        nodeId: () => "node-1",
        nodeSecret: () => "s3cret",
        nodeKey: () => (auth === "keyed" ? keys.privateKey : undefined),
      });

      await client.listWorkspaces();
      await client.listOwnPlacements();
      await client.createWorkspace("fleet", "");
      await client.updateWorkspace("w 1", "fleet", "");
      await client.createOwnPlacement("w1", "/a");
      await client.updateOwnPlacementPath("w1", "/b");
      await client.listOwnSessions();
      await client.createOwnSession({ placementId: "w1", prompt: "hello" });
      await client.adoptOwnSession({
        placementId: "w1",
        agentSessionId: "acp-1",
        additionalDirectories: [],
      });

      expect(calls).toHaveLength(10);
      for (const call of calls) {
        expect(call.headers.get(NODE_ID_HEADER)).toBe("node-1");
        if (auth === "legacy") {
          expect(call.headers.get(NODE_SECRET_HEADER)).toBe("s3cret");
        } else {
          expect(call.headers.has(NODE_SECRET_HEADER)).toBe(false);
          expect(
            verifyNodeHttpProof({
              publicKey: keys.publicKey,
              nodeId: "node-1",
              method: call.method,
              path: new URL(call.url).pathname,
              body: call.body,
              timestamp: call.headers.get(NODE_PROOF_TIMESTAMP_HEADER) ?? "",
              nonce: call.headers.get(NODE_PROOF_NONCE_HEADER) ?? "",
              signature: call.headers.get(NODE_PROOF_SIGNATURE_HEADER) ?? "",
            }),
          ).toEqual({ ok: true });
        }
      }
    },
  );

  it("says nothing about an identity it does not have yet", async () => {
    const calls = capture();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "",
      nodeSecret: () => undefined,
    });

    await client.listWorkspaces();

    expect(calls[0]?.headers.has(NODE_ID_HEADER)).toBe(false);
    expect(calls[0]?.headers.has(NODE_SECRET_HEADER)).toBe(false);
  });

  /**
   * A keyed Node has no shared secret to send, so the relay its config page
   * depends on had nothing to say and every call came back a 401. It signs
   * instead: the same identity that authenticates its WebSocket, over exactly
   * the request it is making, and nothing reusable on the wire.
   */
  it("signs each relayed call with the key it enrolled with", async () => {
    const calls = capture();
    const keys = createIdentityKeyPair();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "node-1",
      nodeKey: () => keys.privateKey,
    });

    await client.listWorkspaces();
    await client.createWorkspace("fleet", "");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.has(NODE_SECRET_HEADER)).toBe(false);
    const nonces = new Set<string>();
    for (const [index, call] of calls.entries()) {
      const timestamp = call.headers.get(NODE_PROOF_TIMESTAMP_HEADER) ?? "";
      const nonce = call.headers.get(NODE_PROOF_NONCE_HEADER) ?? "";
      const signature = call.headers.get(NODE_PROOF_SIGNATURE_HEADER) ?? "";
      nonces.add(nonce);
      expect(call.headers.get(NODE_ID_HEADER)).toBe("node-1");
      expect(
        verifyNodeHttpProof({
          publicKey: keys.publicKey,
          nodeId: "node-1",
          method: index === 0 ? "GET" : "POST",
          path: "/api/workspaces",
          ...(index === 0 ? {} : { body: call.body }),
          timestamp,
          nonce,
          signature,
        }),
      ).toEqual({ ok: true });
    }
    // A nonce reused across calls is a proof the Host has to accept twice.
    expect(nonces.size).toBe(2);
  });

  it("signs the path it actually calls, parameters and all", async () => {
    const calls = capture();
    const keys = createIdentityKeyPair();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "node-1",
      nodeKey: () => keys.privateKey,
    });

    await client.updateWorkspace("w 1", "fleet", "");

    const call = calls[0];
    const verify = (path: string) =>
      verifyNodeHttpProof({
        publicKey: keys.publicKey,
        nodeId: "node-1",
        method: "PATCH",
        path,
        body: call?.body ?? "",
        timestamp: call?.headers.get(NODE_PROOF_TIMESTAMP_HEADER) ?? "",
        nonce: call?.headers.get(NODE_PROOF_NONCE_HEADER) ?? "",
        signature: call?.headers.get(NODE_PROOF_SIGNATURE_HEADER) ?? "",
      });
    expect(verify("/api/workspaces/w%201")).toEqual({ ok: true });
    // The proof is for one resource, not for the collection it lives in.
    expect(verify("/api/workspaces/other")).toEqual({ ok: false, reason: "signature" });
  });

  it("keeps sending the shared secret while that is all a Node has", async () => {
    const calls = capture();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "node-1",
      nodeSecret: () => "s3cret",
      nodeKey: () => undefined,
    });

    await client.listWorkspaces();

    expect(calls[0]?.headers.get(NODE_SECRET_HEADER)).toBe("s3cret");
    expect(calls[0]?.headers.has(NODE_PROOF_SIGNATURE_HEADER)).toBe(false);
  });

  it.each(["legacy", "keyed"])(
    "uses %s node credentials for scoped session lifecycle calls",
    async (authentication) => {
      const keys = createIdentityKeyPair();
      const calls: Array<{
        url: string;
        method: string;
        body: string;
        headers: Headers;
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL | string, init?: RequestInit) => {
          calls.push({
            url: String(input),
            method: init?.method ?? "GET",
            body: String(init?.body ?? ""),
            headers: new Headers(init?.headers),
          });
          const body = String(input).endsWith("/api/sessions")
            ? init?.method === "POST"
              ? JSON.stringify({ id: "fleet-new", state: "starting", agentSessionId: "" })
              : "[]"
            : JSON.stringify({
                id: "fleet-adopted",
                state: "starting",
                agentSessionId: "acp-1",
              });
          return new Response(body, { status: 200 });
        }),
      );
      const client = new FleetClient({
        hostUrl: () => "http://127.0.0.1:8787",
        nodeId: () => "node-1",
        nodeSecret: () => "secret",
        nodeKey: () => (authentication === "keyed" ? keys.privateKey : undefined),
      });

      await client.listOwnSessions();
      await client.createOwnSession({ placementId: "p1", prompt: "hello" });
      await client.adoptOwnSession({
        placementId: "p1",
        agentSessionId: "acp-1",
        additionalDirectories: ["C:\\shared"],
      });

      expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
        ["GET", "/api/sessions"],
        ["POST", "/api/sessions"],
        ["POST", "/api/sessions/adopt"],
      ]);
      expect(calls[2]?.body).toContain('"agentSessionId":"acp-1"');
      expect(calls[2]?.body).toContain('"additionalDirectories":["C:\\\\shared"]');
      for (const call of calls) {
        expect(call.headers.get(NODE_ID_HEADER)).toBe("node-1");
        if (authentication === "legacy") {
          expect(call.headers.get(NODE_SECRET_HEADER)).toBe("secret");
          expect(call.headers.has(NODE_PROOF_SIGNATURE_HEADER)).toBe(false);
        } else {
          expect(call.headers.has(NODE_SECRET_HEADER)).toBe(false);
          expect(
            verifyNodeHttpProof({
              publicKey: keys.publicKey,
              nodeId: "node-1",
              method: call.method,
              path: new URL(call.url).pathname,
              body: call.body,
              timestamp: call.headers.get(NODE_PROOF_TIMESTAMP_HEADER) ?? "",
              nonce: call.headers.get(NODE_PROOF_NONCE_HEADER) ?? "",
              signature: call.headers.get(NODE_PROOF_SIGNATURE_HEADER) ?? "",
            }),
          ).toEqual({ ok: true });
        }
      }
    },
  );
});
