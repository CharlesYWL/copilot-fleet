import { createHash, randomUUID } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  STORE_LIMITS,
  STORE_SCHEMA_VERSION,
  StoreSchema,
  type Receipt,
  type Store,
} from "./contracts.js";

/** A failure the caller can act on; `code` is stable and appears in CLI output. */
export class PrmError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type StateRoot = {
  /** Canonical absolute directory that holds `store.json`. */
  dir: string;
  storeFile: string;
  bindingFile: string;
  lockDir: string;
};

type LockOwner = {
  lockId: string;
  pid: number;
  hostname: string;
  command: string;
  acquiredAt: string;
};

const STORE_FILE = "store.json";
const BINDING_FILE = "binding.json";
const LOCK_DIR = "writer.lock";
const RENAME_RETRIES = 10;
const RENAME_RETRY_MS = 50;

/** Canonical JSON: sorted keys, so equal payloads hash equally. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** OS-level canonical path: expands Windows 8.3 short names and resolves links. */
const realpath = { native: promisify(realpathCallback.native) };

/**
 * Resolve the state directory. It must be absolute, must not be inside the
 * installed skill (updates would erase it), and is canonicalized so two
 * spellings of one directory cannot become two owners.
 */
export const resolveStateRoot = async (
  requested: string,
  skillDir?: string,
): Promise<StateRoot> => {
  if (!isAbsolute(requested))
    throw new PrmError(
      "invalid_state_root",
      "The state directory must be an absolute path.",
      { requested },
    );
  let dir = resolve(requested);
  if (await exists(dir)) dir = await realpath.native(dir);
  else {
    // Canonicalize the nearest existing ancestor so 8.3 short names and links
    // cannot make one directory look like two.
    let ancestor = dirname(dir);
    while (!(await exists(ancestor)) && dirname(ancestor) !== ancestor)
      ancestor = dirname(ancestor);
    if (await exists(ancestor))
      dir = join(await realpath.native(ancestor), relative(ancestor, dir));
  }
  if (skillDir) {
    const skill = await realpath.native(skillDir).catch(() => resolve(skillDir));
    const normalize = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const inside = relative(normalize(skill), normalize(dir));
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
      throw new PrmError(
        "invalid_state_root",
        "Keep state outside the installed skill folder; skill updates would delete it.",
        { requested, skillDir: skill },
      );
  }
  return {
    dir,
    storeFile: join(dir, STORE_FILE),
    bindingFile: join(dir, BINDING_FILE),
    lockDir: join(dir, LOCK_DIR),
  };
};

const readLockOwner = async (root: StateRoot): Promise<LockOwner | undefined> => {
  try {
    return JSON.parse(
      await readFile(join(root.lockDir, "owner.json"), "utf8"),
    ) as LockOwner;
  } catch {
    return undefined;
  }
};

