import { describe, expect, it } from "vitest";
import {
  devTunnelLoginCommand,
  enrollCommand,
  isDevTunnelUrl,
  isLocalOnlyHostUrl,
  keyEnrollCommand,
} from "./enroll-command";

const URL = "https://fleet.example.com";
const TOKEN = "abc123";
const DEVTUNNEL_URL = "https://7m667npm-8790.usw2.devtunnels.ms";
const TUNNEL_ID = "neat-lake-7x8gj9s.usw2";
const FINGERPRINT = "a".repeat(64);
const GRANT = "grant-1.Zm9vYmFyc2VjcmV0";

/**
 * The Connect command is the only place a Host fingerprint is handed to a
 * person, and pasting it is what pins that Host on the new machine. A command
 * missing any of the three parts is a Node that would enrol with whatever
 * answers the URL — which is the failure the whole protocol exists to prevent.
 */
describe("keyEnrollCommand", () => {
  const command = keyEnrollCommand({
    hostUrl: URL,
    hostId: "host-1",
    hostFingerprint: FINGERPRINT,
    enrollmentGrant: GRANT,
  });

  it("carries the URL, the Host identity and the one-time grant", () => {
    expect(command).toContain(`--url="${URL}"`);
    expect(command).toContain(`--host-id="host-1"`);
    expect(command).toContain(`--host-fingerprint="${FINGERPRINT}"`);
    expect(command).toContain(`--enrollment-grant="${GRANT}"`);
  });

  it("never carries the fleet-wide token, which it replaces", () => {
    expect(command).not.toContain("--token");
    expect(command).not.toContain(TOKEN);
  });

  it("uses the same paste-anywhere shape as the legacy command", () => {
    expect(command).toContain("npm install");
    expect(command).toContain("npm run build:node");
    expect(command).not.toContain("$env:");
    expect(command).not.toContain("\\");
  });

  it("lets a dev tunnel node open the tunnel itself", () => {
    const tunnelled = keyEnrollCommand({
      hostUrl: DEVTUNNEL_URL,
      hostId: "host-1",
      hostFingerprint: FINGERPRINT,
      enrollmentGrant: GRANT,
      tunnelId: TUNNEL_ID,
    });
    expect(tunnelled).toContain(`--devtunnel="${TUNNEL_ID}"`);
    // The private URL is one a node cannot authenticate to, so it never appears.
    expect(tunnelled).not.toContain(DEVTUNNEL_URL);
    expect(tunnelled).toContain(`--host-fingerprint="${FINGERPRINT}"`);
  });
});

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

  it("lets the node open the tunnel itself instead of a second terminal", () => {
    expect(command).toContain(`--devtunnel="${TUNNEL_ID}"`);
    expect(command).toContain(TOKEN);
    // The forwarded port is discovered at runtime, so nothing should be
    // transcribed into the command.
    expect(command).not.toContain("127.0.0.1");
    expect(command).not.toContain("devtunnel connect");
  });

  it("keeps the interactive login out of the start command", () => {
    expect(command).not.toContain("devtunnel user login");
    expect(devTunnelLoginCommand()).toBe("devtunnel user login");
  });

  it("degrades to a placeholder rather than a wrong id when none was parsed", () => {
    expect(enrollCommand(DEVTUNNEL_URL, TOKEN)).toContain('--devtunnel="<tunnel-id>"');
  });
});
