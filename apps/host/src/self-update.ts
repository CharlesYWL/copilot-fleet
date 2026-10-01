import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, fstatSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, win32 } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import {
  errorMessage,
  updateFinished,
  type FleetSession,
  type HostLaunchMode,
  type HostUpdateStatus,
} from "@fleet/protocol";
import {
  LAUNCHER_ENDPOINT_ENV,
  LAUNCHER_SCRIPT_ENV,
  LAUNCHER_TOKEN_ENV,
  isProcessAlive,
  nodeConfigDirectory,
} from "@fleet/protocol/runtime";
import {
  checkoutLockHolder,
  describeUncommittedChanges,
  readUpdateRecord,
  uncommittedFiles,
  writeUpdateRecord,
  type UpdateRecord,
} from "@fleet/protocol/updater";

/**
 * The Host updating itself: the same pull, install and build a Node does, and
 * then a restart the way the Host was started.
 *
 * None of the work happens in this process. Under `npm run dev` the file
 * watcher would restart it halfway through the update, and in every mode the
 * process being replaced cannot be the one that brings its replacement up. So
 * the Host hands the update to whatever started it — the launcher behind `npm
 * run dev` and `npm start`, or a one-off task beside the Windows login service
 * — and follows it through the record that updater keeps. The record outlives
 * the restart, which is how the Host that comes back knows how it went.
 */

/** How the Host was started, with what it takes to ask for an update there. */
export type HostLaunch =
  | {
      mode: Extract<HostLaunchMode, "dev" | "dev:tunnel" | "start">;
      restartCommand: string;
      endpoint: string;
      token: string;
    }
  | { mode: "service"; restartCommand: string; restartKind: "host+node" | "host" }
  | { mode: "manual"; reason: string };

export const MANUAL_LAUNCH_REASON =
  "This Host was not started with npm run dev, npm start or the Windows login service, so nothing would start it again after an update. Start it one of those ways to update it from here.";

/** The in-memory database tests use has no directory to keep a record in. */
export const NO_RECORD_REASON =
  "This Host keeps no data directory, so it has nowhere to follow an update from.";

/** With a heartbeat every 30 seconds, this much silence means the updater died. */
const STALE_AFTER_MS = 5 * 60_000;
/** How long an updater has to take up a request before it counts as lost. */
const START_GRACE_MS = 2 * 60_000;
/** How long the restarted Host waits for the Node beside it to come back. */
const LOCAL_NODE_GRACE_MS = 3 * 60_000;
/** Reads of a record that exists but will not parse, before giving up on it. */
const STARTUP_READ_ATTEMPTS = 20;

const LAUNCHED = new Set(["dev", "dev:tunnel", "start"]);

type ServiceManifest = { repositoryPath: string; logPath: string };

export type LaunchProbe = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  repoRoot: string;
  /** The login-service manifest for one workload, when it is installed. */
  readServiceManifest: (kind: "host" | "node") => ServiceManifest | undefined;
  /** Whether this process's standard output is the file at `path`. */
  stdoutIs: (path: string) => boolean;
};

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
    : left === right;
}

/**
 * Works out how this Host was started.
 *
 * The launcher says so in the environment it hands down. The login service
 * cannot — its runner is a copy installed under `%LOCALAPPDATA%`, which an
 * update of the checkout does not replace — so it is recognised by what it does
 * instead: it points the Host's output at the log its manifest names. Nothing
 * else writes a Host's output into that file, which is what makes the check
 * safe to act on; a Host that merely has a login service installed beside it
 * is not mistaken for one started by it.
 */
export function detectHostLaunch(probe: LaunchProbe): HostLaunch {
  const { env, platform, repoRoot } = probe;
  const script = env[LAUNCHER_SCRIPT_ENV];
  const endpoint = env[LAUNCHER_ENDPOINT_ENV];
  const token = env[LAUNCHER_TOKEN_ENV];
  if (script && LAUNCHED.has(script) && endpoint && token) {
    return {
      mode: script as "dev" | "dev:tunnel" | "start",
      restartCommand: script === "start" ? "npm start" : `npm run ${script}`,
      endpoint,
      token,
    };
  }
  if (platform === "win32") {
    const host = probe.readServiceManifest("host");
    if (
      host &&
      samePath(host.repositoryPath, repoRoot, platform) &&
      probe.stdoutIs(host.logPath)
    ) {
      const node = probe.readServiceManifest("node");
      const restartKind =
        node && samePath(node.repositoryPath, repoRoot, platform) ? "host+node" : "host";
      return {
        mode: "service",
        restartCommand: `npm run service -- ${restartKind} restart`,
        restartKind,
      };
    }
  }
  return { mode: "manual", reason: MANUAL_LAUNCH_REASON };
}

