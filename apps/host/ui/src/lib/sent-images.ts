import {
  base64Bytes,
  type AttachmentSummary,
  type PromptAttachment,
} from "@fleet/protocol";
import { isImageAttachment } from "./attachments";

/**
 * Images this browser sent, kept so a sent message's chip can still open them.
 *
 * The transcript keeps only an attachment's name, type and size (see
 * docs/guide/using-fleet.md), because it is stored on the Host and replayed to
 * every browser. The bytes already sat in this browser's memory when they were
 * sent, so keeping a copy here costs the Host nothing and widens nobody's
 * access: another browser, or this one after sign-out, still sees only names.
 *
 * IndexedDB keeps the copies across reloads. Where it is unavailable (private
 * windows that refuse it, tests) the copies last for the page's lifetime only.
 */

export type SentImage = {
  sessionId: string;
  name: string;
  mimeType: string;
  bytes: number;
  data: string;
  /** Epoch milliseconds when this browser handed the prompt to the Host. */
  savedAt: number;
};

type StoredSentImage = SentImage & { matchKey: string; id?: number };

const DATABASE_NAME = "fleet-sent-images";
const STORE_NAME = "images";
const MATCH_INDEX = "matchKey";
const SAVED_AT_INDEX = "savedAt";

/** At 10 MB a prompt, this bounds the copies near the size of a few prompts' worth. */
export const MAX_SENT_IMAGES = 60;
export const SENT_IMAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const pageImages: StoredSentImage[] = [];
let databasePromise: Promise<IDBDatabase | undefined> | undefined;
const listeners = new Set<() => void>();

const announceChange = () => listeners.forEach((listener) => listener());

/**
 * Called whenever kept images change.
 *
 * A sent message can reach the transcript before its images are saved, so a
 * chip that found nothing looks again rather than staying a plain name.
 */
export const onSentImagesChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Which transcript chip an image belongs to.
 *
 * The transcript has no attachment id, so a chip is matched on what it does
 * keep. Names are unique within one prompt, and the session and byte count
 * separate the `image1.png` of one prompt from the next.
 */
const matchKeyOf = (
  sessionId: string,
  attachment: Pick<AttachmentSummary, "name" | "mimeType" | "bytes">,
) =>
  [sessionId, attachment.name, attachment.mimeType, String(attachment.bytes)].join(
    "\u0000",
  );

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

/** The database, or nothing when this browser will not provide one. */
const openDatabase = (): Promise<IDBDatabase | undefined> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  databasePromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex(MATCH_INDEX, MATCH_INDEX);
        store.createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      // Some browsers throw rather than fail the request when storage is off.
      resolve(undefined);
    }
  });
  return databasePromise;
};

const prunePageImages = (now: number) => {
  const cutoff = now - SENT_IMAGE_RETENTION_MS;
  for (let index = pageImages.length - 1; index >= 0; index--) {
    if (pageImages[index]!.savedAt < cutoff) pageImages.splice(index, 1);
  }
  if (pageImages.length > MAX_SENT_IMAGES) {
    pageImages.splice(0, pageImages.length - MAX_SENT_IMAGES);
  }
};

/** Drops copies past the retention window, then the oldest beyond the cap. */
const pruneDatabase = async (database: IDBDatabase, now: number) => {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const index = transaction.objectStore(STORE_NAME).index(SAVED_AT_INDEX);
  const total = await requestResult(index.count());
  let excess = Math.max(0, total - MAX_SENT_IMAGES);
  const cutoff = now - SENT_IMAGE_RETENTION_MS;
  const cursorRequest = index.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const record = cursor.value as StoredSentImage;
    if (excess <= 0 && record.savedAt >= cutoff) return;
    cursor.delete();
    excess--;
    cursor.continue();
  };
  await transactionDone(transaction);
};

/**
 * Keeps the images among `attachments` as they are sent.
 *
 * Saved before the Host answers, because its echo of the message can arrive
 * first. A send that fails leaves a copy no chip refers to, which the
 * retention limits remove like any other.
 */
export const saveSentImages = async (
  sessionId: string,
  attachments: readonly PromptAttachment[],
  now = Date.now(),
): Promise<void> => {
  const records: StoredSentImage[] = attachments
    .filter(isImageAttachment)
    .map((attachment) => {
      const bytes = base64Bytes(attachment.data);
      return {
        sessionId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        bytes,
        data: attachment.data,
        savedAt: now,
        matchKey: matchKeyOf(sessionId, { ...attachment, bytes }),
      };
    });
  if (records.length === 0) return;
  pageImages.push(...records);
  prunePageImages(now);
  announceChange();

  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    // Copies, so the key the store assigns is not written onto the page's records.
    for (const record of records) store.add({ ...record });
    await transactionDone(transaction);
    await pruneDatabase(database, now);
  } catch {
    // A full or refused store only costs the reload copy; this page keeps its own.
  }
};

const storedMatches = async (matchKey: string): Promise<StoredSentImage[]> => {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index(MATCH_INDEX);
    return (await requestResult(index.getAll(matchKey))) as StoredSentImage[];
  } catch {
    return [];
  }
};

/**
 * The image this browser sent for a transcript chip, if it still has it.
 *
 * Should two prompts in one session carry same-named images of the same size,
 * the copy saved nearest the message's time is the one shown.
 */
export const findSentImage = async (
  sessionId: string,
  attachment: Pick<AttachmentSummary, "name" | "mimeType" | "bytes">,
  sentAt: string,
): Promise<SentImage | undefined> => {
  const matchKey = matchKeyOf(sessionId, attachment);
  const candidates = new Map<string, StoredSentImage>();
  const remember = (record: StoredSentImage) =>
    candidates.set(`${record.savedAt}:${record.data.length}`, record);
  pageImages.filter((record) => record.matchKey === matchKey).forEach(remember);
  (await storedMatches(matchKey)).forEach(remember);
  if (candidates.size === 0) return undefined;

  const target = Date.parse(sentAt);
  const distance = (record: StoredSentImage) =>
    Number.isNaN(target) ? -record.savedAt : Math.abs(record.savedAt - target);
  const [closest] = [...candidates.values()].sort(
    (left, right) => distance(left) - distance(right),
  );
  if (!closest) return undefined;
  const { matchKey: _matchKey, id: _id, ...image } = closest;
  return image;
};

/** Forgets every kept image, so the next person on this browser sees names only. */
export const clearSentImages = async (): Promise<void> => {
  pageImages.length = 0;
  announceChange();
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  } catch {
    // Nothing more can be done from the page; the retention window still applies.
  }
};
