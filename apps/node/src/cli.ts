/**
 * Command-line overrides for the node service.
 *
 * Environment variables are awkward to set per invocation (PowerShell needs a
 * separate `$env:` line for each one) and settings.json beats them once a node
 * has been configured, so pointing one run at a different Host used to mean
 * editing files. A flag is the escape hatch: it wins over both.
 */

export class CliError extends Error {}

type FlagSpec = {
  /** The variable this flag stands in for, so one lookup path stays. */
  env: string;
  /** Value-less flags mean "1"; `--no-x` and `--x=0` mean "0". */
  boolean?: boolean;
  placeholder?: string;
  help: string;
  /**
   * Whether settings.json ends up owning this value.
   *
   * A flag outranks the saved settings, which is right for the run the operator
   * typed it on and wrong for every run after it: the node persists what it is
   * using, so by the time it restarts itself the file already holds this value —
   * or a newer one the operator set from the config page. Replaying the original
   * flag then silently reverts that edit. See {@link argvForRestart}.
   */
  persisted?: boolean;
};

const FLAGS: { names: string[]; spec: FlagSpec }[] = [
  {
    names: ["--url", "--host-url"],
    spec: {
      env: "FLEET_HOST_URL",
      placeholder: "<url>",
      help: "Host to connect to (FLEET_HOST_URL)",
      persisted: true,
    },
  },
  {
    names: ["--name", "--node-name"],
    spec: {
      env: "FLEET_NODE_NAME",
      placeholder: "<name>",
      help: "Node name shown in the Host UI (FLEET_NODE_NAME)",
      persisted: true,
    },
  },
  {
    names: ["--token", "--enrollment-token"],
    spec: {
      env: "FLEET_ENROLLMENT_TOKEN",
      placeholder: "<token>",
      help: "Enrollment token for first registration (FLEET_ENROLLMENT_TOKEN)",
    },
  },
  {
    names: ["--max-sessions"],
    spec: {
      env: "FLEET_MAX_SESSIONS",
      placeholder: "<n>",
      help: "Concurrent session capacity (FLEET_MAX_SESSIONS)",
      persisted: true,
    },
  },
  {
    names: ["--copilot-command"],
    spec: {
      env: "FLEET_COPILOT_COMMAND",
      placeholder: "<path>",
      help: "Copilot executable; empty means look on PATH (FLEET_COPILOT_COMMAND)",
      persisted: true,
    },
  },
  {
    names: ["--permission-timeout-ms"],
    spec: {
      env: "PERMISSION_TIMEOUT_MS",
      placeholder: "<ms>",
      help: "How long an agent waits for a decision (PERMISSION_TIMEOUT_MS)",
      persisted: true,
    },
  },
  {
    names: ["--context-tier"],
    spec: {
      env: "FLEET_CONTEXT_TIER",
      placeholder: "<default|long_context>",
      help: "Context window agents are started with (FLEET_CONTEXT_TIER)",
      persisted: true,
    },
  },
  {
    names: ["--config-port"],
    spec: {
      env: "FLEET_NODE_CONFIG_PORT",
      placeholder: "<port>",
      help: "Local config page port (FLEET_NODE_CONFIG_PORT)",
    },
  },
  {
    names: ["--mock-agent"],
    spec: {
      env: "FLEET_MOCK_AGENT",
      boolean: true,
      help: "Use the deterministic no-login adapter (FLEET_MOCK_AGENT)",
    },
  },
];

const HELP_FLAGS = new Set(["-h", "--help"]);

function findFlag(name: string): FlagSpec | undefined {
  return FLAGS.find((flag) => flag.names.includes(name))?.spec;
}

export const USAGE = [
  "Usage: copilot-fleet-node [options]",
  "",
  "Options take precedence over .env and over settings.json.",
  "",
  ...FLAGS.map(({ names, spec }) => {
    const invocation = `${names.join(", ")}${
      spec.boolean ? "[=0|1]" : ` ${spec.placeholder ?? "<value>"}`
    }`;
    return `  ${invocation.padEnd(42)}${spec.help}`;
  }),
  `  ${"-h, --help".padEnd(42)}Show this message`,
  "",
  "Example:",
  "  npm run start:node -- --url=https://fleet.example.com --token=abc123",
].join("\n");

export type CliOverrides = {
  wantsHelp: boolean;
  /** Parsed flags, keyed by the variable each one stands in for. */
  env: Record<string, string>;
};

function booleanValue(flag: string, raw: string | undefined, negated: boolean): string {
  const on = raw === undefined ? !negated : /^(1|true|yes|on)$/i.test(raw);
  if (raw !== undefined && !/^(0|1|true|false|yes|no|on|off)$/i.test(raw)) {
    throw new CliError(`${flag} expects a boolean, got "${raw}"`);
  }
  // `--no-x=1` reads as a double negative; refusing it beats guessing.
  if (negated && raw !== undefined) {
    throw new CliError(`${flag} does not take a value`);
  }
  return on ? "1" : "0";
}

export function parseNodeArgs(argv: readonly string[]): CliOverrides {
  const env: Record<string, string> = {};
  let wantsHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--") continue;
    if (HELP_FLAGS.has(argument)) {
      wantsHelp = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new CliError(`Unexpected argument "${argument}"`);
    }

    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    const negated = name.startsWith("--no-");
    const spec = findFlag(negated ? `--${name.slice("--no-".length)}` : name);
    if (!spec) throw new CliError(`Unknown option "${name}"`);

    if (spec.boolean) {
      env[spec.env] = booleanValue(name, inlineValue, negated);
      continue;
    }
    if (negated) throw new CliError(`Unknown option "${name}"`);

    if (inlineValue !== undefined) {
      env[spec.env] = inlineValue;
      continue;
    }
    // A following flag is never the value; that silently swallows the next
    // option and starts the node with a nonsense host URL.
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`${name} expects a value`);
    }
    env[spec.env] = next;
    index += 1;
  }

  return { wantsHelp, env };
}

/**
 * The arguments a self-update should re-launch this node with.
 *
 * Flags outrank settings.json, which is correct for the run the operator typed
 * them on and wrong for the ones that follow. A node started with
 * `--url=<tunnel>` persists that address, and the operator may later move it
 * from the config page when the tunnel rotates; replaying the original flag
 * into the successor reverts that edit and sends the machine back to a dead
 * address, where nothing can reach it and it cannot be told about the new one.
 *
 * Settings-backed flags are therefore dropped: the file already holds this
 * value, or a newer one that is now the operator's actual intent. Flags with no
 * home in settings — the enrollment token, the config port, the mock adapter —
 * survive, because dropping those would change how the successor runs.
 */
export function argvForRestart(argv: readonly string[]): string[] {
  const kept: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      kept.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const negated = name.startsWith("--no-");
    const spec = findFlag(negated ? `--${name.slice("--no-".length)}` : name);
    if (!spec?.persisted) {
      kept.push(argument);
      continue;
    }
    // A value-taking flag written as `--url <value>` carries the value in the
    // next argument, which has to go with it or it is read as a bare argument
    // and the successor refuses to start.
    if (separator === -1 && !spec.boolean && !negated) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) index += 1;
    }
  }

  return kept;
}
