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
  type TunnelProvider,
  type Workspace,
  TunnelProviderSchema,
  canTransition,
  terminalSessionStates,
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("nodes", "home_dir", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "agent_session_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "yolo", "INTEGER NOT NULL DEFAULT 0");
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | Row
      | undefined;
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  getTunnelEnabled(): boolean {
    return this.getSetting("tunnel.enabled") === "1";
  }

  setTunnelEnabled(enabled: boolean): void {
    this.setSetting("tunnel.enabled", enabled ? "1" : "0");
  }

  getTunnelProvider(): TunnelProvider {
    const stored = this.getSetting("tunnel.provider");
    const parsed = TunnelProviderSchema.safeParse(stored);
    return parsed.success ? parsed.data : "cloudflare";
  }

  /** Preselected in the new-session dialog; each session stores its own copy. */
  getDefaultYolo(): boolean {
    return this.getSetting("defaults.yolo") !== "0";
  }

  setDefaultYolo(yolo: boolean): void {
    this.setSetting("defaults.yolo", yolo ? "1" : "0");
  }

  setTunnelProvider(provider: TunnelProvider): void {
    this.setSetting("tunnel.provider", provider);
  }

  /** Keeps databases created before a column was introduced usable. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  registerNode(
    input: Omit<
      FleetNode,
      "id" | "activeSessions" | "lastHeartbeat" | "online" | "homeDir"
    > & { homeDir?: string },
  ): { node: FleetNode; secret: string } {
    const secret = randomUUID() + randomUUID();
    const now = new Date().toISOString();
    // Re-enrolling under an existing name reclaims that node instead of
    // colliding with the unique index. The enrollment token already gates this,
    // and it keeps placements/sessions attached to a rebuilt machine.
    const existing = this.db
      .prepare("SELECT id FROM nodes WHERE name=?")
      .get(input.name) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE nodes SET secret_hash=?, os=?, arch=?, version=?, capabilities=?,
             max_sessions=?, last_heartbeat=?, home_dir=? WHERE id=?`,
        )
        .run(
          hash(secret),
          input.os,
          input.arch,
          input.version,
          JSON.stringify(input.capabilities),
          input.maxSessions,
          now,
          input.homeDir ?? "",
          existing.id,
        );
      return { node: this.getNode(existing.id)!, secret };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO nodes
          (id,name,secret_hash,os,arch,version,capabilities,max_sessions,last_heartbeat,online,home_dir)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
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
        input.homeDir ?? "",
      );
    return { node: this.getNode(id)!, secret };
  }

  renameNode(id: string, name: string): FleetNode | undefined {
    this.db.prepare("UPDATE nodes SET name=? WHERE id=?").run(name, id);
    return this.getNode(id);
  }

  /** A reconnecting node may have moved home directory or upgraded. */
  setNodeHomeDir(id: string, homeDir: string): void {
    if (!homeDir) return;
    this.db.prepare("UPDATE nodes SET home_dir=? WHERE id=?").run(homeDir, id);
  }

  /**
   * Refreshes what a Node reports about itself on every reconnect.
   *
   * Capabilities were previously only recorded at registration, so upgrading a
   * Node in place left the Host acting on whatever the machine could do months
   * ago — an updated agent kept being rejected for lacking a feature it had.
   */
  setNodeIdentity(id: string, version: string, capabilities: string[]): void {
    this.db
      .prepare("UPDATE nodes SET version=?, capabilities=? WHERE id=?")
      .run(version, JSON.stringify(capabilities), id);
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

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((workspace) => workspace.id === id);
  }

  updateWorkspace(id: string, name: string, description: string): Workspace | undefined {
    this.db
      .prepare("UPDATE workspaces SET name=?,description=? WHERE id=?")
      .run(name, description, id);
    return this.getWorkspace(id);
  }

  /**
   * Removes a workspace and its placements / historical sessions. Refuses when
   * any non-terminal session is still attached so we never yank a live agent.
   */
  deleteWorkspace(id: string): void {
    this.assertNoLiveSessions("workspace_id", id, "workspace");
    this.deleteSessionsWhere("workspace_id", id);
    this.db.prepare("DELETE FROM placements WHERE workspace_id=?").run(id);
    this.db.prepare("DELETE FROM workspaces WHERE id=?").run(id);
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

  updatePlacement(id: string, localPath: string): Placement | undefined {
    this.db.prepare("UPDATE placements SET local_path=? WHERE id=?").run(localPath, id);
    return this.getPlacement(id);
  }

  deletePlacement(id: string): void {
    this.assertNoLiveSessions("placement_id", id, "placement");
    this.deleteSessionsWhere("placement_id", id);
    this.db.prepare("DELETE FROM placements WHERE id=?").run(id);
  }

  /**
   * Drops a registered node and everything that pointed at it. Callers should
   * disconnect the WebSocket first if the node is currently online.
   */
  deleteNode(id: string): void {
    this.assertNoLiveSessions("node_id", id, "node");
    this.deleteSessionsWhere("node_id", id);
    this.db.prepare("DELETE FROM placements WHERE node_id=?").run(id);
    this.db.prepare("DELETE FROM nodes WHERE id=?").run(id);
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

  createSession(placement: Placement, prompt: string, yolo = false): FleetSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions
         (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,last_text,created_at,updated_at,yolo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        yolo ? 1 : 0,
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

  /** Soft disconnect: sessions stay recoverable if the Node still has them. */
  markNodeSessionsOffline(nodeId: string, activity: string): FleetSession[] {
    const changed: FleetSession[] = [];
    for (const session of this.listSessions().filter(
      (item) =>
        item.nodeId === nodeId &&
        !["stopped", "completed", "failed", "offline"].includes(item.state),
    )) {
      changed.push(this.transitionSession(session.id, "offline", activity));
    }
    return changed;
  }

  /**
   * After a Node hello/heartbeat: resurrect offline sessions the Node still
   * owns, and fail the ones that did not come back.
   */
  reconcileOfflineSessions(
    nodeId: string,
    activeSessionIds: readonly string[],
  ): FleetSession[] {
    const active = new Set(activeSessionIds);
    const changed: FleetSession[] = [];
    for (const session of this.listSessions().filter(
      (item) => item.nodeId === nodeId && item.state === "offline",
    )) {
      if (active.has(session.id)) {
        changed.push(
          this.transitionSession(session.id, "idle", "Reconnected to node"),
        );
        continue;
      }
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
    if (event.type === "agent_session" && typeof event.payload.agentSessionId === "string") {
      this.db
        .prepare("UPDATE sessions SET agent_session_id=?,updated_at=? WHERE id=?")
        .run(event.payload.agentSessionId, event.createdAt, event.sessionId);
    }
    return true;
  }

  /** Highest event sequence recorded so a resumed agent can continue from it. */
  maxEventSequence(sessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(sequence) max FROM events WHERE session_id=?")
      .get(sessionId) as Row | undefined;
    return Number(row?.max ?? 0);
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

  private assertNoLiveSessions(
    column: "workspace_id" | "placement_id" | "node_id",
    id: string,
    label: string,
  ): void {
    // Offline rows are leftover after a host/node restart; cascade-delete is fine.
    const settled = new Set<string>([...terminalSessionStates, "offline"]);
    const live = (
      this.db
        .prepare(`SELECT state FROM sessions WHERE ${column}=?`)
        .all(id) as Row[]
    ).filter((row) => !settled.has(String(row.state)));
    if (live.length > 0) {
      throw new Error(
        `Cannot delete ${label} while ${live.length} session(s) are still active`,
      );
    }
  }

  /** Removes a finished session and its event log. Live sessions are refused. */
  deleteSession(id: string): void {
    const session = this.getSession(id);
    if (!session) throw new Error("Session not found");
    if (!terminalSessionStates.has(session.state)) {
      throw new Error("Can only dismiss ended sessions");
    }
    this.db.prepare("DELETE FROM events WHERE session_id=?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }

  /** Purge every stopped / completed / failed session. Returns how many went. */
  deleteEndedSessions(): number {
    const ended = this.listSessions().filter((session) =>
      terminalSessionStates.has(session.state),
    );
    for (const session of ended) this.deleteSession(session.id);
    return ended.length;
  }

  private deleteSessionsWhere(
    column: "workspace_id" | "placement_id" | "node_id",
    id: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ${column}=?)`,
      )
      .run(id);
    this.db.prepare(`DELETE FROM sessions WHERE ${column}=?`).run(id);
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
    homeDir: String(row.home_dir ?? ""),
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
    agentSessionId: String(row.agent_session_id ?? ""),
    yolo: Number(row.yolo ?? 0) === 1,
  };
}
