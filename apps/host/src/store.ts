import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { defaultSecureDataDeps, secureHostDataFiles } from "./data-permissions.js";
import {
  type FleetNode,
  type FleetSession,
  type HostBackup,
  type HostPortableBackupData,
  type Placement,
  type Run,
  type RunPolicy,
  type RunRole,
  type RunState,
  type RunStep,
  type RunNote,
  type RunCriterion,
  type RunStepState,
  type SecurityBackupPayload,
  type SessionEvent,
  type SessionState,
  type TunnelProvider,
  type Workspace,
  HOST_BACKUP_KIND,
  BACKUP_VERSION,
  CHATS_WORKSPACE_DESCRIPTION,
  CHATS_WORKSPACE_ID,
  CHATS_WORKSPACE_NAME,
  DEFAULT_TUNNEL_PROVIDER,
  MUTUAL_AUTH_PROTOCOL,
  HostBackupSchema,
  NodeSchema,
  PlacementSchema,
  RunPolicySchema,
  RunSchema,
  RunStepSchema,
  RunNoteSchema,
  SecurityBackupPayloadSchema,
  SessionEventSchema,
  SessionSchema,
  TunnelProviderSchema,
  WorkspaceSchema,
  eventPayload,
  canTransition,
  isChatsWorkspace,
  sessionFieldsForHostImport,
  terminalSessionStates,
  tryParseJson,
  tunnelProviders,
} from "@fleet/protocol";
import { LEAD_TOKEN_KEY_SETTING } from "./orchestrator/lead-tokens.js";

/**
 * A policy as it arrives from a request body.
 *
 * `Partial` is not enough under `exactOptionalPropertyTypes`: a parsed JSON
 * body has keys that are present and explicitly `undefined`, which that type
 * forbids.
 */
export type RunPolicyInput = { [K in keyof RunPolicy]?: RunPolicy[K] | undefined };

/**
 * A step as a caller describes it, before the store gives it an id and a state.
 */
export type RunStepInput = {
  stepKey: string;
  title: string;
  prompt: string;
  category?: string | undefined;
  dependsOn?: readonly string[] | undefined;
  position?: number | undefined;
  /**
   * Where this step should run, when the caller has already decided.
   *
   * The orchestrator tools resolve a checkout in order to answer the model with
   * a real path, so recording it here is what keeps that answer true — the
   * engine used to decide again from scratch and could pick somewhere else.
   */
  placementId?: string | undefined;
  /** The phase its task was in when this was dispatched. */
  phaseIndex?: number | undefined;
};

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

/**
 * A person, as Entra describes them.
 *
 * `tenantId` and `objectId` are the only two fields Fleet ever authorises on:
 * they are immutable and issued by the identity provider. The other two are
 * display metadata and are deliberately not part of any lookup.
 */
export type AdministratorIdentity = {
  tenantId: string;
  objectId: string;
  username: string;
  displayName: string;
};

export type Administrator = AdministratorIdentity & {
  id: string;
  addedVia: string;
  addedByAdminId: string;
  createdAt: string;
  lastLoginAt: string;
  disabledAt: string;
};

export type NewAdministrator = AdministratorIdentity & {
  addedVia: string;
  addedByAdminId?: string | undefined;
};

/** How a browser session was authenticated, which decides what it may do. */
export type OperatorAuthMethod =
  "password" | "recovery" | "microsoft-code" | "microsoft-device";

export type OperatorSessionRow = {
  tokenHash: string;
  administratorId: string;
  authMethod: OperatorAuthMethod;
  authenticatedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string;
};

