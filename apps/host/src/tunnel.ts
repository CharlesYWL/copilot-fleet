import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TunnelInfo, TunnelProvider, TunnelStatus } from "@fleet/protocol";
import {
  parseLocalTarget,
  providerList,
  providerSpecs,
  type LocalTarget,
  type ProviderSpec,
} from "./tunnel-providers.js";

export { TRYCLOUDFLARE_URL_RE, extractTunnelUrl } from "./tunnel-providers.js";

export function binaryPresent(spec: ProviderSpec): boolean {
  const result = spawnSync(spec.binary, spec.versionArgs, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

export function cloudflaredBinaryPresent(): boolean {
  return binaryPresent(providerSpecs.cloudflare);
}

/** Backoff for unattended restarts; caps so a dead provider stops hammering. */
export const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

export function restartDelay(attempt: number): number {
  const index = Math.min(attempt, RESTART_DELAYS_MS.length - 1);
  return RESTART_DELAYS_MS[index]!;
}

type TunnelManagerOptions = {
  /** Loopback target the tunnel should forward to, e.g. http://127.0.0.1:8787 */
  localTarget: string;
  /** Called when enabled is cleared after an unrecoverable failure. */
  onEnabledCleared?: () => void;
  /** Injected so tests can run without real timers. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export class TunnelManager {
  private status: TunnelStatus = "off";
  private tunnelUrl: string | undefined;
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

  constructor(options: TunnelManagerOptions) {
    this.target = parseLocalTarget(options.localTarget);
    this.onEnabledCleared = options.onEnabledCleared;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get activeProvider(): TunnelProvider {
    return this.provider;
  }

  info(fallbackPublicUrl: string): TunnelInfo {
    const online = this.status === "on" && this.tunnelUrl;
    return {
      provider: this.provider,
      enabled: this.wantEnabled || this.status === "starting" || this.status === "on",
      status: this.status,
      publicUrl: online ? this.tunnelUrl! : fallbackPublicUrl,
      error: this.error ?? null,
      binaryPresent: binaryPresent(providerSpecs[this.provider]),
      providers: providerList.map((spec) => ({
        id: spec.id,
        label: spec.label,
        binary: spec.binary,
        binaryPresent: binaryPresent(spec),
        installHint: spec.installHint,
        ...(spec.caveat ? { caveat: spec.caveat } : {}),
      })),
    };
  }

  /** Live tunnel URL when online; otherwise undefined so callers use fallbacks. */
  activeTunnelUrl(): string | undefined {
    return this.status === "on" ? this.tunnelUrl : undefined;
  }

  async setEnabled(enabled: boolean, provider?: TunnelProvider): Promise<void> {
    // Switching providers while running has to tear the old process down first.
    if (provider && provider !== this.provider && this.child) await this.stop();
    if (provider) this.provider = provider;
    this.wantEnabled = enabled;
    if (enabled) await this.start();
    else await this.stop();
  }

  private async start(): Promise<void> {
    if (this.status === "on" || this.status === "starting") return;
    this.cancelRestart();

    const spec = providerSpecs[this.provider];
    if (!binaryPresent(spec)) {
      this.status = "error";
      this.error = `${spec.binary} is not installed or not on PATH`;
      this.wantEnabled = false;
      this.onEnabledCleared?.();
      throw new Error(this.error);
    }

    this.status = "starting";
    this.error = undefined;
    this.tunnelUrl = undefined;
    this.buffer = "";

    const child = spawn(spec.binary, spec.args(this.target), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const onChunk = (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 64_000) this.buffer = this.buffer.slice(-32_000);
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
      this.status = "error";
      this.error = err.message;
      this.wantEnabled = false;
      this.onEnabledCleared?.();
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.tunnelUrl = undefined;
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
    this.wantEnabled = false;
    this.cancelRestart();
    this.restartAttempt = 0;
    const child = this.child;
    if (!child) {
      this.status = "off";
      this.tunnelUrl = undefined;
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
    this.status = "off";
    this.error = undefined;
  }
}
