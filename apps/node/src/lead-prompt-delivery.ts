import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LeadPromptDeliverySchema,
  LeadPromptReceiptSchema,
  type LeadPromptDelivery,
  type LeadPromptReceipt,
} from "@fleet/protocol";
import { privateJournalDirectory } from "./command-journal.js";

const MAX_SERIALIZED_DELIVERY_BYTES = 16 * 1024 * 1024;

type DeliveryRecord = {
  hostId: string;
  nativeSessionId: string;
  nativeAttempt: string;
  promptDigest: string;
  receipt: LeadPromptReceipt;
};

export class LeadPromptJournal {
  private readonly db: DatabaseSync;
  private readonly pending = new Map<string, LeadPromptReceipt>();
  onFailure: (error: unknown) => void = () => {};
  constructor(
    directory: string,
    private readonly emit: (receipt: LeadPromptReceipt, hostId: string) => unknown,
    secure = true,
  ) {
    if (secure) privateJournalDirectory(directory);
    else mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "lead-deliveries.db"));
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA max_page_count=4096;
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    for (const record of this.all()) {
      if (record.receipt.state === "accepted") {
        record.receipt = {
          ...record.receipt,
          state: "uncertain",
          detail:
            "Node restarted during a native handoff; never automatically re-prompt.",
          at: new Date().toISOString(),
        };
        this.save(record);
      }
    }
  }

  private all(): DeliveryRecord[] {
    return this.db
      .prepare("SELECT data FROM deliveries")
      .all()
      .map((row) => {
        const record = JSON.parse(String(row.data)) as DeliveryRecord;
        if (
          (record.receipt.nativeSessionId !== undefined &&
            record.receipt.nativeSessionId !== record.nativeSessionId) ||
          (record.receipt.attemptId !== undefined &&
            record.receipt.attemptId !== record.nativeAttempt)
        )
          throw new Error(
            "Durable native receipt identity mismatch; reconcile the journal before delivery.",
          );
        record.receipt = LeadPromptReceiptSchema.parse({
          ...record.receipt,
          ...(record.nativeSessionId
            ? {
                nativeSessionId: record.nativeSessionId,
                attemptId: record.nativeAttempt,
              }
            : {}),
        });
        return record;
      });
  }

  private get(id: string): DeliveryRecord | undefined {
    return this.all().find((record) => record.receipt.deliveryId === id);
  }

  get unsettled(): boolean {
    return this.all().some((record) =>
      ["accepted", "uncertain"].includes(record.receipt.state),
    );
  }

  private save(record: DeliveryRecord): void {
    try {
      this.persist(record);
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private persist(record: DeliveryRecord): void {
    LeadPromptReceiptSchema.parse(record.receipt);
    if (!this.get(record.receipt.deliveryId) && this.all().length >= 8192)
      throw new Error("Durable delivery identity storage is full; refuse new prompts.");
    this.db
      .prepare(
        "INSERT INTO deliveries VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.receipt.deliveryId, JSON.stringify(record));
  }

  reserved(sessionId: string, nativeSessionId?: string): boolean {
    return this.all().some(
      (record) =>
        (record.receipt.sessionId === sessionId ||
          (nativeSessionId && record.nativeSessionId === nativeSessionId)) &&
        ["accepted", "uncertain"].includes(record.receipt.state),
    );
  }

  accept(
    hostId: string,
    input: LeadPromptDelivery,
    nativeSessionId: string,
    busy: boolean,
    rejectionReason?: string,
  ): { receipt: LeadPromptReceipt; invoke: boolean } {
    const delivery = LeadPromptDeliverySchema.parse(input);
    const { attachments, ...body } = delivery;
    const serialized = JSON.stringify(
      attachments?.length ? { ...body, attachments } : body,
    );
    if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_DELIVERY_BYTES)
      throw new Error(
        "Durable lead delivery exceeds the 16 MiB serialized payload limit.",
      );
    const digest = createHash("sha256").update(serialized).digest("hex");
    const prior = this.get(delivery.deliveryId);
    if (prior) {
      if (prior.hostId !== hostId || prior.promptDigest !== digest)
        throw new Error("Durable delivery identity was reused with different content.");
      if (prior.receipt.state !== "rejected_busy") {
        this.publish(prior.receipt);
        return { receipt: prior.receipt, invoke: false };
      }
    }
    for (const attachment of attachments ?? []) {
      const encoded = attachment.data.replace(/\s/g, "");
      const canonical = Buffer.from(encoded, "base64").toString("base64");
      if (
        !canonical ||
        (encoded !== canonical && encoded !== canonical.replace(/=+$/, ""))
      ) {
        rejectionReason ??= `Attachment "${attachment.name}" does not contain valid Base64 data.`;
        break;
      }
    }
    const state =
      rejectionReason || !nativeSessionId
        ? "rejected"
        : busy || this.reserved(delivery.sessionId, nativeSessionId)
          ? "rejected_busy"
          : "accepted";
    const nativeAttempt = randomUUID();
    const record: DeliveryRecord = {
      hostId,
      nativeSessionId,
      nativeAttempt,
      promptDigest: digest,
      receipt: {
        deliveryId: delivery.deliveryId,
        sessionId: delivery.sessionId,
        state,
        ...(nativeSessionId ? { nativeSessionId, attemptId: nativeAttempt } : {}),
        detail:
          rejectionReason ??
          (state === "accepted"
            ? "Durably admitted for native handoff; model consumption is not asserted."
            : state === "rejected_busy"
              ? "Native conversation has another prompt reservation or active turn."
              : "Native conversation is not available."),
        at: new Date().toISOString(),
      },
    };
    // This commit MUST precede any possible ACP.prompt side effect.
    this.save(record);
    this.publish(record.receipt);
    return { receipt: record.receipt, invoke: state === "accepted" };
  }

  settle(deliveryId: string, nativeSessionId: string): void {
    const record = this.get(deliveryId);
    if (!record || record.receipt.state !== "accepted") return;
    this.transition(
      record,
      record.nativeSessionId === nativeSessionId ? "settled" : "uncertain",
      record.nativeSessionId === nativeSessionId
        ? "Authoritative current native turn completed."
        : "Native conversation changed during handoff.",
    );
  }

  uncertain(deliveryId: string, detail: string): void {
    const record = this.get(deliveryId);
    if (record && record.receipt.state === "accepted")
      this.transition(record, "uncertain", detail);
  }

  private transition(
    record: DeliveryRecord,
    state: LeadPromptReceipt["state"],
    detail: string,
  ): void {
    record.receipt = {
      ...record.receipt,
      state,
      detail: detail.slice(0, 4000),
      at: new Date().toISOString(),
    };
    this.save(record);
    this.publish(record.receipt);
  }

  replay(hostId: string): void {
    for (const record of this.all())
      if (record.hostId === hostId) this.publish(record.receipt);
  }

  private publish(receipt: LeadPromptReceipt): void {
    if (this.emit(receipt, this.get(receipt.deliveryId)!.hostId) === false)
      this.pending.set(receipt.deliveryId, receipt);
    else this.pending.delete(receipt.deliveryId);
  }

  flush(hostId: string): void {
    for (const receipt of this.pending.values()) {
      if (this.get(receipt.deliveryId)?.hostId !== hostId) continue;
      if (this.emit(receipt, hostId) === false) break;
      this.pending.delete(receipt.deliveryId);
    }
  }

  close(): void {
    this.db.close();
  }
}
