import { describe, expect, it } from "vitest";
import { enrollCommand, isDevTunnelUrl, isLocalOnlyHostUrl } from "./enroll-command";

const URL = "https://fleet.example.com";
const TOKEN = "abc123";
const DEVTUNNEL_URL = "https://7m667npm-8790.usw2.devtunnels.ms";
const TUNNEL_ID = "neat-lake-7x8gj9s.usw2";

describe("enrollCommand", () => {
  it("uses the short root aliases and carries host url + token", () => {
    const command = enrollCommand(URL, TOKEN);
    expect(command).toContain(URL);
    expect(command).toContain(TOKEN);
    expect(command).toContain("npm run build:node");
    expect(command).toContain("npm run start:node");
    expect(command).not.toContain("@fleet/node");
    expect(command).not.toContain("FLEET_NODE_NAME");
  });

  it("passes flags, so one paste works in every shell", () => {
    const command = enrollCommand(URL, TOKEN);
    expect(command).toContain(`npm run start:node -- --url="${URL}" --token="${TOKEN}"`);
    // Neither a `$env:` prefix nor a bash line continuation, both of which are
    // syntax errors in the other shell.
    expect(command).not.toContain("$env:");
    expect(command).not.toContain("\\");
  });
});

describe("isLocalOnlyHostUrl", () => {
  it("flags addresses a remote node cannot reach", () => {
    for (const url of [
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://0.0.0.0:8787",
      "http://[::1]:8787",
    ]) {
      expect(isLocalOnlyHostUrl(url)).toBe(true);
    }
  });

  it("accepts tunnel and LAN addresses", () => {
    for (const url of [
      "https://fleet.example.com",
      "http://192.168.50.73:8787",
      "https://a-b-c.trycloudflare.com",
    ]) {
      expect(isLocalOnlyHostUrl(url)).toBe(false);
    }
  });
});

describe("isDevTunnelUrl", () => {
  it("recognises dev tunnel hosts", () => {
    expect(isDevTunnelUrl(DEVTUNNEL_URL)).toBe(true);
    expect(isDevTunnelUrl(`${DEVTUNNEL_URL}/`)).toBe(true);
  });

  it("leaves other providers alone", () => {
    for (const url of [
      "https://a-b-c.trycloudflare.com",
      "https://foo.ngrok-free.app",
      "http://127.0.0.1:8790",
      "https://fleet.example.com",
    ]) {
      expect(isDevTunnelUrl(url)).toBe(false);
    }
  });
});

describe("enrollCommand for dev tunnels", () => {
  const command = enrollCommand(DEVTUNNEL_URL, TOKEN, TUNNEL_ID);

  it("never hands a node the private URL, which it cannot authenticate to", () => {
    expect(command).not.toContain(DEVTUNNEL_URL);
    expect(command).not.toContain("devtunnels.ms");
  });

  it("signs the node's machine in and dials the forwarded loopback port", () => {
    expect(command).toContain("devtunnel user login");
    expect(command).toContain(`devtunnel connect ${TUNNEL_ID}`);
    expect(command).toContain('--url="http://127.0.0.1:8790"');
    expect(command).toContain(TOKEN);
  });

  it("tells the operator to read the port back, since the CLI may pick another", () => {
    expect(command).toContain("Forwarding from");
  });

  it("degrades to a placeholder rather than a wrong id when none was parsed", () => {
    const withoutId = enrollCommand(DEVTUNNEL_URL, TOKEN);
    expect(withoutId).toContain("devtunnel connect <tunnel-id>");
  });
});
