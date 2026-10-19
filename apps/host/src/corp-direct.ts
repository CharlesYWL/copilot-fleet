import { networkInterfaces } from "node:os";
import type { Server as HttpsServer } from "node:https";
import { X509Certificate } from "node:crypto";
import {
  CorpDirectConfigSchema,
  CorpDirectMaterialSchema,
  isPrivateIpv4,
  type CorpDirectConfig,
  type CorpDirectInfo,
  type CorpDirectMaterial,
} from "@fleet/protocol";
import { createHttpRelay } from "@fleet/protocol/http-relay";
import { issueCorpDirectCertificates } from "./corp-direct-certificates.js";

export const CORP_DIRECT_CONFIG_SETTING = "host.corpDirect.configuration";
export const CORP_DIRECT_MATERIAL_SETTING = "host.corpDirect.material";
export const CORP_DIRECT_INITIALIZED_SETTING = "host.corpDirect.initialized";
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export const privateHostAddresses = (): string[] =>
  [
    ...new Set(
      Object.entries(networkInterfaces())
        .filter(([name]) => !/^(?:vEthernet|Loopback)/i.test(name))
        .flatMap(([, entries]) => entries ?? [])
        .filter(
          (entry) =>
            !entry.internal && entry.family === "IPv4" && isPrivateIpv4(entry.address),
        )
        .map((entry) => entry.address),
    ),
  ].sort();

export const corpDirectFirewallCommand = (
  configuration: CorpDirectConfig,
  nodePath = process.execPath,
): string => {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const name = `CopilotFleet-CorpDirect-${configuration.hostIp}-${configuration.port}`;
  return [
    `# Run on the Host in Administrator PowerShell, only if permitted by your network policy.`,
    `$ruleName = ${quote(name)}`,
    `Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -Name $ruleName -DisplayName 'Copilot Fleet Corp direct' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ${quote(configuration.hostIp)} -LocalPort ${configuration.port} -RemoteAddress Any -Program ${quote(nodePath)} -Profile Any`,
    `# To remove later: Remove-NetFirewallRule -Name $ruleName`,
  ].join("\n");
};

type SettingStore = {
  getSetting: (key: string) => string | undefined;
  setSetting: (key: string, value: string) => void;
};
export type CorpDirectOptions = {
  store: SettingStore;
  upstream: string;
  hostId: () => string;
  canRun: () => boolean;
  localBindHost?: () => string;
  addresses?: () => string[];
  issue?: typeof issueCorpDirectCertificates;
  protect?: () => void | Promise<void>;
  platform?: NodeJS.Platform;
};

/** Host-owned TLS edge, separate from the existing HTTP loopback listener. */
export class CorpDirectAccess {
  private relay: ReturnType<typeof createHttpRelay> | undefined;
  private url: string | undefined;
  private lastError: string | undefined;
  private generation = 0;
  private renewal: NodeJS.Timeout | undefined;
  private renewing = false;

  constructor(private readonly options: CorpDirectOptions) {}

