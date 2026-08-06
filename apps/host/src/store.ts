import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type FleetNode,
  type FleetSession,
  type Placement,
  type SessionEvent,
  type SessionState,
  type Workspace,
  canTransition,
} from "@fleet/protocol";

type Row = Record<string, unknown>;

export class FleetStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL,
        os TEXT NOT NULL, arch TEXT NOT NULL, version TEXT NOT NULL,
        capabilities TEXT NOT NULL, max_sessions INTEGER NOT NULL,
        active_sessions INTEGER NOT NULL DEFAULT 0,
        last_heartbeat TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS placements (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        node_id TEXT NOT NULL REFERENCES nodes(id), local_path TEXT NOT NULL,
        UNIQUE(workspace_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        placement_id TEXT NOT NULL REFERENCES placements(id),
        node_id TEXT NOT NULL REFERENCES nodes(id), state TEXT NOT NULL,
        initial_prompt TEXT NOT NULL, current_activity TEXT NOT NULL,
        last_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(session_id, sequence)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  resetConnectivity(): void {
    this.db.exec("UPDATE nodes SET online=0, active_sessions=0");
    this.db
      .prepare(
        `UPDATE sessions SET state='offline',current_activity='Host restarted',updated_at=?
         WHERE state NOT IN ('stopped','completed','failed','offline')`,
      )
      .run(new Date().toISOString());
  }

  registerNode(input: Omit<FleetNode, "id" | "activeSessions" | "lastHeartbeat" | "online">): {
    node: FleetNode;
    secret: string;
  } {
    const id = randomUUID();
    const secret = randomUUID() + randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO nodes
          (id,name,secret_hash,os,arch,version,capabilities,max_sessions,last_heartbeat,online)
         VALUES (?,?,?,?,?,?,?,?,?,0)`,
      )
      .run(
        id,
        input.name,
        hash(secret),
        input.os,
        input.arch,
        input.version,
        JSON.stringify(input.capabilities),
        input.maxSessions,
        now,
      );
    return { node: this.getNode(id)!, secret };
  }

  authenticateNode(id: string, secret: string): boolean {
    const row = this.db.prepare("SELECT secret_hash FROM nodes WHERE id=?").get(id) as
      | Row
      | undefined;
    if (!row) return false;
    const supplied = Buffer.from(hash(secret));
    const expected = Buffer.from(String(row.secret_hash));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  setNodeOnline(id: string, online: boolean, activeSessions = 0): FleetNode | undefined {
    this.db
      .prepare(
        "UPDATE nodes SET online=?,active_sessions=?,last_heartbeat=? WHERE id=?",
      )
      .run(online ? 1 : 0, activeSessions, new Date().toISOString(), id);
    return this.getNode(id);
  }

  getNode(id: string): FleetNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id=?").get(id) as Row | undefined;
    return row ? nodeFromRow(row) : undefined;
  }

  listNodes(): FleetNode[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(
      nodeFromRow,
    );
  }

  createWorkspace(name: string, description: string): Workspace {
    const workspace = {
      id: randomUUID(),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO workspaces (id,name,description,created_at) VALUES (?,?,?,?)")
      .run(workspace.id, name, description, workspace.createdAt);
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return (
      this.db.prepare("SELECT * FROM workspaces ORDER BY name").all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      createdAt: String(row.created_at),
    }));
  }

  createPlacement(workspaceId: string, nodeId: string, localPath: string): Placement {
    const placement = { id: randomUUID(), workspaceId, nodeId, localPath };
    this.db
      .prepare(
        "INSERT INTO placements (id,workspace_id,node_id,local_path) VALUES (?,?,?,?)",
      )
      .run(placement.id, workspaceId, nodeId, localPath);
    return this.getPlacement(placement.id)!;
  }

  getPlacement(id: string): Placement | undefined {
    const row = this.db
      .prepare(
        `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
         JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
         WHERE p.id=?`,
      )
      .get(id) as Row | undefined;
    return row ? placementFromRow(row) : undefined;
  }

  listPlacements(): Placement[] {
    return (
      this.db
        .prepare(
          `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
           JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
           ORDER BY w.name,n.name`,
        )
        .all() as Row[]
    ).map(placementFromRow);
  }

  createSession(placement: Placement, prompt: string): FleetSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions
         (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,last_text,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        placement.workspaceId,
        placement.id,
        placement.nodeId,
        "queued",
        prompt,
        "Waiting for node",
        "",
        now,
        now,
      );
    return this.getSession(id)!;
  }

  getSession(id: string): FleetSession | undefined {
    const row = this.sessionQuery("WHERE s.id=?").get(id) as Row | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(): FleetSession[] {
    return (this.sessionQuery("ORDER BY s.created_at DESC").all() as Row[]).map(
      sessionFromRow,
    );
  }

  private sessionQuery(suffix: string) {
    return this.db.prepare(
      `SELECT s.*,w.name workspace_name,n.name node_name FROM sessions s
       JOIN workspaces w ON w.id=s.workspace_id JOIN nodes n ON n.id=s.node_id ${suffix}`,
    );
  }

  transitionSession(
    id: string,
    state: SessionState,
    activity?: string,
  ): FleetSession {
    const current = this.getSession(id);
    if (!current) throw new Error("Session not found");
    if (!canTransition(current.state, state)) {
      throw new Error(`Invalid session transition ${current.state} -> ${state}`);
    }
    this.db
      .prepare("UPDATE sessions SET state=?,current_activity=?,updated_at=? WHERE id=?")
      .run(state, activity ?? current.currentActivity, new Date().toISOString(), id);
    return this.getSession(id)!;
  }

  markNodeSessionsFailed(nodeId: string, activity: string): FleetSession[] {
    const changed: FleetSession[] = [];
    for (const session of this.listSessions().filter(
      (item) =>
        item.nodeId === nodeId &&
        !["stopped", "completed", "failed"].includes(item.state),
    )) {
      changed.push(this.transitionSession(session.id, "failed", activity));
    }
    return changed;
  }

  reconcileOfflineSessions(
    nodeId: string,
    activeSessionIds: readonly string[],
  ): FleetSession[] {
    const active = new Set(activeSessionIds);
    const changed: FleetSession[] = [];
    for (const session of this.listSessions().filter(
      (item) =>
        item.nodeId === nodeId &&
        item.state === "offline" &&
        !active.has(item.id),
    )) {
      changed.push(
        this.transitionSession(
          session.id,
          "failed",
          "Execution ended when the Node connection was lost",
        ),
      );
    }
    return changed;
  }

  appendEvent(event: SessionEvent): boolean {
    const previous = this.db
      .prepare("SELECT MAX(sequence) sequence FROM events WHERE session_id=?")
      .get(event.sessionId) as Row;
    const max = Number(previous.sequence ?? 0);
    const duplicate = this.db
      .prepare("SELECT 1 found FROM events WHERE event_id=? OR (session_id=? AND sequence=?)")
      .get(event.eventId, event.sessionId, event.sequence);
    if (duplicate) return false;
    if (event.sequence !== max + 1) {
      throw new Error(`Expected event sequence ${max + 1}, got ${event.sequence}`);
    }
    this.db
      .prepare(
        "INSERT INTO events (event_id,session_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        event.eventId,
        event.sessionId,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt,
      );
    const text = typeof event.payload.text === "string" ? event.payload.text : undefined;
    if (text) {
      this.db
        .prepare("UPDATE sessions SET last_text=?,updated_at=? WHERE id=?")
        .run(text.slice(-500), event.createdAt, event.sessionId);
    }
    return true;
  }

  listEvents(sessionId: string): SessionEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE session_id=? ORDER BY sequence")
        .all(sessionId) as Row[]
    ).map((row) => ({
      eventId: String(row.event_id),
      sessionId: String(row.session_id),
      sequence: Number(row.sequence),
      type: String(row.type) as SessionEvent["type"],
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeFromRow(row: Row): FleetNode {
  return {
    id: String(row.id),
    name: String(row.name),
    os: String(row.os),
    arch: String(row.arch),
    version: String(row.version),
    capabilities: JSON.parse(String(row.capabilities)) as string[],
    maxSessions: Number(row.max_sessions),
    activeSessions: Number(row.active_sessions),
    lastHeartbeat: String(row.last_heartbeat),
    online: Boolean(row.online),
  };
}

function placementFromRow(row: Row): Placement {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    nodeId: String(row.node_id),
    localPath: String(row.local_path),
    workspaceName: String(row.workspace_name),
    nodeName: String(row.node_name),
  };
}

function sessionFromRow(row: Row): FleetSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    placementId: String(row.placement_id),
    nodeId: String(row.node_id),
    nodeName: String(row.node_name),
    state: String(row.state) as SessionState,
    initialPrompt: String(row.initial_prompt),
    currentActivity: String(row.current_activity),
    lastText: String(row.last_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
