import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  ModeSchema,
  PlanInputSchema,
  TriageInputSchema,
  WorkReportSchema,
  type Store,
} from "./contracts.js";
import {
  addJob,
  beginPass,
  cancelBatch,
  endPass,
  holdJob,
  pauseJob,
  planBatch,
  recordObservation,
  recoverPass,
  releaseJob,
  reportBatch,
  reserveVisit,
  resumeJob,
  showJob,
  statusView,
  triageJob,
  type EngineDeps,
  type HelperInput,
  type ParsedPrUrl,
  type ProviderResult,
} from "./engine.js";
import {
  PrmError,
  initializeStore,
  readStore,
  removeOrphanLock,
  resolveStateRoot,
  transact,
  type StateRoot,
} from "./state.js";

export const VERSION = "0.1.0";

export type CliDeps = {
  parseUrl: (url: string) => ParsedPrUrl;
  observe: (input: HelperInput) => Promise<ProviderResult>;
  now: () => number;
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  /** Installed skill folder; state may not live inside it. */
  skillDir?: string | undefined;
};

export type CliOutput = { exitCode: number; body: Record<string, unknown> };

const USAGE = `prm ${VERSION} - portable PR maintenance state and provider reads

Usage: node <skill>/scripts/prm.mjs <command> [options]   (all output is JSON)

Global:  --state <dir>   absolute state directory (or PRM_STATE_DIR; default ~/.prm/state)
         --op <id>       stable operation ID; retrying with the same ID returns the first result

Setup:    init
          add <pr-url> --mode observe|answer|repair [--checkout <dir>] [--verify <cmd>]...
              [--baseline <text>] [--resolve-threads] [--interval <minutes>]
              [--launcher <name>] [--session <id>] [--repair-batches N] [--answer-batches N]
          status | show --job <id>
Pass:     begin [--label <text>]
          observe --pass <id> --job <id> [--requests N]
          triage --pass <id> --job <id> --input <file|->
          plan --pass <id> --job <id> --input <file|->
          report --batch <id> --input <file|->
          cancel --batch <id> --reason <text>
          end --pass <id>
Control:  hold --job <id> --kind design|human --reason <text> [--source <sourceId>]...
          pause --job <id> --reason <text>
Human:    resume --job <id> [--clear <holdId>]... --confirm-human <text>
          release --job <id>
          recover --pass <id> --confirm-stopped <text>  |  recover --lock <lockId>`;

const OPTIONS = {
  state: { type: "string" },
  op: { type: "string" },
  mode: { type: "string" },
  checkout: { type: "string" },
  verify: { type: "string", multiple: true },
  baseline: { type: "string" },
  "resolve-threads": { type: "boolean" },
  interval: { type: "string" },
  launcher: { type: "string" },
  session: { type: "string" },
  "repair-batches": { type: "string" },
  "answer-batches": { type: "string" },
  "mutation-attempts": { type: "string" },
  job: { type: "string" },
  pass: { type: "string" },
  batch: { type: "string" },
  requests: { type: "string" },
  input: { type: "string" },
  label: { type: "string" },
  kind: { type: "string" },
  reason: { type: "string" },
  source: { type: "string", multiple: true },
  clear: { type: "string", multiple: true },
  "confirm-human": { type: "string" },
  "confirm-stopped": { type: "string" },
  lock: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} satisfies ParseArgsConfig["options"];

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

const required = (values: Values, name: keyof Values): string => {
  const value = values[name];
  if (typeof value !== "string" || !value.trim())
    throw new PrmError("invalid_args", `Missing --${String(name)}.`);
  return value;
};

const integer = (
  values: Values,
  name: keyof Values,
  min: number,
  max: number,
): number | undefined => {
  const value = values[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new PrmError(
      "invalid_args",
      `--${String(name)} must be an integer from ${min} to ${max}.`,
    );
  return parsed;
};

const readJsonInput = async (values: Values, deps: CliDeps): Promise<unknown> => {
  const source = required(values, "input");
  const text =
    source === "-" ? await deps.readStdin() : await readFile(resolve(source), "utf8");
  if (Buffer.byteLength(text) > 1_048_576)
    throw new PrmError("invalid_input", "Input JSON exceeds 1 MiB.");
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new PrmError("invalid_input", "The --input file is not valid JSON.");
  }
};