/** Exclusive, non-spinning lock. A held lock is reported, never stolen by age. */
const acquireLock = async (root: StateRoot, command: string): Promise<LockOwner> => {
  const owner: LockOwner = {
    lockId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    command,
    acquiredAt: new Date().toISOString(),
  };
  try {
    await mkdir(root.lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new PrmError(
      "state_busy",
      "Another prm command holds the state lock. Retry shortly. If no prm command is running, ask the user before running `prm recover --lock <lockId>`.",
      { lock: (await readLockOwner(root)) ?? null },
    );
  }
  await writeFile(join(root.lockDir, "owner.json"), JSON.stringify(owner));
  return owner;
};

const releaseLock = async (root: StateRoot, owner: LockOwner): Promise<void> => {
  const current = await readLockOwner(root);
  if (current && current.lockId !== owner.lockId) return;
  await rm(root.lockDir, { recursive: true, force: true });
};

/** Remove one named orphan lock. Operator action only. */
export const removeOrphanLock = async (
  root: StateRoot,
  lockId: string,
): Promise<LockOwner | null> => {
  if (!(await exists(root.lockDir)))
    throw new PrmError("lock_not_found", "There is no writer lock to remove.");
  const current = await readLockOwner(root);
  if (current && current.lockId !== lockId)
    throw new PrmError(
      "recovery_conflict",
      "The lock is now held by a different owner; nothing was removed.",
      { lock: current },
    );
  await rm(root.lockDir, { recursive: true, force: true });
  return current ?? null;
};

export const readStore = async (root: StateRoot): Promise<Store> => {
  let raw: string;
  try {
    raw = await readFile(root.storeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await exists(root.bindingFile))
      throw new PrmError(
        "state_missing",
        "store.json is missing from an initialized state directory. Do not re-initialize: restore the file or ask the user.",
        { stateRoot: root.dir },
      );
    throw new PrmError(
      "state_uninitialized",
      "No prm state here yet. Run `prm init` once.",
      { stateRoot: root.dir },
    );
  }
  let store: Store;
  try {
    store = StoreSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new PrmError(
      "state_corrupt",
      "store.json failed validation. Do not delete it; ask the user to restore or inspect it.",
      { stateRoot: root.dir, reason: (error as Error).message.slice(0, 2_000) },
    );
  }
  const sameRoot =
    process.platform === "win32"
      ? store.binding.stateRoot.toLowerCase() === root.dir.toLowerCase()
      : store.binding.stateRoot === root.dir;
  if (!sameRoot)
    throw new PrmError(
      "state_root_changed",
      "This store was created for a different directory (copied or moved). Ask the user before using it.",
      { boundTo: store.binding.stateRoot, opened: root.dir },
    );
  return store;
};

const serialize = (store: Store): string => {
  const text = `${JSON.stringify(store, null, 2)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > STORE_LIMITS.bytes)
    throw new PrmError(
      "capacity_exceeded",
      "The state store would exceed its 16 MiB budget. Release settled jobs first.",
      { bytes, limit: STORE_LIMITS.bytes },
    );
  return text;
};

/** Temp file, flush, then replace. The old store survives any failure before rename. */
const replaceStore = async (root: StateRoot, text: string, operationId: string) => {
  const temp = join(
    root.dir,
    `store.${operationId.replace(/[^\w-]/g, "_")}.${process.pid}.tmp`,
  );
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, root.storeFile);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const transient = ["EPERM", "EBUSY", "EACCES"].includes(code);
      if (!transient || attempt >= RENAME_RETRIES) {
        await unlink(temp).catch(() => undefined);
        throw new PrmError(
          "storage_error",
          "Could not replace store.json; the previous version is unchanged. Retry the same command with the same --op.",
          { code },
        );
      }
      await sleep(RENAME_RETRY_MS * attempt);
    }
  }
};

const pruneReceipts = (store: Store, now: number) => {
  const receipts = Object.values(store.receipts)
    .filter((receipt) => now - Date.parse(receipt.at) <= STORE_LIMITS.receiptAgeMs)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, STORE_LIMITS.receipts);
  store.receipts = Object.fromEntries(
    receipts.map((receipt) => [receipt.operationId, receipt]),
  );
};

export type TransactionRequest = {
  command: string;
  /** Stable ID for retries. The same ID with the same payload returns the first result. */
  operationId?: string | undefined;
  payload?: unknown;
  now?: () => number;
};

export type TransactionResult<T> = { result: T; revision: number; replayed: boolean };

/**
 * One serialized read-validate-mutate-replace cycle. `mutate` receives a private
 * copy; throwing from it leaves the store untouched.
 */
export const transact = async <T>(
  root: StateRoot,
  request: TransactionRequest,
  mutate: (store: Store) => T | Promise<T>,
): Promise<TransactionResult<T>> => {
  const now = request.now ?? Date.now;
  const lock = await acquireLock(root, request.command);
  try {
    const store = await readStore(root);
    const payloadHash = sha256(
      canonicalJson({ command: request.command, payload: request.payload ?? null }),
    );
    if (request.operationId) {
      const prior = store.receipts[request.operationId];
      if (prior) {
        if (prior.payloadHash !== payloadHash || prior.command !== request.command)
          throw new PrmError(
            "operation_conflict",
            "This --op ID was already used for a different request. Use a new ID for new work.",
            { operationId: request.operationId, command: prior.command },
          );
        return { result: prior.result as T, revision: store.revision, replayed: true };
      }
    }
    const next = structuredClone(store);
    const result = await mutate(next);
    next.revision = store.revision + 1;
    const operationId = request.operationId ?? randomUUID();
    if (request.operationId) {
      const receipt: Receipt = {
        operationId,
        command: request.command,
        payloadHash,
        revision: next.revision,
        at: new Date(now()).toISOString(),
        result,
      };
      next.receipts[operationId] = receipt;
    }
    pruneReceipts(next, now());
    const validated = StoreSchema.parse(next);
    await replaceStore(root, serialize(validated), operationId);
    return { result, revision: next.revision, replayed: false };
  } finally {
    await releaseLock(root, lock);
  }
};

/** Explicit, idempotent initialization. Never recreates a store that went missing. */
export const initializeStore = async (
  root: StateRoot,
  now: () => number = Date.now,
): Promise<{ store: Store; created: boolean }> => {
  await mkdir(root.dir, { recursive: true });
  const canonical = await resolveStateRoot(await realpath.native(root.dir));
  const lock = await acquireLock(canonical, "init");
  try {
    if (await exists(canonical.storeFile))
      return { store: await readStore(canonical), created: false };
    if (await exists(canonical.bindingFile))
      throw new PrmError(
        "state_missing",
        "This directory was initialized before but store.json is gone. Restore it rather than starting over.",
        { stateRoot: canonical.dir },
      );
    const createdAt = new Date(now()).toISOString();
    const store: Store = StoreSchema.parse({
      schemaVersion: STORE_SCHEMA_VERSION,
      storeId: randomUUID(),
      revision: 0,
      createdAt,
      binding: {
        bindingId: randomUUID(),
        profile: "json-local",
        stateRoot: canonical.dir,
        hostname: hostname(),
      },
      activePass: null,
      scan: { carried: [] },
      jobs: {},
      receipts: {},
    });
    await writeFile(
      canonical.bindingFile,
      JSON.stringify(
        { storeId: store.storeId, bindingId: store.binding.bindingId, createdAt },
        null,
        2,
      ),
      { flag: "wx" },
    );
    await replaceStore(canonical, serialize(store), "init");
    return { store, created: true };
  } finally {
    await releaseLock(canonical, lock);
  }
};