function readServiceManifest(
  env: NodeJS.ProcessEnv,
  kind: "host" | "node",
): ServiceManifest | undefined {
  if (!env.LOCALAPPDATA) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(
        win32.join(env.LOCALAPPDATA, "CopilotFleet", "login", kind, "manifest.json"),
        "utf8",
      ).replace(/^\uFEFF/, ""),
    ) as { kind?: unknown; repositoryPath?: unknown; logPath?: unknown };
    if (
      manifest.kind !== kind ||
      typeof manifest.repositoryPath !== "string" ||
      typeof manifest.logPath !== "string"
    ) {
      return undefined;
    }
    return { repositoryPath: manifest.repositoryPath, logPath: manifest.logPath };
  } catch {
    return undefined;
  }
}

function stdoutIs(path: string): boolean {
  try {
    const output = fstatSync(1, { bigint: true });
    if (!output.isFile() || output.ino === 0n) return false;
    const file = statSync(path, { bigint: true });
    return output.ino === file.ino && output.dev === file.dev;
  } catch {
    return false;
  }
}

export function defaultLaunchProbe(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LaunchProbe {
  return {
    env,
    platform: process.platform,
    repoRoot,
    readServiceManifest: (kind) => readServiceManifest(env, kind),
    stdoutIs,
  };
}

/**
 * The id of the Node started beside this Host, from its identity file.
 *
 * Both processes run as the same user on the same machine, so the Host finds
 * the file where that Node keeps it. Only the id is taken from it.
 */
export function readLocalNodeId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const identity = JSON.parse(
      readFileSync(join(nodeConfigDirectory(env), "node.json"), "utf8"),
    ) as { nodeId?: unknown };
    return typeof identity.nodeId === "string" && identity.nodeId
      ? identity.nodeId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why updating would throw work away, if it would.
 *
 * The update resets the checkout hard onto its upstream, as a Node's does. A
 * Node's checkout is a deployment; the Host's is often where somebody is also
 * working, and uncommitted edits are the one thing a reset loses for good —
 * unlike a local commit, which the reflog keeps. Asked here so the browser
 * hears at once; the updater asks again just before it resets.
 */
export async function uncommittedChanges(repoRoot: string): Promise<string | undefined> {
  const changed = await uncommittedFiles(repoRoot);
  if (!changed.ok) return changed.reason;
  return changed.files.length > 0
    ? describeUncommittedChanges(repoRoot, changed.files)
    : undefined;
}

/** Who holds the checkout, when some other update has it. */
export function checkoutBusy(repoRoot: string): string | undefined {
  const holder = checkoutLockHolder(repoRoot);
  return holder
    ? `Another update of this checkout is running (process ${holder.pid}, since ${holder.at}); try again when it has finished`
    : undefined;
}

export type LauncherRequest = {
  token: string;
  type: "update";
  updateId: string;
  statusFile: string;
};

/** Asks the launcher to update; resolves once it has taken the update on. */
export function requestLauncherUpdate(
  endpoint: string,
  message: LauncherRequest,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let reply = "";
    const socket = connect(endpoint);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("the launcher did not answer")),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const newline = reply.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(reply.slice(0, newline)) as {
          ok?: unknown;
          error?: unknown;
        };
        finish(
          parsed.ok === true
            ? undefined
            : new Error(
                typeof parsed.error === "string"
                  ? parsed.error
                  : "the launcher refused the update",
              ),
        );
      } catch {
        finish(new Error("the launcher sent a reply that was not JSON"));
      }
    });
    socket.once("error", (error) =>
      finish(new Error(`the launcher is not reachable (${error.message})`)),
    );
    socket.once("close", () =>
      finish(new Error("the launcher hung up without answering")),
    );
  });
}

export type ServiceRequest = {
  statusFile: string;
  updateId: string;
  restartKind: "host+node" | "host";
  runningRevision: string;
};

/**
 * Registers and starts the one-off task that updates a login-service Host.
 *
 * `scripts/self-update.mjs` does the Windows side; this only runs it and reads
 * the one line it answers with.
 */