const parseWith = <T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: unknown[] } };
  },
  value: unknown,
  what: string,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new PrmError(
      "invalid_input",
      `The ${what} does not match its schema (see schemas/).`,
      {
        issues: parsed.error.issues.slice(0, 20),
      },
    );
  return parsed.data;
};

const stateDir = (values: Values, deps: CliDeps) =>
  values.state ?? deps.env.PRM_STATE_DIR ?? join(homedir(), ".prm", "state");

const engineDeps = (deps: CliDeps): EngineDeps => ({
  parseUrl: deps.parseUrl,
  now: deps.now,
  owner: { hostname: hostname(), pid: process.pid },
});

const parseUrlSafely = (deps: CliDeps) => (url: string) => {
  try {
    return deps.parseUrl(url);
  } catch (error) {
    throw new PrmError(
      "invalid_pr_url",
      `Unsupported PR URL: ${(error as Error).message}`,
    );
  }
};

type Mutation = (store: Store) => unknown;

const mutateWith = async (
  root: StateRoot,
  operationId: string | undefined,
  command: string,
  payload: unknown,
  deps: CliDeps,
  mutate: Mutation,
) => {
  const { result, revision, replayed } = await transact(
    root,
    { command, operationId, payload, now: deps.now },
    mutate,
  );
  return { revision, replayed, ...(result as Record<string, unknown>) };
};

/** observe = reserve (locked) -> provider read (unlocked) -> record (locked). */
const runObserve = async (
  root: StateRoot,
  values: Values,
  deps: CliDeps,
  engine: EngineDeps,
) => {
  const passId = required(values, "pass");
  const jobId = required(values, "job");
  const requests = integer(values, "requests", 1, 40);
  const op = values.op;
  if (op) {
    const prior = (await readStore(root)).receipts[`${op}:record`];
    if (prior)
      return {
        revision: prior.revision,
        replayed: true,
        ...(prior.result as Record<string, unknown>),
      };
  }
  const reservation = await transact(
    root,
    {
      command: "observe.reserve",
      operationId: op ? `${op}:reserve` : undefined,
      payload: { passId, jobId, requests },
      now: deps.now,
    },
    (store) => reserveVisit(store, engine, { passId, jobId, requests }),
  );
  const { reserved, helperInput } = reservation.result;
  let result: ProviderResult | { error: string };
  try {
    result = await deps.observe(helperInput);
  } catch (error) {
    result = { error: `Provider helper failed: ${(error as Error).message}` };
  }
  return mutateWith(
    root,
    op ? `${op}:record` : undefined,
    "observe.record",
    { passId, jobId },
    deps,
    (store) => recordObservation(store, engine, { passId, jobId, reserved, result }),
  );
};

