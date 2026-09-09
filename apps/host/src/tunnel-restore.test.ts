import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostBackupTunnel, TunnelProvider } from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { BinaryProbe, TunnelSupervisor } from "./tunnel.js";
import { providerSpecs } from "./tunnel-providers.js";
import type { ExternalTunnel } from "./external-tunnel.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const stores: FleetStore[] = [];
const supervisors: TunnelSupervisor[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  vi.spyOn(providerSpecs.devtunnel, "prepare");
  vi.mocked(providerSpecs.devtunnel.prepare!).mockResolvedValue(undefined);
  vi.spyOn(providerSpecs.devtunnel, "newTunnelId");
  vi.mocked(providerSpecs.devtunnel.newTunnelId!).mockReturnValue("fleet-new");
  vi.mocked(spawn).mockImplementation(() => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    children.push(child);
    return child;
  });
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  for (const store of stores.splice(0)) store.close();
  children.length = 0;
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

function managed(id?: string, external?: ExternalTunnel) {
  const store = new FleetStore(":memory:");
  stores.push(store);
  if (id) store.setSetting("tunnel.devtunnel.id", id);
  const supervisor = new TunnelSupervisor({
    localTarget: "http://127.0.0.1:8787",
    readExternal: () => external,
    probe: new BinaryProbe(async () => true),
    persistedTunnelId: {
      get: (provider) => store.getSetting(`tunnel.${provider}.id`),
      set: (provider, value) => store.setSetting(`tunnel.${provider}.id`, value),
    },
    onEnabledCleared: (provider) => store.setTunnelProviderEnabled(provider, false),
  });
  supervisors.push(supervisor);
  return { store, supervisor };
}

function ready(child: ChildProcess, id: string) {
  child.stdout?.emit(
    "data",
    Buffer.from(
      `Connect via browser: https://demo-8787.usw2.devtunnels.ms\nReady to accept connections for tunnel: ${id}\n`,
    ),
  );
}

const archived: HostBackupTunnel = {
  enabled: true,
  provider: "devtunnel",
  enabledProviders: ["devtunnel"],
  ids: { devtunnel: "fleet-source.usw2" },
};

