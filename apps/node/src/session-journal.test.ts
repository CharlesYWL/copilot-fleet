import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionPermissions,
  SessionSchema,
  TRANSCRIPT_PAGE_MAX,
  TranscriptProjector,
  type FleetSession,
  type SessionEvent,
} from "@fleet/protocol";
import {
  ReplayBudgetError,
  SessionJournal,
  type SessionJournalOptions,
} from "./session-journal.js";

const directories: string[] = [];
const journals = new Set<SessionJournal>();
const timestamp = "2026-10-09T12:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
  for (const journal of journals) {
    try {
      journal.close();
    } catch {
      // Failure tests explicitly assert close's error before fixture cleanup.
    }
  }
  journals.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function session(id = "worker", overrides: Partial<FleetSession> = {}): FleetSession {
  return SessionSchema.parse({
    id,
    workspaceId: "workspace",
    workspaceName: "Actual workspace catalog name",
    placementId: "placement",
    nodeId: "node",
    nodeName: "Actual node catalog name",
    state: "idle",
    initialPrompt: "Work on the task",
    currentActivity: "Ready",
    lastText: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    agentSessionId: "native-session",
    runId: "run",
    runRole: "worker",
    ...overrides,
  });
}

function event(
  sequence = 1,
  type: SessionEvent["type"] = "agent_text",
  payload: SessionEvent["payload"] = { text: "chunk" },
  sessionId = "worker",
): SessionEvent {
  return {
    eventId: randomUUID(),
    sessionId,
    sequence,
    type,
    payload,
    createdAt: timestamp,
  };
}

function fixture(options: SessionJournalOptions = {}) {
  const directory = resolve(`.session-journal-test-${randomUUID()}`);
  directories.push(directory);
  const journal = open(directory, options);
  return { directory, journal };
}

function open(directory: string, options: SessionJournalOptions = {}): SessionJournal {
  const journal = new SessionJournal(directory, { secure: false, ...options });
  journals.add(journal);
  return journal;
}

function enable(journal: SessionJournal, id = "worker", hostId = "host") {
  journal.enable({ hostId, grantId: `grant-${id}`, session: session(id) });
}

function database(journal: SessionJournal): DatabaseSync {
  return (journal as unknown as { db: DatabaseSync }).db;
}

function operation(id = randomUUID(), sessionId = "worker") {
  return { id, sessionId, action: "prompt" as const, payload: { prompt: "Continue" } };
}

