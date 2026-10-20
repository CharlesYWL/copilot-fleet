import type * as acp from "@agentclientprotocol/sdk";
import { usageAmountKeys, type SessionAccounting } from "@fleet/protocol";
import { acpContextUsage } from "../context-usage.js";
import { hermesResponseTokens, readNativeTokenTotals } from "../usage-totals.js";
import type { UsageContext, UsageReporter } from "./types.js";

export class HermesUsageReporter implements UsageReporter {
  private sessionId = "";
  private baseline = false;
  private startedAt: string | undefined;
  private signature = "";
  private responseFloor: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly context: UsageContext,
    private readonly profile: string,
  ) {}
  async start(sessionId: string, _reset = false, resumed = false): Promise<void> {
    this.close();
    this.sessionId = sessionId;
    this.responseFloor = undefined;
    this.baseline = resumed;
    this.startedAt = resumed ? undefined : new Date().toISOString();
    await this.flush();
    this.timer = setInterval(() => void this.flush(), 3_000);
    this.timer.unref();
  }
  onUpdate(update: acp.SessionUpdate): boolean {
    if (update.sessionUpdate !== "usage_update") return false;
    this.context.report({
      contextTokens: update.used,
      contextWindow: update.size > 0 ? update.size : null,
      context: acpContextUsage(update.used, update.size, this.context.model()),
    });
    return true;
  }
  async afterPrompt(response?: acp.PromptResponse): Promise<void> {
    const reported = hermesResponseTokens(response);
    if (reported) this.responseFloor = reported.totalTokens;
    const persisted = readNativeTokenTotals("hermes", this.sessionId, this.profile);
    const totals =
      reported &&
      (!persisted || (reported.totalTokens ?? 0) >= (persisted.totalTokens ?? 0))
        ? reported
        : persisted;
    if (totals) this.publish(totals);
  }
  async flush(): Promise<void> {
    if (!this.sessionId || this.context.aborted()) return;
    const totals = readNativeTokenTotals("hermes", this.sessionId, this.profile);
    // Hermes coalesces database writes; a native reading behind the completed
    // ACP response is stale, not a new cumulative counter to add or reset.
    if (
      totals &&
      (this.responseFloor === undefined ||
        (totals.totalTokens ?? 0) >= this.responseFloor)
    )
      this.publish(totals);
  }
  close(): void {
    clearInterval(this.timer);
  }
  private publish(totals: Partial<SessionAccounting>): void {
    const signature = JSON.stringify([
      this.sessionId,
      ...usageAmountKeys.map((key) => totals[key]),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.context.report({
      accounting: {
        nativeSessionId: this.sessionId,
        counterId: `${this.profile}:${this.sessionId}`,
        source: "hermes-session-totals",
        observedAt: new Date().toISOString(),
        baseline: this.baseline,
        ...(this.startedAt ? { startedAt: this.startedAt } : {}),
        ...totals,
      },
    });
  }
}
