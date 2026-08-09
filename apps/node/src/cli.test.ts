import { describe, expect, it } from "vitest";
import { CliError, USAGE, parseNodeArgs } from "./cli.js";

describe("parseNodeArgs", () => {
  it("returns nothing to override for an empty command line", () => {
    expect(parseNodeArgs([])).toEqual({ wantsHelp: false, env: {} });
  });

  it("accepts both --flag=value and --flag value", () => {
    expect(parseNodeArgs(["--url=https://fleet.example.com"]).env).toEqual({
      FLEET_HOST_URL: "https://fleet.example.com",
    });
    expect(parseNodeArgs(["--url", "https://fleet.example.com"]).env).toEqual({
      FLEET_HOST_URL: "https://fleet.example.com",
    });
  });

  it("maps every documented flag onto the variable it stands in for", () => {
    const { env } = parseNodeArgs([
      "--host-url=https://fleet.example.com",
      "--node-name=WEILI-PC",
      "--enrollment-token=abc123",
      "--max-sessions=8",
      "--copilot-command=/opt/copilot",
      "--permission-timeout-ms=60000",
      "--config-port=9100",
    ]);
    expect(env).toEqual({
      FLEET_HOST_URL: "https://fleet.example.com",
      FLEET_NODE_NAME: "WEILI-PC",
      FLEET_ENROLLMENT_TOKEN: "abc123",
      FLEET_MAX_SESSIONS: "8",
      FLEET_COPILOT_COMMAND: "/opt/copilot",
      PERMISSION_TIMEOUT_MS: "60000",
      FLEET_NODE_CONFIG_PORT: "9100",
    });
  });

  it("reads booleans bare, inline and negated", () => {
    expect(parseNodeArgs(["--mock-agent"]).env).toEqual({ FLEET_MOCK_AGENT: "1" });
    expect(parseNodeArgs(["--mock-agent=false"]).env).toEqual({ FLEET_MOCK_AGENT: "0" });
    // Turning the .env's FLEET_MOCK_AGENT=1 back off for a single run.
    expect(parseNodeArgs(["--no-mock-agent"]).env).toEqual({ FLEET_MOCK_AGENT: "0" });
  });

  it("keeps an empty value, so a flag can clear a stored setting", () => {
    expect(parseNodeArgs(["--copilot-command="]).env).toEqual({
      FLEET_COPILOT_COMMAND: "",
    });
  });

  it("ignores the separator npm leaves in the argument list", () => {
    expect(parseNodeArgs(["--", "--url=https://fleet.example.com"]).env).toEqual({
      FLEET_HOST_URL: "https://fleet.example.com",
    });
  });

  it("reports help without pretending it is a setting", () => {
    expect(parseNodeArgs(["--help"])).toEqual({ wantsHelp: true, env: {} });
    expect(parseNodeArgs(["-h"]).wantsHelp).toBe(true);
  });

  it("refuses a value-less flag instead of swallowing the next option", () => {
    // `--url --mock-agent` used to register the node against the host
    // "--mock-agent" and fail minutes later with a DNS error.
    expect(() => parseNodeArgs(["--url", "--mock-agent"])).toThrow(CliError);
    expect(() => parseNodeArgs(["--url"])).toThrow(/--url expects a value/);
  });

  it("refuses unknown options and stray words", () => {
    expect(() => parseNodeArgs(["--hostname=x"])).toThrow(/Unknown option "--hostname"/);
    expect(() => parseNodeArgs(["--no-url=x"])).toThrow(/Unknown option/);
    expect(() => parseNodeArgs(["start"])).toThrow(/Unexpected argument "start"/);
  });

  it("refuses a boolean it cannot read either way", () => {
    expect(() => parseNodeArgs(["--mock-agent=maybe"])).toThrow(/expects a boolean/);
    expect(() => parseNodeArgs(["--no-mock-agent=1"])).toThrow(/does not take a value/);
  });

  it("documents every flag it accepts", () => {
    for (const flag of [
      "--url",
      "--name",
      "--token",
      "--max-sessions",
      "--copilot-command",
      "--permission-timeout-ms",
      "--config-port",
      "--mock-agent",
      "--help",
    ]) {
      expect(USAGE).toContain(flag);
    }
  });
});