export function scheduleServiceUpdate(
  request: ServiceRequest,
  { repoRoot, nodePath = process.execPath }: { repoRoot: string; nodePath?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      nodePath,
      [
        join(repoRoot, "scripts", "self-update.mjs"),
        "schedule",
        "--status",
        request.statusFile,
        "--update-id",
        request.updateId,
        "--restart",
        request.restartKind,
        ...(request.runningRevision
          ? ["--running-revision", request.runningRevision]
          : []),
      ],
      { cwd: repoRoot, windowsHide: true, timeout: 120_000, encoding: "utf8" },
      (error, stdout) => {
        const line =
          String(stdout ?? "")
            .trim()
            .split(/\r?\n/)
            .at(-1) ?? "";
        let reply: { ok?: unknown; error?: unknown } | undefined;
        try {
          reply = JSON.parse(line) as { ok?: unknown; error?: unknown };
        } catch {
          reply = undefined;
        }
        if (reply?.ok === true) return resolve();
        reject(
          new Error(
            typeof reply?.error === "string"
              ? reply.error
              : (error?.message ?? "the update task could not be scheduled"),
          ),
        );
      },
    );
  });
}

export type HostSelfUpdateOptions = {
  launch: HostLaunch;
  /** Where the record lives; undefined when this Host keeps no data directory. */
  statusFile: string | undefined;
  /** HEAD when this process started, which is what a login service is running. */
  startupRevision?: () => string;
  /** The commit this Host's checkout is on, asked when a restart is confirmed. */
  currentRevision: () => string;
  /** When this process started, in epoch milliseconds. */
  startedAt: number;
  publish: (status: HostUpdateStatus) => void;
  localNodeId: () => string | undefined;
  /**
   * The Node beside this Host as this Host knows it: undefined when it knows
   * no such Node — enrolled with another fleet, say — and so will not wait for it.
   */
  localNodeState: (nodeId: string) => { online: boolean; revision: string } | undefined;
  liveSessions: (nodeId: string) => FleetSession[];
  nodeUpdateInFlight: (nodeId: string) => boolean;
  stopSessions: (nodeId: string, sessions: readonly FleetSession[]) => void;
  /** Some other update holding the checkout, even one from before a restart. */
  checkoutBusy: () => string | undefined;
  uncommittedChanges: () => Promise<string | undefined>;
  requestLauncher: (endpoint: string, message: LauncherRequest) => Promise<void>;
  scheduleService: (request: ServiceRequest) => Promise<void>;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pollMs?: number;
};

export type HostUpdateRequestResult =
  | { started: true }
  | { started: false; status: number; reason: string; blockedBy?: FleetSession[] };

function refuse(
  status: number,
  reason: string,
  blockedBy?: FleetSession[],
): HostUpdateRequestResult {
  return { started: false, status, reason, ...(blockedBy ? { blockedBy } : {}) };
}

/** Only what a browser renders; comparing these decides whether to publish. */
function progressOf(record: UpdateRecord | undefined) {
  return record
    ? {
        updateId: record.updateId,
        stage: record.stage,
        detail: record.detail,
        revision: record.revision,
        updatedAt: record.updatedAt,
      }
    : undefined;
}

export class HostSelfUpdate {
  private record: UpdateRecord | undefined;
  private timer: NodeJS.Timeout | undefined;
  private requesting = false;
  /** When this Host started serving; the Node beside it is waited for from then. */
  private readyAt: number | undefined;
  private startupReads = 0;
  private closed = false;

