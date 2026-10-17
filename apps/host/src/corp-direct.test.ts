import { describe, expect, it, vi } from "vitest";
import {
  CorpDirectAccess,
  CORP_DIRECT_CONFIG_SETTING,
  CORP_DIRECT_INITIALIZED_SETTING,
  CORP_DIRECT_MATERIAL_SETTING,
  corpDirectFirewallCommand,
} from "./corp-direct.js";
import { TEST_TLS_CERTIFICATE } from "../../../packages/protocol/dist/test-tls-fixture.js";

const fixture = () => {
  const values = new Map<string, string>();
  let allowed = true;
  const issue = vi.fn();
  const access = new CorpDirectAccess({
    store: {
      getSetting: (key) => values.get(key),
      setSetting: (key, value) => {
        values.set(key, value);
      },
    },
    upstream: "http://127.0.0.1:8787",
    hostId: () => "host-test",
    canRun: () => allowed,
    addresses: () => ["10.0.5.136"],
    platform: "win32",
    issue,
  });
  return {
    access,
    values,
    issue,
    revoke: () => {
      allowed = false;
    },
  };
};
const configuration = {
  hostIp: "10.0.5.136",
  port: 8787,
  allowedSources: ["10.0.18.236"],
};

describe("Corp direct Host configuration", () => {
  it("requires an assigned private address, an explicit source scope and corporate ownership", () => {
    const f = fixture();
    expect(() => f.access.configure({ ...configuration, hostIp: "8.8.8.8" })).toThrow();
    expect(() => f.access.configure({ ...configuration, hostIp: "10.0.5.137" })).toThrow(
      /not assigned/,
    );
    expect(() => f.access.configure({ ...configuration, allowedSources: [] })).toThrow();
    f.access.configure(configuration);
    expect(JSON.parse(f.values.get(CORP_DIRECT_CONFIG_SETTING)!)).toEqual(configuration);
    f.revoke();
    expect(() => f.access.configure(configuration)).toThrow(/corporate/);
  });

  it("never returns private PFX values in public setup information", () => {
    const f = fixture();
    f.access.configure(configuration);
    f.values.set(
      CORP_DIRECT_MATERIAL_SETTING,
      JSON.stringify({
        hostId: "host-test",
        hostIp: configuration.hostIp,
        authorityPfx: "synthetic-private-authority",
        serverPfx: "synthetic-private-server",
        caCertificate: TEST_TLS_CERTIFICATE,
        serverExpiresAt: "2030-01-01T00:00:00.000Z",
        caExpiresAt: "2050-01-01T00:00:00.000Z",
      }),
    );
    const info = f.access.info();
    expect(info.caCertificate).toBe(TEST_TLS_CERTIFICATE);
    expect(JSON.stringify(info)).not.toContain("synthetic-private");
    expect(info.firewallCommand).toContain("-LocalPort 8787");
    expect(info.firewallCommand).toContain("10.0.18.236");
  });

  it("fails rather than silently replacing a lost private authority", async () => {
    const f = fixture();
    f.access.configure(configuration);
    f.values.set(CORP_DIRECT_INITIALIZED_SETTING, "1");
    await expect(f.access.start()).rejects.toThrow(/authority is missing/);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it("quotes Windows executable paths without permitting shell interpolation", () => {
    const command = corpDirectFirewallCommand(
      configuration,
      "C:\\User's $tools`\\node.exe",
    );
    expect(command).toContain("-Program 'C:\\User''s $tools`\\node.exe'");
    expect(command).not.toContain("0.0.0.0");
    expect(command).not.toContain("-RemoteAddress Any");
  });
});
