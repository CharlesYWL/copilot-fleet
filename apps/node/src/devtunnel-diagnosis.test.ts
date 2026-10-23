import { describe, expect, it, vi } from "vitest";
import {
  checkDevTunnelHost,
  checkDevTunnelHosting,
  parseDevTunnelShow,
} from "./devtunnel-diagnosis.js";

/** Captured from `devtunnel show <id> --json` (CLI 1.0.2014) with the Host running. */
const HOSTED = `{
  "tunnel": {
    "tunnelId": "fleet-72f9a3f7.usw2",
    "hostConnections": 1,
    "clientConnections": 1,
    "ports": [{ "portNumber": 8787, "protocol": "http" }]
  }
}`;

/** The same command for a tunnel nobody is hosting. */
const NOT_HOSTED = `{
  "tunnel": {
    "tunnelId": "fleet-probe-77308.usw2",
    "hostConnections": 0,
    "clientConnections": 0
  }
}`;

describe("parseDevTunnelShow", () => {
  it("reads whether a Host is attached", () => {
    expect(parseDevTunnelShow(HOSTED)).toEqual({ status: "hosted", hostConnections: 1 });
    expect(parseDevTunnelShow(NOT_HOSTED)).toEqual({ status: "not-hosted" });
  });

  it("tolerates a banner before the JSON", () => {
    expect(parseDevTunnelShow(`Welcome to dev tunnels!\n${NOT_HOSTED}`)).toEqual({
      status: "not-hosted",
    });
  });

  it("does not guess when the output is not what it expects", () => {
    expect(parseDevTunnelShow("Login required.").status).toBe("unknown");
    expect(parseDevTunnelShow("{ not json").status).toBe("unknown");
    expect(parseDevTunnelShow('{"tunnel":{}}').status).toBe("unknown");
  });
});

describe("checkDevTunnelHost", () => {
  it("asks the Dev Tunnels service about the tunnel this Node connects to", async () => {
    const run = vi.fn(async () => NOT_HOSTED);
    const problem = await checkDevTunnelHost("fleet-abc.usw2", { run, timeoutMs: 50 });
    expect(run).toHaveBeenCalledWith(["show", "fleet-abc.usw2", "--json"], 50);
    expect(problem).toMatchObject({
      kind: "tunnel-not-hosted",
      summary: "Host is not running",
    });
    expect(problem.message).toContain("fleet-abc.usw2");
  });

  it("says the tunnel is hosted but not answering when a Host is attached", async () => {
    const problem = await checkDevTunnelHost("fleet-abc.usw2", {
      run: async () => HOSTED,
    });
    expect(problem.kind).toBe("tunnel-not-answering");
    expect(problem.message).toMatch(/Rebuild tunnel/);
  });

  it("quotes the CLI when it cannot answer", async () => {
    const check = await checkDevTunnelHosting("fleet-abc.usw2", {
      run: async () => {
        throw new Error("Login required.");
      },
    });
    expect(check).toEqual({ status: "unknown", detail: "Login required." });
    const problem = await checkDevTunnelHost("fleet-abc.usw2", {
      run: async () => {
        throw new Error("Login required.");
      },
    });
    expect(problem.kind).toBe("tunnel-check-failed");
    expect(problem.message).toMatch(/devtunnel user login/);
  });
});
