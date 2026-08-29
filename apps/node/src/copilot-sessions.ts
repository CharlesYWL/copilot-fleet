import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { errorMessage } from "@fleet/protocol";
import { copilotLaunchArgs, type ContextTier } from "./agents.js";

export type DiscoveryErrorCode =
  | "unsupported_list"
  | "unsupported_load"
  | "list_failed"
  | "session_not_found"
  | "load_failed";

export class CopilotSessionDiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CopilotSessionDiscoveryError";
  }
}

export type DiscoveredCopilotSession = {
  id: string;
  cwd: string;
  additionalDirectories: string[];
  loadSupported: boolean;
  title?: string;
  updatedAt?: string;
};

export type SessionPreview = {
  items: Array<{ role: "user" | "assistant"; text: string }>;
  truncated: boolean;
};

type DiscoveryConnection = {
  initialize: () => Promise<acp.InitializeResponse>;
  list: (cursor?: string) => Promise<acp.ListSessionsResponse>;
  load: (
    session: DiscoveredCopilotSession,
    includeAdditionalDirectories: boolean,
  ) => Promise<void>;
  close: () => void;
};

type OpenConnection = (
  onUpdate: (update: acp.SessionUpdate) => void,
) => Promise<DiscoveryConnection>;

export type CopilotSessionDiscoveryOptions = {
  getCopilotCommand: () => string;
  getContextTier: () => ContextTier;
  openConnection?: OpenConnection;
  spawnProcess?: typeof spawn;
  now?: () => number;
  cacheTtlMs?: number;
  previewCharacters?: number;
  previewItems?: number;
};

type CachedPage = {
  expiresAt: number;
  sessions: DiscoveredCopilotSession[];
  nextCursor?: string;
};

const OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_PREVIEW_CHARACTERS = 12_000;
const DEFAULT_PREVIEW_ITEMS = 12;

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), OPERATION_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function metadata(
  info: acp.SessionInfo,
  loadSupported: boolean,
): DiscoveredCopilotSession {
  return {
    id: info.sessionId,
    cwd: info.cwd,
    additionalDirectories: [...(info.additionalDirectories ?? [])],
    loadSupported,
    ...(typeof info.title === "string" && info.title !== "" ? { title: info.title } : {}),
    ...(typeof info.updatedAt === "string" && info.updatedAt !== ""
      ? { updatedAt: info.updatedAt }
      : {}),
  };
}

function boundPreview(
  source: readonly { role: "user" | "assistant"; text: string }[],
  maxCharacters: number,
  maxItems: number,
  previouslyTruncated: boolean,
): SessionPreview {
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  let remaining = maxCharacters;
  let truncated = previouslyTruncated || source.length > maxItems;
  for (const item of source.slice(-maxItems).reverse()) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text =
      item.text.length <= remaining
        ? item.text
        : item.text.slice(item.text.length - remaining);
    if (text.length !== item.text.length) truncated = true;
    items.unshift({ role: item.role, text });
    remaining -= text.length;
  }
  return { items, truncated };
}

/**
 * Discovers Copilot conversations exclusively through the public ACP surface.
 */
export class CopilotSessionDiscovery {
  private readonly pages = new Map<string, CachedPage>();
  private readonly sessions = new Map<
    string,
    { value: DiscoveredCopilotSession; expiresAt: number }
  >();

  constructor(private readonly options: CopilotSessionDiscoveryOptions) {}

  get(sessionId: string): DiscoveredCopilotSession | undefined {
    const found = this.sessions.get(sessionId);
    const now = (this.options.now ?? Date.now)();
    return found && found.expiresAt > now ? found.value : undefined;
  }