describe("restoring stable tunnels", () => {
  it("replaces a running destination tunnel and ignores its late output", async () => {
    const { store, supervisor } = managed("fleet-destination.use");
    await supervisor.setEnabled("devtunnel", true);
    const previous = children[0]!;
    ready(previous, "fleet-destination.use");

    const backup = store.exportHostBackup({ enrollmentToken: "", tunnel: archived });
    store.replaceHostBackup(backup);
    await supervisor.restoreSettings(store.getTunnelBackupSettings());
    ready(children[1]!, "fleet-source.usw2");
    ready(previous, "fleet-destination.use");

    expect(previous.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(spawn).toHaveBeenLastCalledWith(
      "devtunnel",
      ["host", "fleet-source.usw2"],
      expect.any(Object),
    );
    expect(supervisor.activeTunnelId()).toBe("fleet-source.usw2");
    expect(store.getSetting("tunnel.devtunnel.id")).toBe("fleet-source.usw2");
    expect(providerSpecs.devtunnel.newTunnelId).not.toHaveBeenCalled();
  });

  it("exports the cluster-qualified ID reported by the live tunnel", async () => {
    const { store, supervisor } = managed("fleet-source");
    store.setTunnelProviderEnabled("devtunnel", true);
    await supervisor.setEnabled("devtunnel", true);
    ready(children[0]!, "fleet-source.usw2");

    expect(supervisor.backupSettings(store.getTunnelBackupSettings())).toMatchObject({
      ids: { devtunnel: "fleet-source.usw2" },
      enabledProviders: ["devtunnel"],
    });
  });

  it("keeps restored IDs while disabled, then reuses them when enabled later", async () => {
    const { store, supervisor } = managed("fleet-destination.use");
    await supervisor.setEnabled("devtunnel", true);
    const settings = { ...archived, enabled: false, enabledProviders: [] };
    store.replaceHostBackup(
      store.exportHostBackup({ enrollmentToken: "", tunnel: settings }),
    );
    await supervisor.restoreSettings(store.getTunnelBackupSettings());

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.activeTunnelId()).toBeUndefined();
    expect(store.getSetting("tunnel.devtunnel.id")).toBe("fleet-source.usw2");

    await supervisor.setEnabled("devtunnel", true);
    expect(spawn).toHaveBeenLastCalledWith(
      "devtunnel",
      ["host", "fleet-source.usw2"],
      expect.any(Object),
    );
  });

  it("cancels a pre-restore setup that completes after the new ID is running", async () => {
    let finishSetup: () => void = () => {};
    vi.mocked(providerSpecs.devtunnel.prepare!).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const { store, supervisor } = managed("fleet-destination.use");
    const starting = supervisor.setEnabled("devtunnel", true);
    await vi.waitFor(() =>
      expect(providerSpecs.devtunnel.prepare).toHaveBeenCalledOnce(),
    );

    store.replaceHostBackup(
      store.exportHostBackup({ enrollmentToken: "", tunnel: archived }),
    );
    await supervisor.restoreSettings(store.getTunnelBackupSettings());
    finishSetup();
    await starting;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "devtunnel",
      ["host", "fleet-source.usw2"],
      expect.any(Object),
    );
    expect(store.getSetting("tunnel.devtunnel.id")).toBe("fleet-source.usw2");
  });

  it("does not let a cancelled startup replace the restored primary provider", async () => {
    let finishSetup: () => void = () => {};
    vi.mocked(providerSpecs.devtunnel.prepare!).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const { supervisor } = managed("fleet-destination.use");
    const starting = supervisor.setEnabled("devtunnel", true);
    await vi.waitFor(() =>
      expect(providerSpecs.devtunnel.prepare).toHaveBeenCalledOnce(),
    );

    await supervisor.restoreSettings({
      ...archived,
      provider: "ngrok",
      enabledProviders: ["ngrok"],
    });
    finishSetup();
    await starting;

    expect(supervisor.primary).toBe("ngrok");
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "ngrok",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("invalidates a pending binary probe instead of starting the old provider after restore", async () => {
    const { supervisor } = managed("fleet-destination.use");
    let finishProbe: (present: boolean) => void = () => {};
    vi.spyOn(BinaryProbe.prototype, "present").mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const starting = supervisor.setEnabled("devtunnel", true);
    await vi.waitFor(() => expect(BinaryProbe.prototype.present).toHaveBeenCalledOnce());

    await supervisor.restoreSettings({
      ...archived,
      enabled: false,
      enabledProviders: [],
    });
    finishProbe(true);
    await starting;

    expect(spawn).not.toHaveBeenCalled();
    expect(providerSpecs.devtunnel.prepare).not.toHaveBeenCalled();
    expect(supervisor.primary).toBe("devtunnel");
  });

  it("reports an account/setup failure without replacing the archived ID", async () => {
    const { store, supervisor } = managed();
    vi.mocked(providerSpecs.devtunnel.prepare!).mockRejectedValue(
      new Error("Tunnel not found or this account cannot host it"),
    );
    const settings = {
      ...archived,
      enabledProviders: ["ngrok", "devtunnel"] satisfies TunnelProvider[],
    };
    store.replaceHostBackup(
      store.exportHostBackup({ enrollmentToken: "", tunnel: settings }),
    );

    await expect(
      supervisor.restoreSettings(store.getTunnelBackupSettings()),
    ).rejects.toThrow(/Dev Tunnels: Tunnel not found/);
    expect(store.getSetting("tunnel.devtunnel.id")).toBe("fleet-source.usw2");
    expect(store.getEnabledTunnelProviders()).toEqual(["ngrok"]);
    expect(providerSpecs.devtunnel.newTunnelId).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "ngrok",
      expect.any(Array),
      expect.any(Object),
    );
  });
});

describe("external tunnels during a move", () => {
  const external = {
    provider: "devtunnel",
    url: "https://demo-8787.usw2.devtunnels.ms",
    tunnelId: "fleet-external.usw2",
  } satisfies ExternalTunnel;

  it("includes an externally hosted tunnel that is absent from stored settings", () => {
    const { store, supervisor } = managed(undefined, external);
    expect(supervisor.backupSettings(store.getTunnelBackupSettings())).toEqual({
      enabled: true,
      provider: "devtunnel",
      enabledProviders: ["devtunnel"],
      ids: { devtunnel: "fleet-external.usw2" },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([archived, { ...archived, enabled: false, enabledProviders: [] }])(
    "refuses to replace an external tunnel before touching its process",
    async (settings) => {
      const { supervisor } = managed(undefined, external);
      expect(() => supervisor.assertCanRestore(settings)).toThrow(/separately managed/);
      await expect(supervisor.restoreSettings(settings)).rejects.toThrow(
        /another terminal/,
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(
        supervisor.backupSettings({ enabled: false, provider: "devtunnel" }).ids,
      ).toEqual({
        devtunnel: "fleet-external.usw2",
      });
    },
  );

  it("keeps a matching external tunnel while managing the other providers", async () => {
    const { supervisor } = managed(undefined, external);
    await supervisor.restoreSettings({
      ...archived,
      enabledProviders: ["devtunnel", "ngrok"],
      ids: { devtunnel: "fleet-external.usw2" },
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "ngrok",
      expect.any(Array),
      expect.any(Object),
    );
    await supervisor.stop();
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    expect(supervisor.activeTunnelId()).toBe("fleet-external.usw2");
  });
});
