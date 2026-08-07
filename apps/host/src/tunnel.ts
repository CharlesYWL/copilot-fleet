import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TunnelInfo, TunnelStatus } from "@fleet/protocol";

/** Matches the URL cloudflared prints for account-less quick tunnels. */
export const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function extractTunnelUrl(text: string): string | undefined {
  const match = text.match(TRYCLOUDFLARE_URL_RE);
  if (!match) return undefined;
  return match[0].replace(/\/+$/, "");
}

export function cloudflaredBinaryPresent(): boolean {
  const result = spawnSync("cloudflared", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

type TunnelManagerOptions = {
  /** Loopback target the tunnel should forward to, e.g. http://127.0.0.1:8787 */
  localTarget: string;
  /** Called when enabled is cleared after an unexpected process exit. */
  onEnabledCleared?: () => void;
};

export class TunnelManager {
  private status: TunnelStatus = "off";
  private tunnelUrl: string | undefined;
  private error: string | undefined;
  private child: ChildProcess | undefined;
  private buffer = "";
  private readonly localTarget: string;
  private readonly onEnabledCleared: (() => void) | undefined;
  /** Desired enabled flag while a start/stop is in flight. */
  private wantEnabled = false;

  constructor(options: TunnelManagerOptions) {
    this.localTarget = options.localTarget;
    this.onEnabledCleared = options.onEnabledCleared;
  }

  info(fallbackPublicUrl: string): TunnelInfo {
    const online = this.status === "on" && this.tunnelUrl;
    return {
      provider: "cloudflare",
      enabled: this.wantEnabled || this.status === "starting" || this.status === "on",
      status: this.status,
      publicUrl: online ? this.tunnelUrl! : fallbackPublicUrl,
      error: this.error ?? null,
      binaryPresent: cloudflaredBinaryPresent(),
    };
  }

  /** Live tunnel URL when online; otherwise undefined so callers use fallbacks. */
  activeTunnelUrl(): string | undefined {
    return this.status === "on" ? this.tunnelUrl : undefined;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.wantEnabled = enabled;
    if (enabled) await this.start();
    else await this.stop();
  }

  private async start(): Promise<void> {
    if (this.status === "on" || this.status === "starting") return;

    if (!cloudflaredBinaryPresent()) {
      this.status = "error";
      this.error = "cloudflared is not installed or not on PATH";
      this.wantEnabled = false;
      this.onEnabledCleared?.();
      throw new Error(this.error);
    }

    this.status = "starting";
    this.error = undefined;
    this.tunnelUrl = undefined;
    this.buffer = "";

    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", this.localTarget, "--no-autoupdate"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;

    const onChunk = (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 64_000) this.buffer = this.buffer.slice(-32_000);
      if (this.tunnelUrl) return;
      const url = extractTunnelUrl(this.buffer);
      if (!url) return;
      this.tunnelUrl = url;
      this.status = "on";
      this.error = undefined;
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("error", (err) => {
      this.child = undefined;
      this.status = "error";
      this.error = err.message;
      this.tunnelUrl = undefined;
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
      this.error = `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      this.wantEnabled = false;
      this.onEnabledCleared?.();
    });
  }

  async stop(): Promise<void> {
    this.wantEnabled = false;
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