describe("durable Node session journal", () => {
  it("migrates an existing rollback journal without losing pending history or uncertainty", () => {
    const { directory, journal } = fixture();
    enable(journal);
    const saved = journal.append(event());
    journal.flush();
    const accepted = operation();
    journal.acceptOperation(accepted);
    journal.close();
    const previous = new DatabaseSync(join(directory, "sessions.db"));
    previous.exec("PRAGMA journal_mode=DELETE");
    previous.close();
    const reopened = open(directory);
    expect(database(reopened).prepare("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );
    expect(reopened.events("worker", 0)).toEqual([saved]);
    expect(reopened.get("worker")!.acknowledgedSequence).toBe(0);
    expect(reopened.operations("worker")[0]).toMatchObject({
      id: accepted.id,
      state: "uncertain",
    });
    expect(reopened.acceptOperation(accepted).invoke).toBe(false);
  });
  it("keeps FULL durability in WAL mode and checkpoints deleted history", () => {
    const { directory, journal } = fixture();
    expect(database(journal).prepare("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );
    expect(
      Number(database(journal).prepare("PRAGMA synchronous").get()!.synchronous),
    ).toBe(2);
    enable(journal);
    journal.append(event(1, "agent_text", { text: "Sensitive temporary transcript" }));
    journal.flush();
    journal.acknowledge("worker", 1);
    journal.retire("worker");
    const wal = join(directory, "sessions.db-wal");
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  });

  it("coalesces cumulative ACKs atomically without accepting uncommitted evidence", () => {
    const { journal } = fixture();
    enable(journal, "first");
    enable(journal, "second");
    journal.append(event(1, "agent_text", { text: "one" }, "first"));
    journal.append(event(1, "agent_text", { text: "two" }, "second"));
    journal.flush();
    expect(() =>
      journal.acknowledgeBatch([
        { sessionId: "first", sequence: 1, controlEpoch: 0 },
        { sessionId: "second", sequence: 2, controlEpoch: 0 },
      ]),
    ).toThrow("committed");
    expect(journal.get("first")!.acknowledgedSequence).toBe(0);
    const exec = vi.spyOn(database(journal), "exec");
    journal.acknowledgeBatch([
      { sessionId: "first", sequence: 1, controlEpoch: 0 },
      { sessionId: "second", sequence: 1, controlEpoch: 0 },
      { sessionId: "first", sequence: 0, controlEpoch: 0 },
    ]);
    expect(exec.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(journal.get("first")!.acknowledgedSequence).toBe(1);
    expect(journal.get("second")!.acknowledgedSequence).toBe(1);
    exec.mockRestore();
  });
  it("journals only explicitly enabled, non-lead sessions and retains full metadata", () => {
    const { journal, directory } = fixture();
    expect(journal.has("worker")).toBe(false);
    expect(() => journal.append(event())).toThrow("not enabled");
    expect(() =>
      journal.enable({
        hostId: "host",
        grantId: "grant",
        session: session("lead", { runRole: "lead" }),
      }),
    ).toThrow("non-lead");
    const full = session("worker", {
      name: "An actual session label",
      yolo: true,
      favorite: true,
      additionalDirectories: ["Q:\\other-workspace"],
      stopRequested: true,
      operatorUsername: "operator",
      readOnly: true,
      usage: { aiCredits: 4 },
    });
    journal.enable({ hostId: "host", grantId: "grant", session: full, controlEpoch: 8 });
    expect(journal.get("worker")).toEqual({
      hostId: "host",
      grantId: "grant",
      session: full,
      controlEpoch: 8,
      acknowledgedControlEpoch: 0,
      acknowledgedSequence: 0,
      highWater: 0,
    });
    journal.close();
    expect(open(directory).get("worker")?.session).toEqual(full);
  });

  it("seeds a new grant from Host's sequence offset without resetting an existing journal", () => {
    const { journal, directory } = fixture();
    const input = {
      hostId: "host",
      grantId: "grant",
      session: session(),
      sequenceOffset: 100,
    };
    journal.enable(input);
    expect(journal.highWater("worker")).toBe(100);
    expect(journal.get("worker")?.acknowledgedSequence).toBe(100);
    expect(journal.append(event(1)).sequence).toBe(101);
    journal.flush();
    journal.enable({ ...input, sequenceOffset: 900, controlEpoch: 5 });
    expect(journal.get("worker")).toMatchObject({
      highWater: 101,
      acknowledgedSequence: 100,
      controlEpoch: 5,
    });
    journal.close();
    const reopened = open(directory);
    expect(reopened.append(event(301)).sequence).toBe(301);
    reopened.flush();
    expect(reopened.highWater("worker")).toBe(301);
  });

  it("commits batches before publishing and never exposes buffered events as durable", () => {
    vi.useFakeTimers();
    const batches: SessionEvent[][] = [];
    const { journal, directory } = fixture({
      onEvents: (events) => {
        const observer = new DatabaseSync(join(directory, "sessions.db"), {
          readOnly: true,
        });
        expect(
          Number(observer.prepare("SELECT COUNT(*) AS n FROM events").get()!.n),
        ).toBe(batches.flat().length + events.length);
        expect(journal.events("worker", 0)).toEqual([...batches.flat(), ...events]);
        observer.close();
        batches.push(events);
      },
    });
    enable(journal);
    expect(
      Number(database(journal).prepare("PRAGMA synchronous").get()!.synchronous),
    ).toBe(2);
    const first = journal.append(event());
    const second = journal.append(event());
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(journal.highWater("worker")).toBe(2);
    expect(journal.get("worker")?.highWater).toBe(0);
    expect(journal.events("worker", 0)).toEqual([]);
    expect(journal.transcript("worker").blocks).toEqual([]);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(31);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([[first, second]]);
    expect(journal.get("worker")?.highWater).toBe(2);
    expect(journal.get("worker")?.session.lastText).toBe("chunk");
  });

  it("flushes byte thresholds and semantic boundaries without waiting for the timer", () => {
    const batches: SessionEvent[][] = [];
    const { journal } = fixture({
      batchBytes: 800,
      batchMs: 60_000,
      onEvents: (batch) => batches.push(batch),
    });
    enable(journal);
    const first = journal.append(event(1, "agent_text", { text: "a".repeat(300) }));
    expect(batches).toEqual([]);
    const second = journal.append(event(1, "agent_text", { text: "b".repeat(300) }));
    expect(batches).toEqual([[first]]);
    const boundary = journal.append(
      event(1, "turn_complete", { stopReason: "end_turn" }),
    );
    expect(batches.flat()).toEqual([first, second, boundary]);
    expect(journal.events("worker", 0)).toEqual([first, second, boundary]);
  });

  it("commits a single oversized output chunk intact rather than dropping or truncating it", () => {
    const batches: SessionEvent[][] = [];
    const { journal } = fixture({
      batchBytes: 512,
      onEvents: (batch) => batches.push(batch),
    });
    enable(journal);
    const large = journal.append(event(1, "agent_text", { text: "🙂".repeat(2000) }));
    expect(batches).toEqual([[large]]);
    expect(journal.events("worker", 0)).toEqual([large]);
  });

  it("copies admitted data so producer and subscriber mutation cannot corrupt the journal", () => {
    const { journal } = fixture({
      onEvents: (batch) => {
        batch[0]!.payload.text = "subscriber mutation";
      },
    });
    enable(journal);
    const source = event();
    const returned = journal.append(source);
    source.payload.text = "producer mutation";
    returned.payload.text = "return mutation";
    journal.flush();
    expect(journal.events("worker", 0)[0]?.payload.text).toBe("chunk");
  });

  it("preserves IDs and sequences on buffered, committed and reopened duplicate replay", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const first = journal.append(event(40));
    const source = event(1, "agent_text", { text: "content", extra: { b: 2, a: 1 } });
    const emitted = journal.append(source);
    expect(emitted.sequence).toBe(41);
    expect(emitted.eventId).toBe(source.eventId);
    expect(journal.append(source)).toEqual(emitted);
    journal.flush();
    expect(
      journal.append({ ...source, payload: { extra: { a: 1, b: 2 }, text: "content" } }),
    ).toEqual(emitted);
    expect(() => journal.append({ ...source, payload: { text: "different" } })).toThrow(
      "conflicting",
    );
    journal.close();
    const reopened = open(directory);
    expect(reopened.append(source)).toEqual(emitted);
    expect(reopened.events("worker", 0)).toEqual([first, emitted]);
    expect(reopened.append(event()).sequence).toBe(42);
  });

  it("replays more than 2000 events over bounded committed pages without renumbering", () => {
    const { journal, directory } = fixture({ batchMs: 60_000 });
    enable(journal);
    const expected = Array.from({ length: 2517 }, (_, index) =>
      journal.append(event(1, "agent_text", { text: `${index}: ${"x".repeat(50)}` })),
    );
    journal.close();
    const reopened = open(directory);
    const actual: SessionEvent[] = [];
    for (;;) {
      const page = reopened.events("worker", actual.at(-1)?.sequence ?? 0, 127, 8192);
      expect(page.length).toBeLessThanOrEqual(127);
      expect(
        page.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0),
      ).toBeLessThanOrEqual(8192);
      if (!page.length) break;
      actual.push(...page);
    }
    expect(actual).toEqual(expected);
    expect(reopened.events("worker", 0, 5000).length).toBe(2000);
    expect(reopened.highWater("worker")).toBe(2517);
  });

  it("enforces exact UTF-8 replay budgets and exposes an actionable oversized-first error", () => {
    const { journal } = fixture();
    enable(journal);
    const first = journal.append(event(1, "agent_text", { text: "🐈".repeat(50) }));
    const second = journal.append(event());
    journal.flush();
    const bytes = Buffer.byteLength(JSON.stringify(first));
    expect(journal.events("worker", 0, 20, bytes)).toEqual([first]);
    expect(() => journal.events("worker", 0, 20, bytes - 1)).toThrow(ReplayBudgetError);
    try {
      journal.events("worker", 0, 20, bytes - 1);
    } catch (error) {
      expect((error as ReplayBudgetError).requiredBytes).toBe(bytes);
    }
    expect(journal.events("worker", first.sequence, 1)).toEqual([second]);
    expect(journal.events("worker", 0, 0)).toEqual([]);
    expect(journal.events("worker", 0, 10, 0)).toEqual([]);
    expect(() => journal.events("worker", 0, -1)).toThrow();
    expect(() => journal.events("worker", 0, 1, NaN)).toThrow();
    expect(journal.append(event()).sequence).toBe(3);
  });

  it("does not acknowledge buffered events or lower the acknowledgement watermark", () => {
    const { journal, directory } = fixture();
    enable(journal);
    journal.append(event(10));
    expect(() => journal.acknowledge("worker", 10)).toThrow("committed");
    journal.flush();
    journal.acknowledge("worker", 10);
    journal.acknowledge("worker", 1);
    expect(() => journal.acknowledge("worker", 11)).toThrow("committed");
    expect(journal.events("worker", 0)).toHaveLength(1);
    journal.close();
    expect(open(directory).get("worker")?.acknowledgedSequence).toBe(10);
  });

  it("persists control acknowledgement independently of event acknowledgement", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation(input);
    journal.append(event(50));
    journal.flush();
    journal.settleOperation(input.id, "settled");
    expect(journal.get("worker")?.acknowledgedControlEpoch).toBe(0);
    journal.acknowledgeControl("worker", 1);
    journal.acknowledgeControl("worker", 0);
    expect(journal.get("worker")).toMatchObject({
      acknowledgedControlEpoch: 1,
      controlEpoch: 1,
      acknowledgedSequence: 0,
      highWater: 50,
    });
    expect(() => journal.acknowledgeControl("worker", 2)).toThrow("local control epoch");
    expect(() => journal.acknowledgeControl("worker", -1)).toThrow();
    journal.close();
    const reopened = open(directory);
    expect(reopened.get("worker")?.acknowledgedControlEpoch).toBe(1);
    expect(() => reopened.purge("host")).toThrow("unacknowledged");
    reopened.acknowledge("worker", 50);
    reopened.purge("host");
    expect(reopened.has("worker")).toBe(false);
  });

  it("defaults legacy control acknowledgements to zero and does not infer them from event ACKs", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation(input);
    journal.settleOperation(input.id, "settled");
    journal.append(event(10));
    journal.flush();
    journal.acknowledge("worker", 10);
    database(journal).exec(
      "UPDATE sessions SET data=json_remove(data,'$.acknowledgedControlEpoch')",
    );
    journal.close();
    const reopened = open(directory);
    expect(reopened.get("worker")?.acknowledgedControlEpoch).toBe(0);
    expect(() => reopened.purge("host")).toThrow("unacknowledged");
    reopened.acknowledgeControl("worker", 1);
    reopened.close();
    expect(open(directory).get("worker")?.acknowledgedControlEpoch).toBe(1);
  });

  it("advances matching-grant control acknowledgements only within the prior local epoch", () => {
    const { journal } = fixture();
    enable(journal);
    for (let index = 0; index < 3; index += 1) journal.acceptOperation(operation());
    const grant = { hostId: "host", grantId: "grant-worker", session: session() };
    journal.enable({ ...grant, controlEpoch: 2 });
    expect(journal.get("worker")).toMatchObject({
      controlEpoch: 3,
      acknowledgedControlEpoch: 2,
    });
    journal.enable({ ...grant, controlEpoch: 0 });
    expect(journal.get("worker")).toMatchObject({
      controlEpoch: 3,
      acknowledgedControlEpoch: 2,
    });
    expect(() => journal.enable({ ...grant, grantId: "other", controlEpoch: 8 })).toThrow(
      "binding",
    );
    expect(journal.get("worker")?.acknowledgedControlEpoch).toBe(2);
    journal.enable({ ...grant, controlEpoch: 8 });
    expect(journal.get("worker")).toMatchObject({
      controlEpoch: 8,
      acknowledgedControlEpoch: 3,
    });
  });

  it("retains high-water, dedup evidence and permission results after explicit body trimming", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const source = event(50);
    const first = journal.append(source);
    const permission = journal.append(
      event(1, "permission", { requestId: "p", title: "Read" }),
    );
    const resolved = journal.append(
      event(1, "permission_result", { requestId: "p", outcome: "allowed" }),
    );
    const page = journal.transcript("worker");
    expect(() => journal.trimAcknowledged("worker", 52)).toThrow("unacknowledged");
    journal.acknowledge("worker", 52);
    journal.trimAcknowledged("worker", 52);
    expect(journal.events("worker", 0)).toEqual([]);
    expect(journal.highWater("worker")).toBe(52);
    expect(journal.permissions("worker")).toEqual([resolved]);
    expect(journal.transcript("worker").generation).not.toBe(page.generation);
    journal.close();
    const reopened = open(directory);
    expect(reopened.append(source)).toEqual(first);
    expect(reopened.append(permission)).toEqual(permission);
    expect(reopened.events("worker", 0)).toEqual([]);
    expect(reopened.append(event()).sequence).toBe(53);
    reopened.flush();
    expect(reopened.events("worker", 0)).toHaveLength(1);
    expect(reopened.permissions("worker")).toEqual([resolved]);
  });

  it("durably flushes pending output, acceptance and the epoch before permitting a command", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const preceding = journal.append(event(42));
    const input = operation();
    const accepted = journal.acceptOperation(input);
    expect(accepted).toMatchObject({
      invoke: true,
      operation: {
        ...input,
        grantId: "grant-worker",
        controlEpoch: 1,
        afterSequence: 42,
        state: "accepted",
      },
    });
    const observer = new DatabaseSync(join(directory, "sessions.db"), { readOnly: true });
    expect(
      JSON.parse(
        String(
          observer.prepare("SELECT data FROM operations WHERE id=?").get(input.id)!.data,
        ),
      ),
    ).toEqual(accepted.operation);
    expect(
      JSON.parse(
        String(
          observer.prepare("SELECT data FROM sessions WHERE id='worker'").get()!.data,
        ),
      ).controlEpoch,
    ).toBe(1);
    expect(Number(observer.prepare("SELECT COUNT(*) AS n FROM events").get()!.n)).toBe(1);
    observer.close();
    expect(journal.events("worker", 0)).toEqual([preceding]);
    expect(journal.acceptOperation(input)).toEqual({ ...accepted, invoke: false });
    expect(journal.get("worker")?.controlEpoch).toBe(1);
    expect(journal.acceptOperation(operation()).operation.controlEpoch).toBe(2);
  });

  it("deduplicates canonical operation payloads but rejects changed identity content", () => {
    const { journal } = fixture();
    enable(journal);
    enable(journal, "another");
    const input = { ...operation(), payload: { text: "same", config: { a: 1, b: 2 } } };
    const accepted = journal.acceptOperation(input);
    expect(
      journal.acceptOperation({
        ...input,
        payload: { config: { b: 2, a: 1 }, text: "same" },
      }).invoke,
    ).toBe(false);
    expect(() =>
      journal.acceptOperation({ ...input, payload: { text: "different" } }),
    ).toThrow("conflicting");
    expect(() => journal.acceptOperation({ ...input, action: "cancel" })).toThrow(
      "conflicting",
    );
    expect(() => journal.acceptOperation({ ...input, sessionId: "another" })).toThrow(
      "conflicting",
    );
    expect(journal.operations("worker")).toEqual([accepted.operation]);
    expect(journal.get("worker")?.controlEpoch).toBe(1);
  });

  it("reserves Host-origin operations durably without advancing local control or re-invoking offline", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    const accepted = journal.acceptOperation({ ...input, origin: "host" });
    expect(accepted).toMatchObject({
      invoke: true,
      operation: { origin: "host", controlEpoch: 0, state: "accepted" },
    });
    expect(journal.get("worker")?.controlEpoch).toBe(0);
    const observer = new DatabaseSync(join(directory, "sessions.db"), { readOnly: true });
    expect(
      JSON.parse(
        String(
          observer.prepare("SELECT data FROM operations WHERE id=?").get(input.id)!.data,
        ),
      ),
    ).toEqual(accepted.operation);
    observer.close();
    expect(journal.acceptOperation(input)).toEqual({ ...accepted, invoke: false });
    expect(journal.acceptOperation({ ...input, origin: "local" }).operation.origin).toBe(
      "host",
    );
    journal.close();
    const reopened = open(directory);
    expect(reopened.acceptOperation(input)).toMatchObject({
      invoke: false,
      operation: { origin: "host", state: "uncertain", controlEpoch: 0 },
    });
    expect(reopened.get("worker")?.controlEpoch).toBe(0);
    const local = reopened.acceptOperation(operation());
    expect(local.operation).toMatchObject({ origin: "local", controlEpoch: 1 });
    expect(
      reopened.operations("worker").filter((item) => item.origin !== "host"),
    ).toEqual([local.operation]);
  });

  it("defaults legacy operation origins to local without giving a retry another invocation", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation(input);
    database(journal).exec("UPDATE operations SET data=json_remove(data,'$.origin')");
    journal.close();
    const reopened = open(directory);
    expect(reopened.acceptOperation({ ...input, origin: "host" })).toMatchObject({
      invoke: false,
      operation: { origin: "local", state: "uncertain", controlEpoch: 1 },
    });
    expect(reopened.get("worker")?.controlEpoch).toBe(1);
    const queued = operation();
    reopened.acceptOperation({ ...queued, origin: "host", queued: true });
    expect(() => reopened.beginOperation(queued.id)).toThrow("local-origin");
    expect(reopened.get("worker")?.controlEpoch).toBe(1);
  });

  it("reserves uncertainty metadata so recovery works at the exact journal quota", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation(input);
    const used = Number(
      database(journal).prepare("SELECT bytes FROM storage WHERE id=1").get()!.bytes,
    );
    journal.close();
    const reopened = open(directory, { maxBytes: used });
    expect(reopened.operations("worker")[0]?.state).toBe("uncertain");
    expect(reopened.acceptOperation(input).invoke).toBe(false);
  });

  it("retains queued work across reopen and durably begins it once at the current output boundary", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    const queued = journal.acceptOperation({ ...input, queued: true });
    expect(queued).toMatchObject({
      invoke: false,
      operation: { state: "queued", controlEpoch: 1, afterSequence: 0 },
    });
    expect(journal.acceptOperation(input).invoke).toBe(false);
    expect(() => journal.purge("host")).toThrow("queued");
    journal.close();
    const reopened = open(directory);
    expect(reopened.operations("worker")[0]?.state).toBe("queued");
    const output = reopened.append(event(42));
    const accepted = reopened.beginOperation(input.id);
    expect(accepted).toMatchObject({
      state: "accepted",
      controlEpoch: 2,
      afterSequence: 42,
    });
    expect(reopened.events("worker", 0)).toEqual([output]);
    const observer = new DatabaseSync(join(directory, "sessions.db"), { readOnly: true });
    expect(
      JSON.parse(
        String(
          observer.prepare("SELECT data FROM operations WHERE id=?").get(input.id)!.data,
        ),
      ),
    ).toEqual(accepted);
    observer.close();
    expect(() => reopened.beginOperation(input.id)).toThrow("Only queued");
    expect(reopened.acceptOperation(input).invoke).toBe(false);
    reopened.close();
    const recovered = open(directory);
    expect(recovered.operations("worker")[0]?.state).toBe("uncertain");
    expect(() => recovered.beginOperation(input.id)).toThrow("Only queued");
  });

  it("executes an older queued prompt after later local actions at a fresh control epoch", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const prompt = operation();
    expect(
      journal.acceptOperation({ ...prompt, queued: true }).operation.controlEpoch,
    ).toBe(1);
    const config = journal.acceptOperation({
      ...operation(),
      action: "config",
      payload: { configId: "model", value: "model-id" },
    }).operation;
    expect(config.controlEpoch).toBe(2);
    journal.settleOperation(config.id, "settled");
    journal.acknowledgeControl("worker", 2);
    journal.append(event(42));
    const begun = journal.beginOperation(prompt.id);
    expect(begun).toMatchObject({
      controlEpoch: 3,
      afterSequence: 42,
      state: "accepted",
    });
    expect(journal.get("worker")).toMatchObject({
      controlEpoch: 3,
      acknowledgedControlEpoch: 2,
    });
    expect(
      journal.operations("worker").map((item) => [item.id, item.controlEpoch]),
    ).toEqual([
      [config.id, 2],
      [prompt.id, 3],
    ]);
    expect(() => journal.beginOperation(prompt.id)).toThrow("Only queued");
    expect(journal.get("worker")?.controlEpoch).toBe(3);
    journal.close();
    const reopened = open(directory);
    expect(reopened.operations("worker")[1]).toMatchObject({
      id: prompt.id,
      state: "uncertain",
      controlEpoch: 3,
    });
    expect(reopened.get("worker")?.controlEpoch).toBe(3);
  });

  it("persists idempotent per-session queue priority without changing identity or control epochs", () => {
    const { journal, directory } = fixture();
    enable(journal);
    enable(journal, "other");
    const inputs = [operation(), operation(), operation()];
    const original = inputs.map(
      (input) => journal.acceptOperation({ ...input, queued: true }).operation,
    );
    const other = journal.acceptOperation({
      ...operation(randomUUID(), "other"),
      queued: true,
    }).operation;
    journal.prioritizeOperation(other.id);
    journal.prioritizeOperation(original[0]!.id);
    expect(journal.operations("worker")[0]?.priority).toBe(1);
    journal.prioritizeOperation(original[0]!.id);
    expect(journal.operations("worker")[0]?.priority).toBe(1);
    journal.prioritizeOperation(original[1]!.id);
    journal.prioritizeOperation(original[0]!.id);
    journal.prioritizeOperation(original[0]!.id);
    const expected = [
      { ...original[0]!, priority: 3 },
      { ...original[1]!, priority: 2 },
      original[2]!,
    ];
    expect(journal.operations("worker")).toEqual(expected);
    expect(journal.get("worker")?.controlEpoch).toBe(3);
    expect(journal.acceptOperation(inputs[0]!)).toEqual({
      operation: expected[0],
      invoke: false,
    });
    journal.close();
    const reopened = open(directory);
    expect(reopened.operations("worker")).toEqual(expected);
    expect(reopened.get("worker")?.controlEpoch).toBe(3);
    reopened.prioritizeOperation(original[2]!.id);
    expect(reopened.operations("worker")[2]).toEqual({ ...original[2]!, priority: 4 });
    expect(reopened.operations("other")[0]?.priority).toBe(1);
  });

  it("defaults legacy operation priorities to zero and can prioritize them after reopen", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation({ ...input, queued: true });
    database(journal).exec("UPDATE operations SET data=json_remove(data,'$.priority')");
    journal.close();
    const reopened = open(directory);
    expect(reopened.operations("worker")[0]?.priority).toBe(0);
    reopened.prioritizeOperation(input.id);
    expect(reopened.operations("worker")[0]).toMatchObject({
      priority: 1,
      controlEpoch: 1,
      state: "queued",
    });
  });

  it.each(["accepted", "settled"] as const)(
    "refuses prioritizing %s operations without changing their receipts",
    (state) => {
      const { journal } = fixture();
      enable(journal);
      const input = operation();
      journal.acceptOperation(input);
      if (state === "settled") journal.settleOperation(input.id, "settled");
      const before = journal.operations("worker");
      expect(() => journal.prioritizeOperation(input.id)).toThrow("Only queued");
      expect(journal.operations("worker")).toEqual(before);
      expect(journal.get("worker")?.controlEpoch).toBe(1);
    },
  );

  it("rolls back the fresh begin epoch if the queued operation update cannot commit", () => {
    const { journal } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation({ ...input, queued: true });
    database(journal).exec(`
      CREATE TRIGGER reject_begin BEFORE UPDATE ON operations
      WHEN json_extract(NEW.data,'$.state')='accepted'
      BEGIN SELECT RAISE(ABORT,'injected begin failure'); END;
    `);
    expect(() => journal.beginOperation(input.id)).toThrow("begin failure");
    expect(journal.get("worker")?.controlEpoch).toBe(1);
    expect(journal.operations("worker")[0]).toMatchObject({
      state: "queued",
      controlEpoch: 1,
    });
    expect(() => journal.close()).toThrow("begin failure");
  });

  it("allows queued cancellation without ever granting native invocation", () => {
    const { journal } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation({ ...input, queued: true });
    journal.settleOperation(input.id, "rejected", "Cancelled before execution.");
    expect(journal.acceptOperation({ ...input, queued: true }).invoke).toBe(false);
    expect(() => journal.beginOperation(input.id)).toThrow("Only queued");
    journal.acknowledgeControl("worker", 1);
    journal.purge("host");
    expect(journal.has("worker")).toBe(false);
  });

  it("leaves a queued operation uninvoked when its durable begin transition fails", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const input = operation();
    journal.acceptOperation({ ...input, queued: true });
    database(journal).exec("PRAGMA query_only=ON");
    expect(() => journal.beginOperation(input.id)).toThrow();
    expect(journal.operations("worker")[0]?.state).toBe("queued");
    expect(() => journal.close()).toThrow();
    const reopened = open(directory);
    expect(reopened.operations("worker")[0]?.state).toBe("queued");
    expect(reopened.beginOperation(input.id).state).toBe("accepted");
  });

  it("makes accepted operations uncertain on reopen and never automatically invokes them twice", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const accepted = operation();
    const settled = operation();
    const rejected = operation();
    journal.acceptOperation(accepted);
    journal.acceptOperation(settled);
    journal.settleOperation(settled.id, "settled");
    journal.acceptOperation(rejected);
    journal.settleOperation(rejected.id, "rejected", "Policy rejected");
    journal.close();
    const reopened = open(directory);
    expect(reopened.operations("worker").map((item) => item.state)).toEqual([
      "uncertain",
      "settled",
      "rejected",
    ]);
    for (const input of [accepted, settled, rejected])
      expect(reopened.acceptOperation(input).invoke).toBe(false);
    expect(reopened.operations("worker")[0]?.error).toContain(
      "never automatically invoke",
    );
    expect(reopened.get("worker")?.controlEpoch).toBe(3);
    reopened.settleOperation(accepted.id, "settled");
    expect(() => reopened.settleOperation(settled.id, "uncertain")).toThrow(
      "cannot change",
    );
    expect(() => reopened.settleOperation(rejected.id, "settled")).toThrow(
      "cannot change",
    );
  });

  it("isolates Host namespaces and rejects grant, node and execution-binding replacement", () => {
    const { journal } = fixture();
    enable(journal, "worker", "host-one");
    enable(journal, "second", "host-two");
    journal.append(event());
    journal.append(event(1, "agent_text", { text: "other Host" }, "second"));
    journal.flush();
    for (const changed of [
      { hostId: "host-two", grantId: "grant-worker", session: session() },
      { hostId: "host-one", grantId: "new-grant", session: session() },
      {
        hostId: "host-one",
        grantId: "grant-worker",
        session: session("worker", { nodeId: "other-node" }),
      },
    ])
      expect(() => journal.enable(changed)).toThrow("binding");
    expect(journal.list("host-one").map((item) => item.session.id)).toEqual(["worker"]);
    expect(journal.list("host-two").map((item) => item.session.id)).toEqual(["second"]);
    expect(journal.list("missing")).toEqual([]);
    expect(() => journal.updateSession(session("worker", { runRole: "lead" }))).toThrow(
      "non-lead",
    );
    expect(() =>
      journal.updateSession(session("worker", { placementId: "another-placement" })),
    ).toThrow("binding");
  });

  it("refuses purging unacknowledged or actively accepted work unless explicitly overridden", () => {
    const { journal, directory } = fixture();
    enable(journal, "worker", "host-one");
    enable(journal, "second", "host-two");
    journal.append(event());
    const other = journal.append(event(1, "agent_text", { text: "keep" }, "second"));
    journal.flush();
    expect(() => journal.purge("host-one")).toThrow("unacknowledged");
    journal.acknowledge("worker", 1);
    const command = operation();
    journal.acceptOperation(command);
    expect(() => journal.purge("host-one")).toThrow("active accepted");
    journal.settleOperation(command.id, "settled");
    expect(() => journal.purge("host-one")).toThrow("unacknowledged");
    journal.acknowledgeControl("worker", 1);
    journal.purge("host-one");
    expect(journal.has("worker")).toBe(false);
    expect(journal.operations("worker")).toEqual([]);
    expect(journal.events("second", 0)).toEqual([other]);
    expect(() => journal.purge("host-two")).toThrow("unacknowledged");
    journal.purge("host-two", true);
    expect(journal.list("host-two")).toEqual([]);
    journal.close();
    expect(open(directory).has("worker")).toBe(false);
  });

  it("overrides accepted-operation purge only in the explicitly selected Host namespace", () => {
    const { journal } = fixture();
    enable(journal, "worker", "host-one");
    enable(journal, "second", "host-two");
    journal.acceptOperation(operation());
    const other = journal.acceptOperation(operation(randomUUID(), "second")).operation;
    journal.purge("host-one", true);
    expect(journal.operations("worker")).toEqual([]);
    expect(journal.operations("second")).toEqual([other]);
  });

  it("retires only confirmed session data and preserves its monotonic non-content tombstone", () => {
    const { journal, directory } = fixture();
    enable(journal, "worker", "host-one");
    enable(journal, "peer", "host-one");
    enable(journal, "other", "host-two");
    const marker = `private-retirement-content-${randomUUID()}`;
    journal.updateSession({
      ...journal.get("worker")!.session,
      initialPrompt: marker,
      name: marker,
    });
    const input = { ...operation(), payload: { prompt: marker } };
    journal.acceptOperation(input);
    journal.append(event(37, "system", { text: `User: ${marker}` }));
    journal.append(event(1, "permission", { requestId: "permission", title: marker }));
    journal.append(
      event(1, "permission_result", { requestId: "permission", outcome: "allowed" }),
    );
    const peer = journal.append(event(10, "agent_text", { text: "peer output" }, "peer"));
    const other = journal.append(
      event(20, "agent_text", { text: "other output" }, "other"),
    );
    journal.flush();
    journal.settleOperation(input.id, "settled");
    journal.acknowledge("worker", 39);
    journal.acknowledgeControl("worker", 1);
    // Host-confirmed quiescence also retires unresolved Host forwarding receipts.
    journal.acceptOperation({ ...operation(), origin: "host" });
    journal.transcript("worker");
    journal.retire("worker");
    expect(journal.has("worker")).toBe(false);
    expect(journal.get("worker")).toBeUndefined();
    expect(journal.events("worker", 0)).toEqual([]);
    expect(journal.operations("worker")).toEqual([]);
    expect(journal.permissions("worker")).toEqual([]);
    expect(journal.highWater("worker")).toBe(39);
    expect(journal.list("host-one").map((item) => item.session.id)).toEqual(["peer"]);
    expect(journal.events("peer", 0)).toEqual([peer]);
    expect(journal.events("other", 0)).toEqual([other]);
    expect(() => journal.transcript("worker")).toThrow("not enabled");
    expect(() => journal.retire("worker")).not.toThrow();
    expect(() => journal.retire("never-enabled")).not.toThrow();
    expect(() => enable(journal, "worker", "host-one")).toThrow("retired");
    expect(
      Number(database(journal).prepare("PRAGMA secure_delete").get()!.secure_delete),
    ).toBe(1);
    journal.close();
    expect(
      readFileSync(join(directory, "sessions.db")).includes(Buffer.from(marker)),
    ).toBe(false);
    const reopened = open(directory);
    expect(reopened.highWater("worker")).toBe(39);
    expect(reopened.has("worker")).toBe(false);
    expect(() => enable(reopened, "worker", "host-two")).toThrow("retired");
    reopened.purge("host-two", true);
    expect(reopened.highWater("worker")).toBe(39);
    expect(reopened.events("peer", 0)).toEqual([peer]);
    reopened.purge("host-one", true);
    expect(reopened.highWater("worker")).toBe(0);
  });

  it("refuses retirement until both event and control watermarks are acknowledged", () => {
    const { journal } = fixture();
    enable(journal);
    journal.append(event(42));
    expect(() => journal.retire("worker")).toThrow("unacknowledged");
    expect(journal.get("worker")?.highWater).toBe(42);
    journal.acknowledge("worker", 42);
    const input = operation();
    journal.acceptOperation(input);
    journal.settleOperation(input.id, "settled");
    expect(() => journal.retire("worker")).toThrow("unacknowledged");
    expect(journal.has("worker")).toBe(true);
    journal.acknowledgeControl("worker", 1);
    journal.retire("worker");
    expect(journal.has("worker")).toBe(false);
    expect(journal.highWater("worker")).toBe(42);
  });

  it.each(["accepted", "queued"] as const)(
    "refuses retirement of acknowledged but still %s local work",
    (state) => {
      const { journal } = fixture();
      enable(journal);
      const input = operation();
      journal.acceptOperation({ ...input, queued: state === "queued" });
      journal.acknowledgeControl("worker", 1);
      expect(() => journal.retire("worker")).toThrow("active local");
      expect(journal.operations("worker")[0]?.state).toBe(state);
      journal.settleOperation(input.id, state === "queued" ? "rejected" : "settled");
      journal.retire("worker");
      expect(journal.has("worker")).toBe(false);
    },
  );

  it("rolls back retirement and its tombstone together if deleting the session fails", () => {
    const onFailure = vi.fn();
    const { journal, directory } = fixture({ onFailure });
    enable(journal);
    const saved = journal.append(event(30));
    journal.flush();
    journal.acknowledge("worker", 30);
    database(journal).exec(`
      CREATE TRIGGER reject_retirement BEFORE DELETE ON sessions
      BEGIN SELECT RAISE(ABORT,'injected retirement failure'); END;
    `);
    expect(() => journal.retire("worker")).toThrow("retirement failure");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(journal.events("worker", 0)).toEqual([saved]);
    expect(journal.has("worker")).toBe(true);
    expect(
      Number(
        database(journal).prepare("SELECT COUNT(*) AS n FROM retired_sessions").get()!.n,
      ),
    ).toBe(0);
    expect(() => journal.close()).toThrow("retirement failure");
    const reopened = open(directory);
    expect(reopened.has("worker")).toBe(true);
    expect(reopened.events("worker", 0)).toEqual([saved]);
  });

  it("fails closed on real SQLite write failure with no uncommitted publication or command invocation", () => {
    vi.useFakeTimers();
    const onEvents = vi.fn();
    const onFailure = vi.fn();
    const { journal, directory } = fixture({ onEvents, onFailure });
    enable(journal);
    const committed = journal.append(event(1, "system", { text: "User: durable" }));
    onEvents.mockClear();
    database(journal).exec("PRAGMA query_only=ON");
    journal.append(event());
    vi.advanceTimersByTime(32);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
    expect(journal.events("worker", 0)).toEqual([committed]);
    expect(journal.get("worker")?.highWater).toBe(1);
    expect(() => journal.acceptOperation(operation())).toThrow();
    expect(() => journal.append(event())).toThrow();
    expect(() => journal.updateSession(session())).toThrow();
    expect(journal.operations("worker")).toEqual([]);
    expect(() => journal.close()).toThrow();
    const reopened = open(directory);
    expect(reopened.events("worker", 0)).toEqual([committed]);
    expect(reopened.append(event()).sequence).toBe(2);
  });

  it("rolls back the entire output group and high-water on a mid-transaction write error", () => {
    const onFailure = vi.fn();
    const onEvents = vi.fn();
    const { journal } = fixture({ onFailure, onEvents });
    enable(journal);
    const first = journal.append(event());
    journal.append(event());
    database(journal).exec(`
      CREATE TRIGGER reject_second BEFORE INSERT ON events WHEN NEW.sequence=2
      BEGIN SELECT RAISE(ABORT,'injected SQLite write failure'); END;
    `);
    expect(() => journal.flush()).toThrow("SQLite write failure");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
    expect(journal.events("worker", 0)).toEqual([]);
    expect(journal.get("worker")?.highWater).toBe(0);
    expect(first.sequence).toBe(1);
    expect(() => journal.close()).toThrow("SQLite write failure");
  });

  it("rolls back acceptance and its epoch atomically if operation storage fails", () => {
    const { journal } = fixture();
    enable(journal);
    database(journal).exec(`
      CREATE TRIGGER reject_operation BEFORE INSERT ON operations
      BEGIN SELECT RAISE(ABORT,'injected operation storage failure'); END;
    `);
    expect(() => journal.acceptOperation(operation())).toThrow(
      "operation storage failure",
    );
    expect(journal.get("worker")?.controlEpoch).toBe(0);
    expect(journal.operations("worker")).toEqual([]);
    expect(() => journal.close()).toThrow("operation storage failure");
  });

  it("never silently evicts acknowledged or unacknowledged evidence when its budget is exhausted", () => {
    const onFailure = vi.fn();
    const { journal, directory } = fixture({ maxBytes: 4096, onFailure });
    enable(journal);
    const retained = journal.append(event(1, "agent_text", { text: "retained" }));
    journal.flush();
    journal.acknowledge("worker", 1);
    expect(() =>
      journal.append(event(1, "agent_text", { text: "x".repeat(5000) })),
    ).toThrow("storage is full");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(journal.events("worker", 0)).toEqual([retained]);
    expect(() => journal.acceptOperation(operation())).toThrow("storage is full");
    expect(() => journal.close()).toThrow("storage is full");
    expect(open(directory).events("worker", 0)).toEqual([retained]);
  });

  it("fails closed if publication fails, but retains its already committed evidence", () => {
    const onFailure = vi.fn();
    const { journal } = fixture({
      onFailure,
      onEvents: () => {
        throw new Error("subscriber unavailable");
      },
    });
    enable(journal);
    const output = journal.append(event());
    expect(() => journal.flush()).toThrow("subscriber unavailable");
    expect(journal.events("worker", 0)).toEqual([output]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(() => journal.acceptOperation(operation())).toThrow("subscriber unavailable");
    expect(() => journal.close()).toThrow("subscriber unavailable");
  });

  it("allows post-commit settlement and nested publication without corrupting either batch", () => {
    const input = operation();
    const nested = event();
    const batches: SessionEvent[][] = [];
    const { journal, directory } = fixture({
      onEvents: (batch) => {
        batches.push(batch);
        expect(journal.events("worker", 0)).toEqual(batches.flat());
        if (batches.length === 1) journal.append(nested);
        journal.settleOperation(input.id, "settled");
      },
    });
    enable(journal);
    journal.acceptOperation(input);
    const first = journal.append(event());
    journal.flush();
    expect(batches.map((batch) => batch.map((item) => item.eventId))).toEqual([
      [first.eventId],
      [nested.eventId],
    ]);
    expect(journal.events("worker", 0).map((item) => item.sequence)).toEqual([1, 2]);
    expect(journal.operations("worker")[0]?.state).toBe("settled");
    expect(journal.get("worker")?.controlEpoch).toBe(1);
    journal.close();
    expect(open(directory).operations("worker")[0]?.state).toBe("settled");
  });

  it("reports constructor storage errors and does not clean up unrelated files", () => {
    const { journal, directory } = fixture();
    journal.close();
    const unrelated = join(directory, "keep.txt");
    writeFileSync(unrelated, "do not touch");
    const invalid = join(directory, "not-a-directory");
    writeFileSync(invalid, "file");
    const onFailure = vi.fn();
    expect(() => new SessionJournal(invalid, { secure: false, onFailure })).toThrow();
    expect(onFailure).toHaveBeenCalledTimes(1);
    const reopened = open(directory);
    enable(reopened);
    reopened.purge("host");
    expect(readFileSync(unrelated, "utf8")).toBe("do not touch");
  });

  it("rejects linked journal ancestors instead of following them", () => {
    const { journal, directory } = fixture();
    journal.close();
    const target = join(directory, "target");
    const linked = join(directory, "linked");
    mkdirSync(target);
    symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    const onFailure = vi.fn();
    expect(
      () => new SessionJournal(join(linked, "child"), { secure: false, onFailure }),
    ).toThrow("linked");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("updates standard event metadata without fabricating catalog labels", () => {
    const { journal, directory } = fixture();
    enable(journal);
    const state = journal.append(
      event(1, "state", { state: "running", activity: "Working" }),
    );
    const commands = [{ name: "explain", description: "Explain this" }];
    const options = [
      {
        id: "model",
        name: "Model",
        category: "model",
        description: "",
        currentValue: "model-id",
        choices: [],
      },
    ];
    journal.append(event(1, "commands", { commands }));
    journal.append(event(1, "config", { options }));
    journal.append(event(1, "usage", { aiCredits: 5, contextTokens: 100 }));
    journal.append(event(1, "usage", { contextTokens: 200 }));
    journal.append(event(1, "agent_session", { agentSessionId: "new-native" }));
    journal.append(event(1, "agent_text", { text: "x".repeat(600) }));
    journal.flush();
    expect(journal.get("worker")?.session).toMatchObject({
      state: "running",
      currentActivity: "Working",
      workspaceName: "Actual workspace catalog name",
      nodeName: "Actual node catalog name",
      agentSessionId: "new-native",
      commands,
      configOptions: options,
      usage: { aiCredits: 5, contextTokens: 200 },
      lastText: "x".repeat(500),
      lastActivityAt: timestamp,
    });
    const snapshot = journal.get("worker")!.session;
    journal.updateSession({
      ...snapshot,
      name: "Renamed",
      workspaceName: "Renamed catalog workspace",
    });
    journal.close();
    expect(open(directory).get("worker")?.session).toMatchObject({
      name: "Renamed",
      workspaceName: "Renamed catalog workspace",
      state: state.payload.state,
    });
  });

  it("matches the shared transcript projector, pagination, permissions and stable reload revisions", () => {
    const { journal, directory } = fixture();
    enable(journal);
    enable(journal, "another");
    const projected: SessionEvent[] = [];
    const add = (type: SessionEvent["type"], payload: SessionEvent["payload"]) =>
      projected.push(journal.append(event(1, type, payload)));
    add("system", {
      text: "User: Read the code",
      attachments: [{ name: "a.txt", mimeType: "text/plain", bytes: 1 }],
    });
    add("agent_text", { text: "Hello " });
    add("agent_text", { text: "world" });
    add("agent_thought", { text: "Thinking" });
    add("tool", { toolCallId: "tool", title: "Read source", status: "running" });
    add("agent_text", { text: "Later text" });
    add("tool", { toolCallId: "tool", status: "completed" });
    add("permission", { requestId: "p", title: "Read files" });
    add("permission_result", { requestId: "p", outcome: "allowed" });
    add("permission", { requestId: "pending", title: "Write files" });
    add("turn_complete", { stopReason: "end_turn" });
    add("state", { state: "idle", activity: "Ready" });
    add("error", { message: "An example failure" });
    add("config", { options: [] });
    const projector = new TranscriptProjector();
    for (const item of projected) projector.apply(item);
    const page = journal.transcript("worker");
    expect(page.blocks).toEqual(projector.blocks);
    expect(page.prompts).toEqual(projector.prompts);
    expect(page.activity?.eventId).toBe(projected.at(-2)?.eventId);
    expect(page.revision).toBe(projected.length);
    const tail = journal.transcript("worker", { limit: 3 });
    expect(tail.blocks).toEqual(projector.blocks.slice(-3));
    const previous = journal.transcript("worker", { before: tail.start, limit: 3 });
    expect(previous.blocks).toEqual(
      projector.blocks.slice(Math.max(0, tail.start - 3), tail.start),
    );
    expect(previous.prompts).toBeUndefined();
    const permissions = new SessionPermissions();
    permissions.apply(projected);
    expect(journal.permissions("worker")).toEqual(permissions.latestEvents());
    page.blocks[0]!.text = "must not mutate the projector";
    expect(journal.transcript("worker").blocks).toEqual(projector.blocks);
    journal.transcript("another");
    expect(journal.transcript("worker").blocks).toEqual(projector.blocks);
    journal.close();
    const reopened = open(directory);
    expect(reopened.transcript("worker")).toEqual({ ...page, blocks: projector.blocks });
    const next = reopened.append(event(1, "agent_text", { text: "New turn" }));
    reopened.flush();
    projector.apply(next);
    const advanced = reopened.transcript("worker");
    expect(advanced.blocks).toEqual(projector.blocks);
    expect(advanced.generation).toBe(page.generation);
    expect(advanced.revision).toBe(page.revision + 1);
  });

  it("incrementally projects repeated snapshots and keeps only the selected session warm", () => {
    const { journal } = fixture();
    enable(journal);
    enable(journal, "second");
    for (let index = 0; index < 3; index += 1) journal.append(event());
    for (let index = 0; index < 2; index += 1)
      journal.append(event(1, "agent_text", { text: "other" }, "second"));
    journal.flush();
    const apply = vi.spyOn(TranscriptProjector.prototype, "apply");
    try {
      const first = journal.transcript("worker");
      expect(apply).toHaveBeenCalledTimes(3);
      expect(journal.transcript("worker")).toEqual(first);
      expect(apply).toHaveBeenCalledTimes(3);
      journal.append(event());
      journal.flush();
      expect(apply).toHaveBeenCalledTimes(3);
      const next = journal.transcript("worker");
      expect(apply).toHaveBeenCalledTimes(4);
      expect(next.generation).toBe(first.generation);
      expect(next.revision).toBe(first.revision + 1);
      expect(apply.mock.calls.every(([item]) => item.sessionId === "worker")).toBe(true);
      journal.transcript("second");
      expect(apply).toHaveBeenCalledTimes(6);
      expect(journal.transcript("worker")).toEqual(next);
      expect(apply).toHaveBeenCalledTimes(10);
    } finally {
      apply.mockRestore();
    }
  });

  it("caps transcript snapshots even when the short remaining prefix would expand the page", () => {
    const { journal } = fixture({ batchMs: 60_000 });
    enable(journal);
    const ids: string[] = [];
    for (let index = 0; index < TRANSCRIPT_PAGE_MAX + 7; index += 1)
      ids.push(
        journal.append(event(1, "tool", { toolCallId: `tool-${index}`, title: "Read" }))
          .eventId,
      );
    journal.flush();
    const page = journal.transcript("worker", { limit: Number.MAX_SAFE_INTEGER });
    expect(page.total).toBe(TRANSCRIPT_PAGE_MAX + 7);
    expect(page.blocks).toHaveLength(TRANSCRIPT_PAGE_MAX);
    expect(page.start).toBe(7);
    expect(page.blocks[0]?.key).toBe(ids[7]);
    expect(journal.transcript("worker").blocks).toHaveLength(200);
    expect(
      journal.transcript("worker", {
        before: TRANSCRIPT_PAGE_MAX,
        limit: Number.MAX_SAFE_INTEGER,
      }).blocks,
    ).toHaveLength(TRANSCRIPT_PAGE_MAX);
    expect(() => journal.transcript("worker", { limit: Infinity })).toThrow();
  });

  it("flushes and closes explicitly, and refuses new writes after close", () => {
    const onEvents = vi.fn();
    const { journal, directory } = fixture({ onEvents });
    enable(journal);
    const output = journal.append(event());
    journal.close();
    expect(onEvents).toHaveBeenCalledWith([output]);
    expect(() => journal.append(event())).toThrow("closed");
    expect(() => journal.acceptOperation(operation())).toThrow("closed");
    expect(() => journal.close()).not.toThrow();
    expect(open(directory).events("worker", 0)).toEqual([output]);
  });

  it.runIf(process.env.FLEET_JOURNAL_BENCHMARK === "1")(
    "benchmarks durable commit plus streamed publication at p95 below 100ms",
    async () => {
      const started = new Map<string, number>();
      const latencies: number[] = [];
      const commits: number[] = [];
      let published: (() => void) | undefined;
      const { journal } = fixture({
        onEvents: (events) => {
          journal.transcript("worker");
          const now = performance.now();
          for (const item of events) latencies.push(now - started.get(item.eventId)!);
          published?.();
        },
      });
      enable(journal);
      for (let batch = 0; batch < 60; batch += 1) {
        const publication = new Promise<void>((done) => {
          published = done;
        });
        for (let token = 0; token < 32; token += 1) {
          const chunk = event(1, "agent_text", { text: "streamed output ".repeat(8) });
          started.set(chunk.eventId, performance.now());
          journal.append(chunk);
        }
        await publication;
        const boundary = event(1, "turn_complete", { stopReason: "end_turn" });
        started.set(boundary.eventId, performance.now());
        const beforeCommit = performance.now();
        journal.append(boundary);
        commits.push(performance.now() - beforeCommit);
      }
      const p95 = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
      const streamingP95 = p95(latencies);
      const commitP95 = p95(commits);
      console.log(
        JSON.stringify({
          benchmark: "session-journal",
          events: latencies.length,
          groups: commits.length * 2,
          batchMs: 32,
          batchBytes: 65536,
          synchronous: "FULL",
          snapshotPerBatch: true,
          streamCommitP95Ms: Number(streamingP95.toFixed(2)),
          immediateCommitP95Ms: Number(commitP95.toFixed(2)),
        }),
      );
      expect(streamingP95).toBeLessThan(100);
      expect(commitP95).toBeLessThan(100);
    },
  );
});