  async list(cursor?: string): Promise<{
    sessions: DiscoveredCopilotSession[];
    nextCursor?: string;
  }> {
    const key = cursor ?? "";
    const now = (this.options.now ?? Date.now)();
    const cached = this.pages.get(key);
    if (cached && cached.expiresAt > now) {
      return {
        sessions: cached.sessions,
        ...(cached.nextCursor ? { nextCursor: cached.nextCursor } : {}),
      };
    }

    const connection = await this.open(() => {});
    try {
      const capabilities = await this.initialize(connection);
      this.assertListCapability(capabilities);
      let result: acp.ListSessionsResponse;
      try {
        result = await withTimeout(
          connection.list(cursor),
          "Copilot session listing timed out",
        );
      } catch (error) {
        throw new CopilotSessionDiscoveryError(
          "list_failed",
          `Copilot could not list sessions: ${errorMessage(error)}`,
        );
      }
      const sessions = result.sessions.map((info) =>
        metadata(info, capabilities?.loadSession === true),
      );
      const expiresAt = now + (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
      for (const session of sessions) {
        this.sessions.set(session.id, { value: session, expiresAt });
      }
      const page: CachedPage = {
        expiresAt,
        sessions,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
      this.pages.set(key, page);
      return {
        sessions,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    } finally {
      connection.close();
    }
  }

  async preview(sessionId: string): Promise<SessionPreview> {
    const now = (this.options.now ?? Date.now)();
    const found = this.sessions.get(sessionId);
    if (!found || found.expiresAt <= now) {
      throw new CopilotSessionDiscoveryError(
        "session_not_found",
        "Refresh the Copilot session list before loading this preview",
      );
    }

    const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
    let dropped = false;
    const rawLimit = (this.options.previewCharacters ?? DEFAULT_PREVIEW_CHARACTERS) * 4;
    let rawCharacters = 0;
    const onUpdate = (update: acp.SessionUpdate): void => {
      if (
        update.sessionUpdate !== "user_message_chunk" &&
        update.sessionUpdate !== "agent_message_chunk"
      ) {
        return;
      }
      if (update.content.type !== "text" || update.content.text === "") return;
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const last = messages.at(-1);
      if (last?.role === role) {
        last.text += update.content.text;
      } else {
        messages.push({ role, text: update.content.text });
      }
      rawCharacters += update.content.text.length;
      while (rawCharacters > rawLimit && messages.length > 1) {
        rawCharacters -= messages.shift()!.text.length;
        dropped = true;
      }
    };

    const connection = await this.open(onUpdate);
    try {
      const capabilities = await this.initialize(connection);
      if (capabilities?.loadSession !== true || !found.value.loadSupported) {
        throw new CopilotSessionDiscoveryError(
          "unsupported_load",
          "This Copilot version can list sessions but cannot load their context",
        );
      }
      try {
        await withTimeout(
          connection.load(
            found.value,
            capabilities.sessionCapabilities?.additionalDirectories != null,
          ),
          "Copilot session load timed out",
        );
      } catch (error) {
        throw new CopilotSessionDiscoveryError(
          "load_failed",
          `Copilot could not load this session: ${errorMessage(error)}`,
        );
      }
      return boundPreview(
        messages,
        this.options.previewCharacters ?? DEFAULT_PREVIEW_CHARACTERS,
        this.options.previewItems ?? DEFAULT_PREVIEW_ITEMS,
        dropped,
      );
    } finally {
      connection.close();
    }
  }

  private async initialize(
    connection: DiscoveryConnection,
  ): Promise<acp.AgentCapabilities | undefined> {
    try {
      const response = await withTimeout(
        connection.initialize(),
        "Copilot ACP initialization timed out",
      );
      return response.agentCapabilities;
    } catch (error) {
      throw new CopilotSessionDiscoveryError(
        "list_failed",
        `Copilot ACP initialization failed: ${errorMessage(error)}`,
      );
    }
  }

  private assertListCapability(capabilities: acp.AgentCapabilities | undefined): void {
    if (capabilities?.sessionCapabilities?.list == null) {
      throw new CopilotSessionDiscoveryError(
        "unsupported_list",
        "This Copilot version does not support ACP session listing",
      );
    }
  }

  private open(
    onUpdate: (update: acp.SessionUpdate) => void,
  ): Promise<DiscoveryConnection> {
    return (this.options.openConnection ?? (() => this.openProcess(onUpdate)))(onUpdate);
  }

  private async openProcess(
    onUpdate: (update: acp.SessionUpdate) => void,
  ): Promise<DiscoveryConnection> {
    const executable =
      this.options.getCopilotCommand() || process.env.FLEET_COPILOT_COMMAND || "copilot";
    const args = copilotLaunchArgs(false, this.options.getContextTier());
    const viaShell = process.platform === "win32";
    const command = viaShell && executable.includes(" ") ? `"${executable}"` : executable;
    const child: ChildProcessWithoutNullStreams = (this.options.spawnProcess ?? spawn)(
      command,
      args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: viaShell,
      },
    );
    let launchError: Error | undefined;
    const launchFailed = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        launchError = new Error(`Could not start Copilot: ${errorMessage(error)}`, {
          cause: error,
        });
        reject(launchError);
      });
    });
    void launchFailed.catch(() => {});
    const request = <T>(work: Promise<T>): Promise<T> =>
      launchError ? Promise.reject(launchError) : Promise.race([work, launchFailed]);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}\n${chunk.trim()}`.slice(-4_000);
    });

    const app = acp
      .client({ name: "copilot-fleet-session-discovery" })
      .onNotification(acp.methods.client.session.update, ({ params }) =>
        onUpdate(params.update),
      );
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    const suffix = () => (stderr.trim() ? `: ${stderr.trim()}` : "");
    return {
      initialize: async () =>
        request(
          connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
          }),
        ),
      list: async (cursor) =>
        request(
          connection.agent.request(acp.methods.agent.session.list, {
            ...(cursor ? { cursor } : {}),
          }),
        ),
      load: async (session, includeAdditionalDirectories) => {
        try {
          await request(
            connection.agent.request(acp.methods.agent.session.load, {
              sessionId: session.id,
              cwd: session.cwd,
              ...(includeAdditionalDirectories && session.additionalDirectories.length > 0
                ? { additionalDirectories: session.additionalDirectories }
                : {}),
              mcpServers: [],
            }),
          );
        } catch (error) {
          throw new Error(`${errorMessage(error)}${suffix()}`, { cause: error });
        }
      },
      close: () => {
        connection.close();
        if (child.exitCode === null) child.kill();
      },
    };
  }
}
