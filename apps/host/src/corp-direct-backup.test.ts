import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "./store.js";
import { openSecurityEnvelope, sealSecurityEnvelope } from "./auth/security-backup.js";
import {
  CORP_DIRECT_CONFIG_SETTING,
  CORP_DIRECT_INITIALIZED_SETTING,
  CORP_DIRECT_MATERIAL_SETTING,
} from "./corp-direct.js";
import { TEST_TLS_CERTIFICATE } from "../../../packages/protocol/dist/test-tls-fixture.js";

const stores: FleetStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const setup = () => {
  const store = new FleetStore(":memory:");
  stores.push(store);
  store.insertAdministrator({
    tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    objectId: "synthetic-owner",
    username: "synthetic@microsoft.com",
    displayName: "Synthetic",
    addedVia: "claim",
  });
  store.setSetting("auth.mode", "microsoft-only");
  store.setSetting("auth.csrfKey", "synthetic-csrf-key");
  store.setSetting("orchestrator.tokenKey", "synthetic-lead-key");
  return store;
};
const configuration = {
  hostIp: "10.0.5.136",
  port: 8787,
  allowedSources: ["10.0.18.236"],
};
const material = {
  hostId: "synthetic-host",
  hostIp: configuration.hostIp,
  authorityPfx: "SYNTHETIC-PRIVATE-CA-PFX",
  serverPfx: "SYNTHETIC-PRIVATE-LEAF-PFX",
  caCertificate: TEST_TLS_CERTIFICATE,
  serverExpiresAt: "2030-01-01T00:00:00.000Z",
  caExpiresAt: "2050-01-01T00:00:00.000Z",
};
const seedDirect = (store: FleetStore) => {
  store.setSetting(CORP_DIRECT_CONFIG_SETTING, JSON.stringify(configuration));
  store.setSetting(CORP_DIRECT_MATERIAL_SETTING, JSON.stringify(material));
  store.setSetting(CORP_DIRECT_INITIALIZED_SETTING, "1");
};
const archive = (store: FleetStore) => store.exportHostBackup({ enrollmentToken: "" });
const portableData = (store: FleetStore) => {
  const {
    kind: _kind,
    version: _version,
    enrollmentToken: _token,
    nodes,
    ...data
  } = archive(store);
  return { ...data, nodes: nodes.map(({ secretHash: _secret, ...node }) => node) };
};

describe("Corp direct security backup", () => {
  it("keeps private certificates out of legacy data backups and preserves the receiving authority", () => {
    const source = setup();
    seedDirect(source);
    const legacy = archive(source);
    expect(JSON.stringify(legacy)).not.toContain(material.authorityPfx);
    expect(JSON.stringify(legacy)).not.toContain(material.serverPfx);
    const receiving = setup();
    seedDirect(receiving);
    receiving.replaceHostBackup(legacy);
    expect(receiving.getSetting(CORP_DIRECT_MATERIAL_SETTING)).toBe(
      JSON.stringify(material),
    );
  });

  it("encrypts and restores the same CA and private listener configuration", () => {
    const source = setup();
    seedDirect(source);
    const payload = source.exportSecurityBackup();
    expect(payload.corpDirect?.material?.authorityPfx).toBe(material.authorityPfx);
    const envelope = sealSecurityEnvelope(payload, "synthetic passphrase for test only");
    expect(JSON.stringify(envelope)).not.toContain(material.authorityPfx);
    const opened = openSecurityEnvelope(envelope, "synthetic passphrase for test only");
    if (!opened.ok) throw new Error(opened.error);
    const receiving = setup();
    receiving.importPortableBackup({
      data: portableData(source),
      security: opened.payload,
    });
    expect(receiving.getSetting(CORP_DIRECT_CONFIG_SETTING)).toBe(
      JSON.stringify(configuration),
    );
    expect(JSON.parse(receiving.getSetting(CORP_DIRECT_MATERIAL_SETTING)!)).toEqual(
      material,
    );
    expect(receiving.getSetting(CORP_DIRECT_INITIALIZED_SETTING)).toBe("1");
  });

  it("does not retain a different Host's TLS authority when restoring an older portable backup", () => {
    const oldSource = setup();
    const receiving = setup();
    seedDirect(receiving);
    receiving.importPortableBackup({
      data: portableData(oldSource),
      security: oldSource.exportSecurityBackup(),
    });
    expect(receiving.getSetting(CORP_DIRECT_CONFIG_SETTING)).toBe("");
    expect(receiving.getSetting(CORP_DIRECT_MATERIAL_SETTING)).toBe("");
    expect(receiving.getSetting(CORP_DIRECT_INITIALIZED_SETTING)).toBe("0");
  });
});
