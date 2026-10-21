import type * as acp from "@agentclientprotocol/sdk";
import {
  HERMES_NATIVE_USAGE_SOURCE,
  usageAmountKeys,
  type SessionAccounting,
} from "@fleet/protocol";
import { acpContextUsage } from "../context-usage.js";
import { readNativeTokenTotals } from "../usage-totals.js";
import type { UsageContext, UsageReporter } from "./types.js";

export class HermesUsageReporter implements UsageReporter {
  private sessionId = "";
  private baseline = false;
  private startedAt: string | undefined;
  private signature = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly context: UsageContext,
    private readonly profile: string,
  ) {}

  async start(sessionId: string, _reset = false, resumed = false): Promise<void> {
    this.close();
    this.sessionId = sessionId;
    this.signature = "";
    this.baseline = resumed;
    this.startedAt = resumed ? undefined : new Date().toISOString();
    await this.flush();
    if (!this.context.stopping()) {
      this.timer = setInterval(() => void this.flush(), 3_000);
      this.timer.unref();
    }
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
  async afterPrompt(_response?: acp.PromptResponse): Promise<void> {
    // ACP responses can count only this attached process and already include
    // cache in input. They cannot replace the lifetime canonical database row.
    // Coalesced persistence is picked up by this read or a subsequent poll.
    await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.sessionId || this.context.aborted()) return;
    const totals = readNativeTokenTotals("hermes", this.sessionId, this.profile);
    if (totals) this.publish(totals);
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
        counterId: `${HERMES_NATIVE_USAGE_SOURCE}:${this.profile}:${this.sessionId}`,
        source: HERMES_NATIVE_USAGE_SOURCE,
        observedAt: new Date().toISOString(),
        baseline: this.baseline,
        ...(this.startedAt ? { startedAt: this.startedAt } : {}),
        ...totals,
      },
    });
  }
}
