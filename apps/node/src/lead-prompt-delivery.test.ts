import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PROMPT,
  LeadPromptDeliverySchema,
  type LeadPromptReceipt,
  type SessionEvent,
} from "@fleet/protocol";
import { LeadPromptJournal } from "./lead-prompt-delivery.js";
import { CommandRouter } from "./router.js";
import type { AgentFactory } from "./agents.js";

const directories: string[] = [];
const journals: LeadPromptJournal[] = [];
const attachment = { name: "evidence.txt", mimeType: "text/plain", data: "ZXZpZGVuY2U=" };
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = resolve(`.lead-delivery-test-${randomUUID()}`);
  directories.push(directory);
  const receipts: LeadPromptReceipt[] = [];
  const journal = new LeadPromptJournal(
    directory,
    (receipt) => receipts.push(receipt),
    false,
  );
  journals.push(journal);
  return { directory, receipts, journal };
}

describe("durable native lead prompt handoff", () => {
  it("bounds serialized delivery independently of its compact lifecycle journal", () => {
    const f = fixture();
    const oversized = LeadPromptDeliverySchema.parse({
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "oversized serialized data",
      attachments: [{ ...attachment, data: "\0".repeat(3 * 1024 * 1024) }],
    });
    expect(() => f.journal.accept("host", oversized, "native", false)).toThrow(
      "16 MiB serialized payload",
    );
    expect(f.receipts).toEqual([]);
    expect(f.journal.reserved("lead", "native")).toBe(false);
  });

  it.each(["nativeSessionId", "attemptId"] as const)(
    "does not rewrite a conflicting persisted %s during receipt enrichment",
    (field) => {
      const f = fixture();
      const delivery = { deliveryId: randomUUID(), sessionId: "lead", prompt: "handoff" };
      f.journal.accept("host", delivery, "native", false);
      const database = new DatabaseSync(join(f.directory, "lead-deliveries.db"));
      database
        .prepare("UPDATE deliveries SET data=json_set(data,?,?) WHERE id=?")
        .run(
          `$.receipt.${field}`,
          field === "attemptId" ? randomUUID() : "another-native",
          delivery.deliveryId,
        );
      database.close();
      expect(() => f.journal.accept("host", delivery, "native", false)).toThrow(
        "identity mismatch",
      );
    },
  );

  it("durably rejects unsupported content without reserving a native prompt", () => {
    const f = fixture();
    const delivery = {
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "unsupported fields",
    };
    const rejected = f.journal.accept(
      "host",
      delivery,
      "",
      false,
      "Unsupported delivery fields.",
    );
    expect(rejected).toMatchObject({
      invoke: false,
      receipt: { state: "rejected", detail: "Unsupported delivery fields." },
    });
    expect(f.journal.reserved("lead")).toBe(false);
    f.journal.replay("host");
    expect(f.receipts.at(-1)).toEqual(rejected.receipt);
  });

  it.each([
    { kind: "text only", attachments: undefined, expected: "accepted" },
    { kind: "with attachments", attachments: [attachment], expected: "accepted" },
    {
      kind: "at the file count limit",
      attachments: Array.from({ length: MAX_ATTACHMENTS_PER_PROMPT }, () => attachment),
      expected: "accepted",
    },
    {
      kind: "at the decoded byte cap",
      attachments: [
        {
          ...attachment,
          data: Buffer.alloc(MAX_ATTACHMENT_BYTES, 97).toString("base64"),
        },
      ],
      expected: "accepted",
    },
    {
      kind: "with unpadded Base64",
      attachments: [{ ...attachment, data: "YQ" }],
      expected: "accepted",
    },
    {
      kind: "with malformed Base64",
      attachments: [{ ...attachment, data: "%%invalid%%" }],
      expected: "rejected",
    },
    {
      kind: "with empty data",
      attachments: [{ ...attachment, data: "" }],
      expected: "schema_error",
    },
    {
      kind: "with missing name",
      attachments: [{ ...attachment, name: "" }],
      expected: "schema_error",
    },
    {
      kind: "with missing MIME type",
      attachments: [{ ...attachment, mimeType: "" }],
      expected: "schema_error",
    },
    {
      kind: "over the file count",
      attachments: Array.from(
        { length: MAX_ATTACHMENTS_PER_PROMPT + 1 },
        () => attachment,
      ),
      expected: "schema_error",
    },
    {
      kind: "over the decoded byte cap",
      attachments: [
        {
          ...attachment,
          data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
        },
      ],
      expected: "schema_error",
    },
  ])(
    "persists native identity and forwards $kind exactly once until authoritative settlement",
    async ({ attachments, expected }) => {
      const f = fixture();
      let sequence = 0;
      let sink!: (event: SessionEvent) => void;
      let complete!: () => void;
      const prompt = vi.fn(async () => {
        expect(f.journal.reserved("lead", "native")).toBe(true);
        await new Promise<void>((done) => {
          complete = done;
        });
      });
      const start: AgentFactory["start"] = async (sessionId, _cwd, emit) => {
        sink = emit;
        emit({
          eventId: "native",
          sessionId,
          sequence: ++sequence,
          type: "agent_session",
          payload: { agentSessionId: "native" },
          createdAt: new Date().toISOString(),
        });
        return {
          busy: false,
          prompt,
          cancel: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          resync: vi.fn(),
          resolvePermission: vi.fn(),
          denyPendingPermissions: vi.fn(),
          setConfigOption: vi.fn(async () => {}),
        };
      };
      const router = new CommandRouter(
        { start },
        1,
        () => {},
        async (path) => path,
        () => "",
        async () => [],
        () => {},
        { leadDeliveries: f.journal },
      );
      await router.route({
        type: "resume_session",
        commandId: "resume",
        sessionId: "lead",
        agentSessionId: "native",
        localPath: "C:\\private-coordinator",
        additionalDirectories: [],
        sequenceOffset: 0,
        readOnly: false,
        yolo: false,
        agent: "",
        mcpServers: [],
        config: [],
      });
      const delivery = {
        deliveryId: randomUUID(),
        sessionId: "lead",
        prompt: "command completed",
        ...(attachments ? { attachments } : {}),
      };
      if (expected === "schema_error") {
        await expect(router.deliverLeadPrompt("host", delivery)).rejects.toThrow();
        expect(prompt).not.toHaveBeenCalled();
        expect(f.journal.reserved("lead", "native")).toBe(false);
        await router.stopAll();
        return;
      }
      const accepted = await router.deliverLeadPrompt("host", delivery);
      if (expected === "rejected") {
        expect(accepted).toMatchObject({
          state: "rejected",
          detail: expect.stringContaining("valid Base64"),
        });
        expect(prompt).not.toHaveBeenCalled();
        expect(f.journal.reserved("lead", "native")).toBe(false);
        expect(await router.deliverLeadPrompt("host", delivery)).toEqual(accepted);
        await router.stopAll();
        return;
      }
      expect(accepted).toMatchObject({
        state: "accepted",
        nativeSessionId: "native",
        attemptId: expect.any(String),
      });
      expect(await router.deliverLeadPrompt("host", delivery)).toEqual(accepted);
      const storage = new DatabaseSync(join(f.directory, "lead-deliveries.db"), {
        readOnly: true,
      });
      const stored = storage
        .prepare("SELECT data FROM deliveries WHERE id=?")
        .get(delivery.deliveryId)!;
      storage.close();
      expect(Buffer.byteLength(String(stored.data), "utf8")).toBeLessThan(8192);
      expect(String(stored.data)).not.toContain('"attachments"');
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith("command completed", attachments, {
        allowContextRollover: false,
      });
      expect(
        (
          await router.route({
            type: "prompt",
            commandId: "human",
            sessionId: "lead",
            prompt: "human prompt",
            attachments: [],
          })
        ).ok,
      ).toBe(false);
      sink({
        eventId: "idle",
        sessionId: "lead",
        sequence: ++sequence,
        type: "state",
        payload: { state: "idle" },
        createdAt: new Date().toISOString(),
      });
      expect(f.journal.reserved("lead")).toBe(true);
      sink({
        eventId: "historical-turn",
        sessionId: "lead",
        sequence: ++sequence,
        type: "turn_complete",
        payload: { stopReason: "end_turn", historyReplay: true },
        createdAt: new Date().toISOString(),
      });
      expect(f.journal.reserved("lead")).toBe(true);
      sink({
        eventId: "actual-turn",
        sessionId: "lead",
        sequence: ++sequence,
        type: "turn_complete",
        payload: { stopReason: "end_turn" },
        createdAt: new Date().toISOString(),
      });
      complete();
      expect(f.journal.reserved("lead")).toBe(false);
      expect(f.receipts.at(-1)).toMatchObject({
        state: "settled",
        nativeSessionId: "native",
        attemptId: accepted.attemptId,
      });
      await router.stopAll();
    },
  );

  it("retries busy refusals but never re-prompts an ambiguous native handoff after restart", () => {
    const f = fixture();
    const delivery = { deliveryId: randomUUID(), sessionId: "lead", prompt: "complete" };
    expect(f.journal.accept("host", delivery, "native", true)).toMatchObject({
      invoke: false,
      receipt: { state: "rejected_busy" },
    });
    const accepted = f.journal.accept("host", delivery, "native", false);
    expect(accepted).toMatchObject({
      invoke: true,
      receipt: { nativeSessionId: "native", attemptId: expect.any(String) },
    });
    f.journal.close();
    journals.splice(journals.indexOf(f.journal), 1);
    const oldJournal = new DatabaseSync(join(f.directory, "lead-deliveries.db"));
    oldJournal.exec(
      "UPDATE deliveries SET data=json_remove(data,'$.receipt.nativeSessionId','$.receipt.attemptId')",
    );
    oldJournal.close();
    const restored = new LeadPromptJournal(
      f.directory,
      (receipt) => f.receipts.push(receipt),
      false,
    );
    journals.push(restored);
    expect(restored.accept("host", delivery, "native", false)).toMatchObject({
      invoke: false,
      receipt: {
        state: "uncertain",
        nativeSessionId: "native",
        attemptId: accepted.receipt.attemptId,
      },
    });
    expect(
      restored.accept("host", { ...delivery, attachments: [] }, "native", false).invoke,
    ).toBe(false);
    expect(() =>
      restored.accept(
        "host",
        { ...delivery, attachments: [attachment] },
        "native",
        false,
      ),
    ).toThrow("different");
    // The native turn that received it died with the old Node process. What is
    // unknown is consumption, not whether it is still running: the delivery is
    // never replayed, but it no longer holds the conversation or blocks update.
    expect(restored.reserved("another-fleet-id", "native")).toBe(false);
    expect(restored.reserved("lead")).toBe(false);
    expect(restored.unsettled).toBe(false);
    expect(() =>
      restored.accept("host", { ...delivery, prompt: "changed" }, "native", false),
    ).toThrow("different");
    restored.replay("host");
    expect(f.receipts.at(-1)?.state).toBe("uncertain");
  });

  it("lets a lead resume and take new prompts after the Node restarted mid-handoff", async () => {
    const f = fixture();
    const prompts: { sessionId: string; text: string }[] = [];
    const start: AgentFactory["start"] = async (sessionId, _cwd, emit, options) => {
      emit({
        eventId: randomUUID(),
        sessionId,
        sequence: (options?.sequenceOffset ?? 0) + 1,
        type: "agent_session",
        payload: { agentSessionId: options?.resumeAgentSessionId ?? "native" },
        createdAt: new Date().toISOString(),
      });
      return {
        busy: false,
        prompt: vi.fn(async (text: string) => {
          prompts.push({ sessionId, text });
          // Never answers: the turn is still in flight when the Node goes away.
          await new Promise<void>(() => {});
        }),
        cancel: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        resync: vi.fn(),
        resolvePermission: vi.fn(),
        denyPendingPermissions: vi.fn(),
        setConfigOption: vi.fn(async () => {}),
      };
    };
    const routerFor = (journal: LeadPromptJournal) =>
      new CommandRouter(
        { start },
        1,
        () => {},
        async (path) => path,
        () => "",
        async () => [],
        () => {},
        { leadDeliveries: journal },
      );
    const resume = (commandId: string) => ({
      type: "resume_session" as const,
      commandId,
      sessionId: "lead",
      agentSessionId: "native",
      localPath: "C:\\private-coordinator",
      additionalDirectories: [],
      sequenceOffset: 0,
      readOnly: false,
      yolo: false,
      agent: "",
      mcpServers: [],
      config: [],
    });
    const before = routerFor(f.journal);
    expect((await before.route(resume("before-restart"))).ok).toBe(true);
    const interrupted = {
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "command completed",
    };
    expect((await before.deliverLeadPrompt("host", interrupted)).state).toBe("accepted");
    expect(f.journal.reserved("lead", "native")).toBe(true);

    // The Node process restarts with the handoff still inside a native turn.
    f.journal.close();
    journals.splice(journals.indexOf(f.journal), 1);
    const restored = new LeadPromptJournal(
      f.directory,
      (receipt) => f.receipts.push(receipt),
      false,
    );
    journals.push(restored);
    const after = routerFor(restored);

    expect(await after.route(resume("after-restart"))).toMatchObject({ ok: true });
    // The Host replays what it still holds; the interrupted handoff is reported,
    // never prompted into the resumed conversation a second time.
    expect(await after.deliverLeadPrompt("host", interrupted)).toMatchObject({
      state: "uncertain",
    });
    expect(prompts).toEqual([{ sessionId: "lead", text: "command completed" }]);
    expect(
      await after.route({
        type: "prompt",
        commandId: "human-after-restart",
        sessionId: "lead",
        prompt: "carry on",
        attachments: [],
      }),
    ).toMatchObject({ ok: true });
    expect(prompts.at(-1)).toEqual({ sessionId: "lead", text: "carry on" });
    await after.stopAll();
    await before.stopAll();
  });
});