export type NewOperatorSession = {
  tokenHash: string;
  administratorId: string;
  authMethod: OperatorAuthMethod;
  authenticatedAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type AdministratorInvitation = {
  id: string;
  createdByAdminId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string;
  candidateTenantId: string;
  candidateObjectId: string;
  candidateUsername: string;
  candidateDisplayName: string;
  decidedByAdminId: string;
  decidedAt: string;
  decision: string;
};

export type SecurityAuditInput = {
  eventType: string;
  actorKind: string;
  outcome: string;
  actorId?: string | undefined;
  targetId?: string | undefined;
  requestHost?: string | undefined;
  tunnelProvider?: string | undefined;
  detail?: string | undefined;
};

export type SecurityAuditRecord = {
  id: string;
  eventType: string;
  actorKind: string;
  actorId: string;
  targetId: string;
  requestHost: string;
  tunnelProvider: string;
  outcome: string;
  detail: string;
  createdAt: string;
};

/** What a revoked session was, so its live socket can be found and closed. */
export type RevokedSession = { tokenHash: string; administratorId: string };

/**
 * One authorisation for one machine to join the fleet.
 *
 * The row holds `SHA-256(secret)` and nothing else that could enrol anything:
 * the digest is what the completion's HMAC is keyed with, so the Host can check
 * a proof it could never have produced.
 */
export type EnrollmentGrantRow = {
  id: string;
  tokenHash: string;
  createdByAdminId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string;
  consumedByNodeId: string;
};

/** MVP administrators are peers, and twenty peers is already a large fleet. */
export const MAX_ADMINISTRATORS = 20;

/** The one setting that decides whether a legacy Node may still connect. */
export const MUTUAL_AUTH_REQUIRED_SETTING = "node.mutualAuthentication.required";

/** Newest-first retention for the local security log. */
export const MAX_SECURITY_AUDIT_ROWS = 10_000;

/**
 * A sanitised reason, never a request body or a provider's output.
 *
 * The audit is readable by every administrator, so anything copied into it is
 * effectively published to all of them; a cap is what keeps an attacker from
 * using the log as storage.
 */
export const MAX_AUDIT_DETAIL_LENGTH = 500;

/**
 * Settings a data restore must not touch.
 *
 * Everything here answers "who owns this Host", not "what is on it": erasing
 * any of them would either lock every administrator out or hand the Host back
 * to whoever reaches it first. The Host's own identity and the key its lead
 * tokens are signed with are here for the same reason from the other side —
 * they are what the fleet's machines and its running orchestrators recognise
 * this Host by, and a data restore is not a change of identity.
 */
export const PRESERVED_SETTING_KEYS = [
  "auth.mode",
  "auth.passwordEnabled",
  "auth.operatorPassword",
  "auth.passwordIsRecovery",
  "auth.entraTenantId",
  "auth.entraClientId",
  "auth.deviceFlowEnabled",
  "auth.csrfKey",
  "auth.sessionKey",
  "orchestrator.tokenKey",
  "host.identity.id",
  "host.identity.privateKey",
  "host.identity.publicKey",
  "host.identity.fingerprint",
  "node.mutualAuthentication.required",
] as const;

const terminalStateList = [...terminalSessionStates];
/** Terminal plus offline: settled enough that a cascade delete is safe. */
const settledStateList = [...terminalStateList, "offline"];

const placeholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(",");

/**
 * Refuses an edit aimed at the reserved Chats workspace.
 *
 * Its name, its description and the placements under it are all derived — the
 * name is what the UI pins, and each placement is a node's own home directory,
 * rewritten whenever that node reports one. An operator edit would either be
 * undone by the next heartbeat or leave a chat session pointing at a directory
 * nobody chose, so it is refused here, in the store, rather than only in the
 * route that happens to be the usual way in.
 *
 * `refusal` is the finished clause rather than a verb to conjugate. Deriving
 * the past tense by appending "d" read correctly for "rename" and "delete" and
 * produced "cannot be move a checkout out ofd" for everything else.
 */
function assertNotReserved(workspaceId: string, refusal: string): void {
  if (!isChatsWorkspace(workspaceId)) return;
  throw new Error(`Chats is built in and cannot be ${refusal}`);
}

/** What a placement edit is told, since three of them say the same thing. */
const NO_MANUAL_CHECKOUTS =
  "given checkouts by hand — every node gets one automatically, at its home directory";

/** How the Host locks its own data down, injectable so tests can watch it. */
export type SecureFiles = (databasePath: string) => void;

export class FleetStore {
  private readonly db: DatabaseSync; /**
   * Compiling the same SQL on every call showed up on the hot path: a node
   * heartbeat arrives every five seconds per node and each one re-prepared the
   * session query. Statements are cached by text and live as long as the
   * connection does.
   */
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string, options: { secureFiles?: SecureFiles } = {}) {
    /*
     * The default writes to stderr rather than to a logger, because the store
     * is constructed before anything that has one — and a Host that could not
     * protect its own database must not have that fact swallowed. The server
     * passes a logging one in.
     */
    const secure =
      options.secureFiles ??
      ((databasePath) =>
        secureHostDataFiles(
          databasePath,
          defaultSecureDataDeps((message) => process.stderr.write(`${message}\n`)),
        ));
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    /*
     * After the first pragma, not before: WAL mode is what creates the `-wal`
     * and `-shm` sidecars, and those carry the same rows the database does. A
     * Host that locked down only the main file would be leaving its private key
     * readable in a journal.
     */
    secure(path);
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
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL, objective TEXT NOT NULL, state TEXT NOT NULL,
        lead_session_id TEXT NOT NULL DEFAULT '',
        placement_id TEXT NOT NULL DEFAULT '',
        policy TEXT NOT NULL, failure_reason TEXT NOT NULL DEFAULT '',
        settle_seq INTEGER NOT NULL DEFAULT 0,
        wake_seq INTEGER NOT NULL DEFAULT 0,
        empty_wake_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        step_key TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '', depends_on TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
        placement_id TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '',
        event_seq_from INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        dispatched_at TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_key)
      );
      CREATE TABLE IF NOT EXISTS run_notes (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        phase_index INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_notes_run ON run_notes(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_steps_session ON run_steps(session_id);
      CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
      -- Who may drive this Host. Keyed by the two immutable Entra claims: an
      -- address is a display label that a tenant admin can hand to somebody
      -- else, and authorising one would hand them the fleet with it.
      CREATE TABLE IF NOT EXISTS administrators (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        added_by_admin_id TEXT NOT NULL DEFAULT '',
        added_via TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL DEFAULT '',
        disabled_at TEXT NOT NULL DEFAULT '',
        UNIQUE(tenant_id, object_id)
      );
      -- Only the digest, so a database read is not a set of live cookies.
      CREATE TABLE IF NOT EXISTS operator_sessions (
        token_hash TEXT PRIMARY KEY,
        administrator_id TEXT NOT NULL DEFAULT '',
        auth_method TEXT NOT NULL,
        authenticated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_operator_sessions_admin
        ON operator_sessions(administrator_id);
      CREATE TABLE IF NOT EXISTS administrator_invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_admin_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL DEFAULT '',
        candidate_tenant_id TEXT NOT NULL DEFAULT '',
        candidate_object_id TEXT NOT NULL DEFAULT '',
        candidate_username TEXT NOT NULL DEFAULT '',
        candidate_display_name TEXT NOT NULL DEFAULT '',
        decided_by_admin_id TEXT NOT NULL DEFAULT '',
        decided_at TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS security_audit (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        request_host TEXT NOT NULL DEFAULT '',
        tunnel_provider TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_security_audit_sequence
        ON security_audit(sequence);
      CREATE TABLE IF NOT EXISTS enrollment_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_admin_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL DEFAULT '',
        consumed_by_node_id TEXT NOT NULL DEFAULT ''
      );
    `);
    this.addColumnIfMissing("nodes", "home_dir", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("nodes", "revision", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("nodes", "public_key", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing(
      "nodes",
      "auth_protocol",
      "TEXT NOT NULL DEFAULT 'legacy-secret'",
    );
    this.addColumnIfMissing("sessions", "agent_session_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "yolo", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "commands", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "config_options", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("placements", "position", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("workspaces", "position", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "position", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "run_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "run_role", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("sessions", "read_only", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing(
      "sessions",
      "last_lead_prompt_at",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.addColumnIfMissing("runs", "phases", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("runs", "phase_index", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("runs", "pending_prompt", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("nodes", "agents", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("runs", "success_criteria", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("runs", "stop_when", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("run_steps", "phase_index", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("workspaces", "kind", "TEXT NOT NULL DEFAULT 'project'");
    this.ensureChatsWorkspace();
    this.rebuildSessionStateFromEvents();
  }

  /**
   * Seeds the reserved Chats workspace if it is not already there.
   *
   * Run on every open rather than as a one-time migration: the row also has to
   * exist on a database restored from a backup taken before Chats existed, and
   * an insert guarded by its own id makes "create it" and "leave it alone" the
   * same call. `createdAt` is therefore whenever this Host first opened the
   * file, which is as true a creation date as a reserved row can have.
   */
  private ensureChatsWorkspace(): void {
    if (this.getWorkspace(CHATS_WORKSPACE_ID)) return;
    this.transaction(() => this.seedChatsWorkspace());
  }

  /**
   * The body of {@link ensureChatsWorkspace}, without a transaction of its own.
   *
   * `transaction` issues a bare `BEGIN IMMEDIATE`, which SQLite refuses inside
   * another one — and restoring a backup has to seed this row within the same
   * transaction that deleted every workspace, or a failure part-way through
   * would leave a Host with no Chats workspace and no way back.
   */
  private seedChatsWorkspace(): void {
    if (this.getWorkspace(CHATS_WORKSPACE_ID)) return;
    this.freeChatsName();
    this.statement(
      `INSERT INTO workspaces (id,name,description,created_at,position,kind)
       VALUES (?,?,?,?,-1,'chats')`,
    ).run(
      CHATS_WORKSPACE_ID,
      CHATS_WORKSPACE_NAME,
      CHATS_WORKSPACE_DESCRIPTION,
      new Date().toISOString(),
    );
  }

  /**
   * Moves an operator's own workspace out of the reserved name, if one holds it.
   *
   * `name` is unique, so a project someone already called "Chats" would make
   * the seed fail — and an insert that fails quietly leaves a Host with no
   * Chats row at all, which nothing downstream is written to survive. The
   * reserved row takes the name and the project keeps everything else,
   * including its id, its placements and its history; only the label moves, and
   * it moves somewhere the operator can see and rename back.
   */
  private freeChatsName(): void {
    const clash = this.statement("SELECT id FROM workspaces WHERE name=? AND id<>?").get(
      CHATS_WORKSPACE_NAME,
      CHATS_WORKSPACE_ID,
    ) as Row | undefined;
    if (!clash) return;
    const taken = new Set(
      (this.statement("SELECT name FROM workspaces").all() as Row[]).map((row) =>
        String(row.name),
      ),
    );
    let suffix = 2;
    while (taken.has(`${CHATS_WORKSPACE_NAME} (${suffix})`)) suffix += 1;
    this.statement("UPDATE workspaces SET name=? WHERE id=?").run(
      `${CHATS_WORKSPACE_NAME} (${suffix})`,
      String(clash.id),
    );
  }

  /**
   * Re-derives each live session's pickers and slash menu from its event log.
   *
   * These two columns are a cache of the newest `config`/`commands` frame, and a
   * reader that could not parse one left the cache holding an older answer — or
   * no answer at all. That is not self-correcting: the pickers are how an
   * operator changes a picker, so a session that lost them has no control left
   * to press and no way back. The frames themselves were stored intact, so the
   * repair is a re-read rather than a guess, and a Host that now understands a
   * payload it previously rejected applies that understanding to what it
   * already has instead of only to what arrives next.
   *
   * Runs on open, against every session that is not terminal. `offline` is
   * included deliberately: it is the reconciliation state a disconnected
   * session waits in, so those are precisely the ones about to come back and be
   * rendered — skipping them would leave the repair for a session that never
   * gets a second chance at it.
   */
  private rebuildSessionStateFromEvents(): void {
    const sessions = this.db
      .prepare(
        `SELECT id FROM sessions WHERE state NOT IN (${placeholders(terminalStateList)})`,
      )
      .all(...(terminalStateList as never[])) as Row[];
    if (sessions.length === 0) return;
    const newest = this.db.prepare(
      `SELECT payload FROM events WHERE session_id=? AND type=?
       ORDER BY sequence DESC LIMIT 1`,
    );
    const update = this.db.prepare("UPDATE sessions SET commands=? WHERE id=?");
    const updateConfig = this.db.prepare(
      "UPDATE sessions SET config_options=? WHERE id=?",
    );
    this.transaction(() => {
      for (const row of sessions) {
        const id = String(row.id);
        const commands = this.newestPayloadList(newest, id, "commands");
        if (commands) update.run(JSON.stringify(commands), id);
        const options = this.newestPayloadList(newest, id, "config");
        if (options) updateConfig.run(JSON.stringify(options), id);
      }
    });
  }

  /** The list carried by a session's newest readable frame of `type`. */
  private newestPayloadList(
    statement: StatementSync,
    sessionId: string,
    type: "commands" | "config",
  ): unknown[] | undefined {
    const row = statement.get(sessionId, type) as Row | undefined;
    if (!row) return undefined;
    const parsed = SessionEventSchema.safeParse({
      eventId: "rebuild",
      sessionId,
      sequence: 1,
      type,
      payload: JSON.parse(String(row.payload)) as unknown,
      createdAt: new Date().toISOString(),
    });
    if (!parsed.success) return undefined;
    return type === "commands"
      ? eventPayload(parsed.data, "commands")?.commands
      : eventPayload(parsed.data, "config")?.options;
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

  /**
   * Which providers the operator has switched on.
   *
   * Stored per provider because they run concurrently. The legacy single-provider
   * keys are still read as a fallback so an existing install keeps whatever it
   * had running instead of coming back up with every tunnel off.
   */
  getEnabledTunnelProviders(): TunnelProvider[] {
    const explicit = tunnelProviders.filter(
      (provider) => this.getSetting(`tunnel.${provider}.enabled`) === "1",
    );
    if (explicit.length > 0) return [...explicit];
    return this.getTunnelEnabled() ? [this.getTunnelProvider()] : [];
  }

  setTunnelProviderEnabled(provider: TunnelProvider, enabled: boolean): void {
    this.setSetting(`tunnel.${provider}.enabled`, enabled ? "1" : "0");
    // Kept in step so a downgrade, a backup, or the legacy reader still sees a
    // coherent answer rather than a tunnel that claims to be off while running.
    const anyEnabled = tunnelProviders.some(
      (id) => this.getSetting(`tunnel.${id}.enabled`) === "1",
    );
    this.setTunnelEnabled(anyEnabled);
    if (enabled) this.setTunnelProvider(provider);
  }

  getTunnelProvider(): TunnelProvider {
    const stored = this.getSetting("tunnel.provider");
    const parsed = TunnelProviderSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_TUNNEL_PROVIDER;
  }

  /**
   * Preselected in the new-session dialog; each session stores its own copy.
   *
   * Off unless someone said otherwise. The opposite reading — anything but "0"
   * is on — made `--allow-all` the default on a database nobody had touched,
   * so a fresh Host ran agents with no human in the loop while the README said
   * permissions were explicit.
   */
  getDefaultYolo(): boolean {
    return this.getSetting("defaults.yolo") === "1";
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

  /**
   * The model and reasoning effort new sessions start on.
   *
   * Empty means "whatever Copilot picks", which is the honest default: the
   * fleet has no opinion until someone states one, and a hardcoded model name
   * would go stale the week after it was written.
   *
   * Stored as the raw values Copilot reports, because those are what have to go
   * back to it. The settings UI offers them from what sessions have actually
   * reported rather than from a list of our own.
   */
  getDefaultModel(): string {
    return this.getSetting("defaults.model") ?? "";
  }

  setDefaultModel(model: string): void {
    this.setSetting("defaults.model", model);
  }

  getDefaultReasoningEffort(): string {
    return this.getSetting("defaults.reasoningEffort") ?? "";
  }

  setDefaultReasoningEffort(effort: string): void {
    this.setSetting("defaults.reasoningEffort", effort);
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
      sessions: (
        this.sessionQuery("ORDER BY s.position,s.created_at DESC").all() as Row[]
      ).map((row) => ({
        ...sessionFromRow(row),
        position: Number(row.position ?? 0),
      })),
      events: (
        this.statement("SELECT * FROM events ORDER BY session_id,sequence").all() as Row[]
      ).map(eventFromRow),
      runs: (this.statement("SELECT * FROM runs ORDER BY created_at").all() as Row[]).map(
        runFromRow,
      ),
      runSteps: (
        this.statement(
          "SELECT * FROM run_steps ORDER BY run_id,position,created_at",
        ).all() as Row[]
      ).map(runStepFromRow),
      runNotes: (
        this.statement(
          "SELECT * FROM run_notes ORDER BY run_id,created_at",
        ).all() as Row[]
      ).map(runNoteFromRow),
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
    this.transaction(() => this.replaceHostBackupRows(parsed));
    // Placements went too, and the ones under Chats are derived rather than
    // archived: each node rebuilds its own on the reconnect that follows.
    for (const node of parsed.nodes) this.syncChatPlacement(node.id);
  }

  /**
   * The body of a data restore, without a transaction of its own.
   *
   * Separate so a portable restore can put the data and the security envelope
   * back in one commit: a Host left with somebody else's catalog and its own
   * administrators is not a state anybody asked for, and it is what a restore
   * that failed halfway would leave behind.
   */
  private replaceHostBackupRows(parsed: HostBackup): void {
    this.db.exec(
      "DELETE FROM run_notes; DELETE FROM run_steps; DELETE FROM runs; DELETE FROM events; DELETE FROM sessions; DELETE FROM placements; DELETE FROM workspaces; DELETE FROM nodes",
    );
    /*
     * Settings are replaced wholesale except the ones that decide who may
     * operate this Host. An archive predates the security envelope it is
     * being restored into, so clearing `auth.*` would delete the Entra
     * configuration and CSRF key out from under administrators the archive
     * does not even know about — leaving a claimed Host that nobody can sign
     * into. Restoring data must not silently unclaim a Host.
     */
    this.statement(
      `DELETE FROM settings WHERE key NOT IN (${placeholders(PRESERVED_SETTING_KEYS)})`,
    ).run(...(PRESERVED_SETTING_KEYS as unknown as string[]));
    this.setTunnelEnabled(parsed.tunnel.enabled);
    this.setTunnelProvider(parsed.tunnel.provider);
    this.setDefaultYolo(parsed.defaults.yolo);
    this.setAutoResume(parsed.defaults.autoResume);
    this.setSetting("enrollment.token", parsed.enrollmentToken);
    if (parsed.publicUrl) this.setSetting("host.publicUrl", parsed.publicUrl);
    for (const node of parsed.nodes) {
      this.statement(
        `INSERT INTO nodes
            (id,name,secret_hash,public_key,auth_protocol,os,arch,version,revision,
             capabilities,max_sessions,active_sessions,last_heartbeat,online,home_dir)
           VALUES (?,?,?,'',?,?,?,?,?,?,?,0,?,0,?)`,
      ).run(
        node.id,
        node.name,
        node.secretHash,
        // A version 1 archive predates Node keys, so every row it carries is a
        // shared-secret machine. A portable restore corrects this afterwards
        // from its security envelope, which is the only place a key can be.
        node.authProtocol,
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
        "INSERT INTO workspaces (id,name,description,created_at,position,kind) VALUES (?,?,?,?,?,?)",
      ).run(
        workspace.id,
        workspace.name,
        workspace.description,
        workspace.createdAt,
        workspace.position,
        workspace.kind,
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
             config_options,position,run_id,run_role)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        session.runId,
        session.runRole,
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
    for (const run of parsed.runs) {
      this.statement(
        `INSERT INTO runs
            (id,workspace_id,name,objective,state,lead_session_id,placement_id,policy,
             phases,phase_index,success_criteria,stop_when,
             failure_reason,settle_seq,wake_seq,empty_wake_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        run.id,
        run.workspaceId,
        run.name,
        run.objective,
        runStateForHostImport(run.state),
        run.leadSessionId,
        run.placementId,
        JSON.stringify(run.policy),
        // Everything that says what the task *is* travels with it. Dropped,
        // a restored task keeps its steps and forgets what they were for.
        JSON.stringify(run.phases),
        run.phaseIndex,
        JSON.stringify(run.successCriteria),
        run.stopWhen,
        run.failureReason,
        run.settleSeq,
        run.wakeSeq,
        run.emptyWakeCount,
        run.createdAt,
        run.updatedAt,
      );
    }
    for (const step of parsed.runSteps) {
      this.statement(
        `INSERT INTO run_steps
            (id,run_id,step_key,title,prompt,category,depends_on,state,session_id,
             placement_id,output,event_seq_from,attempts,phase_index,dispatched_at,position,
             created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        step.id,
        step.runId,
        step.stepKey,
        step.title,
        step.prompt,
        step.category,
        JSON.stringify(step.dependsOn),
        runStepStateForHostImport(step.state),
        step.sessionId,
        step.placementId,
        step.output,
        step.eventSeqFrom,
        step.attempts,
        step.phaseIndex,
        step.dispatchedAt,
        step.position,
        step.createdAt,
        step.updatedAt,
      );
    }
    // After the runs they reference, or the foreign key rejects them.
    for (const note of parsed.runNotes) {
      this.statement(
        "INSERT INTO run_notes (id,run_id,phase_index,body,created_at) VALUES (?,?,?,?,?)",
      ).run(note.id, note.runId, note.phaseIndex, note.body, note.createdAt);
    }
    // The restore deleted every workspace, and an archive taken before Chats
    // existed has no row to put back — so the Host would come up from a valid
    // backup with the one workspace nothing is written to work without.
    this.seedChatsWorkspace();
  }

  /**
   * The Host's authority, ready to be sealed and carried to another machine.
   *
   * Its contents are the answer to "who owns this Host and what does it prove
   * things with", which is why the caller encrypts it: administrators, the
   * Entra configuration, the CSRF and lead-token keys, the Host identity when
   * it has one, and the material Nodes authenticate against.
   *
   * Sessions, invitations and half-finished logins are deliberately absent.
   * They belong to the machine that issued them and mean nothing on another.
   */
  exportSecurityBackup(): SecurityBackupPayload {
    const setting = (key: string) => this.getSetting(key) ?? "";
    const csrfKey = setting("auth.csrfKey");
    const leadTokenKey = setting(LEAD_TOKEN_KEY_SETTING);
    if (!csrfKey || !leadTokenKey) {
      // Both are written on the first boot that needs them; a Host without
      // them has not finished starting, and an archive missing either would
      // restore a Host whose sessions and lead tokens cannot be verified.
      throw new Error("This Host has no security keys to export yet.");
    }
    const identity = {
      id: setting("host.identity.id"),
      privateKey: setting("host.identity.privateKey"),
      publicKey: setting("host.identity.publicKey"),
      fingerprint: setting("host.identity.fingerprint"),
    };
    const administrators = (
      this.statement(
        "SELECT * FROM administrators ORDER BY created_at, id",
      ).all() as Row[]
    ).map((row) => {
      const administrator = toAdministrator(row);
      return {
        id: administrator.id,
        tenantId: administrator.tenantId,
        objectId: administrator.objectId,
        username: administrator.username,
        displayName: administrator.displayName,
        addedVia: administrator.addedVia,
        addedByAdminId: administrator.addedByAdminId,
        createdAt: administrator.createdAt,
        lastLoginAt: administrator.lastLoginAt,
        disabledAt: administrator.disabledAt,
      };
    });
    const nodeAuth = (
      this.statement(
        "SELECT id, secret_hash, public_key, auth_protocol FROM nodes ORDER BY name",
      ).all() as Row[]
    ).map((row) => ({
      nodeId: String(row.id),
      // Named rather than inferred from which column is populated: a fleet
      // mid-migration has both kinds, and a machine that has upgraded still
      // has its old hash until enforcement deletes it.
      authProtocol: String(row.auth_protocol || "legacy-secret"),
      secretHash: String(row.secret_hash ?? ""),
      publicKey: String(row.public_key ?? ""),
    }));
    return SecurityBackupPayloadSchema.parse({
      version: 1,
      enrollmentToken: setting("enrollment.token"),
      auth: {
        mode: setting("auth.mode"),
        passwordEnabled: setting("auth.passwordEnabled") === "1",
        passwordVerifier: setting("auth.operatorPassword"),
        passwordIsRecovery: setting("auth.passwordIsRecovery") === "1",
        entraTenantId: setting("auth.entraTenantId"),
        entraClientId: setting("auth.entraClientId"),
        deviceFlowEnabled: setting("auth.deviceFlowEnabled") === "1",
        csrfKey,
      },
      // Enforcement is part of who may talk to this Host, so it travels with
      // the administrators rather than with the catalog.
      node: {
        mutualAuthenticationRequired: this.mutualNodeAuthenticationRequired(),
      },
      leadTokenKey,
      ...(identity.id || identity.privateKey || identity.publicKey
        ? { hostIdentity: identity }
        : {}),
      administrators,
      nodeAuth,
    });
  }

  /**
   * Becomes the Host the archive describes, data and authority together.
   *
   * One transaction, because the two halves are one decision: a machine that
   * took the catalog and kept its own administrators is a machine two people
   * think they own. Every browser session on the receiving Host is revoked and
   * returned to the caller, so the sockets they are holding can be closed —
   * the Host they signed into is not the Host they are now talking to.
   */
  importPortableBackup(input: {
    data: HostPortableBackupData;
    security: SecurityBackupPayload;
  }): { revokedSessions: RevokedSession[] } {
    const authByNode = new Map(
      input.security.nodeAuth.map((node) => [node.nodeId, node]),
    );
    if (
      authByNode.size !== input.data.nodes.length ||
      input.data.nodes.some((node) => !authByNode.has(node.id))
    ) {
      throw new Error("That backup's Node data does not match its security envelope.");
    }
    const data = HostBackupSchema.parse({
      ...input.data,
      enrollmentToken: input.security.enrollmentToken,
      nodes: input.data.nodes.map((node) => {
        const auth = authByNode.get(node.id);
        // A Node with neither proof cannot be restored: it would come back as a
        // row nothing can authenticate against, which is a machine the operator
        // has to re-enrol without being told why.
        if (!auth || (!auth.secretHash && !auth.publicKey)) {
          throw new Error(
            "That backup has no authentication record for one of its Nodes.",
          );
        }
        return { ...node, secretHash: auth.secretHash };
      }),
      kind: HOST_BACKUP_KIND,
      version: BACKUP_VERSION,
    });
    const security = SecurityBackupPayloadSchema.parse(input.security);
    if (security.administrators.every((row) => row.disabledAt !== "")) {
      // A restore that left nobody able to sign in would be a Host locked
      // against its own operator, recoverable only from the console.
      throw new Error("That backup contains no active administrator.");
    }
    const revokedSessions = this.transaction(() => {
      this.replaceHostBackupRows(data);
      return this.replaceSecurityRows(security);
    });
    for (const node of data.nodes) this.syncChatPlacement(node.id);
    return { revokedSessions };
  }

  /** The security half of a portable restore, inside the caller's transaction. */
  private replaceSecurityRows(security: SecurityBackupPayload): RevokedSession[] {
    const at = new Date().toISOString();
    const live = this.statement(
      "SELECT token_hash, administrator_id FROM operator_sessions WHERE revoked_at=''",
    ).all() as Row[];
    this.statement("UPDATE operator_sessions SET revoked_at=? WHERE revoked_at=''").run(
      at,
    );
    // Nothing half-finished travels or survives: an invitation issued here was
    // issued by the Host this one has just stopped being.
    this.statement("DELETE FROM administrator_invitations").run();
    /*
     * Disabled rather than deleted. `operator_sessions` points at these rows,
     * so deleting them would either break that reference or take with it the
     * revoked sessions the caller still has to close sockets for. Disabling
     * ends their authority just as completely.
     */
    this.statement("UPDATE administrators SET disabled_at=? WHERE disabled_at=''").run(
      at,
    );
    for (const administrator of security.administrators) {
      const existing = this.statement(
        "SELECT id FROM administrators WHERE tenant_id=? AND object_id=?",
      ).get(administrator.tenantId, administrator.objectId) as Row | undefined;
      if (existing) {
        // The same person, already known here under a local id that other
        // rows point at. Their identity is `(tid, oid)`, so that row is them.
        this.statement(
          `UPDATE administrators
             SET username=?, display_name=?, added_via=?, added_by_admin_id=?,
                 created_at=?, last_login_at=?, disabled_at=?
           WHERE id=?`,
        ).run(
          administrator.username,
          administrator.displayName,
          administrator.addedVia,
          administrator.addedByAdminId,
          administrator.createdAt,
          administrator.lastLoginAt,
          administrator.disabledAt,
          String(existing.id),
        );
        continue;
      }
      this.statement(
        `INSERT INTO administrators
           (id,tenant_id,object_id,username,display_name,added_by_admin_id,added_via,
            created_at,last_login_at,disabled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        administrator.id,
        administrator.tenantId,
        administrator.objectId,
        administrator.username,
        administrator.displayName,
        administrator.addedByAdminId,
        administrator.addedVia,
        administrator.createdAt,
        administrator.lastLoginAt,
        administrator.disabledAt,
      );
    }
    this.setSetting("auth.mode", security.auth.mode);
    this.setSetting("auth.passwordEnabled", security.auth.passwordEnabled ? "1" : "0");
    this.setSetting("auth.operatorPassword", security.auth.passwordVerifier);
    this.setSetting(
      "auth.passwordIsRecovery",
      security.auth.passwordIsRecovery ? "1" : "0",
    );
    this.setSetting("auth.entraTenantId", security.auth.entraTenantId);
    this.setSetting("auth.entraClientId", security.auth.entraClientId);
    this.setSetting(
      "auth.deviceFlowEnabled",
      security.auth.deviceFlowEnabled ? "1" : "0",
    );
    this.setSetting("auth.csrfKey", security.auth.csrfKey);
    this.setSetting(LEAD_TOKEN_KEY_SETTING, security.leadTokenKey);
    /*
     * Enforcement, and what it implies about the retired credential. A fleet
     * that had declared the shared Node secret over must not come back
     * accepting it, and the fleet-wide token that enforcement retired must not
     * be written back into the settings table as an authority nobody is
     * watching.
     */
    this.setMutualNodeAuthenticationRequired(security.node.mutualAuthenticationRequired);
    this.setSetting(
      "enrollment.token",
      security.node.mutualAuthenticationRequired ? "" : security.enrollmentToken,
    );
    if (security.hostIdentity) {
      this.setSetting("host.identity.id", security.hostIdentity.id);
      this.setSetting("host.identity.privateKey", security.hostIdentity.privateKey);
      this.setSetting("host.identity.publicKey", security.hostIdentity.publicKey);
      this.setSetting("host.identity.fingerprint", security.hostIdentity.fingerprint);
    }
    // Applied over the nodes the data half just restored, so a machine that
    // still has its `node.json` reconnects without being re-enrolled. Both
    // proofs travel: a fleet mid-migration has machines of each kind, and the
    // one this Host cannot restore is the one that comes back a stranger.
    for (const node of security.nodeAuth) {
      this.statement(
        "UPDATE nodes SET secret_hash=?, public_key=?, auth_protocol=? WHERE id=?",
      ).run(node.secretHash, node.publicKey, node.authProtocol, node.nodeId);
    }
    // A grant authorises one machine to join the Host that printed it. This is
    // no longer that Host.
    this.statement("DELETE FROM enrollment_grants").run();
    return live.map((row) => ({
      tokenHash: String(row.token_hash),
      administratorId: String(row.administrator_id),
    }));
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

  // ---------------------------------------------------------------------------
  // Security: who may drive this Host, and what they did.
  //
  // Kept together because every rule below is one transaction away from being
  // an authorisation bug: removing an administrator has to revoke their
  // sessions in the same commit, and claiming a Host has to see a count that
  // nobody else can change between the check and the insert.
  // ---------------------------------------------------------------------------

  countActiveAdministrators(): number {
    const row = this.statement(
      "SELECT COUNT(*) AS total FROM administrators WHERE disabled_at=''",
    ).get() as Row | undefined;
    return Number(row?.total ?? 0);
  }

  listAdministrators(): Administrator[] {
    const rows = this.statement(
      "SELECT * FROM administrators WHERE disabled_at='' ORDER BY created_at, id",
    ).all() as Row[];
    return rows.map((row) => toAdministrator(row));
  }

  getAdministrator(id: string): Administrator | undefined {
    const row = this.statement(
      "SELECT * FROM administrators WHERE id=? AND disabled_at=''",
    ).get(id) as Row | undefined;
    return row ? toAdministrator(row) : undefined;
  }

  /** The authorisation lookup, by the only two claims Fleet trusts. */
  findAdministrator(tenantId: string, objectId: string): Administrator | undefined {
    const row = this.statement(
      "SELECT * FROM administrators WHERE tenant_id=? AND object_id=? AND disabled_at=''",
    ).get(tenantId, objectId) as Row | undefined;
    return row ? toAdministrator(row) : undefined;
  }

  insertAdministrator(input: NewAdministrator): Administrator {
    return this.transaction(() => this.insertAdministratorRow(input));
  }

  /**
   * The first claim, as one indivisible decision.
   *
   * Two browsers can hold a valid identity at the same moment, and both can
   * observe an empty table before either writes. `BEGIN IMMEDIATE` takes the
   * write lock before the count is read, so the loser sees one administrator
   * rather than creating a second.
   */
  claimFirstAdministrator(identity: AdministratorIdentity): Administrator | undefined {
    return this.transaction(() => {
      if (this.countActiveAdministrators() > 0) return undefined;
      return this.insertAdministratorRow({ ...identity, addedVia: "claim" });
    });
  }

  disableAdministrator(id: string): boolean {
    return this.transaction(() => this.disableAdministratorRow(id) !== undefined);
  }

  /**
   * Removes an administrator and ends every session they hold, together.
   *
   * Separating the two would leave a window in which a removed administrator
   * still holds a working cookie, and the window would be however long the
   * second statement took to arrive — including forever, if it failed.
   */
  disableAdministratorAndRevoke(id: string): RevokedSession[] {
    return this.transaction(() => {
      if (this.disableAdministratorRow(id) === undefined) return [];
      return this.revokeSessionsForAdministratorRow(id);
    });
  }

  touchAdministratorLogin(id: string, at: string): void {
    this.statement("UPDATE administrators SET last_login_at=? WHERE id=?").run(at, id);
  }

  private insertAdministratorRow(input: NewAdministrator): Administrator {
    const existing = this.statement(
      "SELECT * FROM administrators WHERE tenant_id=? AND object_id=?",
    ).get(input.tenantId, input.objectId) as Row | undefined;
    if (existing && String(existing.disabled_at) === "") {
      this.statement(
        "UPDATE administrators SET username=?, display_name=? WHERE id=?",
      ).run(input.username, input.displayName, String(existing.id));
      return toAdministrator({
        ...existing,
        username: input.username,
        display_name: input.displayName,
      });
    }
    if (this.countActiveAdministrators() >= MAX_ADMINISTRATORS) {
      throw new Error(
        `This Host already has the maximum of ${MAX_ADMINISTRATORS} administrators`,
      );
    }
    const createdAt = new Date().toISOString();
    if (existing) {
      this.statement(
        `UPDATE administrators
         SET username=?, display_name=?, added_via=?, added_by_admin_id=?, disabled_at=''
         WHERE id=?`,
      ).run(
        input.username,
        input.displayName,
        input.addedVia,
        input.addedByAdminId ?? "",
        String(existing.id),
      );
      return toAdministrator({
        ...existing,
        username: input.username,
        display_name: input.displayName,
        added_via: input.addedVia,
        added_by_admin_id: input.addedByAdminId ?? "",
        disabled_at: "",
      });
    }
    const id = randomUUID();
    this.statement(
      `INSERT INTO administrators
         (id,tenant_id,object_id,username,display_name,added_by_admin_id,added_via,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.tenantId,
      input.objectId,
      input.username,
      input.displayName,
      input.addedByAdminId ?? "",
      input.addedVia,
      createdAt,
    );
    return {
      id,
      tenantId: input.tenantId,
      objectId: input.objectId,
      username: input.username,
      displayName: input.displayName,
      addedByAdminId: input.addedByAdminId ?? "",
      addedVia: input.addedVia,
      createdAt,
      lastLoginAt: "",
      disabledAt: "",
    };
  }

  /**
   * The body of a removal, without a transaction of its own.
   *
   * Returns nothing when the removal is refused, which is the case that matters:
   * the final active administrator cannot be removed, or the Host would be left
   * with no way in at all short of a local recovery command.
   */
  private disableAdministratorRow(id: string): Administrator | undefined {
    const row = this.statement(
      "SELECT * FROM administrators WHERE id=? AND disabled_at=''",
    ).get(id) as Row | undefined;
    if (!row) return undefined;
    if (this.countActiveAdministrators() <= 1) return undefined;
    const disabledAt = new Date().toISOString();
    this.statement("UPDATE administrators SET disabled_at=? WHERE id=?").run(
      disabledAt,
      id,
    );
    return toAdministrator({ ...row, disabled_at: disabledAt });
  }

  insertOperatorSession(input: NewOperatorSession): void {
    this.statement(
      `INSERT INTO operator_sessions
         (token_hash,administrator_id,auth_method,authenticated_at,last_seen_at,expires_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      input.tokenHash,
      input.administratorId,
      input.authMethod,
      input.authenticatedAt,
      input.lastSeenAt,
      input.expiresAt,
    );
  }

  getOperatorSession(tokenHash: string): OperatorSessionRow | undefined {
    const row = this.statement("SELECT * FROM operator_sessions WHERE token_hash=?").get(
      tokenHash,
    ) as Row | undefined;
    return row ? toOperatorSession(row) : undefined;
  }

  touchOperatorSession(tokenHash: string, lastSeenAt: string): void {
    this.statement("UPDATE operator_sessions SET last_seen_at=? WHERE token_hash=?").run(
      lastSeenAt,
      tokenHash,
    );
  }

  revokeOperatorSession(tokenHash: string): void {
    this.statement(
      "UPDATE operator_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at=''",
    ).run(new Date().toISOString(), tokenHash);
  }

  revokeSessionsForAdministrator(administratorId: string): RevokedSession[] {
    return this.transaction(() =>
      this.revokeSessionsForAdministratorRow(administratorId),
    );
  }

  /** Ends every session that was authenticated a particular way. */
  revokeSessionsByMethod(authMethod: OperatorAuthMethod): RevokedSession[] {
    return this.transaction(() => {
      const rows = this.statement(
        "SELECT token_hash, administrator_id FROM operator_sessions WHERE auth_method=? AND revoked_at=''",
      ).all(authMethod) as Row[];
      this.statement(
        "UPDATE operator_sessions SET revoked_at=? WHERE auth_method=? AND revoked_at=''",
      ).run(new Date().toISOString(), authMethod);
      return rows.map((row) => ({
        tokenHash: String(row.token_hash),
        administratorId: String(row.administrator_id),
      }));
    });
  }

  countOperatorSessions(): number {
    const row = this.statement(
      "SELECT COUNT(*) AS total FROM operator_sessions",
    ).get() as Row | undefined;
    return Number(row?.total ?? 0);
  }

  /** Drops rows that can no longer authenticate anything. */
  deleteExpiredOperatorSessions(nowIso: string): number {
    const rows = this.statement(
      "SELECT token_hash FROM operator_sessions WHERE expires_at<=? OR revoked_at<>''",
    ).all(nowIso) as Row[];
    if (rows.length === 0) return 0;
    this.statement(
      "DELETE FROM operator_sessions WHERE expires_at<=? OR revoked_at<>''",
    ).run(nowIso);
    return rows.length;
  }

  private revokeSessionsForAdministratorRow(administratorId: string): RevokedSession[] {
    const rows = this.statement(
      "SELECT token_hash FROM operator_sessions WHERE administrator_id=? AND revoked_at=''",
    ).all(administratorId) as Row[];
    this.statement(
      "UPDATE operator_sessions SET revoked_at=? WHERE administrator_id=? AND revoked_at=''",
    ).run(new Date().toISOString(), administratorId);
    return rows.map((row) => ({
      tokenHash: String(row.token_hash),
      administratorId,
    }));
  }

  createInvitation(input: {
    tokenHash: string;
    createdByAdminId: string;
    expiresAt: string;
  }): AdministratorInvitation {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.statement(
      `INSERT INTO administrator_invitations
         (id,token_hash,created_by_admin_id,created_at,expires_at)
       VALUES (?,?,?,?,?)`,
    ).run(id, input.tokenHash, input.createdByAdminId, createdAt, input.expiresAt);
    return {
      id,
      createdByAdminId: input.createdByAdminId,
      createdAt,
      expiresAt: input.expiresAt,
      consumedAt: "",
      candidateTenantId: "",
      candidateObjectId: "",
      candidateUsername: "",
      candidateDisplayName: "",
      decidedByAdminId: "",
      decidedAt: "",
      decision: "",
    };
  }

  /**
   * Redeems an invitation into a candidate, and only a candidate.
   *
   * A link that leaks is a link somebody else can open, so redemption records
   * who turned up and grants nothing. An existing administrator sees the exact
   * identity and decides.
   */
  consumeInvitation(
    tokenHash: string,
    identity: AdministratorIdentity,
  ): AdministratorInvitation | undefined {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const row = this.statement(
        `SELECT * FROM administrator_invitations
         WHERE token_hash=? AND consumed_at='' AND expires_at>?`,
      ).get(tokenHash, now) as Row | undefined;
      if (!row) return undefined;
      this.statement(
        `UPDATE administrator_invitations
         SET consumed_at=?, candidate_tenant_id=?, candidate_object_id=?,
             candidate_username=?, candidate_display_name=?
         WHERE id=?`,
      ).run(
        now,
        identity.tenantId,
        identity.objectId,
        identity.username,
        identity.displayName,
        String(row.id),
      );
      return toInvitation({
        ...row,
        consumed_at: now,
        candidate_tenant_id: identity.tenantId,
        candidate_object_id: identity.objectId,
        candidate_username: identity.username,
        candidate_display_name: identity.displayName,
      });
    });
  }

  getInvitation(id: string): AdministratorInvitation | undefined {
    const row = this.statement("SELECT * FROM administrator_invitations WHERE id=?").get(
      id,
    ) as Row | undefined;
    return row ? toInvitation(row) : undefined;
  }

  listInvitations(): AdministratorInvitation[] {
    const rows = this.statement(
      "SELECT * FROM administrator_invitations ORDER BY created_at DESC",
    ).all() as Row[];
    return rows.map((row) => toInvitation(row));
  }

  listPendingCandidates(): AdministratorInvitation[] {
    const rows = this.statement(
      `SELECT * FROM administrator_invitations
       WHERE consumed_at<>'' AND decision='' ORDER BY consumed_at`,
    ).all() as Row[];
    return rows.map((row) => toInvitation(row));
  }

  approveCandidate(
    invitationId: string,
    decidedByAdminId: string,
  ): Administrator | undefined {
    return this.transaction(() => {
      const row = this.decidePendingRow(invitationId, decidedByAdminId, "approved");
      if (!row) return undefined;
      return this.insertAdministratorRow({
        tenantId: String(row.candidate_tenant_id),
        objectId: String(row.candidate_object_id),
        username: String(row.candidate_username),
        displayName: String(row.candidate_display_name),
        addedVia: "invitation",
        addedByAdminId: decidedByAdminId,
      });
    });
  }

  rejectCandidate(invitationId: string, decidedByAdminId: string): boolean {
    return this.transaction(
      () =>
        this.decidePendingRow(invitationId, decidedByAdminId, "rejected") !== undefined,
    );
  }

  revokeInvitation(invitationId: string): boolean {
    const now = new Date().toISOString();
    const row = this.statement(
      "SELECT id FROM administrator_invitations WHERE id=? AND decision=''",
    ).get(invitationId) as Row | undefined;
    if (!row) return false;
    this.statement(
      `UPDATE administrator_invitations
       SET decision='revoked', decided_at=?, consumed_at=CASE consumed_at WHEN '' THEN ? ELSE consumed_at END
       WHERE id=?`,
    ).run(now, now, invitationId);
    return true;
  }

  private decidePendingRow(
    invitationId: string,
    decidedByAdminId: string,
    decision: "approved" | "rejected",
  ): Row | undefined {
    const row = this.statement(
      `SELECT * FROM administrator_invitations
       WHERE id=? AND consumed_at<>'' AND decision=''`,
    ).get(invitationId) as Row | undefined;
    if (!row) return undefined;
    this.statement(
      "UPDATE administrator_invitations SET decision=?, decided_by_admin_id=?, decided_at=? WHERE id=?",
    ).run(decision, decidedByAdminId, new Date().toISOString(), invitationId);
    return row;
  }

  /**
   * Appends one security event and trims the log in the same commit.
   *
   * Trimming separately would let a burst grow the table without bound between
   * the append and whatever was meant to prune it. `sequence` rather than
   * `created_at` because thousands of events can share a millisecond, and an
   * ambiguous order is an ambiguous retention rule.
   */
  recordSecurityAudit(entry: SecurityAuditInput): void {
    this.transaction(() => {
      const highest = this.statement(
        "SELECT COALESCE(MAX(sequence),0) AS top FROM security_audit",
      ).get() as Row | undefined;
      const sequence = Number(highest?.top ?? 0) + 1;
      this.statement(
        `INSERT INTO security_audit
           (id,event_type,actor_kind,actor_id,target_id,request_host,tunnel_provider,outcome,detail,created_at,sequence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        entry.eventType,
        entry.actorKind,
        entry.actorId ?? "",
        entry.targetId ?? "",
        entry.requestHost ?? "",
        entry.tunnelProvider ?? "",
        entry.outcome,
        (entry.detail ?? "").slice(0, MAX_AUDIT_DETAIL_LENGTH),
        new Date().toISOString(),
        sequence,
      );
      this.statement("DELETE FROM security_audit WHERE sequence<=?").run(
        sequence - MAX_SECURITY_AUDIT_ROWS,
      );
    });
  }

  listSecurityAudit(limit: number): SecurityAuditRecord[] {
    const rows = this.statement(
      "SELECT * FROM security_audit ORDER BY sequence DESC LIMIT ?",
    ).all(Math.max(1, Math.floor(limit))) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      eventType: String(row.event_type),
      actorKind: String(row.actor_kind),
      actorId: String(row.actor_id),
      targetId: String(row.target_id),
      requestHost: String(row.request_host),
      tunnelProvider: String(row.tunnel_provider),
      outcome: String(row.outcome),
      detail: String(row.detail),
      createdAt: String(row.created_at),
    }));
  }

  countSecurityAudit(): number {
    const row = this.statement("SELECT COUNT(*) AS total FROM security_audit").get() as
      Row | undefined;
    return Number(row?.total ?? 0);
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
      | "id"
      | "activeSessions"
      | "lastHeartbeat"
      | "online"
      | "homeDir"
      | "revision"
      | "authProtocol"
      // Omitted so the optional versions below actually take effect — an
      // intersection cannot loosen a property the Omit still requires.
      | "agents"
    > & { homeDir?: string; revision?: string; agents?: FleetNode["agents"] },
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
           agents=?, max_sessions=?, last_heartbeat=?, home_dir=? WHERE id=?`,
      ).run(
        hash(secret),
        input.os,
        input.arch,
        input.version,
        input.revision ?? "",
        JSON.stringify(input.capabilities),
        JSON.stringify(input.agents ?? []),
        input.maxSessions,
        now,
        input.homeDir ?? "",
        existing.id,
      );
      this.syncChatPlacement(existing.id);
      return { node: this.getNode(existing.id)!, secret };
    }

    const id = randomUUID();
    this.statement(
      `INSERT INTO nodes
        (id,name,secret_hash,os,arch,version,revision,capabilities,agents,max_sessions,last_heartbeat,online,home_dir)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    ).run(
      id,
      input.name,
      hash(secret),
      input.os,
      input.arch,
      input.version,
      input.revision ?? "",
      JSON.stringify(input.capabilities),
      JSON.stringify(input.agents ?? []),
      input.maxSessions,
      now,
      input.homeDir ?? "",
    );
    this.syncChatPlacement(id);
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
    // A machine that moved, was rebuilt, or only learned to report a home
    // directory in a later build corrects its Chats checkout here — the same
    // reconnect that corrects everything else it describes about itself.
    if (identity.homeDir) this.syncChatPlacement(id);
  }

  authenticateNode(id: string, secret: string): boolean {
    const row = this.statement("SELECT secret_hash FROM nodes WHERE id=?").get(id) as
      Row | undefined;
    if (!row) return false;
    const stored = String(row.secret_hash);
    // A key-based Node has no shared secret at all, and an empty stored hash
    // must never be something an empty presented one matches.
    if (!stored) return false;
    const supplied = Buffer.from(hash(secret));
    const expected = Buffer.from(stored);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  /**
   * Enrolls a Node against a public key instead of minting it a secret.
   *
   * The name is reclaimed exactly as token registration reclaims it, so a
   * rebuilt machine keeps its placements and its session history — but the row
   * it reclaims has its key replaced, because the machine that proved the grant
   * is the one that owns the row from here on.
   */
  registerNodeWithKey(
    input: Omit<
      FleetNode,
      | "id"
      | "activeSessions"
      | "lastHeartbeat"
      | "online"
      | "homeDir"
      | "revision"
      | "agents"
      | "authProtocol"
    > & {
      homeDir?: string;
      revision?: string;
      agents?: FleetNode["agents"];
      publicKey: string;
    },
  ): FleetNode {
    if (!input.publicKey) {
      throw new Error("A key-based Node registration needs a public key.");
    }
    const now = new Date().toISOString();
    const existing = this.statement("SELECT id FROM nodes WHERE name=?").get(
      input.name,
    ) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      this.statement(
        `UPDATE nodes SET secret_hash='', public_key=?, auth_protocol=?, os=?, arch=?,
           version=?, revision=?, capabilities=?, agents=?, max_sessions=?,
           last_heartbeat=?, home_dir=? WHERE id=?`,
      ).run(
        input.publicKey,
        MUTUAL_AUTH_PROTOCOL,
        input.os,
        input.arch,
        input.version,
        input.revision ?? "",
        JSON.stringify(input.capabilities),
        JSON.stringify(input.agents ?? []),
        input.maxSessions,
        now,
        input.homeDir ?? "",
        id,
      );
    } else {
      this.statement(
        `INSERT INTO nodes
          (id,name,secret_hash,public_key,auth_protocol,os,arch,version,revision,
           capabilities,agents,max_sessions,last_heartbeat,online,home_dir)
         VALUES (?,?,'',?,?,?,?,?,?,?,?,?,?,0,?)`,
      ).run(
        id,
        input.name,
        input.publicKey,
        MUTUAL_AUTH_PROTOCOL,
        input.os,
        input.arch,
        input.version,
        input.revision ?? "",
        JSON.stringify(input.capabilities),
        JSON.stringify(input.agents ?? []),
        input.maxSessions,
        now,
        input.homeDir ?? "",
      );
    }
    this.syncChatPlacement(id);
    return this.getNode(id)!;
  }

  /**
   * Deletes the shared secret of every Node that no longer needs one.
   *
   * The last step of the migration and the one that makes it irreversible.
   * While both proofs exist, anything that learned a secret can still use it,
   * and relaxing the enforcement switch brings that back; enforcement is the
   * operator saying that is over, so the weaker proof has to actually go.
   *
   * A Node that has not upgraded keeps the only credential it has: it is
   * refused at the gateway by the switch, which is a state an operator can
   * undo, rather than by having been made unauthenticatable, which is not.
   */
  clearLegacyNodeSecrets(): number {
    const { changes } = this.statement(
      "UPDATE nodes SET secret_hash='' WHERE auth_protocol=? AND secret_hash<>''",
    ).run(MUTUAL_AUTH_PROTOCOL);
    return Number(changes);
  }

  /** The one key a Node may prove itself with, or `""` for a legacy machine. */
  nodePublicKey(id: string): string {
    const row = this.statement("SELECT public_key FROM nodes WHERE id=?").get(id) as
      Row | undefined;
    return row ? String(row.public_key ?? "") : "";
  }

  /** How far the fleet is through the migration, for Settings and for the enforcement switch. */
  nodeAuthenticationSummary(): { total: number; mutualAuth: number; legacy: number } {
    const rows = this.statement("SELECT auth_protocol FROM nodes").all() as Row[];
    const mutualAuth = rows.filter(
      (row) => String(row.auth_protocol) === MUTUAL_AUTH_PROTOCOL,
    ).length;
    return { total: rows.length, mutualAuth, legacy: rows.length - mutualAuth };
  }

  /**
   * Whether the shared-secret protocol is still accepted.
   *
   * Off unless an operator has explicitly turned it on, and it must stay off
   * until every machine has upgraded: switching early does not make a fleet
   * safer, it makes the Nodes that have not been restarted yet unreachable —
   * and an operator who has locked half their fleet out turns it back off and
   * leaves it off.
   */
  mutualNodeAuthenticationRequired(): boolean {
    return this.getSetting(MUTUAL_AUTH_REQUIRED_SETTING) === "1";
  }

  setMutualNodeAuthenticationRequired(required: boolean): void {
    this.setSetting(MUTUAL_AUTH_REQUIRED_SETTING, required ? "1" : "0");
  }

  // -- enrollment grants -------------------------------------------------------

  createEnrollmentGrant(input: {
    tokenHash: string;
    createdByAdminId: string;
    createdAt: string;
    expiresAt: string;
  }): EnrollmentGrantRow {
    const id = randomUUID();
    this.statement(
      `INSERT INTO enrollment_grants (id,token_hash,created_by_admin_id,created_at,expires_at)
       VALUES (?,?,?,?,?)`,
    ).run(id, input.tokenHash, input.createdByAdminId, input.createdAt, input.expiresAt);
    return this.getEnrollmentGrant(id)!;
  }

  getEnrollmentGrant(id: string): EnrollmentGrantRow | undefined {
    const row = this.statement("SELECT * FROM enrollment_grants WHERE id=?").get(id) as
      Row | undefined;
    return row ? toEnrollmentGrant(row) : undefined;
  }

  /**
   * Spends a grant, or reports that somebody else already did.
   *
   * One statement with the unconsumed condition in its `WHERE`, so two Nodes
   * completing at once produce one enrolment rather than two rows sharing a
   * grant — which is the whole meaning of "single use".
   */
  consumeEnrollmentGrant(id: string, nodeId: string, at: string): boolean {
    const result = this.statement(
      `UPDATE enrollment_grants SET consumed_at=?, consumed_by_node_id=?
       WHERE id=? AND consumed_at=''`,
    ).run(at, nodeId, id);
    return Number(result.changes) === 1;
  }

  /** Clears every grant, for a restore that has made this a different Host. */
  deleteEnrollmentGrants(): void {
    this.statement("DELETE FROM enrollment_grants").run();
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
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      description,
      createdAt: new Date().toISOString(),
      kind: "project",
    };
    // New workspaces go to the end, so an order arranged by hand survives the
    // next project being added.
    const last = this.statement(
      "SELECT MAX(position) position FROM workspaces WHERE kind<>'chats'",
    ).get() as Row | undefined;
    this.statement(
      "INSERT INTO workspaces (id,name,description,created_at,position,kind) VALUES (?,?,?,?,?,'project')",
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
    assertNotReserved(id, "renamed");
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
    assertNotReserved(id, "deleted");
    this.assertNoLiveSessions("workspace_id", id, "workspace");
    this.transaction(() => {
      this.deleteSessionsWhere("workspace_id", id);
      this.statement("DELETE FROM placements WHERE workspace_id=?").run(id);
      this.statement("DELETE FROM workspaces WHERE id=?").run(id);
    });
  }

  listWorkspaces(): Workspace[] {
    return (
      this.statement(
        // Chats is pinned to the top, above whatever order the operator
        // arranged their projects into. It is the fleet's own row rather than
        // one of theirs, and letting it drift into the middle of the list — or
        // be dragged there — would suggest it can be organised like a project.
        `SELECT * FROM workspaces
         ORDER BY CASE WHEN kind='chats' THEN 0 ELSE 1 END, position, name`,
      ).all() as Row[]
    ).map(workspaceFromRow);
  }

  /** See {@link reorderPlacements}: the whole list travels, for the same reason. */
  reorderWorkspaces(orderedIds: readonly string[]): Workspace[] {
    // Chats is excluded rather than refused: it is pinned above the list by
    // {@link listWorkspaces} either way, and a browser that sends the rendered
    // order back is describing what it drew, not asking to move it.
    const own = (
      this.statement("SELECT id FROM workspaces WHERE kind<>'chats'").all() as Row[]
    ).map((row) => String(row.id));
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
    assertNotReserved(workspaceId, NO_MANUAL_CHECKOUTS);
    return this.insertPlacement(workspaceId, nodeId, localPath);
  }

  private insertPlacement(
    workspaceId: string,
    nodeId: string,
    localPath: string,
  ): Placement {
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
   * Points a node's Chats checkout at the home directory it just reported.
   *
   * Chat placements are derived, not filed: an operator never adds one, and the
   * path is whatever the machine says its home is. So this runs on every
   * registration and every reconnect, which is also what repairs a node that
   * moved, was rebuilt under a new user, or first reported a home directory
   * only after a Host upgrade taught it to.
   *
   * A node that does not know its home directory is skipped rather than given
   * an empty path: `localPath` is handed straight to the agent as a working
   * directory, and `""` would start a process wherever the Node happened to be.
   * It simply has no Chats row until it reports one.
   */
  syncChatPlacement(nodeId: string): Placement | undefined {
    const node = this.getNode(nodeId);
    if (!node?.homeDir) return undefined;
    const existing = this.statement(
      "SELECT id,local_path FROM placements WHERE workspace_id=? AND node_id=?",
    ).get(CHATS_WORKSPACE_ID, nodeId) as Row | undefined;
    if (!existing) return this.insertPlacement(CHATS_WORKSPACE_ID, nodeId, node.homeDir);
    if (String(existing.local_path) !== node.homeDir) {
      this.statement("UPDATE placements SET local_path=? WHERE id=?").run(
        node.homeDir,
        String(existing.id),
      );
    }
    return this.getPlacement(String(existing.id));
  }

  /** The Chats checkout for a node, if that node has reported a home directory. */
  chatPlacementFor(nodeId: string): Placement | undefined {
    const row = this.statement(
      "SELECT id FROM placements WHERE workspace_id=? AND node_id=?",
    ).get(CHATS_WORKSPACE_ID, nodeId) as Row | undefined;
    return row ? this.getPlacement(String(row.id)) : undefined;
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
    const existing = this.getPlacement(id);
    // Both directions: a chat checkout is the node's own home directory and is
    // not an operator's to repath or refile, and a project checkout moved into
    // Chats would be silently repathed to the home directory by the next
    // heartbeat — losing the checkout without ever saying so.
    if (existing) {
      assertNotReserved(existing.workspaceId, "repointed at another directory by hand");
    }
    if (workspaceId !== undefined) assertNotReserved(workspaceId, NO_MANUAL_CHECKOUTS);
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
    const existing = this.getPlacement(id);
    if (existing) {
      assertNotReserved(existing.workspaceId, "stripped of its checkouts by hand");
    }
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
        // Chats first, to match {@link listWorkspaces}: every list a browser
        // builds from these — the sidebar tree, the new-session picker — should
        // put the fleet's own row in the same place.
        `SELECT p.*,w.name workspace_name,n.name node_name FROM placements p
         JOIN workspaces w ON w.id=p.workspace_id JOIN nodes n ON n.id=p.node_id
         ORDER BY CASE WHEN w.kind='chats' THEN 0 ELSE 1 END,w.name,p.position,n.name`,
      ).all() as Row[]
    ).map(placementFromRow);
  }

  createSession(
    placement: Placement,
    prompt: string,
    yolo = false,
    name = "",
    run: { runId?: string; runRole?: RunRole; readOnly?: boolean } = {},
  ): FleetSession {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.statement(
      `INSERT INTO sessions
       (id,workspace_id,placement_id,node_id,state,initial_prompt,current_activity,last_text,created_at,updated_at,yolo,name,run_id,run_role,read_only)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      run.runId ?? "",
      run.runRole ?? "",
      run.readOnly ? 1 : 0,
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

  /** When the engine last sent this Lead any automated prompt. */
  lastOrchestratorPromptAt(id: string): string {
    const row = this.statement(
      "SELECT last_lead_prompt_at FROM sessions WHERE id=? AND run_role='lead'",
    ).get(id) as Row | undefined;
    return String(row?.last_lead_prompt_at ?? "");
  }

  /**
   * Records before sending, so a crash after dispatch cannot repeat the prompt
   * on every deadline sweep after restart.
   */
  recordOrchestratorPrompt(id: string, at = new Date().toISOString()): boolean {
    const result = this.statement(
      "UPDATE sessions SET last_lead_prompt_at=? WHERE id=? AND run_role='lead'",
    ).run(at, id);
    return Number(result.changes) > 0;
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

  /**
   * Creates a run in the one state it may start in.
   *
   * `awaiting_approval` is the entrance rather than a checkpoint: a human
   * authorises the objective and its budget once, and every later dispatch
   * spends that authorisation instead of asking again.
   */
  createRun(input: {
    workspaceId: string;
    name: string;
    objective: string;
    policy?: RunPolicyInput | undefined;
    /** The stages the orchestrator planned; empty for an unphased run. */
    phases?: readonly string[] | undefined;
    /** What has to be observably true before this task is finished. */
    successCriteria?: readonly RunCriterion[] | undefined;
    /** One line naming the observable state that ends the task. */
    stopWhen?: string | undefined;
  }): Run {
    const now = new Date().toISOString();
    const id = randomUUID();
    const policy = RunPolicySchema.parse(input.policy ?? {});
    this.statement(
      `INSERT INTO runs
       (id,workspace_id,name,objective,state,policy,phases,success_criteria,stop_when,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.workspaceId,
      input.name,
      input.objective,
      "awaiting_approval",
      JSON.stringify(policy),
      JSON.stringify(input.phases ?? []),
      JSON.stringify(input.successCriteria ?? []),
      input.stopWhen ?? "",
      now,
      now,
    );
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const row = this.statement("SELECT * FROM runs WHERE id=?").get(id) as
      Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  listRuns(): Run[] {
    return (
      this.statement("SELECT * FROM runs ORDER BY created_at DESC").all() as Row[]
    ).map(runFromRow);
  }

  /** Patches a run. Callers check {@link canTransitionRun} before moving state. */
  updateRun(
    id: string,
    patch: Partial<
      Pick<
        Run,
        | "state"
        | "leadSessionId"
        | "placementId"
        | "failureReason"
        | "emptyWakeCount"
        | "name"
        | "phaseIndex"
        | "pendingPrompt"
        | "stopWhen"
      >
    > & {
      phases?: readonly string[] | undefined;
      successCriteria?: readonly RunCriterion[] | undefined;
    },
  ): Run | undefined {
    if (!this.getRun(id)) return undefined;
    const columns: Record<string, unknown> = {
      state: patch.state,
      lead_session_id: patch.leadSessionId,
      placement_id: patch.placementId,
      failure_reason: patch.failureReason,
      empty_wake_count: patch.emptyWakeCount,
      name: patch.name,
      phase_index: patch.phaseIndex,
      pending_prompt: patch.pendingPrompt,
      stop_when: patch.stopWhen,
      phases: patch.phases === undefined ? undefined : JSON.stringify(patch.phases),
      success_criteria:
        patch.successCriteria === undefined
          ? undefined
          : JSON.stringify(patch.successCriteria),
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.getRun(id);
    const assignments = entries.map(([column]) => `${column}=?`).join(",");
    this.statement(`UPDATE runs SET ${assignments},updated_at=? WHERE id=?`).run(
      ...entries.map(([, value]) => value as string | number),
      new Date().toISOString(),
      id,
    );
    return this.getRun(id);
  }

  setRunState(id: string, state: RunState, failureReason = ""): Run | undefined {
    return this.updateRun(id, { state, ...(failureReason ? { failureReason } : {}) });
  }

  /**
   * Advances the settle counter.
   *
   * Counters rather than timestamps because "wake the Lead exactly once per
   * settle" is decided by comparing these two numbers, and a wall clock loses
   * that comparison to same-millisecond settles and to restarts.
   */
  recordRunSettle(id: string): Run | undefined {
    if (!this.getRun(id)) return undefined;
    this.statement("UPDATE runs SET settle_seq=settle_seq+1,updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      id,
    );
    return this.getRun(id);
  }

  /** Catches the wake counter up to the settle counter; see {@link recordRunSettle}. */
  recordRunWake(id: string): Run | undefined {
    if (!this.getRun(id)) return undefined;
    this.statement("UPDATE runs SET wake_seq=settle_seq,updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      id,
    );
    return this.getRun(id);
  }

  /**
   * Writes a step, or takes another run at one that already exists.
   *
   * The step key is the Lead's name for a unit of work, so reusing it is how a
   * retry says "this is that step again": the row is reused and `attempts`
   * moves, rather than the run growing a second step that means the same thing.
   */
  upsertRunStep(runId: string, input: RunStepInput): RunStep {
    const now = new Date().toISOString();
    const existing = this.statement(
      "SELECT * FROM run_steps WHERE run_id=? AND step_key=?",
    ).get(runId, input.stepKey) as Row | undefined;

    if (existing) {
      this.statement(
        `UPDATE run_steps
         SET title=?,prompt=?,category=?,depends_on=?,state='pending',
             attempts=attempts+1,session_id='',placement_id=?,output='',
             dispatched_at='',phase_index=?,updated_at=?
         WHERE id=?`,
      ).run(
        input.title,
        input.prompt,
        input.category ?? String(existing.category ?? ""),
        JSON.stringify(input.dependsOn ?? parseJsonList(existing.depends_on)),
        input.placementId ?? "",
        input.phaseIndex ?? Number(existing.phase_index ?? 0),
        now,
        String(existing.id),
      );
      return this.getRunStep(String(existing.id))!;
    }

    const id = randomUUID();
    this.statement(
      `INSERT INTO run_steps
       (id,run_id,step_key,title,prompt,category,depends_on,state,attempts,position,placement_id,phase_index,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      runId,
      input.stepKey,
      input.title,
      input.prompt,
      input.category ?? "",
      JSON.stringify(input.dependsOn ?? []),
      "pending",
      1,
      input.position ?? this.listRunSteps(runId).length,
      input.placementId ?? "",
      input.phaseIndex ?? 0,
      now,
      now,
    );
    return this.getRunStep(id)!;
  }

  /**
   * Retries one step in the Copilot session that already knows the work.
   *
   * `upsertRunStep` deliberately clears the old session association. A follow-up
   * has to restore it in the same transaction, or a Host crash between the two
   * writes turns "reuse this worker" into an ordinary pending step that starts a
   * different session after restart.
   */
  retryRunStepInSession(
    runId: string,
    input: RunStepInput,
    sessionId: string,
    eventSeqFrom: number,
  ): RunStep {
    return this.transaction(() => {
      const retried = this.upsertRunStep(runId, input);
      return this.updateRunStep(retried.id, {
        sessionId,
        placementId: input.placementId ?? "",
        eventSeqFrom,
      })!;
    });
  }

  getRunStep(id: string): RunStep | undefined {
    const row = this.statement("SELECT * FROM run_steps WHERE id=?").get(id) as
      Row | undefined;
    return row ? runStepFromRow(row) : undefined;
  }

  listRunSteps(runId: string): RunStep[] {
    return (
      this.statement(
        "SELECT * FROM run_steps WHERE run_id=? ORDER BY position,created_at",
      ).all(runId) as Row[]
    ).map(runStepFromRow);
  }

  /** The step a session is doing the work for, if it belongs to a run at all. */
  getRunStepBySession(sessionId: string): RunStep | undefined {
    if (!sessionId) return undefined;
    const row = this.statement("SELECT * FROM run_steps WHERE session_id=?").get(
      sessionId,
    ) as Row | undefined;
    return row ? runStepFromRow(row) : undefined;
  }

  /**
   * Records what a phase established, in the orchestrator's own words.
   *
   * Append-only, and written as a phase ends rather than assembled at the end.
   * The person reviewing a finished task sees a short account of how it got
   * there; reconstructing that from a dozen worker transcripts is the thing
   * this exists to save them.
   */
  appendRunNote(runId: string, phaseIndex: number, body: string): RunNote {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.statement(
      "INSERT INTO run_notes (id,run_id,phase_index,body,created_at) VALUES (?,?,?,?,?)",
    ).run(id, runId, phaseIndex, body, createdAt);
    return { id, runId, phaseIndex, body, createdAt };
  }

  listRunNotes(runId: string): RunNote[] {
    return (
      this.statement("SELECT * FROM run_notes WHERE run_id=? ORDER BY created_at").all(
        runId,
      ) as Row[]
    ).map(runNoteFromRow);
  }

  updateRunStep(
    id: string,
    patch: Partial<
      Pick<
        RunStep,
        "state" | "sessionId" | "placementId" | "output" | "eventSeqFrom" | "dispatchedAt"
      >
    >,
  ): RunStep | undefined {
    if (!this.getRunStep(id)) return undefined;
    const columns: Record<string, unknown> = {
      state: patch.state,
      session_id: patch.sessionId,
      placement_id: patch.placementId,
      output: patch.output,
      event_seq_from: patch.eventSeqFrom,
      dispatched_at: patch.dispatchedAt,
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.getRunStep(id);
    const assignments = entries.map(([column]) => `${column}=?`).join(",");
    this.statement(`UPDATE run_steps SET ${assignments},updated_at=? WHERE id=?`).run(
      ...entries.map(([, value]) => value as string | number),
      new Date().toISOString(),
      id,
    );
    return this.getRunStep(id);
  }

  /** Replaces a run's whole plan. Used by the handwritten-DAG fixture. */
  replaceRunSteps(runId: string, steps: readonly RunStepInput[]): RunStep[] {
    return this.transaction(() => {
      this.statement("DELETE FROM run_steps WHERE run_id=?").run(runId);
      steps.forEach((step, index) => {
        this.upsertRunStep(runId, { ...step, position: index });
      });
      return this.listRunSteps(runId);
    });
  }

  /** Deletes a run, its steps, and its notes. Callers stop live sessions first. */
  deleteRun(id: string): boolean {
    return this.transaction(() => {
      if (!this.getRun(id)) return false;
      // Notes reference the run, so they have to go first or the foreign key
      // rejects the delete and takes the whole transaction with it.
      this.statement("DELETE FROM run_notes WHERE run_id=?").run(id);
      this.statement("DELETE FROM run_steps WHERE run_id=?").run(id);
      this.statement("DELETE FROM runs WHERE id=?").run(id);
      return true;
    });
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
   * that destroyed the transcripts the operator had just come back for.
   * Orchestrator conversations are also excluded: Stop deliberately parks them
   * for Resume or an explicit Dismiss. Those rows can still be removed one at a
   * time with {@link deleteSession}.
   *
   * Returns how many went.
   */
  deleteEndedSessions(): number {
    const list = placeholders(terminalStateList);
    const disposable = `state IN (${list}) AND agent_session_id = '' AND run_role <> 'lead'`;
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
    agents: parseJsonList(row.agents),
    maxSessions: Number(row.max_sessions),
    activeSessions: Number(row.active_sessions),
    lastHeartbeat: String(row.last_heartbeat),
    online: Boolean(row.online),
    homeDir: String(row.home_dir ?? ""),
    authProtocol: String(row.auth_protocol || "legacy-secret"),
  });
}

function workspaceFromRow(row: Row): Workspace {
  return WorkspaceSchema.parse({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    createdAt: String(row.created_at),
    kind: String(row.kind ?? "project"),
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
    runId: String(row.run_id ?? ""),
    runRole: String(row.run_role ?? ""),
    readOnly: Boolean(row.read_only),
  });
}

function runFromRow(row: Row): Run {
  // `tryParseJson` answers with a result envelope, not the value: reading it as
  // the value silently produced `{ok,value}`, which parses to a policy of pure
  // defaults — so an orchestrator's `on_any_settle` came back as `none` and its
  // run finished instead of waking it.
  const stored = tryParseJson(String(row.policy ?? ""));
  return RunSchema.parse({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    objective: String(row.objective),
    state: String(row.state),
    leadSessionId: String(row.lead_session_id ?? ""),
    placementId: String(row.placement_id ?? ""),
    // A policy that will not parse is a row from a build that shaped it
    // differently; defaults are a working run, a throw is a lost one.
    policy: stored.ok ? stored.value : {},
    phases: parseJsonList(row.phases),
    successCriteria: parseJsonList(row.success_criteria),
    stopWhen: String(row.stop_when ?? ""),
    phaseIndex: Number(row.phase_index ?? 0),
    failureReason: String(row.failure_reason ?? ""),
    pendingPrompt: String(row.pending_prompt ?? ""),
    settleSeq: Number(row.settle_seq ?? 0),
    wakeSeq: Number(row.wake_seq ?? 0),
    emptyWakeCount: Number(row.empty_wake_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function runStepFromRow(row: Row): RunStep {
  return RunStepSchema.parse({
    id: String(row.id),
    runId: String(row.run_id),
    stepKey: String(row.step_key),
    title: String(row.title),
    prompt: String(row.prompt),
    category: String(row.category ?? ""),
    dependsOn: parseJsonList(row.depends_on),
    state: String(row.state),
    sessionId: String(row.session_id ?? ""),
    placementId: String(row.placement_id ?? ""),
    output: String(row.output ?? ""),
    eventSeqFrom: Number(row.event_seq_from ?? 0),
    attempts: Number(row.attempts ?? 0),
    phaseIndex: Number(row.phase_index ?? 0),
    dispatchedAt: String(row.dispatched_at ?? ""),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function runNoteFromRow(row: Row): RunNote {
  return RunNoteSchema.parse({
    id: String(row.id),
    runId: String(row.run_id),
    phaseIndex: Number(row.phase_index ?? 0),
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
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

/**
 * Where an imported run has to land.
 *
 * Sessions come back `offline` on import, so a run restored as `running` would
 * be waiting on a settle that nothing alive can produce — and with no connected
 * node, nothing will ever tick it either. `awaiting_lead` is the same landing
 * the engine uses whenever it has stopped advancing on its own, so the run
 * shows up asking for a human instead of pretending to work.
 */
function runStateForHostImport(state: RunState): RunState {
  if (state === "running" || state === "awaiting_lead" || state === "planning") {
    return "awaiting_lead";
  }
  if (state === "aggregating") return "awaiting_lead";
  return state;
}

/** A step that was mid-flight when the archive was written did not survive it. */
function runStepStateForHostImport(state: RunStepState): RunStepState {
  return state === "starting" || state === "running" ? "failed" : state;
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

function toAdministrator(row: Row): Administrator {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    objectId: String(row.object_id),
    username: String(row.username),
    displayName: String(row.display_name),
    addedByAdminId: String(row.added_by_admin_id),
    addedVia: String(row.added_via),
    createdAt: String(row.created_at),
    lastLoginAt: String(row.last_login_at),
    disabledAt: String(row.disabled_at),
  };
}

/**
 * `auth_method` is read back as written rather than re-parsed.
 *
 * Every value in the column came from {@link NewOperatorSession}, and a session
 * whose method could not be recognised must not be silently downgraded to one
 * that can — the callers treat `microsoft-code` as the strongest proof there is.
 */
function toOperatorSession(row: Row): OperatorSessionRow {
  return {
    tokenHash: String(row.token_hash),
    administratorId: String(row.administrator_id),
    authMethod: String(row.auth_method) as OperatorAuthMethod,
    authenticatedAt: String(row.authenticated_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    revokedAt: String(row.revoked_at),
  };
}

function toInvitation(row: Row): AdministratorInvitation {
  return {
    id: String(row.id),
    createdByAdminId: String(row.created_by_admin_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    consumedAt: String(row.consumed_at),
    candidateTenantId: String(row.candidate_tenant_id),
    candidateObjectId: String(row.candidate_object_id),
    candidateUsername: String(row.candidate_username),
    candidateDisplayName: String(row.candidate_display_name),
    decidedByAdminId: String(row.decided_by_admin_id),
    decidedAt: String(row.decided_at),
    decision: String(row.decision),
  };
}

function toEnrollmentGrant(row: Row): EnrollmentGrantRow {
  return {
    id: String(row.id),
    tokenHash: String(row.token_hash),
    createdByAdminId: String(row.created_by_admin_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    consumedAt: String(row.consumed_at),
    consumedByNodeId: String(row.consumed_by_node_id),
  };
}