  supported(): boolean {
    return (this.options.platform ?? process.platform) === "win32";
  }
  activeUrl = (): string | undefined => {
    if (!this.options.canRun() || !this.url) return undefined;
    return (this.options.addresses ?? privateHostAddresses)().includes(
      new URL(this.url).hostname,
    )
      ? this.url
      : undefined;
  };
  error = (): string | undefined =>
    this.lastError ??
    (this.url &&
    !(this.options.addresses ?? privateHostAddresses)().includes(
      new URL(this.url).hostname,
    )
      ? "The configured Corp direct private IP is no longer assigned to this Host. Update it explicitly."
      : undefined);
  configuration(): CorpDirectConfig | undefined {
    const raw = this.options.store.getSetting(CORP_DIRECT_CONFIG_SETTING);
    if (!raw) return undefined;
    try {
      return CorpDirectConfigSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "Stored Corp direct configuration is invalid. Switch it off and save a valid private network configuration.",
      );
    }
  }

  configure(input: CorpDirectConfig): void {
    if (!this.options.canRun())
      throw new Error(
        "Corp direct requires a verified Microsoft corporate administrator and Microsoft sign-in.",
      );
    if (this.relay)
      throw new Error(
        "Switch Corp direct off before editing its listener configuration.",
      );
    const configuration = CorpDirectConfigSchema.parse(input);
    this.validateAddress(configuration);
    this.options.store.setSetting(
      CORP_DIRECT_CONFIG_SETTING,
      JSON.stringify(configuration),
    );
    this.lastError = undefined;
  }

  info(): CorpDirectInfo {
    const configuration = this.configuration();
    const material = this.material();
    return {
      supported: this.supported(),
      addresses: (this.options.addresses ?? privateHostAddresses)(),
      configuration: configuration ?? null,
      ...(material ? { caCertificate: material.caCertificate } : {}),
      ...(configuration
        ? { firewallCommand: corpDirectFirewallCommand(configuration) }
        : {}),
    };
  }

  private material(): CorpDirectMaterial | undefined {
    const raw = this.options.store.getSetting(CORP_DIRECT_MATERIAL_SETTING);
    if (!raw) return undefined;
    try {
      return CorpDirectMaterialSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "Stored Corp direct certificate material is invalid; it was not replaced. Restore a portable security backup.",
      );
    }
  }

  private validateAddress(configuration: CorpDirectConfig): void {
    if (!this.supported())
      throw new Error("Automatic Corp direct certificates require Windows.");
    if ((this.options.localBindHost?.() ?? "127.0.0.1") !== "127.0.0.1")
      throw new Error(
        "Corp direct requires the existing HTTP Host listener on 127.0.0.1. Leave HOST unset or set HOST=127.0.0.1.",
      );
    if (
      !(this.options.addresses ?? privateHostAddresses)().includes(configuration.hostIp)
    )
      throw new Error(
        "The configured Corp direct private IP is not assigned to this Host. Update the address explicitly and generate a new Node command.",
      );
  }

  private async ensureMaterial(
    configuration: CorpDirectConfig,
    generation: number,
  ): Promise<CorpDirectMaterial> {
    const existing = this.material();
    if (
      !existing &&
      this.options.store.getSetting(CORP_DIRECT_INITIALIZED_SETTING) === "1"
    )
      throw new Error(
        "The Corp direct private authority is missing. Restore its portable security backup; existing trust was not silently replaced.",
      );
    if (existing && existing.hostId !== this.options.hostId())
      throw new Error(
        "The Corp direct authority belongs to another Host identity. Restore matching Host identity and TLS material.",
      );
    if (
      existing &&
      Date.parse(new X509Certificate(existing.caCertificate).validTo) <= Date.now()
    )
      throw new Error(
        "The Corp direct certificate authority has expired. Existing trust was not silently rotated.",
      );
    if (
      existing &&
      existing.hostIp === configuration.hostIp &&
      Date.parse(existing.serverExpiresAt) > Date.now() + RENEW_BEFORE_MS
    )
      return existing;
    const material = await (this.options.issue ?? issueCorpDirectCertificates)(
      this.options.hostId(),
      configuration.hostIp,
      existing,
    );
    if (generation !== this.generation || !this.options.canRun())
      throw new Error(
        "Corp direct startup was cancelled or corporate authorization changed.",
      );
    this.options.store.setSetting(CORP_DIRECT_MATERIAL_SETTING, JSON.stringify(material));
    this.options.store.setSetting(CORP_DIRECT_INITIALIZED_SETTING, "1");
    return material;
  }

  start = async (): Promise<string> => {
    if (!this.options.canRun())
      throw new Error(
        "Corp direct requires a verified Microsoft corporate administrator and Microsoft sign-in.",
      );
    const configuration = this.configuration();
    if (!configuration)
      throw new Error(
        "Configure a private Host IP and HTTPS port before enabling Corp direct.",
      );
    this.validateAddress(configuration);
    if (this.url && this.relay) return this.url;
    this.lastError = undefined;
    const generation = this.generation;
    await this.options.protect?.();
    const material = await this.ensureMaterial(configuration, generation);
    if (generation !== this.generation || !this.options.canRun())
      throw new Error("Corp direct startup was cancelled.");
    const origin = `https://${configuration.hostIp}:${configuration.port}`;
    const acceptedHosts = new Set([
      `${configuration.hostIp}:${configuration.port}`,
      ...(configuration.port === 443 ? [configuration.hostIp] : []),
    ]);
    const relay = createHttpRelay({
      upstream: this.options.upstream,
      tls: { pfx: Buffer.from(material.serverPfx, "base64"), passphrase: "" },
      allowPeer: () => this.options.canRun(),
      allowRequest: (request) =>
        this.options.canRun() &&
        acceptedHosts.has(request.headers.host ?? "") &&
        (request.headers.origin === undefined ||
          request.headers.origin === new URL(origin).origin),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        relay.server.once("error", reject);
        relay.server.listen(
          { host: configuration.hostIp, port: configuration.port, exclusive: true },
          () => {
            relay.server.removeListener("error", reject);
            resolve();
          },
        );
      });
      if (generation !== this.generation || !this.options.canRun())
        throw new Error("Corp direct startup was cancelled.");
    } catch (error) {
      await relay.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE")
        throw new Error(
          `Corp direct cannot bind ${configuration.hostIp}:${configuration.port}: the address/port is already in use. It did not select another port.`,
          { cause: error },
        );
      throw error;
    }
    this.relay = relay;
    this.url = origin;
    relay.server.on("error", () => {
      if (this.relay !== relay) return;
      void this.stop().then(
        () => {
          if (!this.relay) this.lastError = "The Corp direct listener failed.";
        },
        () => {
          this.lastError =
            "The Corp direct listener could not be closed after a failure.";
        },
      );
    });
    this.renewal = setInterval(
      () => void this.refreshCertificates(configuration),
      60 * 60 * 1000,
    );
    this.renewal.unref();
    return origin;
  };

  private async refreshCertificates(configuration: CorpDirectConfig): Promise<void> {
    if (this.renewing || !this.relay) return;
    this.renewing = true;
    const generation = this.generation;
    try {
      if (!this.options.canRun())
        throw new Error("Corporate authorization is no longer available.");
      this.validateAddress(configuration);
      const material = await this.ensureMaterial(configuration, generation);
      if (generation === this.generation && this.relay)
        (this.relay.server as HttpsServer).setSecureContext({
          pfx: Buffer.from(material.serverPfx, "base64"),
          passphrase: "",
        });
    } catch {
      if (generation !== this.generation) return;
      await this.stop();
      this.lastError =
        "Corp direct could not renew or validate its address/certificate. Check the private address and authority; existing trust was not replaced.";
    } finally {
      this.renewing = false;
    }
  }

  stop = async (): Promise<void> => {
    this.generation += 1;
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = undefined;
    const relay = this.relay;
    this.relay = undefined;
    this.url = undefined;
    this.lastError = undefined;
    await relay?.close();
  };
}
