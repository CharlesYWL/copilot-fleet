import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type FleetNode,
  type FleetSession,
  type Placement,
  type SessionEvent,
  type SessionState,
  type TunnelProvider,
  type Workspace,
  NodeSchema,
  PlacementSchema,
  SessionEventSchema,
  SessionSchema,
  TunnelProviderSchema,
  WorkspaceSchema,
  eventPayload,
  canTransition,
  terminalSessionStates,
} from "@fleet/protocol";

type Row = Record<string, unknown>;

const terminalStateList = [...terminalSessionStates];
/** Terminal plus offline: settled enough that a cascade delete is safe. */
const settledStateList = [...terminalStateList, "offline"];

const placeholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(",");

export class FleetStore {
  private readonly db: DatabaseSync;
  /**
   * Compiling the same SQL on every call showed up on the hot path: a node
   * heartbeat arrives every five seconds per node and each one re-prepared the
   * session query. Statements are cached by text and live as long as the
   * connection does.
   */
  private readonly statements = new Map<string, StatementSync>();

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
      -- Every ownership question (which sessions does this node own, may this
      -- workspace be deleted) filtered these columns with a full scan.
      CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_placement ON sessions(placement_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
    `);
    this.addColumnIfMissing("nodes", "home_dir", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "agent_session_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "yolo", "INTEGER NOT NULL DEFAULT 0");
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** Groups related writes so a crash cannot leave half of them applied. */
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting(key: string): string | undefined {
    const row = this.statement("SELECT value FROM settings WHERE key=?").get(key) as
      Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.statement(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, value);
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
    this.statements.clear();
    this.db.close();
  }

  resetConnectivity(): void {
    this.db.exec("UPDATE nodes SET online=0, active_sessions=0");
    this.statement(
      `UPDATE sessions SET state='offline',current_activity='Host restarted',updated_at=?
       WHERE state NOT IN (${placeholders(settledStateList)})`,
    ).run(new Date().toISOString(), ...settledStateList);
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
    const existing = this.statement("SELECT id FROM nodes WHERE name=?").get(
      input.name,
    ) as { id: string } | undefined;
    if (existing) {
      this.statement(
        `UPDATE nodes SET secret_hash=?, os=?, arch=?, version=?, capabilities=?,
           max_sessions=?, last_heartbeat=?, home_dir=? WHERE id=?`,
      ).run(
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
    this.statement(
      `INSERT INTO nodes
        (id,name,secret_hash,os,arch,version,capabilities,max_sessions,last_heartbeat,online,home_dir)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
    ).run(
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
    this.statement("UPDATE nodes SET name=? WHERE id=?").run(name, id);
    return this.getNode(id);
  }

  /** A reconnecting node may have moved home directory or upgraded. */
  setNodeHomeDir(id: string, homeDir: string): void {
    if (!homeDir) return;
    this.statement("UPDATE nodes SET home_dir=? WHERE id=?").run(homeDir, id);
  }

  /**
   * Refreshes what a Node reports about itself on every reconnect.
   *
   * Capabilities were previously only recorded at registration, so upgrading a
   * Node in place left the Host acting on whatever the machine could do months
   * ago — an updated agent kept being rejected for lacking a feature it had.
   */
  setNodeIdentity(id: string, version: string, capabilities: string[]): void {
    this.statement("UPDATE nodes SET version=?, capabilities=? WHERE id=?").run(
      version,
      JSON.stringify(capabilities),
      id,
    );
  }

