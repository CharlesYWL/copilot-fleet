import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  SessionStateSchema,
  terminalSessionStates,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import type { AgentFactory, SessionAgent } from "./agents.js";

export type CommandResult = {
  commandId: string;
  ok: boolean;
  error?: string;
};

type SessionSlot = {
  agent?: SessionAgent;
  ready: Promise<void>;
};

export class CommandRouter {
  private readonly slots = new Map<string, SessionSlot>();
  private readonly handled = new Map<string, Promise<CommandResult>>();

  constructor(
    private readonly factory: AgentFactory,
    private readonly maxSessions: number,
    private readonly emit: (event: SessionEvent) => void,
    private readonly validatePath: (path: string) => Promise<string> = validateWorkspacePath,
  ) {}

  get activeSessionIds(): string[] {
    return [...this.slots.keys()];
  }

  async route(command: NodeCommand): Promise<CommandResult> {
    const previous = this.handled.get(command.commandId);
    if (previous) return previous;
    const pending = this.run(command);
    this.handled.set(command.commandId, pending);
    return pending;
  }

  private async run(command: NodeCommand): Promise<CommandResult> {
    try {
      await this.execute(command);
      return { commandId: command.commandId, ok: true };
    } catch (error) {
      return {
        commandId: command.commandId,
        ok: false,
        error: error instanceof Error ? error.message : "Command failed",
      };
    }
  }

  denyPendingPermissions(): void {
    for (const slot of this.slots.values()) slot.agent?.denyPendingPermissions();
  }

  async stopAll(): Promise<void> {
    const slots = [...this.slots.entries()];
    for (const [sessionId] of slots) this.slots.delete(sessionId);
    await Promise.all(
      slots.map(async ([, slot]) => {
        await slot.ready.catch(() => undefined);
        await slot.agent?.stop();
      }),
    );
  }

  private async execute(command: NodeCommand): Promise<void> {
    if (command.type === "start_session") {
      return this.startSession(command);
    }

    const slot = this.slots.get(command.sessionId);
    await slot?.ready;
    const agent = slot?.agent;
    if (!agent) throw new Error("Session is not active on this node");
    if (command.type === "prompt") {
      void agent.prompt(command.prompt).catch(() => undefined);
    } else if (command.type === "cancel") {
      await agent.cancel();
    } else if (command.type === "stop") {
      await agent.stop();
      if (this.slots.get(command.sessionId) === slot) {
        this.slots.delete(command.sessionId);
      }
    } else {
      agent.resolvePermission(command.requestId, {
        outcome: command.outcome,
        ...(command.optionId ? { optionId: command.optionId } : {}),
      });
    }
  }

  private startSession(
    command: Extract<NodeCommand, { type: "start_session" }>,
  ): Promise<void> {
    const existing = this.slots.get(command.sessionId);
    if (existing) return existing.ready;
    if (this.slots.size >= this.maxSessions) {
      return Promise.reject(new Error("Node is at capacity"));
    }

    const slot: SessionSlot = { ready: Promise.resolve() };
    this.slots.set(command.sessionId, slot);
    slot.ready = this.initializeSession(command, slot);
    return slot.ready;
  }

  private async initializeSession(
    command: Extract<NodeCommand, { type: "start_session" }>,
    slot: SessionSlot,
  ): Promise<void> {
    try {
      const cwd = await this.validatePath(command.localPath);
      const sink = (event: SessionEvent) => {
        this.emit(event);
        if (
          event.type === "state" &&
          SessionStateSchema.safeParse(event.payload.state).success &&
          terminalSessionStates.has(SessionStateSchema.parse(event.payload.state))
        ) {
          this.release(command.sessionId, slot);
        }
      };
      const agent = await this.factory.start(command.sessionId, cwd, sink);
      slot.agent = agent;
      if (this.slots.get(command.sessionId) !== slot) {
        await agent.stop();
        throw new Error("Session terminated during startup");
      }
      void agent
        .prompt(command.prompt)
        .catch(() => this.release(command.sessionId, slot));
    } catch (error) {
      this.release(command.sessionId, slot);
      throw error;
    }
  }

  private release(sessionId: string, slot: SessionSlot): void {
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
  }
}

export async function validateWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("Workspace path must be absolute");
  const canonical = await realpath(resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Workspace path must be a directory");
  return canonical;
}
