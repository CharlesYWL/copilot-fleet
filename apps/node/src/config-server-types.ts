import type {
  NodeBackup,
  CommandReadiness,
  CommandPermissionRule,
  CommandPermissionEntry,
} from "@fleet/protocol";
import type { LogEntry } from "@fleet/protocol/log-buffer";
import type { Credentials } from "./config.js";
import type {
  PlacementLike,
  SessionStatusLike,
  StartedSession,
  WorkspaceLike,
} from "./fleet-client.js";
import type { FolderListing } from "./pick-folder.js";
import type { PathCheck } from "./path-check.js";
import type { DiscoveredCopilotSession, SessionPreview } from "./copilot-sessions.js";
import type { Settings } from "./settings.js";

export type ConfigStatus = {
  nodeId: string;
  version: string;
  connected: boolean;
  activeSessions: number;
  mockAgent: boolean;
  devTunnel?: { id: string; url: string };
  commandExecution?: CommandReadiness;
};

/** What `GET /api/identity` tells an agent about the Fleet node it runs on. */
export type NodeIdentity = {
  /** Fixed at enrolment; a rename never changes it. */
  nodeId: string;
  /** The name the Host last confirmed for this node, which a rename there updates. */
  nodeName: string;
  /** The operating system's host name, which a Fleet name need not match. */
  machineName: string;
  /** False while the Host is unreachable, when a rename made there has not arrived yet. */
  connected: boolean;
};

export type FleetApi = {
  listWorkspaces: () => Promise<WorkspaceLike[]>;
  listOwnPlacements: () => Promise<PlacementLike[]>;
  createWorkspace: (name: string, description: string) => Promise<WorkspaceLike>;
  updateWorkspace: (
    id: string,
    name: string,
    description: string,
  ) => Promise<WorkspaceLike>;
  createOwnPlacement: (workspaceId: string, localPath: string) => Promise<PlacementLike>;
  updateOwnPlacementPath: (id: string, localPath: string) => Promise<PlacementLike>;
  listOwnSessions: () => Promise<SessionStatusLike[]>;
  createOwnSession: (input: {
    placementId: string;
    prompt: string;
    name?: string;
  }) => Promise<StartedSession>;
  adoptOwnSession: (input: {
    placementId: string;
    agentSessionId: string;
    additionalDirectories: string[];
    name?: string;
  }) => Promise<StartedSession>;
};

export type SessionDiscoveryApi = {
  list: (cursor?: string) => Promise<{
    sessions: DiscoveredCopilotSession[];
    nextCursor?: string;
  }>;
  preview: (sessionId: string) => Promise<SessionPreview>;
  get: (sessionId: string) => DiscoveredCopilotSession | undefined;
};

export type ConfigServerOptions = {
  getSettings: () => Settings;
  getStatus: () => ConfigStatus;
  applySettings: (settings: Settings) => Promise<void>;
  getCredentials: () => Credentials | undefined;
  applyBackup: (archive: NodeBackup) => Promise<void>;
  log: (message: string) => void;
  rebuildDevTunnel?: () => void;
  recentLogs?: () => LogEntry[];
  port?: number;
  fleet?: FleetApi;
  listFolders?: (path: string) => Promise<FolderListing>;
  inspectPath?: (path: string) => PathCheck;
  sessionDiscovery?: SessionDiscoveryApi;
  getCommandPermissions?: () => {
    version: number;
    rules: CommandPermissionRule[];
    entries?: CommandPermissionEntry[];
  };
  updateCommandPermissions?: (
    expectedVersion: number,
    rules: CommandPermissionRule[],
  ) => Promise<{ version: number; rules: CommandPermissionRule[] }>;
  updateCommandPermissionEntries?: (
    expectedVersion: number,
    entries: CommandPermissionEntry[],
  ) => Promise<{
    version: number;
    rules: CommandPermissionRule[];
    entries: CommandPermissionEntry[];
  }>;
};

export type ConfigReply = { status: number; body: unknown };

export type ConfigRouter = (
  method: string,
  url: string,
  body: string,
) => Promise<ConfigReply>;
