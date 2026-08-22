import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "./mcp-endpoint.js";

const server = (url: string) => ({
  name: "fleet",
  url,
  headers: [{ name: "Authorization", value: "Bearer t" }],
});

describe("resolveMcpServers", () => {
  it("keeps the path but uses the address this node reaches the Host on", () => {
    // The Host preferred its public tunnel; this node talks to it on the LAN,
    // and sending the agent out to the internet to come back would be absurd.
    const [resolved] = resolveMcpServers(
      [server("https://spare-tunnel.trycloudflare.com/mcp")],
      "http://192.168.1.40:8787",
    );
    expect(resolved?.url).toBe("http://192.168.1.40:8787/mcp");
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
});
