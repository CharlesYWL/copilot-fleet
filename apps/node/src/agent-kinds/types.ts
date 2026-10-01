import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentKind,
  ContextTier,
  PromptAttachment,
  SessionUsage,
} from "@fleet/protocol";

export type AgentLaunch = {
  command: string;
  args: readonly string[];
  contextTier?: ContextTier | undefined;
  notice?: string | undefined;
  failureMessage: (error: unknown, stderr: string) => string;
};

export type AgentLaunchOptions = {
  signal?: AbortSignal;
  yolo: boolean;
  agencyMode: boolean;
  contextTier: ContextTier;
};

export type AgentSessionHandle = {
  connection: acp.ClientConnection;
  sessionId: string;
  options(): readonly acp.SessionConfigOption[];
  yolo: boolean;
  customAgent: string;
  setConfigOption: (id: string, value: string) => Promise<void>;
  notice: (text: string) => void;
  assertActive: () => void;
};

export type UsageContext = {
  report: (usage: SessionUsage) => void;
  notice: (text: string) => void;
  model: () => string | undefined;
  stopping: () => boolean;
  aborted: () => boolean;
  assertActive: () => void;
  prompt: (text: string, signal: AbortSignal) => Promise<void>;
};

export interface UsageReporter {
  /** True when the update was consumed (for example a hidden usage query). */
  onUpdate(update: acp.SessionUpdate): boolean;
  start?(sessionId: string, reset?: boolean): Promise<void>;
  beforePrompt?(text: string, hasAttachments: boolean): void;
  afterPrompt?(): Promise<void>;
  finishPrompt?(): void;
  reset?(): void;
  flush?(): Promise<void>;
  close?(): void;
}

export interface AgentKindAdapter {
  readonly kind: AgentKind;
  readonly label: string;
  readonly yolo: "launch-flag" | "auto-approve";
  readonly tracksUnpromptedWork?: boolean;
  prepare(options: AgentLaunchOptions): Promise<AgentLaunch>;
  usage(context: UsageContext): UsageReporter;
  afterSessionStart?(session: AgentSessionHandle): Promise<void>;
  configOptions?(
    response: acp.NewSessionResponse | acp.LoadSessionResponse,
  ): acp.SessionConfigOption[];
  setConfigOption?(
    session: AgentSessionHandle,
    id: string,
    value: string,
  ): Promise<acp.SessionConfigOption[]>;
  readonly rollover?: {
    matches(error: unknown): boolean;
    prompt(
      assignment: string,
      latest: string,
      attachments?: readonly PromptAttachment[],
    ): string;
    notice: string;
  };
}