  constructor(private readonly options: HostSelfUpdateOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  status(): HostUpdateStatus {
    const { launch, statusFile } = this.options;
    const update = progressOf(this.record);
    return {
      launch: launch.mode,
      restartCommand: launch.mode === "manual" ? "" : launch.restartCommand,
      unavailableReason:
        launch.mode === "manual" ? launch.reason : statusFile ? "" : NO_RECORD_REASON,
      ...(update ? { update } : {}),
    };
  }

  /** Reads what the last update left behind, and follows one still running. */
  start(): void {
    const path = this.options.statusFile;
    if (!path) return;
    const read = readUpdateRecord(path);
    if (read || !existsSync(path)) {
      this.observe(read);
      return;
    }
    // There, but not readable this instant — mid-rename, briefly locked. A
    // restarted Host that gave up here would never confirm its own restart.
    this.startupReads = STARTUP_READ_ATTEMPTS;
    this.poll();
  }

  /**
   * This Host is serving. A restart that only launched it can be confirmed
   * from now on, and not before: a Host that cannot bind its port never gets
   * this far.
   */
  ready(): void {
    this.readyAt ??= this.now();
    if (this.record && !updateFinished(this.record.stage)) this.observe(this.record);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private inFlight(): boolean {
    return this.record !== undefined && !updateFinished(this.record.stage);
  }

  /** Whether this process is the one a restart in the record brought up. */
  private replacedByRestart(record: UpdateRecord): boolean {
    return (
      record.stage === "restarting" &&
      record.restartRequestedAt !== undefined &&
      this.options.startedAt > Date.parse(record.restartRequestedAt)
    );
  }

  /** Why the Node beside this Host may not update by itself right now. */
  blocksNodeUpdate(nodeId: string): string | undefined {
    if (!this.inFlight() || this.options.localNodeId() !== nodeId) return undefined;
    return "The Host is updating this machine's checkout, and this Node restarts with it";
  }

  /**
   * Why a session may not start or resume on this Node right now.
   *
   * Between the operator agreeing which sessions to stop and the restart that
   * stops them, anything new started there would be killed without anyone
   * having been asked. A Host the restart has already replaced lifts it: the
   * Node it was protecting has restarted too.
   */
  blocksNodeWork(nodeId: string): string | undefined {
    const record = this.record;
    if (!record || updateFinished(record.stage) || this.replacedByRestart(record)) {
      return undefined;
    }
    if (this.options.localNodeId() !== nodeId) return undefined;
    return "This machine is updating the Host and restarts its Node with it; try again once the update has finished";
  }

  /**
   * Starts an update, or says why not.
   *
   * `sessionIds` are the local Node's sessions the operator agreed to stop,
   * as the refusal listed them. Consent covers those and only those: a session
   * started since is named in a fresh refusal rather than stopped unseen.
   */
  async request({
    stopSessions = false,
    sessionIds = [],
  }: {
    stopSessions?: boolean;
    sessionIds?: readonly string[];
  } = {}): Promise<HostUpdateRequestResult> {
    const { launch, statusFile } = this.options;
    if (launch.mode === "manual") return refuse(409, launch.reason);
    if (!statusFile) return refuse(409, NO_RECORD_REASON);
    // Read afresh: the updater may have finished since the last poll.
    this.observe(readUpdateRecord(statusFile));
    if (this.requesting || this.inFlight()) {
      return refuse(409, "A Host update is already running");
    }
    this.requesting = true;
    try {
      const busy = this.options.checkoutBusy();
      if (busy) return refuse(409, busy);
      const nodeId = this.options.localNodeId();
      if (nodeId && this.options.nodeUpdateInFlight(nodeId)) {
        return refuse(
          409,
          "This machine's Node is updating itself; update the Host once it has finished",
        );
      }
      const dirty = await this.options.uncommittedChanges();
      if (dirty) return refuse(409, dirty);
      const live = nodeId ? this.options.liveSessions(nodeId) : [];
      const agreed = new Set(stopSessions ? sessionIds : []);
      if (live.some((session) => !agreed.has(session.id))) {
        return refuse(
          409,
          `This machine's Node is running ${live.length} session(s); updating the Host restarts it and would stop them`,
          live,
        );
      }

      const updateId = randomUUID();
      const at = new Date(this.now()).toISOString();
      this.save({
        updateId,
        stage: "checking",
        detail: "Update requested",
        restartCommand: launch.restartCommand,
        revision: "",
        requestedAt: at,
        updatedAt: at,
        // Both restarts end with processes only the new Host can vouch for.
        confirmRestart: "host",
      });
      try {
        if (launch.mode === "service") {
          await this.options.scheduleService({
            statusFile,
            updateId,
            restartKind: launch.restartKind,
            runningRevision: this.options.startupRevision?.() ?? "",
          });
        } else {
          await this.options.requestLauncher(launch.endpoint, {
            token: launch.token,
            type: "update",
            updateId,
            statusFile,
          });
        }
      } catch (error) {
        const reason = `Could not start the update: ${errorMessage(error)}`;
        this.options.log.warn({ updateId }, reason);
        // Whatever the updater managed to write is kept; only an untouched
        // request is marked as the failure it is.
        const current = readUpdateRecord(statusFile);
        if (
          !current ||
          (current.updateId === updateId && current.updaterPid === undefined)
        ) {
          this.save({
            ...(current ?? this.record!),
            stage: "failed",
            detail: reason,
            updatedAt: new Date(this.now()).toISOString(),
          });
        }
        return refuse(502, reason);
      }
      if (nodeId && live.length > 0) this.options.stopSessions(nodeId, live);
      this.options.log.info(
        { updateId, launch: launch.mode },
        `Host update started; ${launch.restartCommand} restarts it`,
      );
      this.poll();
      return { started: true };
    } finally {
      this.requesting = false;
    }
  }

  /** Writes the record and tells browsers, for the changes this process makes. */
  private save(record: UpdateRecord): void {
    try {
      writeUpdateRecord(this.options.statusFile!, record);
    } catch (error) {
      this.options.log.warn(
        { err: error },
        "Could not write the Host update record; progress may not survive a restart",
      );
    }
    this.record = record;
    this.options.publish(this.status());
  }

  private poll(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const path = this.options.statusFile;
      if (!path) return;
      const read = readUpdateRecord(path);
      if (!read && !this.record && this.startupReads > 0 && existsSync(path)) {
        this.startupReads -= 1;
        this.poll();
        return;
      }
      this.startupReads = 0;
      this.observe(read);
    }, this.options.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  private observe(read: UpdateRecord | undefined): void {
    // A record that cannot be read this instant — mid-rename, briefly locked —
    // is not an update that ended; one this Host was following stays followed.
    const current = read ?? (this.inFlight() ? this.record : undefined);
    const record = current ? this.settle(current) : undefined;
    const changed =
      JSON.stringify(progressOf(record)) !== JSON.stringify(progressOf(this.record));
    this.record = record;
    if (changed) this.options.publish(this.status());
    if (record && !updateFinished(record.stage)) this.poll();
  }

  /**
   * Finishes a record nobody else will.
   *
   * A restart is confirmed by the Host it brought up — the only process that
   * can see the outcome — once it is serving, from the build it is running,
   * and with the Node beside it back on that build too: a Host that came back
   * alone is no proof its Node did. Everything else is the updater's to
   * finish, and an updater that has stopped writing — its heartbeat gone quiet,
   * or its process gone — has failed, whatever stage it reached.
   */
  private settle(record: UpdateRecord): UpdateRecord {
    if (updateFinished(record.stage)) return record;
    const now = this.now();
    if (this.replacedByRestart(record) && record.confirmRestart === "host") {
      return this.confirmRestart(record, now);
    }
    const quiet = now - Date.parse(record.updatedAt);
    const running =
      record.updaterPid !== undefined
        ? (this.options.isAlive ?? isProcessAlive)(record.updaterPid)
        : now - Date.parse(record.requestedAt) < START_GRACE_MS;
    if (running && quiet < STALE_AFTER_MS) return record;
    return this.finish(record, {
      stage: "failed",
      detail:
        record.updaterPid === undefined
          ? "The update was never picked up by the process that runs it"
          : running
            ? `The update stopped making progress (last: ${record.detail})`
            : `The update stopped before it finished (last: ${record.detail})`,
    });
  }

  private confirmRestart(record: UpdateRecord, now: number): UpdateRecord {
    if (this.readyAt === undefined) return record;
    const matches = (revision: string) =>
      revision !== "" &&
      record.revision !== "" &&
      revision.slice(0, 12) === record.revision.slice(0, 12);
    const running = this.options.currentRevision().trim();
    if (!matches(running)) {
      return this.finish(record, {
        stage: "failed",
        detail: `The Host came back on ${running.slice(0, 12) || "an unknown commit"}, not ${record.revision}`,
      });
    }
    const nodeId = this.options.localNodeId();
    const node = nodeId ? this.options.localNodeState(nodeId) : undefined;
    if (node && !(node.online && matches(node.revision))) {
      if (now - this.readyAt < LOCAL_NODE_GRACE_MS) return record;
      return this.finish(record, {
        stage: "failed",
        detail: node.online
          ? `The Host is on ${record.revision}, but this machine's Node came back on ${node.revision.slice(0, 12) || "an unknown commit"}`
          : `The Host is on ${record.revision}, but this machine's Node did not come back`,
      });
    }
    return this.finish(record, {
      stage: "up_to_date",
      detail: `Updated to ${record.revision}`,
    });
  }

  private finish(
    record: UpdateRecord,
    outcome: Pick<UpdateRecord, "stage" | "detail">,
  ): UpdateRecord {
    const settled = {
      ...record,
      ...outcome,
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      writeUpdateRecord(this.options.statusFile!, settled);
    } catch (error) {
      this.options.log.warn({ err: error }, "Could not record how the Host update ended");
    }
    return settled;
  }
}