  authenticateNode(id: string, secret: string): boolean {
    const row = this.statement("SELECT secret_hash FROM nodes WHERE id=?").get(id) as
      Row | undefined;
    if (!row) return false;
    const supplied = Buffer.from(hash(secret));
    const expected = Buffer.from(String(row.secret_hash));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  setNodeOnline(id: string, online: boolean, activeSessions = 0): FleetNode | undefined {
    return this.recordPresence(id, online, activeSessions).node;
  }

  /**
   * Records a heartbeat and reports whether anything a browser renders moved.
   *
   * `lastHeartbeat` changes on every beat, so publishing the row unconditionally
   * re-rendered the whole app every five seconds per node for no visible reason.
   */
  recordPresence(
    id: string,
    online: boolean,
    activeSessions = 0,
  ): { node: FleetNode | undefined; changed: boolean } {
    const previous = this.getNode(id);
    this.statement(
      "UPDATE nodes SET online=?,active_sessions=?,last_heartbeat=? WHERE id=?",
    ).run(online ? 1 : 0, activeSessions, new Date().toISOString(), id);
    const node = this.getNode(id);
    if (!node) return { node: undefined, changed: false };
    const changed =
      !previous ||
      previous.online !== node.online ||
      previous.activeSessions !== node.activeSessions;
    return { node, changed };
  }

  getNode(id: string): FleetNode | undefined {
    const row = this.statement("SELECT * FROM nodes WHERE id=?").get(id) as
      Row | undefined;
    return row ? nodeFromRow(row) : undefined;
  }

  listNodes(): FleetNode[] {
    return (this.statement("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(
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
    this.statement(
      "INSERT INTO workspaces (id,name,description,created_at) VALUES (?,?,?,?)",
    ).run(workspace.id, name, description, workspace.createdAt);
    return workspace;
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.statement("SELECT * FROM workspaces WHERE id=?").get(id) as
      Row | undefined;
    return row ? workspaceFromRow(row) : undefined;
  }

  updateWorkspace(id: string, name: string, description: string): Workspace | undefined {
    this.statement("UPDATE workspaces SET name=?,description=? WHERE id=?").run(
      name,
      description,
      id,
    );
    return this.getWorkspace(id);
  }

  /**
   * Removes a workspace and its placements / historical sessions. Refuses when
   * any non-terminal session is still attached so we never yank a live agent.
   */
  deleteWorkspace(id: string): void {
    this.assertNoLiveSessions("workspace_id", id, "workspace");
    this.transaction(() => {
      this.deleteSessionsWhere("workspace_id", id);
      this.statement("DELETE FROM placements WHERE workspace_id=?").run(id);
      this.statement("DELETE FROM workspaces WHERE id=?").run(id);
    });
  }

  listWorkspaces(): Workspace[] {
    return (this.statement("SELECT * FROM workspaces ORDER BY name").all() as Row[]).map(
      workspaceFromRow,
    );
  }

  createPlacement(workspaceId: string, nodeId: string, localPath: string): Placement {
    const placement = { id: randomUUID(), workspaceId, nodeId, localPath };
    this.statement(
      "INSERT INTO placements (id,workspace_id,node_id,local_path) VALUES (?,?,?,?)",
    ).run(placement.id, workspaceId, nodeId, localPath);
    return this.getPlacement(placement.id)!;
  }

  updatePlacement(id: string, localPath: string): Placement | undefined {
    this.statement("UPDATE placements SET local_path=? WHERE id=?").run(localPath, id);
    return this.getPlacement(id);
  }

  deletePlacement(id: string): void {
    this.assertNoLiveSessions("placement_id", id, "placement");
    this.transaction(() => {
      this.deleteSessionsWhere("placement_id", id);
      this.statement("DELETE FROM placements WHERE id=?").run(id);
    });
  }

  /**
   * Drops a registered node and everything that pointed at it. Callers should
   * disconnect the WebSocket first if the node is currently online.
   */
  deleteNode(id: string): void {
    this.assertNoLiveSessions("node_id", id, "node");
    this.transaction(() => {
      this.deleteSessionsWhere("node_id", id);
      this.statement("DELETE FROM placements WHERE node_id=?").run(id);
      this.statement("DELETE FROM nodes WHERE id=?").run(id);
    });
  }

  getPlacement(id: string): Placement | undefined {
    const row = this.statement(
      `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
       JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
       WHERE p.id=?`,
    ).get(id) as Row | undefined;
    return row ? placementFromRow(row) : undefined;
  }

  listPlacements(): Placement[] {
    return (
      this.statement(
        `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
         JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
         ORDER BY w.name,n.name`,
      ).all() as Row[]
    ).map(placementFromRow);
  }

  createSession(placement: Placement, prompt: string, yolo = false): FleetSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.statement(
      `INSERT INTO sessions
       (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,last_text,created_at,updated_at,yolo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
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

  private sessionQuery(suffix: string): StatementSync {
    return this.statement(
      `SELECT s.*,w.name workspace_name,n.name node_name FROM sessions s
       JOIN workspaces w ON w.id=s.workspace_id JOIN nodes n ON n.id=s.node_id ${suffix}`,
    );
  }

  /** Ids only, straight off the indexes, for the bulk lifecycle transitions. */
  private sessionIdsWhere(where: string, ...params: unknown[]): string[] {
    return (
      this.statement(`SELECT id FROM sessions ${where}`).all(
        ...(params as never[]),
      ) as Row[]
    ).map((row) => String(row.id));
  }

  transitionSession(id: string, state: SessionState, activity?: string): FleetSession {
    const current = this.getSession(id);
    if (!current) throw new Error("Session not found");
    if (!canTransition(current.state, state)) {
      throw new Error(`Invalid session transition ${current.state} -> ${state}`);
    }
    this.statement(
      "UPDATE sessions SET state=?,current_activity=?,updated_at=? WHERE id=?",
    ).run(state, activity ?? current.currentActivity, new Date().toISOString(), id);
    return this.getSession(id)!;
  }

  /** Soft disconnect: sessions stay recoverable if the Node still has them. */
  markNodeSessionsOffline(nodeId: string, activity: string): FleetSession[] {
    const ids = this.sessionIdsWhere(
      `WHERE node_id=? AND state NOT IN (${placeholders(settledStateList)})`,
      nodeId,
      ...settledStateList,
    );
    return ids.map((id) => this.transitionSession(id, "offline", activity));
  }

  /**
   * After a Node hello/heartbeat: resurrect offline sessions the Node still
   * owns, and settle the ones that did not come back.
   *
   * The Node reporting an empty inventory is the *recovery* path, not a second
   * failure, so the activity has to say what was observed — the Node is back
   * and no longer has this session — instead of blaming the connection a second
   * time. Copilot keeps the agent session on disk, so anything with an agent id
   * is one Resume away from continuing where it stopped.
   */
  reconcileOfflineSessions(
    nodeId: string,
    activeSessionIds: readonly string[],
  ): FleetSession[] {
    const active = new Set(activeSessionIds);
    // Runs on every heartbeat, so it must not walk the session table: the
    // filter is an indexed lookup and the common answer is an empty list.
    const rows = this.statement(
      "SELECT id,agent_session_id FROM sessions WHERE node_id=? AND state=?",
    ).all(nodeId, "offline") as Row[];
    return rows.map((row) => {
      const id = String(row.id);
      if (active.has(id))
        return this.transitionSession(id, "idle", "Reconnected to node");
      return this.transitionSession(
        id,
        "failed",
        row.agent_session_id
          ? "Node reconnected without this session; Resume re-attaches it"
          : "Node reconnected without this session; it never reached the agent",
      );
    });
  }

  /**
   * Appends one agent event and the session columns derived from it.
   *
   * Wrapped in a transaction because an agent streams these continuously: the
   * gap between the sequence check and the insert was wide enough for a second
   * event to claim the same number, and a crash between the insert and the
   * derived updates left `last_text` describing an event that never landed.
   */
  appendEvent(event: SessionEvent): boolean {
    return this.transaction(() => {
      const duplicate = this.statement(
        "SELECT 1 found FROM events WHERE event_id=? OR (session_id=? AND sequence=?)",
      ).get(event.eventId, event.sessionId, event.sequence);
      if (duplicate) return false;
      const previous = this.statement(
        "SELECT MAX(sequence) sequence FROM events WHERE session_id=?",
      ).get(event.sessionId) as Row;
      const max = Number(previous.sequence ?? 0);
      if (event.sequence !== max + 1) {
        throw new Error(`Expected event sequence ${max + 1}, got ${event.sequence}`);
      }
      this.statement(
        "INSERT INTO events (event_id,session_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?,?)",
      ).run(
        event.eventId,
        event.sessionId,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt,
      );
      // Streamed text is what a tile previews, so the newest chunk is kept on
      // the session row rather than re-read from the event log every render.
      const text =
        eventPayload(event, "agent_text")?.text ??
        eventPayload(event, "agent_thought")?.text ??
        eventPayload(event, "system")?.text;
      if (text) {
        this.statement("UPDATE sessions SET last_text=?,updated_at=? WHERE id=?").run(
          text.slice(-500),
          event.createdAt,
          event.sessionId,
        );
      }
      const agentSessionId = eventPayload(event, "agent_session")?.agentSessionId;
      if (agentSessionId) {
        this.statement(
          "UPDATE sessions SET agent_session_id=?,updated_at=? WHERE id=?",
        ).run(agentSessionId, event.createdAt, event.sessionId);
      }
      return true;
    });
  }

  /** Highest event sequence recorded so a resumed agent can continue from it. */
  maxEventSequence(sessionId: string): number {
    const row = this.statement(
      "SELECT MAX(sequence) max FROM events WHERE session_id=?",
    ).get(sessionId) as Row | undefined;
    return Number(row?.max ?? 0);
  }

  listEvents(sessionId: string): SessionEvent[] {
    return (
      this.statement("SELECT * FROM events WHERE session_id=? ORDER BY sequence").all(
        sessionId,
      ) as Row[]
    ).map(eventFromRow);
  }

  private assertNoLiveSessions(
    column: "workspace_id" | "placement_id" | "node_id",
    id: string,
    label: string,
  ): void {
    // Offline rows are leftover after a host/node restart; cascade-delete is fine.
    const row = this.statement(
      `SELECT COUNT(*) live FROM sessions
       WHERE ${column}=? AND state NOT IN (${placeholders(settledStateList)})`,
    ).get(id, ...settledStateList) as Row;
    const live = Number(row.live ?? 0);
    if (live > 0) {
      throw new Error(`Cannot delete ${label} while ${live} session(s) are still active`);
    }
  }

  /** Removes a finished session and its event log. Live sessions are refused. */
  deleteSession(id: string): void {
    const session = this.getSession(id);
    if (!session) throw new Error("Session not found");
    if (!terminalSessionStates.has(session.state)) {
      throw new Error("Can only dismiss ended sessions");
    }
    this.transaction(() => {
      this.statement("DELETE FROM events WHERE session_id=?").run(id);
      this.statement("DELETE FROM sessions WHERE id=?").run(id);
    });
  }

  /** Purge every stopped / completed / failed session. Returns how many went. */
  deleteEndedSessions(): number {
    const list = placeholders(terminalStateList);
    return this.transaction(() => {
      this.statement(
        `DELETE FROM events WHERE session_id IN
           (SELECT id FROM sessions WHERE state IN (${list}))`,
      ).run(...terminalStateList);
      const result = this.statement(`DELETE FROM sessions WHERE state IN (${list})`).run(
        ...terminalStateList,
      );
      return Number(result.changes);
    });
  }

  private deleteSessionsWhere(
    column: "workspace_id" | "placement_id" | "node_id",
    id: string,
  ): void {
    this.statement(
      `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ${column}=?)`,
    ).run(id);
    this.statement(`DELETE FROM sessions WHERE ${column}=?`).run(id);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/*
 * Rows come back from SQLite as untyped records, and every mapper used to cast
 * its way to a domain type — `String(row.state) as SessionState` would happily
 * hand a typo straight to the UI. Parsing with the wire schemas makes the
 * database prove it holds what the rest of the system already assumes.
 */

function nodeFromRow(row: Row): FleetNode {
  return NodeSchema.parse({
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
  });
}

function workspaceFromRow(row: Row): Workspace {
  return WorkspaceSchema.parse({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    createdAt: String(row.created_at),
  });
}

function placementFromRow(row: Row): Placement {
  return PlacementSchema.parse({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    nodeId: String(row.node_id),
    localPath: String(row.local_path),
    workspaceName: String(row.workspace_name),
    nodeName: String(row.node_name),
  });
}

function sessionFromRow(row: Row): FleetSession {
  return SessionSchema.parse({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    placementId: String(row.placement_id),
    nodeId: String(row.node_id),
    nodeName: String(row.node_name),
    state: String(row.state),
    initialPrompt: String(row.initial_prompt),
    currentActivity: String(row.current_activity),
    lastText: String(row.last_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    agentSessionId: String(row.agent_session_id ?? ""),
    yolo: Number(row.yolo ?? 0) === 1,
  });
}

function eventFromRow(row: Row): SessionEvent {
  return SessionEventSchema.parse({
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  });
}
