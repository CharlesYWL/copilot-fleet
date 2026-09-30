import type * as acp from "@agentclientprotocol/sdk";
import { errorMessage } from "@fleet/protocol";
import { parseContextUsage } from "../context-usage.js";
import { SessionCreditReader } from "../session-credits.js";
import type { UsageContext, UsageReporter } from "./types.js";

export class CopilotUsageReporter implements UsageReporter {
  private reader: SessionCreditReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading: Promise<void> | undefined;
  private creditError: string | undefined;
  private contextError: string | undefined;
  private contextAvailable = false;
  private capture:
    { text: string; hidden: boolean; truncated: boolean; complete: boolean } | undefined;

  constructor(private readonly context: UsageContext) {}

  async start(sessionId: string, reset = false): Promise<void> {
    this.close();
    await this.reading;
    this.context.assertActive();
    this.reader = new SessionCreditReader(sessionId);
    if (reset) {
      this.context.report({
        aiCredits: null,
        contextTokens: null,
        contextWindow: null,
        context: null,
      });
    }
    await this.flush();
    if (!this.context.stopping()) {
      this.timer = setInterval(() => void this.flush(), 2_000);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.reading) return this.reading;
    if (!this.reader) return Promise.resolve();
    const read = this.reader
      .read()
      .then((aiCredits) => {
        if (this.context.aborted()) return;
        this.creditError = undefined;
        if (aiCredits !== undefined) this.context.report({ aiCredits });
      })
      .catch((error: unknown) => {
        if (this.context.aborted()) return;
        const message = `Session AI credit usage is unavailable: ${errorMessage(error)}`;
        if (this.creditError !== message) this.context.notice(message);
        this.creditError = message;
      })
      .finally(() => {
        this.reading = undefined;
      });
    this.reading = read;
    return read;
  }

  onUpdate(update: acp.SessionUpdate): boolean {
    if (update.sessionUpdate === "usage_update") {
      this.context.report({
        contextTokens: update.used,
        ...(update.size > 0 ? { contextWindow: update.size } : {}),
      });
      return true;
    }
    if (update.sessionUpdate === "available_commands_update") {
      this.contextAvailable = update.availableCommands.some(
        (command) => command.name === "context",
      );
    }
    if (
      this.capture &&
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      const capture = this.capture;
      const text = update.content.text;
      const belongs =
        !capture.hidden ||
        (!capture.complete &&
          (capture.text !== "" ||
            text.startsWith("Context Usage") ||
            "Context Usage".startsWith(text) ||
            text.startsWith("Context information")));
      if (belongs) {
        capture.text += text;
        if (capture.text.length > 32_768) {
          capture.text = capture.text.slice(0, 32_768);
          capture.truncated = true;
        }
        capture.complete =
          capture.text.startsWith("Context information is not yet available.") ||
          /\bBuffer\s+[\d.,]+[kKmM]?\s+\([\d.]+%\)\s*$/.test(capture.text);
        return capture.hidden;
      }
    }
    return false;
  }

  beforePrompt(text: string, hasAttachments: boolean): void {
    if (this.contextAvailable && text.trim() === "/context" && !hasAttachments) {
      this.capture = { text: "", hidden: false, truncated: false, complete: false };
    }
  }

  async afterPrompt(): Promise<void> {
    if (this.capture && !this.capture.hidden) this.publishContext();
    else if (this.contextAvailable && !this.context.stopping()) {
      this.capture = { text: "", hidden: true, truncated: false, complete: false };
      try {
        await this.context.prompt("/context", AbortSignal.timeout(5_000));
        this.publishContext();
      } catch (error) {
        this.contextFailed(error);
      } finally {
        this.capture = undefined;
      }
    }
    await this.flush();
  }

  finishPrompt(): void {
    this.capture = undefined;
  }

  reset(): void {
    this.contextAvailable = false;
    this.capture = undefined;
  }

  close(): void {
    clearInterval(this.timer);
  }

  private publishContext(): void {
    if (!this.capture) return;
    try {
      if (this.capture.truncated)
        throw new Error("Copilot's /context report was too large");
      const context = parseContextUsage(this.capture.text);
      const model = this.context.model();
      this.context.report({
        context:
          context && model && model !== "auto" && model !== context.model
            ? null
            : context,
      });
      this.contextError = undefined;
    } catch (error) {
      this.contextFailed(error);
    }
  }

  private contextFailed(error: unknown): void {
    this.context.report({ context: null });
    const message = `Context usage is unavailable: ${errorMessage(error)}`;
    if (message !== this.contextError && !this.context.stopping())
      this.context.notice(message);
    this.contextError = message;
  }
}
