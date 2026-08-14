import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type FleetNode,
  type FleetSession,
  type HostBackup,
  type Placement,
  type SessionEvent,
  type SessionState,
  type TunnelProvider,
  type Workspace,
  HOST_BACKUP_KIND,
  BACKUP_VERSION,
  HostBackupSchema,
  NodeSchema,
  PlacementSchema,
  SessionEventSchema,
  SessionSchema,
  TunnelProviderSchema,
  WorkspaceSchema,
  eventPayload,
  canTransition,
  sessionFieldsForHostImport,
  terminalSessionStates,
} from "@fleet/protocol";

type Row = Record<string, unknown>;

/**
 * What happened to an event offered to the log.
 *
 * `skipped` counts the events that never arrived before this one — the Host was
 * down while the Node kept working — so a caller can say so once instead of
 * treating a hole as corruption.
 */
export type AppendResult = { stored: boolean; skipped: number };

/**
 * What a Node tells the Host about itself in its `hello` frame.
 *
 * Every field is optional so that {@link FleetStore.setNodeIdentity} only
 * touches what was actually reported.
 */
export type ReportedNodeIdentity = {
  version?: string;
  revision?: string;
  capabilities?: string[];
  maxSessions?: number;
  os?: string;
  arch?: string;
  homeDir?: string;
};

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
    this.addColumnIfMissing("nodes", "revision", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "agent_session_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "yolo", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "commands", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "config_options", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("placements", "position", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("workspaces", "position", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "position", "INTEGER NOT NULL DEFAULT 0");
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

  /**
   * Whether a session a Node lost is re-attached without being asked.
   *
   * On by default: the sessions this applies to were interrupted by a restart
   * rather than ended by anyone, and re-attaching only reopens the conversation
   * — it sends no prompt, so nothing runs until an operator says so.
   */
  getAutoResume(): boolean {
    return this.getSetting("defaults.autoResume") !== "0";
  }

  setAutoResume(enabled: boolean): void {
    this.setSetting("defaults.autoResume", enabled ? "1" : "0");
  }

  setTunnelProvider(provider: TunnelProvider): void {
    this.setSetting("tunnel.provider", provider);
  }

  /**
   * A portable snapshot of this Host: catalog, transcripts, settings, and the
   * hashes Nodes authenticate with. The caller supplies the enrollment token
   * and (optionally) a public URL because those live outside the catalog tables.
   */
  exportHostBackup(input: { enrollmentToken: string; publicUrl?: string }): HostBackup {
    const backup = {
      kind: HOST_BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      enrollmentToken: input.enrollmentToken,
      ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
      tunnel: {
        enabled: this.getTunnelEnabled(),
        provider: this.getTunnelProvider(),
      },
      defaults: {
        yolo: this.getDefaultYolo(),
        autoResume: this.getAutoResume(),
      },
      nodes: (this.statement("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(
        (row) => ({
          ...nodeFromRow(row),
          secretHash: String(row.secret_hash),
        }),
      ),
      workspaces: (
        this.statement("SELECT * FROM workspaces ORDER BY position,name").all() as Row[]
      ).map((row) => ({
        ...workspaceFromRow(row),
        position: Number(row.position ?? 0),
      })),
      placements: (
        this.statement(
          `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
           JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
           ORDER BY w.name,p.position,n.name`,
        ).all() as Row[]
      ).map((row) => ({
        ...placementFromRow(row),
        position: Number(row.position ?? 0),
      })),
      sessions: (this.sessionQuery("ORDER BY s.position,s.created_at DESC").all() as Row[]).map(
        (row) => ({
          ...sessionFromRow(row),
          position: Number(row.position ?? 0),
        }),
      ),
      events: (
        this.statement("SELECT * FROM events ORDER BY session_id,sequence").all() as Row[]
      ).map(eventFromRow),
    };
    return HostBackupSchema.parse(backup);
  }

  /**
   * Replaces every catalog row and settings key with the archive.
   *
   * Live session states become `offline` so a moved Host does not claim agents
   * that are still on the old process. Node secret hashes are restored as-is,
   * so machines that still have `node.json` can authenticate without re-enrolling.
   */
  replaceHostBackup(backup: HostBackup): void {
    const parsed = HostBackupSchema.parse(backup);
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM events; DELETE FROM sessions; DELETE FROM placements; DELETE FROM workspaces; DELETE FROM nodes; DELETE FROM settings",
      );
      this.setTunnelEnabled(parsed.tunnel.enabled);
      this.setTunnelProvider(parsed.tunnel.provider);
      this.setDefaultYolo(parsed.defaults.yolo);
      this.setAutoResume(parsed.defaults.autoResume);
      this.setSetting("enrollment.token", parsed.enrollmentToken);
      if (parsed.publicUrl) this.setSetting("host.publicUrl", parsed.publicUrl);
      for (const node of parsed.nodes) {
        this.statement(
          `INSERT INTO nodes
            (id,name,secret_hash,os,arch,version,revision,capabilities,max_sessions,
             active_sessions,last_heartbeat,online,home_dir)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,0,?)`,
        ).run(
          node.id,
          node.name,
          node.secretHash,
          node.os,
          node.arch,
          node.version,
          node.revision,
          JSON.stringify(node.capabilities),
          node.maxSessions,
          node.lastHeartbeat,
          node.homeDir,
        );
      }
      for (const workspace of parsed.workspaces) {
        this.statement(
          "INSERT INTO workspaces (id,name,description,created_at,position) VALUES (?,?,?,?,?)",
        ).run(
          workspace.id,
          workspace.name,
          workspace.description,
          workspace.createdAt,
          workspace.position,
        );
      }
      for (const placement of parsed.placements) {
        this.statement(
          "INSERT INTO placements (id,workspace_id,node_id,local_path,position) VALUES (?,?,?,?,?)",
        ).run(
          placement.id,
          placement.workspaceId,
          placement.nodeId,
          placement.localPath,
          placement.position,
        );
      }
      for (const session of parsed.sessions) {
        const imported = sessionFieldsForHostImport(session);
        this.statement(
          `INSERT INTO sessions
            (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,
             last_text,created_at,updated_at,agent_session_id,yolo,name,commands,
             config_options,position)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          session.id,
          session.workspaceId,
          session.placementId,
          session.nodeId,
          imported.state,
          session.initialPrompt,
          imported.currentActivity,
          session.lastText,
          session.createdAt,
          session.updatedAt,
          session.agentSessionId,
          session.yolo ? 1 : 0,
          session.name,
          JSON.stringify(session.commands),
          JSON.stringify(session.configOptions),
          session.position,
        );
      }
      for (const event of parsed.events) {
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
      }
    });
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
      "id" | "activeSessions" | "lastHeartbeat" | "online" | "homeDir" | "revision"
    > & { homeDir?: string; revision?: string },
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
        `UPDATE nodes SET secret_hash=?, os=?, arch=?, version=?, revision=?, capabilities=?,
           max_sessions=?, last_heartbeat=?, home_dir=? WHERE id=?`,
      ).run(
        hash(secret),
        input.os,
        input.arch,
        input.version,
        input.revision ?? "",
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
        (id,name,secret_hash,os,arch,version,revision,capabilities,max_sessions,last_heartbeat,online,home_dir)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    ).run(
      id,
      input.name,
      hash(secret),
      input.os,
      input.arch,
      input.version,
      input.revision ?? "",
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

  /**
   * Renames a Node, reporting a name already in use rather than throwing.
   *
   * A rename arriving over `hello` cannot be handled the way the browser's is —
   * with a 409 for the operator to read — because there is nobody watching the
   * socket. Taking the collision as an answer lets the reconnect continue and
   * the Node be told which name it actually has.
   */
  tryRenameNode(id: string, name: string): FleetNode | undefined {
    const taken = this.statement("SELECT id FROM nodes WHERE name=? AND id<>?").get(
      name,
      id,
    ) as { id: string } | undefined;
    if (taken) return undefined;
    return this.renameNode(id, name);
  }

  /**
   * Refreshes everything a Node reports about itself on every reconnect.
   *
   * Registration used to be the only writer of these columns, so a machine that
   * changed after enrollment kept being described — and scheduled — by what it
   * was on the day it enrolled:
   *
   * - capabilities: an agent upgraded in place kept being rejected for lacking
   *   a feature it had already gained;
   * - maxSessions: raising Max Sessions in the local Node UI saved and
   *   reconnected, but the Host kept scheduling against the enrollment value,
   *   so the new slots were never usable;
   * - os/arch/homeDir: a rebuilt or migrated machine kept displaying, and
   *   seeding placement paths from, the platform it no longer runs.
   *
   * Fields the caller leaves out are kept, so a Node that reports less than the
   * current protocol cannot blank a column it simply does not know about.
   */
  setNodeIdentity(id: string, identity: ReportedNodeIdentity): void {
    const columns: string[] = [];
    const values: (string | number)[] = [];
    const set = (column: string, value: string | number | undefined): void => {
      if (value === undefined) return;
      columns.push(`${column}=?`);
      values.push(value);
    };
    set("version", identity.version);
    // Unlike home_dir, an empty revision is a real answer — "this checkout is
    // not a git repository" — and must be able to replace a stale commit, or a
    // machine that moved to a tarball deploy would keep claiming the last
    // commit it ever reported.
    set("revision", identity.revision);
    set(
      "capabilities",
      identity.capabilities ? JSON.stringify(identity.capabilities) : undefined,
    );
    set("max_sessions", identity.maxSessions);
    set("os", identity.os);
    set("arch", identity.arch);
    // An empty string is what a Node sends when it does not know its home
    // directory; overwriting a good value with it would lose the placement seed.
    set("home_dir", identity.homeDir ? identity.homeDir : undefined);
    if (columns.length === 0) return;
    this.statement(`UPDATE nodes SET ${columns.join(",")} WHERE id=?`).run(...values, id);
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
    // New workspaces go to the end, so an order arranged by hand survives the
    // next project being added.
    const last = this.statement("SELECT MAX(position) position FROM workspaces").get() as
      Row | undefined;
    this.statement(
      "INSERT INTO workspaces (id,name,description,created_at,position) VALUES (?,?,?,?,?)",
    ).run(
      workspace.id,
      name,
      description,
      workspace.createdAt,
      Number(last?.position ?? -1) + 1,
    );
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
    return (
      this.statement("SELECT * FROM workspaces ORDER BY position,name").all() as Row[]
    ).map(workspaceFromRow);
  }

  /** See {@link reorderPlacements}: the whole list travels, for the same reason. */
  reorderWorkspaces(orderedIds: readonly string[]): Workspace[] {
    const own = (this.statement("SELECT id FROM workspaces").all() as Row[]).map((row) =>
      String(row.id),
    );
    const known = new Set(own);
    const ordered = orderedIds.filter((id) => known.has(id));
    const missing = own.filter((id) => !ordered.includes(id));
    this.transaction(() => {
      [...ordered, ...missing].forEach((id, index) => {
        this.statement("UPDATE workspaces SET position=? WHERE id=?").run(index, id);
      });
    });
    return this.listWorkspaces();
  }

  createPlacement(workspaceId: string, nodeId: string, localPath: string): Placement {
    const placement = { id: randomUUID(), workspaceId, nodeId, localPath };
    // New placements land at the end of their workspace's list rather than
    // wherever `name` happens to put them, so an order the operator arranged by
    // hand is not rearranged by the next machine they add.
    const last = this.statement(
      "SELECT MAX(position) position FROM placements WHERE workspace_id=?",
    ).get(workspaceId) as Row | undefined;
    this.statement(
      "INSERT INTO placements (id,workspace_id,node_id,local_path,position) VALUES (?,?,?,?,?)",
    ).run(placement.id, workspaceId, nodeId, localPath, Number(last?.position ?? -1) + 1);
    return this.getPlacement(placement.id)!;
  }

  /**
   * Writes the order an operator arranged by hand.
   *
   * Takes the whole list rather than one placement and an index: a move is two
   * edits in a sequence, and applying them one at a time leaves the list in a
   * state where two rows claim the same position — briefly, but visibly, and
   * permanently if the second write never lands. Ids that do not belong to the
   * workspace are ignored rather than rejected, because a browser can be
   * holding a list from before another one deleted a row.
   */
  reorderPlacements(workspaceId: string, orderedIds: readonly string[]): Placement[] {
    const own = (
      this.statement("SELECT id FROM placements WHERE workspace_id=?").all(
        workspaceId,
      ) as Row[]
    ).map((row) => String(row.id));
    const known = new Set(own);
    const ordered = orderedIds.filter((id) => known.has(id));
    // Anything the caller did not mention keeps its place at the end, so a
    // stale list cannot silently drop a placement out of the ordering.
    const missing = own.filter((id) => !ordered.includes(id));
    this.transaction(() => {
      [...ordered, ...missing].forEach((id, index) => {
        this.statement("UPDATE placements SET position=? WHERE id=?").run(index, id);
      });
    });
    return this.listPlacements().filter(
      (placement) => placement.workspaceId === workspaceId,
    );
  }

  updatePlacement(
    id: string,
    localPath?: string,
    workspaceId?: string,
  ): Placement | undefined {
    if (localPath !== undefined) {
      this.statement("UPDATE placements SET local_path=? WHERE id=?").run(localPath, id);
    }
    if (workspaceId !== undefined) {
      this.movePlacement(id, workspaceId);
    }
    return this.getPlacement(id);
  }

  /**
   * Files a placement under a different workspace, sessions and all.
   *
   * The sessions carry their own `workspace_id` so the sidebar can group history
   * without a join; leaving that behind would strand every past run of this
   * checkout under the project it used to belong to, while the checkout itself
   * moved. They are updated in the same transaction for that reason.
   *
   * Refused when the target already has this node: the table's own uniqueness
   * rule says a workspace can only be in one place on a given machine, and the
   * raw constraint error names a column rather than either project.
   */
  private movePlacement(id: string, workspaceId: string): void {
    const placement = this.getPlacement(id);
    if (!placement) return;
    if (placement.workspaceId === workspaceId) return;
    if (!this.getWorkspace(workspaceId)) {
      throw new Error("Unknown workspace");
    }
    const clash = this.statement(
      "SELECT id FROM placements WHERE workspace_id=? AND node_id=? AND id<>?",
    ).get(workspaceId, placement.nodeId, id) as Row | undefined;
    if (clash) {
      throw new Error("That workspace already has a placement on this node");
    }
    this.transaction(() => {
      this.statement("UPDATE placements SET workspace_id=? WHERE id=?").run(
        workspaceId,
        id,
      );
      this.statement("UPDATE sessions SET workspace_id=? WHERE placement_id=?").run(
        workspaceId,
        id,
      );
    });
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
         ORDER BY w.name,p.position,n.name`,
      ).all() as Row[]
    ).map(placementFromRow);
  }

  createSession(
    placement: Placement,
    prompt: string,
    yolo = false,
    name = "",
  ): FleetSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.statement(
      `INSERT INTO sessions
       (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,last_text,created_at,updated_at,yolo,name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      name.trim(),
    );
    return this.getSession(id)!;
  }

  /**
   * Renames a session, or clears the name when given an empty one so the label
   * falls back to the initial prompt.
   *
   * `updated_at` deliberately moves: the tile ordering and the "last touched"
   * reading both come from it, and a rename is an operator touching this row.
   */
  renameSession(id: string, name: string): FleetSession | undefined {
    if (!this.getSession(id)) return undefined;
    this.statement("UPDATE sessions SET name=?,updated_at=? WHERE id=?").run(
      name.trim(),
      new Date().toISOString(),
      id,
    );
    return this.getSession(id);
  }

  getSession(id: string): FleetSession | undefined {
    const row = this.sessionQuery("WHERE s.id=?").get(id) as Row | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(): FleetSession[] {
    // `position` defaults to 0, so a fleet nobody has rearranged keeps the
    // newest-first order it always had; only sessions an operator dragged
    // carry a number that overrides it.
    return (
      this.sessionQuery("ORDER BY s.position,s.created_at DESC").all() as Row[]
    ).map(sessionFromRow);
  }

  /**
   * Writes the order an operator dragged sessions into.
   *
   * Positions are only ever compared between siblings — the tree groups by
   * workspace and node before it sorts — so numbering each dragged group from
   * zero is enough, and saves having to renumber the whole table to insert one
   * row. See {@link reorderPlacements} for why the whole list travels.
   */
  reorderSessions(orderedIds: readonly string[]): FleetSession[] {
    const known = new Set(
      (this.statement("SELECT id FROM sessions").all() as Row[]).map((row) =>
        String(row.id),
      ),
    );
    this.transaction(() => {
      orderedIds
        .filter((id) => known.has(id))
        .forEach((id, index) => {
          this.statement("UPDATE sessions SET position=? WHERE id=?").run(index, id);
        });
    });
    return this.listSessions();
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
   *
   * A session the Node reports as busy comes back as `running`, not `idle`.
   * Landing everything on `idle` was a guess, and when the socket dropped
   * mid-turn it was the wrong one: the UI unlocked its composer over an agent
   * that still had a prompt in flight, and every follow-up the operator typed
   * was refused by the Node and silently dropped. Nodes too old to report
   * business send no ids, so they keep the old landing state.
   */
  reconcileOfflineSessions(
    nodeId: string,
    activeSessionIds: readonly string[],
    busySessionIds: readonly string[] = [],
  ): FleetSession[] {
    const active = new Set(activeSessionIds);
    const busy = new Set(busySessionIds);
    // Runs on every heartbeat, so it must not walk the session table: the
    // filter is an indexed lookup and the common answer is an empty list.
    const rows = this.statement(
      "SELECT id,agent_session_id FROM sessions WHERE node_id=? AND state=?",
    ).all(nodeId, "offline") as Row[];
    return rows.map((row) => {
      const id = String(row.id);
      if (active.has(id)) {
        return busy.has(id)
          ? this.transitionSession(id, "running", "Reconnected to node; still working")
          : this.transitionSession(id, "idle", "Reconnected to node");
      }
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
   *
   * A sequence ahead of the next expected one is stored rather than refused.
   * Events are produced by a Node that keeps working while the Host is down, and
   * the ones raised during the outage are simply gone — so demanding the exact
   * next number meant the first event after a Host restart was rejected, and
   * every event after it too, because the gap could never close. The session
   * went deaf: its transcript stopped, its state froze wherever it happened to
   * be, and nothing short of restarting the Node recovered it.
   */
  appendEvent(event: SessionEvent): AppendResult {
    return this.transaction(() => {
      const duplicate = this.statement(
        "SELECT 1 found FROM events WHERE event_id=? OR (session_id=? AND sequence=?)",
      ).get(event.eventId, event.sessionId, event.sequence);
      if (duplicate) return { stored: false, skipped: 0 };
      const previous = this.statement(
        "SELECT MAX(sequence) sequence FROM events WHERE session_id=?",
      ).get(event.sessionId) as Row;
      const max = Number(previous.sequence ?? 0);
      const skipped = Math.max(0, event.sequence - (max + 1));
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
      // Only the newest event describes the session now: an event that arrives
      // late and fills a hole must not drag the preview backwards.
      if (event.sequence > max) {
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
        // The pickers and the slash menu are current state, so only the newest
        // report may set them: an event that arrives late and fills a hole
        // would otherwise reinstate the model the session has already left.
        const commands = eventPayload(event, "commands")?.commands;
        if (commands) {
          this.statement("UPDATE sessions SET commands=?,updated_at=? WHERE id=?").run(
            JSON.stringify(commands),
            event.createdAt,
            event.sessionId,
          );
        }
        const options = eventPayload(event, "config")?.options;
        if (options) {
          this.statement(
            "UPDATE sessions SET config_options=?,updated_at=? WHERE id=?",
          ).run(JSON.stringify(options), event.createdAt, event.sessionId);
        }
      }
      const agentSessionId = eventPayload(event, "agent_session")?.agentSessionId;
      if (agentSessionId) {
        this.statement(
          "UPDATE sessions SET agent_session_id=?,updated_at=? WHERE id=?",
        ).run(agentSessionId, event.createdAt, event.sessionId);
      }
      return { stored: true, skipped };
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

  /**
   * Purges finished sessions, but keeps the ones Resume can still re-attach.
   *
   * A Node reboot settles its sessions as `failed` while Copilot still holds the
   * conversation, so "ended" and "gone" are not the same thing. Clearing swept
   * both away, which meant the single visible button after a restart was the one
   * that destroyed the transcripts the operator had just come back for. Those
   * rows can still be removed one at a time with {@link deleteSession}, which is
   * a deliberate act on a session someone is looking at.
   *
   * Returns how many went.
   */
  deleteEndedSessions(): number {
    const list = placeholders(terminalStateList);
    const disposable = `state IN (${list}) AND agent_session_id = ''`;
    return this.transaction(() => {
      this.statement(
        `DELETE FROM events WHERE session_id IN
           (SELECT id FROM sessions WHERE ${disposable})`,
      ).run(...terminalStateList);
      const result = this.statement(`DELETE FROM sessions WHERE ${disposable}`).run(
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
    revision: String(row.revision ?? ""),
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
    name: String(row.name ?? ""),
    initialPrompt: String(row.initial_prompt),
    currentActivity: String(row.current_activity),
    lastText: String(row.last_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    agentSessionId: String(row.agent_session_id ?? ""),
    yolo: Number(row.yolo ?? 0) === 1,
    commands: parseJsonList(row.commands),
    configOptions: parseJsonList(row.config_options),
  });
}

/**
 * A stored JSON list, or an empty one.
 *
 * These columns hold what a node last reported, so anything unreadable is a
 * row written by a build that shaped them differently. An empty list renders as
 * "this agent offers no commands", which is the same thing a client sees before
 * the first report arrives — and far better than failing to parse the session.
 */
function parseJsonList(value: unknown): unknown[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