const runCommand = async (
  command: string,
  positionals: string[],
  values: Values,
  deps: CliDeps,
) => {
  const engine = engineDeps({ ...deps, parseUrl: parseUrlSafely(deps) });
  const root = await resolveStateRoot(stateDir(values, deps), deps.skillDir);
  const mutate = (payload: unknown, fn: Mutation) =>
    mutateWith(root, values.op, command, payload, deps, fn);

  switch (command) {
    case "init": {
      const { store, created } = await initializeStore(root, deps.now);
      return {
        created,
        stateRoot: store.binding.stateRoot,
        storeId: store.storeId,
        revision: store.revision,
      };
    }
    case "status":
      return statusView(await readStore(root));
    case "show":
      return showJob(await readStore(root), required(values, "job"));
    case "add": {
      const url = positionals[0];
      if (!url)
        throw new PrmError(
          "invalid_args",
          "Usage: prm add <pr-url> --mode observe|answer|repair ...",
        );
      const mode = parseWith(ModeSchema, values.mode ?? "observe", "--mode");
      const args = {
        url,
        mode,
        checkout: values.checkout ? resolve(values.checkout) : null,
        baseline: values.baseline ?? null,
        verification: values.verify ?? [],
        resolveThreads: values["resolve-threads"] ?? false,
        intervalMinutes: integer(values, "interval", 1, 1_440) ?? 15,
        budgets: {
          ...(integer(values, "repair-batches", 1, 30) !== undefined
            ? { repairBatches: integer(values, "repair-batches", 1, 30)! }
            : {}),
          ...(integer(values, "answer-batches", 1, 30) !== undefined
            ? { answerBatches: integer(values, "answer-batches", 1, 30)! }
            : {}),
          ...(integer(values, "mutation-attempts", 1, 1_000) !== undefined
            ? { mutationAttempts: integer(values, "mutation-attempts", 1, 1_000)! }
            : {}),
        },
        launcher: values.launcher,
        sessionId: values.session,
      };
      return mutate(args, (store) => addJob(store, engine, args));
    }
    case "begin": {
      const label = values.label ?? "agent";
      return mutate({ label }, (store) => beginPass(store, engine, label));
    }
    case "observe":
      return runObserve(root, values, deps, engine);
    case "triage": {
      const passId = required(values, "pass");
      const jobId = required(values, "job");
      const input = parseWith(
        TriageInputSchema,
        await readJsonInput(values, deps),
        "triage input",
      );
      return mutate({ passId, jobId, input }, (store) =>
        triageJob(store, engine, { passId, jobId, input }),
      );
    }
    case "plan": {
      const passId = required(values, "pass");
      const jobId = required(values, "job");
      const input = parseWith(
        PlanInputSchema,
        await readJsonInput(values, deps),
        "plan input",
      );
      return mutate({ passId, jobId, input }, (store) =>
        planBatch(store, engine, { passId, jobId, input }),
      );
    }
    case "report": {
      const batchId = required(values, "batch");
      const report = parseWith(
        WorkReportSchema,
        await readJsonInput(values, deps),
        "work report",
      );
      return mutate({ batchId, report }, (store) =>
        reportBatch(store, engine, { batchId, report }),
      );
    }
    case "cancel": {
      const args = {
        batchId: required(values, "batch"),
        reason: required(values, "reason"),
      };
      return mutate(args, (store) => cancelBatch(store, engine, args));
    }
    case "end": {
      const passId = required(values, "pass");
      return mutate({ passId }, (store) => endPass(store, engine, { passId }));
    }
    case "hold": {
      const kind = required(values, "kind");
      if (kind !== "design" && kind !== "human")
        throw new PrmError("invalid_args", "--kind must be design or human.");
      const args = {
        jobId: required(values, "job"),
        kind,
        reason: required(values, "reason"),
        sourceIds: values.source ?? [],
      } as const;
      return mutate(args, (store) =>
        holdJob(store, engine, { ...args, sourceIds: [...args.sourceIds] }),
      );
    }
    case "pause": {
      const args = { jobId: required(values, "job"), reason: required(values, "reason") };
      return mutate(args, (store) => pauseJob(store, engine, args));
    }
    case "resume": {
      const args = {
        jobId: required(values, "job"),
        clearHolds: values.clear ?? [],
        confirmHuman: required(values, "confirm-human"),
      };
      return mutate(args, (store) => resumeJob(store, engine, args));
    }
    case "release": {
      const jobId = required(values, "job");
      return mutate({ jobId }, (store) => releaseJob(store, engine, { jobId }));
    }
    case "recover": {
      if (values.lock) {
        const removed = await removeOrphanLock(root, values.lock);
        return {
          removedLock: removed,
          next: "Retry the command that reported state_busy.",
        };
      }
      const args = {
        passId: required(values, "pass"),
        confirmStopped: required(values, "confirm-stopped"),
      };
      return mutate(args, (store) => recoverPass(store, engine, args));
    }
    default:
      throw new PrmError(
        "unknown_command",
        `Unknown command "${command}". Run with --help.`,
      );
  }
};

export const run = async (argv: string[], deps: CliDeps): Promise<CliOutput> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      exitCode: 1,
      body: {
        ok: false,
        error: { code: "invalid_args", message: (error as Error).message },
      },
    };
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version) return { exitCode: 0, body: { ok: true, version: VERSION } };
  if (values.help || !command)
    return {
      exitCode: values.help ? 0 : 1,
      body: { ok: Boolean(values.help), usage: USAGE },
    };
  try {
    const result = await runCommand(command, rest, values, deps);
    return { exitCode: 0, body: { ok: true, command, ...result } };
  } catch (error) {
    if (error instanceof PrmError)
      return {
        exitCode: 1,
        body: {
          ok: false,
          command,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        },
      };
    return {
      exitCode: 1,
      body: {
        ok: false,
        command,
        error: { code: "internal_error", message: (error as Error).message },
      },
    };
  }
};

export const readAllStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** The installed layout is <skill>/scripts/prm.mjs. */
export const installedSkillDir = (): string =>
  dirname(dirname(fileURLToPath(import.meta.url)));
