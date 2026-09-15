import { open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHECKPOINT_TYPE = "session.usage_checkpoint";
const CHUNK_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_TYPE_TOKEN_BYTES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCheckpoint(detail: string): Error {
  return new Error(`Invalid Copilot session usage checkpoint: ${detail}`);
}

/**
 * Reads cumulative AI credits from one native Copilot session, not premium requests.
 * Callers serialize read() calls; this reader owns no timer or persistent file handle.
 * Only newline-terminated checkpoints are consumed. Checkpoints over 4 MiB fail
 * explicitly; unrelated lines can be arbitrarily large without growing the buffer.
 * Invalid checkpoints throw once per consumed line; subsequent reads continue.
 */
export class SessionCreditReader {
  private readonly path: string;
  private readonly line = Buffer.alloc(MAX_CHECKPOINT_BYTES);
  private identity: Pick<Stats, "dev" | "ino" | "birthtimeMs"> | undefined;
  private offset = 0;
  private credits: number | undefined;
  private lineLength = 0;
  private oversized = false;
  private checkpoint = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private token: string | undefined = "";
  private key: string | undefined;
  private readingValue = false;

  constructor(
    agentSessionId: string,
    copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  ) {
    if (
      typeof agentSessionId !== "string" ||
      agentSessionId.length === 0 ||
      agentSessionId.length > 128 ||
      /[^a-zA-Z0-9_-]/.test(agentSessionId)
    ) {
      throw new Error("Invalid Copilot session id: expected one safe path component");
    }
    this.path = join(copilotHome, "session-state", agentSessionId, "events.jsonl");
  }

  async read(): Promise<number | undefined> {
    const file = await open(this.path, "r").catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      this.reset();
      return undefined;
    });
    if (!file) return undefined;

    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Copilot session events must be a file");
      if (
        this.identity?.dev !== stat.dev ||
        this.identity.ino !== stat.ino ||
        this.identity.birthtimeMs !== stat.birthtimeMs ||
        stat.size < this.offset
      ) {
        this.reset();
      }
      this.identity = stat;
      if (stat.size === this.offset) return this.credits;

      const buffer = Buffer.alloc(CHUNK_BYTES);
      // Snapshot the size so a continuously appending writer cannot prolong a poll.
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read({
          buffer,
          offset: 0,
          length: Math.min(buffer.length, stat.size - this.offset),
          position: this.offset,
        });
        if (bytesRead === 0) {
          this.reset();
          break;
        }
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          this.scanType(part);
          const copied = part.copy(this.line, this.lineLength);
          this.lineLength += copied;
          this.oversized ||= copied < part.length;
          this.offset += part.length + (newline < 0 ? 0 : 1);
          if (newline >= 0) this.finishLine();
          start = end + 1;
        }
      }
      return this.credits;
    } finally {
      await file.close();
    }
  }

  // Recognize only a top-level type, even after a huge tool payload. Token storage
  // is capped, and quoted/escaped payload text cannot masquerade as an event type.
  private scanType(part: Buffer): void {
    for (const byte of part) {
      if (this.checkpoint) return;
      if (this.inString) {
        if (!this.escaped && byte === 34) {
          this.inString = false;
          if (this.depth === 1) {
            let token: unknown = this.token;
            if (typeof token === "string" && token.includes("\\")) {
              try {
                token = JSON.parse(`"${token}"`) as unknown;
              } catch {
                token = undefined;
              }
            }
            if (this.readingValue) {
              this.checkpoint = this.key === "type" && token === CHECKPOINT_TYPE;
            } else {
              this.key = typeof token === "string" ? token : undefined;
            }
          }
        } else {
          if (this.depth === 1 && this.token !== undefined) {
            this.token =
              this.token.length < MAX_TYPE_TOKEN_BYTES
                ? this.token + String.fromCharCode(byte)
                : undefined;
          }
          this.escaped = !this.escaped && byte === 92;
        }
      } else if (byte === 34) {
        this.inString = true;
        this.escaped = false;
        this.token = "";
      } else if (byte === 123 || byte === 91) {
        this.depth++;
      } else if (byte === 125 || byte === 93) {
        this.depth--;
      } else if (this.depth === 1 && byte === 58) {
        this.readingValue = true;
      } else if (this.depth === 1 && byte === 44) {
        this.readingValue = false;
        this.key = undefined;
      }
    }
  }

  private finishLine(): void {
    const checkpoint = this.checkpoint;
    const oversized = this.oversized;
    const line =
      checkpoint && !oversized
        ? this.line.toString("utf8", 0, this.lineLength)
        : undefined;
    // Consume a malformed line before throwing so subsequent polls can recover.
    this.resetLine();
    if (!checkpoint) return;
    if (oversized) {
      throw invalidCheckpoint(`exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    }

    let event: unknown;
    try {
      event = JSON.parse(line!) as unknown;
    } catch {
      throw invalidCheckpoint("malformed JSON");
    }
    if (!isRecord(event) || event.type !== CHECKPOINT_TYPE) return;
    if (event.data === undefined) return;
    if (!isRecord(event.data)) throw invalidCheckpoint("data must be an object");
    if (!Object.hasOwn(event.data, "totalNanoAiu")) return;
    const nanoAiu = event.data.totalNanoAiu;
    if (typeof nanoAiu !== "number" || !Number.isSafeInteger(nanoAiu) || nanoAiu < 0) {
      throw invalidCheckpoint("totalNanoAiu must be a non-negative safe integer");
    }
    this.credits = nanoAiu / 1e9;
  }

  private resetLine(): void {
    this.lineLength = 0;
    this.oversized = false;
    this.checkpoint = false;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.token = "";
    this.key = undefined;
    this.readingValue = false;
  }

  private reset(): void {
    this.identity = undefined;
    this.offset = 0;
    this.credits = undefined;
    this.resetLine();
  }
}
