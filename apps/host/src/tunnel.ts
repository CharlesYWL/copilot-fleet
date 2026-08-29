import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type {
  TunnelInfo,
  TunnelProvider,
  TunnelProviderInfo,
  TunnelState,
  TunnelStatus,
} from "@fleet/protocol";
import { readExternalTunnel, type ExternalTunnel } from "./external-tunnel.js";
import {
  parseLocalTarget,
  providerList,
  providerSpecs,
  type LocalTarget,
  type ProviderSpec,
} from "./tunnel-providers.js";

const run = promisify(execFile);

/** Long enough that a Settings page polling every 2s never re-probes. */
export const BINARY_PROBE_TTL_MS = 300_000;

/**
 * Remembers which provider CLIs are installed.
 *
 * Probing is a process spawn, and describing the tunnel needs one probe per
 * supported provider. The Settings page polls that description every two
 * seconds, so an uncached probe meant five synchronous spawns per poll —
 * enough to stall the Host's event loop for as long as the page stayed open.
 * Installing a CLI while the Host runs is rare and always accompanied by
 * toggling the tunnel, which invalidates the cache anyway.
 */
export class BinaryProbe {
  private readonly cache = new Map<string, { present: boolean; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly probe: (spec: ProviderSpec) => Promise<boolean> = runVersionProbe,
    private readonly ttlMs = BINARY_PROBE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async present(spec: ProviderSpec): Promise<boolean> {
    const cached = this.cache.get(spec.binary);
    if (cached && cached.expiresAt > this.now()) return cached.present;
    // Callers arrive in bursts (one per provider, plus the active one), so
    // sharing a single in-flight probe keeps that burst to one spawn each.
    const pending = this.inFlight.get(spec.binary);
    if (pending) return pending;
    const probe = this.probe(spec)
      .then((present) => {
        this.cache.set(spec.binary, {
          present,
          expiresAt: this.now() + this.ttlMs,
        });
        return present;
      })
      .finally(() => this.inFlight.delete(spec.binary));
    this.inFlight.set(spec.binary, probe);
    return probe;
  }

  /** Called when the operator switches provider or asks for a fresh start. */
  invalidate(): void {
    this.cache.clear();
  }
}

async function runVersionProbe(spec: ProviderSpec): Promise<boolean> {
  try {
    await run(spec.binary, spec.versionArgs, {
      windowsHide: true,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Backoff for unattended restarts; caps so a dead provider stops hammering. */
export const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Why a provider is refused, in the words the panel and the API both use.
 *
 * One sentence in one place: this is raised from the manager, returned in the
 * state of an external tunnel nobody may adopt, and matched by the route that
 * refuses the request — three readings of the same rule that only have to
 * disagree once to become two rules.
 */
export function ineligibleProviderMessage(provider: TunnelProvider): string {
  return `${providerSpecs[provider].label} publishes plain HTTP, so Fleet will not expose the operator console, node credentials or lead tokens through it. Use an HTTPS provider such as Dev Tunnels.`;
}

export function restartDelay(attempt: number): number {
  const index = Math.min(attempt, RESTART_DELAYS_MS.length - 1);
  return RESTART_DELAYS_MS[index]!;
}

/**
 * Whether the id the CLI reported should replace the one it was asked for.
 *
 * Dev Tunnels names a tunnel `<name>.<cluster>`, and the cluster is chosen by
 * the service when the tunnel is created, from wherever the machine happened to
 * be reaching it. A bare `fleet-abc` is therefore not an identifier at all: it
 * is a name that exists once per cluster, and `devtunnel create fleet-abc` from
 * a machine that now resolves elsewhere reports no conflict, because in that
 * cluster the name is free — it quietly mints a *second* tunnel.
 *
 * That is what a reboot did here. The Host came back hosting `fleet-abc.usw3`
 * while every node still dialed the `fleet-abc` that resolved to `.usw2`, and
 * the fleet was split in half by a name both halves agreed on.
 *
 * The CLI prints the tunnel it actually hosted, cluster and all, so that is the
 * name worth keeping: it names one tunnel from any machine, in any order, for
 * good. Adopting it is what stops the next reboot from forking the fleet again.
 */
export function shouldAdoptTunnelId(
  current: string | undefined,
  reported: string | undefined,
): reported is string {
  return Boolean(reported) && reported !== current;
}

type TunnelManagerOptions = {
  /** Loopback target the tunnel should forward to, e.g. http://127.0.0.1:8787 */
  localTarget: string;
  /**
   * Which provider this manager owns.
   *
   * Set at construction because the supervisor runs one manager per provider,
   * and ownership decides whose external state a manager may claim. Deferring
   * it to the first `setEnabled` left every manager answering as the default,
   * so all of them reported the same tunnel.
   */
  provider?: TunnelProvider;
  /** Called when enabled is cleared after an unrecoverable failure. */
  onEnabledCleared?: () => void;
  /** Injected so tests can run without real timers. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Detects a tunnel running as its own process; injected for tests. */
  readExternal?: () => ExternalTunnel | undefined;
  /** Injected so tests never spawn a real CLI. */
  probe?: BinaryProbe;
  /**
   * Reads and writes the reusable tunnel id for providers that support one.
   * Persisting it is what keeps the public URL stable across Host restarts, so
   * a node's connect command does not have to be reissued every time.
   */
  persistedTunnelId?: {
    get: (provider: TunnelProvider) => string | undefined;
    set: (provider: TunnelProvider, id: string) => void;
  };
};

export class TunnelManager {
  private status: TunnelStatus = "off";
  private tunnelUrl: string | undefined;
  private inspectUrl: string | undefined;
  private tunnelId: string | undefined;
  private error: string | undefined;
  private child: ChildProcess | undefined;
  private buffer = "";
  private provider: TunnelProvider = "cloudflare";
  private readonly target: LocalTarget;
  private readonly onEnabledCleared: (() => void) | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  /** Desired enabled flag while a start/stop is in flight. */
  private wantEnabled = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly readExternal: () => ExternalTunnel | undefined;
  private readonly probe: BinaryProbe;
  private readonly persistedTunnelId: TunnelManagerOptions["persistedTunnelId"];

  constructor(options: TunnelManagerOptions) {
    this.target = parseLocalTarget(options.localTarget);
    this.onEnabledCleared = options.onEnabledCleared;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.readExternal = options.readExternal ?? (() => readExternalTunnel());
    this.probe = options.probe ?? new BinaryProbe();
    this.persistedTunnelId = options.persistedTunnelId;
    if (options.provider) this.provider = options.provider;
  }

  /**
   * External state only counts when it belongs to the provider this owns, and
   * when that provider is one the console may stand behind.
   *
   * Adopting is not passive: an adopted URL becomes the address enrollment
   * hands out, a name the request guard answers to, and an entry in the scheme
   * map that decides whether a session cookie may be issued. A `bore` process
   * somebody started in another terminal must not acquire all three by
   * existing. It cannot be stopped from here — this manager never spawned it —
   * so it is reported as an error the operator can act on instead.
   */
  private ownExternal(): ExternalTunnel | undefined {
    const external = this.readExternal();
    if (external?.provider !== this.provider) return undefined;
    return providerSpecs[this.provider].controlPlaneEligible ? external : undefined;
  }

  /** Whether an external tunnel is running that this manager refuses to adopt. */
  private refusedExternal(): ExternalTunnel | undefined {
    const external = this.readExternal();
    if (external?.provider !== this.provider) return undefined;
    return providerSpecs[this.provider].controlPlaneEligible ? undefined : external;
  }

  get activeProvider(): TunnelProvider {
    return this.provider;
  }

  /** The provider catalog, shared by every manager through one probe cache. */
  async providerCatalog(): Promise<TunnelProviderInfo[]> {
    return Promise.all(
      providerList.map(async (spec) => ({
        id: spec.id,
        label: spec.label,
        binary: spec.binary,
        binaryPresent: await this.probe.present(spec),
        installHint: spec.installHint,
        setupSteps: spec.setupSteps,
        docsUrl: spec.docsUrl,
        externalScheme: spec.externalScheme,
        access: spec.access,
        controlPlaneEligible: spec.controlPlaneEligible,
        ...(spec.caveat ? { caveat: spec.caveat } : {}),
      })),
    );
  }

  /** Live tunnel URL when online; otherwise undefined so callers use fallbacks. */
  activeTunnelUrl(): string | undefined {
    const external = this.ownExternal();
    if (external) return external.url;
    return this.status === "on" ? this.tunnelUrl : undefined;
  }

  /** Provider-side tunnel id when online, for providers that expose one. */
  activeTunnelId(): string | undefined {
    const external = this.ownExternal();
    if (external) return external.tunnelId;
    return this.status === "on" ? this.tunnelId : undefined;
  }

  /** This provider's live state, without the shared provider catalog. */
  state(): TunnelState {
    const refused = this.refusedExternal();
    if (refused) {
      return {
        provider: this.provider,
        enabled: false,
        status: "error",
        error: ineligibleProviderMessage(this.provider),
        external: true,
      };
    }
    const externalMine = this.ownExternal();
    const url = externalMine ? externalMine.url : this.tunnelUrl;
    const online = externalMine ? Boolean(externalMine.url) : this.status === "on";
    const tunnelId = externalMine ? externalMine.tunnelId : this.tunnelId;
    // Only meaningful alongside a live tunnel; a stale inspector link points at
    // a tunnel that no longer exists.
    const inspectUrl = externalMine ? undefined : this.inspectUrl;
    return {
      provider: this.provider,
      enabled: externalMine
        ? true
        : this.wantEnabled || this.status === "starting" || this.status === "on",
      status: externalMine ? (externalMine.url ? "on" : "starting") : this.status,
      error: externalMine ? null : (this.error ?? null),
      external: Boolean(externalMine),
      ...(online && url ? { url } : {}),
      ...(online && inspectUrl ? { inspectUrl } : {}),
      ...(tunnelId ? { tunnelId } : {}),
    };
  }

  async setEnabled(enabled: boolean, provider?: TunnelProvider): Promise<void> {
    // A separately running tunnel owns its own lifecycle; toggling here would
    // either kill a process this manager never started or start a second one
    // competing for the same local port.
    if (this.readExternal()) return;
    // Switching providers while running has to tear the old process down first.
    if (provider && provider !== this.provider && this.child) await this.stop();
    if (provider && provider !== this.provider) this.probe.invalidate();
    if (provider) this.provider = provider;
    this.wantEnabled = enabled;
    if (enabled) await this.start();
    else await this.stop();
  }

  private async start(): Promise<void> {
    if (this.status === "on" || this.status === "starting") return;
    this.cancelRestart();

    const spec = providerSpecs[this.provider];
    /*
     * Checked here rather than only in `POST /api/tunnel`, because the route is
     * one of three ways a tunnel comes up. The settings row an operator enabled
     * before this rule existed is replayed on every boot, and the unattended
     * restart below re-enters this method on its own — so a rule that lived in
     * the route was a rule two paths walked around. A provider with no TLS
     * would carry the Fleet session cookie, the node credentials and every
     * transcript in clear text, and none of that depends on who asked.
     */
    if (!spec.controlPlaneEligible) {
      this.status = "error";
      this.error = ineligibleProviderMessage(this.provider);
      this.wantEnabled = false;
      this.onEnabledCleared?.();
      throw new Error(this.error);
    }
    if (!(await this.probe.present(spec))) {
      this.status = "error";
      this.error = `${spec.binary} is not installed or not on PATH`;
      this.wantEnabled = false;
      // The operator's likely next move is to install it, so do not let a
      // remembered "missing" answer make the retry fail without looking.
      this.probe.invalidate();
      this.onEnabledCleared?.();
      throw new Error(this.error);
    }

    this.status = "starting";
    this.error = undefined;
    this.tunnelUrl = undefined;
    this.inspectUrl = undefined;
    this.tunnelId = undefined;
    this.buffer = "";

    // Resolved before the spawn so a failed registration reports itself as a
    // setup problem rather than as a tunnel that starts and immediately dies.
    let reusedId: string | undefined;
    if (spec.prepare && spec.newTunnelId && this.persistedTunnelId) {
      reusedId = this.persistedTunnelId.get(this.provider) ?? spec.newTunnelId();
      try {
        await spec.prepare(this.target, reusedId);
        this.persistedTunnelId.set(this.provider, reusedId);
      } catch (error) {
        this.status = "error";
        this.error = error instanceof Error ? error.message : String(error);
        this.wantEnabled = false;
        this.onEnabledCleared?.();
        throw error;
      }
      // Reported straight away: the connect command depends on it, and for a
      // reused tunnel it is already true before the CLI prints anything. It is
      // only provisional, though — see the adoption in `onChunk`, which trades
      // it for the cluster-qualified name once the CLI says which tunnel it
      // actually hosted.
      this.tunnelId = reusedId;
    }

    const child = spawn(spec.binary, spec.args(this.target, reusedId), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const onChunk = (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 64_000) this.buffer = this.buffer.slice(-32_000);
      // The id can be printed after the URL, so it is parsed on its own
      // schedule rather than being folded into the URL branch below.
      //
      // Adopted rather than merely filled in when absent. The id this was
      // started with can be a bare name that means a different tunnel from a
      // different machine; what the CLI prints is the one it is hosting, and
      // persisting that is what keeps every later start and every node pointed
      // at the same tunnel.
      const reported = spec.extractId?.(this.buffer);
      if (shouldAdoptTunnelId(this.tunnelId, reported)) {
        this.tunnelId = reported;
        this.persistedTunnelId?.set(this.provider, reported);
      }
      if (!this.inspectUrl) this.inspectUrl = spec.extractInspectUrl?.(this.buffer);
      if (this.tunnelUrl) return;
      const url = spec.extractUrl(this.buffer);
      if (!url) return;
      this.tunnelUrl = url;
      this.status = "on";
      this.error = undefined;
      // A URL means this attempt worked, so the next crash starts backoff over.
      this.restartAttempt = 0;
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.tunnelUrl = undefined;
      this.inspectUrl = undefined;
      this.tunnelId = undefined;
      this.status = "error";
      this.error = err.message;
      this.wantEnabled = false;
      this.onEnabledCleared?.();
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.tunnelUrl = undefined;
      this.inspectUrl = undefined;
      this.tunnelId = undefined;
      if (this.status === "stopping") {
        this.status = "off";
        this.error = undefined;
        return;
      }
      this.status = "error";
      this.error = `${spec.binary} exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      // The operator still wants the tunnel, so recover instead of giving up.
      if (this.wantEnabled) this.scheduleRestart();
      else this.onEnabledCleared?.();
    });
  }

  private scheduleRestart(): void {
    this.cancelRestart();
    const delay = restartDelay(this.restartAttempt);
    this.restartAttempt += 1;
    this.status = "starting";
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined;
      if (!this.wantEnabled) return;
      this.status = "off";
      void this.start().catch(() => undefined);
    }, delay);
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return;
    this.clearTimer(this.restartTimer);
    this.restartTimer = undefined;
  }

  async stop(): Promise<void> {
    // Never signal a process this manager did not spawn.
    if (this.readExternal()) return;
    this.wantEnabled = false;
    this.cancelRestart();
    this.restartAttempt = 0;
    const child = this.child;
    if (!child) {
      this.status = "off";
      this.tunnelUrl = undefined;
      this.inspectUrl = undefined;
      this.tunnelId = undefined;
      this.error = undefined;
      return;
    }

    this.status = "stopping";
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", done);
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        done();
      }, 5_000);
    });

    this.child = undefined;
    this.tunnelUrl = undefined;
    this.inspectUrl = undefined;
    this.tunnelId = undefined;
    this.status = "off";
    this.error = undefined;
  }
}

/**
 * Runs every provider that the operator has switched on.
 *
 * Providers are not alternatives to each other: a fixed Cloudflare hostname is
 * the address a teammate can reach, while a private Dev Tunnel is the one only
 * this account can, and both are worth having up at once. Each provider gets
 * its own manager and its own switch; the supervisor only decides which of the
 * live URLs enrollment should hand out.
 */
export class TunnelSupervisor {
  private readonly managers = new Map<TunnelProvider, TunnelManager>();
  /** One probe cache across providers, so a poll costs at most one spawn each. */
  private readonly probe: BinaryProbe;
  private primaryProvider: TunnelProvider | undefined;

  constructor(private readonly options: TunnelManagerOptions) {
    this.probe = options.probe ?? new BinaryProbe();
  }

  private manager(provider: TunnelProvider): TunnelManager {
    const existing = this.managers.get(provider);
    if (existing) return existing;
    const manager = new TunnelManager({
      ...this.options,
      provider,
      probe: this.probe,
    });
    this.managers.set(provider, manager);
    return manager;
  }

  get primary(): TunnelProvider | undefined {
    return this.primaryProvider;
  }

  setPrimary(provider: TunnelProvider | undefined): void {
    this.primaryProvider = provider;
  }

  async setEnabled(
    provider: TunnelProvider,
    enabled: boolean,
    makePrimary = true,
  ): Promise<void> {
    await this.manager(provider).setEnabled(enabled, provider);
    if (enabled && makePrimary) this.primaryProvider = provider;
    else if (!enabled && this.primaryProvider === provider) {
      this.primaryProvider = this.onlineProviders()[0];
    }
  }

  /** Providers currently serving a URL, in the order they were declared. */
  private onlineProviders(): TunnelProvider[] {
    return providerList
      .map((spec) => spec.id)
      .filter((id) => this.managers.get(id)?.activeTunnelUrl());
  }

  /**
   * The manager whose URL enrollment advertises.
   *
   * An explicit choice wins so the operator can point nodes at the address they
   * mean; otherwise the first provider that is actually serving one is used,
   * which keeps enrollment working after a primary is switched off.
   */
  private primaryManager(): TunnelManager | undefined {
    const explicit = this.primaryProvider
      ? this.managers.get(this.primaryProvider)
      : undefined;
    if (explicit?.activeTunnelUrl()) return explicit;
    const fallback = this.onlineProviders()[0];
    return fallback ? this.managers.get(fallback) : undefined;
  }

  activeTunnelUrl(): string | undefined {
    return this.primaryManager()?.activeTunnelUrl();
  }

  /**
   * The URL that may be pushed to nodes that are already running.
   *
   * Deliberately not the same as the enrollment URL. Enrollment can advertise a
   * private tunnel because the operator gets a command to go with it, but a
   * live node told to move somewhere it cannot authenticate is stranded: it
   * cannot reach the Host, so it cannot be told where to go instead. Only
   * providers a node can dial unaided are eligible.
   */
  broadcastTunnelUrl(): string | undefined {
    const dialable = providerList
      .filter((spec) => spec.nodeDialable !== false)
      .map((spec) => spec.id);
    const preferred = this.primaryProvider;
    const ordered =
      preferred && dialable.includes(preferred)
        ? [preferred, ...dialable.filter((id) => id !== preferred)]
        : dialable;
    for (const id of ordered) {
      const url = this.managers.get(id)?.activeTunnelUrl();
      if (url) return url;
    }
    return undefined;
  }

  activeTunnelId(): string | undefined {
    return this.primaryManager()?.activeTunnelId();
  }

  /**
   * Every address a tunnel is currently serving this Host at.
   *
   * The request guard needs all of them, not just the primary: two providers
   * can run side by side, and a browser arriving over the one that is not
   * primary is an operator, not an attacker.
   */
  allTunnelUrls(): string[] {
    return providerList
      .map((spec) => this.managers.get(spec.id)?.activeTunnelUrl())
      .filter((url): url is string => Boolean(url));
  }

  /**
   * The same URLs, with the provider that published each one.
   *
   * The scheme policy needs the pair: `bore` forwards plain TCP with no TLS at
   * all, so an operator session must never be issued over it, and the only way
   * to know that about a hostname is to remember who produced it.
   */
  allTunnelEndpoints(): { provider: TunnelProvider; url: string | undefined }[] {
    return providerList.map((spec) => ({
      provider: spec.id,
      url: this.managers.get(spec.id)?.activeTunnelUrl(),
    }));
  }

  async info(fallbackPublicUrl: string): Promise<TunnelInfo> {
    // Touch every provider so a switched-off one still reports its state and
    // the UI can offer it, rather than only listing what has already run.
    const tunnels = providerList.map((spec) => this.manager(spec.id).state());
    const providers = await this.manager(providerList[0]!.id).providerCatalog();
    const url = this.activeTunnelUrl();
    const primaryUrlOwner = providerList
      .map((spec) => spec.id)
      .find((id) => this.managers.get(id)?.activeTunnelUrl() === url && url);
    const tunnelId = this.activeTunnelId();
    return {
      primary: primaryUrlOwner ?? null,
      publicUrl: url ?? fallbackPublicUrl,
      providers,
      tunnels,
      ...(tunnelId ? { tunnelId } : {}),
    };
  }

  async stop(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.stop()));
  }
}
