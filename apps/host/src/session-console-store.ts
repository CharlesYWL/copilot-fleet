import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ConsoleGrantSchema,
  ConsoleOperationSchema,
  type ConsoleOperation,
  type ConsoleGrant,
  type FleetSession,
} from "@fleet/protocol";

function bindingKey(hostId: string, session: FleetSession): string {
  return JSON.stringify([
    hostId,
    session.nodeId,
    session.placementId,
    session.executionBinding?.worktreeId,
    session.executionBinding?.generation,
    session.executionBinding?.cwd,
  ]);
}

export class SessionConsoleStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_console_grants (
        session_id TEXT PRIMARY KEY, binding TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_console_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS session_console_local_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
  }

  grant(hostId: string, session: FleetSession, sequenceOffset: number): ConsoleGrant {
    const binding = bindingKey(hostId, session);
    const previous = this.db
      .prepare("SELECT binding,data FROM session_console_grants WHERE session_id=?")
      .get(session.id);
    const existing =
      previous?.binding === binding
        ? ConsoleGrantSchema.parse(JSON.parse(String(previous.data)))
        : undefined;
    const grant: ConsoleGrant = {
      hostId,
      session,
      sequenceOffset,
      grantId: existing?.grantId ?? randomUUID(),
      controlEpoch: existing?.controlEpoch ?? 0,
    };
    this.db
      .prepare(
        "INSERT INTO session_console_grants VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET binding=excluded.binding,data=excluded.data",
      )
      .run(session.id, binding, JSON.stringify(grant));
    return grant;
  }

  get(sessionId: string): ConsoleGrant | undefined {
    const row = this.db
      .prepare("SELECT data FROM session_console_grants WHERE session_id=?")
      .get(sessionId);
    return row ? ConsoleGrantSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  matches(grant: ConsoleGrant, session: FleetSession): boolean {
    const row = this.db
      .prepare("SELECT binding FROM session_console_grants WHERE session_id=?")
      .get(session.id);
    return row?.binding === bindingKey(grant.hostId, session);
  }

  epoch(sessionId: string, epoch: number): void {
    const grant = this.get(sessionId);
    if (!grant || epoch < grant.controlEpoch)
      throw new Error("Stale console control epoch");
    this.db
      .prepare("UPDATE session_console_grants SET data=? WHERE session_id=?")
      .run(JSON.stringify({ ...grant, controlEpoch: epoch }), sessionId);
  }

  accept(id: string, sessionId: string, payload: unknown): boolean {
    const digest = createHash("sha256")
      .update(JSON.stringify([sessionId, payload]))
      .digest("hex");
    const old = this.db
      .prepare("SELECT * FROM session_console_operations WHERE id=?")
      .get(id);
    if (old) {
      if (old.session_id !== sessionId || old.digest !== digest)
        throw new Error("Operation ID already identifies different input");
      if (old.state === "rejected") {
        this.db
          .prepare(
            "UPDATE session_console_operations SET state='accepted',error='' WHERE id=?",
          )
          .run(id);
        return true;
      }
      if (old.state !== "settled")
        throw new Error(
          String(old.error) ||
            "Operation delivery is uncertain; review the session before new input",
        );
      return false;
    }
    const count = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) count FROM session_console_operations WHERE session_id=?",
        )
        .get(sessionId)!.count,
    );
    if (count >= 10_000) throw new Error("Session console receipt storage is full");
    this.db
      .prepare(
        "INSERT INTO session_console_operations(id,session_id,digest,state) VALUES (?,?,?,'accepted')",
      )
      .run(id, sessionId, digest);
    return true;
  }

  settle(id: string, error = "", rejected = false): void {
    this.db
      .prepare("UPDATE session_console_operations SET state=?,error=? WHERE id=?")
      .run(error ? (rejected ? "rejected" : "uncertain") : "settled", error, id);
  }

  localOperation(operation: ConsoleOperation): void {
    const previousRow = this.db
      .prepare("SELECT data FROM session_console_local_operations WHERE id=?")
      .get(operation.id);
    if (previousRow) {
      const previous = ConsoleOperationSchema.parse(JSON.parse(String(previousRow.data)));
      if (
        previous.sessionId !== operation.sessionId ||
        previous.grantId !== operation.grantId ||
        previous.action !== operation.action ||
        previous.payloadDigest !== operation.payloadDigest
      )
        throw new Error("Local operation identity changed");
      if (
        previous.controlEpoch > operation.controlEpoch ||
        (["settled", "rejected"].includes(previous.state) &&
          !["settled", "rejected"].includes(operation.state))
      )
        return;
    } else if (
      Number(
        this.db
          .prepare(
            "SELECT COUNT(*) count FROM session_console_local_operations WHERE session_id=?",
          )
          .get(operation.sessionId)!.count,
      ) >= 10_000
    ) {
      throw new Error("Local operation receipt storage is full");
    }
    const stored = ["settled", "rejected"].includes(operation.state)
      ? { ...operation, payload: {} }
      : operation;
    this.db
      .prepare(
        "INSERT INTO session_console_local_operations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(operation.id, operation.sessionId, JSON.stringify(stored));
  }

  localOperations(sessionId: string): ConsoleOperation[] {
    return this.db
      .prepare("SELECT data FROM session_console_local_operations WHERE session_id=?")
      .all(sessionId)
      .map((row) => ConsoleOperationSchema.parse(JSON.parse(String(row.data))));
  }
}
