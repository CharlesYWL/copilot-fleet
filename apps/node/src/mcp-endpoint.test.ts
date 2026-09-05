import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "./mcp-endpoint.js";

const server = (url: string) => ({
  name: "fleet",
  url,
  headers: [{ name: "Authorization", value: "Bearer t" }],
});

describe("resolveMcpServers", () => {
  it("keeps the path but uses the address this node reaches the Host on", () => {
    // The Host preferred its public tunnel; this node talks to it on loopback,
    // and sending the agent out to the internet to come back would be absurd.
    const [resolved] = resolveMcpServers(
      [server("https://spare-tunnel.trycloudflare.com/mcp")],
      "http://127.0.0.1:8787",
    );
    expect(resolved?.url).toBe("http://127.0.0.1:8787/mcp");
    expect(resolved?.headers).toEqual([{ name: "Authorization", value: "Bearer t" }]);
  });

  it("leaves an address that already matches alone", () => {
    const [resolved] = resolveMcpServers(
      [server("http://127.0.0.1:8787/mcp")],
      "http://127.0.0.1:8787",
    );
    expect(resolved?.url).toBe("http://127.0.0.1:8787/mcp");
  });

  it("accepts a bare path, since the path is all it uses", () => {
    const [resolved] = resolveMcpServers([server("/mcp")], "http://127.0.0.1:8787");
    expect(resolved?.url).toBe("http://127.0.0.1:8787/mcp");
  });

  it("returns nothing for the ordinary session, which is given no servers", () => {
    expect(resolveMcpServers([], "http://127.0.0.1:8787")).toEqual([]);
  });

  it("tolerates a command from a Host that predates the field", () => {
    expect(resolveMcpServers(undefined, "http://127.0.0.1:8787")).toEqual([]);
  });

  /**
   * The header this rebases carries a live lead token.
   *
   * That token is the orchestrator's whole control plane — it starts sessions,
   * reads transcripts and dispatches work — and it is sent on every call the
   * agent makes to the address produced here. Pointing it at plain HTTP on
   * anything but this machine puts it in front of whoever is on the path, so
   * the command fails loudly rather than quietly handing it over.
   */
  it("refuses to point an agent's lead token at plain HTTP off this machine", () => {
    expect(() => resolveMcpServers([server("/mcp")], "http://192.168.1.40:8787")).toThrow(
      /HTTPS|plain HTTP|loopback/i,
    );
    expect(() => resolveMcpServers([server("/mcp")], "http://bore.pub:45871")).toThrow(
      /HTTPS|plain HTTP|loopback/i,
    );
  });

  it("says nothing about it when there is no server to rebase", () => {
    // An ordinary session carries no token, so an address that could not carry
    // one safely is not this function's problem.
    expect(resolveMcpServers([], "http://192.168.1.40:8787")).toEqual([]);
  });

  it("still rebases onto https anywhere, and onto loopback", () => {
    expect(resolveMcpServers([server("/mcp")], "https://192.168.1.40:8787")[0]?.url).toBe(
      "https://192.168.1.40:8787/mcp",
    );
    expect(resolveMcpServers([server("/mcp")], "http://localhost:8787")[0]?.url).toBe(
      "http://localhost:8787/mcp",
    );
  });
});
