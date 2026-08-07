import { describe, expect, it } from "vitest";
import { enrollCommand, isLocalOnlyHostUrl } from "./enroll-command";

const URL = "https://fleet.example.com";
const TOKEN = "abc123";

describe("enrollCommand", () => {
  it("uses the short root aliases and carries host url + token", () => {
    for (const shell of ["bash", "powershell"] as const) {
      const command = enrollCommand(shell, URL, TOKEN);
      expect(command).toContain(URL);
      expect(command).toContain(TOKEN);
      expect(command).toContain("npm run build:node");
      expect(command).toContain("npm run start:node");
      expect(command).not.toContain("@fleet/node");
      expect(command).not.toContain("FLEET_NODE_NAME");
    }
  });

  it("continues bash lines but keeps powershell statements standalone", () => {
    expect(enrollCommand("bash", URL, TOKEN)).toContain("\\");
    expect(enrollCommand("powershell", URL, TOKEN)).not.toContain("\\");
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
