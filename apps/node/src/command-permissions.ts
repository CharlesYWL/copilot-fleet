import { createHash, randomUUID } from "node:crypto";
import { extname, isAbsolute, normalize } from "node:path";
import {
  CommandPermissionRuleSchema,
  CommandPermissionMatchSchema,
  CommandPermissionEntrySchema,
  CommandTextSchema,
  EXACT_SCRIPT_PERMISSION_PREFIX,
  isExactScriptPermissionKey,
  type CommandApprovalScope,
  type CommandPermissionMatch,
  type CommandPermissionRule,
  type CommandPermissionEntry,
  type CommandPreparation,
  type PreparedCommand,
} from "@fleet/protocol";
import { canonicalPath } from "./canonical-path.js";
import {
  resolvePermissionExecutable,
  isPermissionExecutableName,
  type PermissionExecutableResolver,
} from "./command-permissions-executable.js";

export const DEFAULT_COMMAND_PERMISSION_RULES: CommandPermissionRule[] = [
  { id: "builtin-cd", commandKey: "cd", command: "cd", path: "*", builtin: true },
  {
    id: "builtin-set-location",
    commandKey: "set-location",
    command: "set-location",
    path: "*",
    builtin: true,
  },
];

const EXECUTABLE_PIN = /^(.*) @sha256:([a-f0-9]{64})$/;
const gitCommands = new Set(
  "add am apply archive bisect blame branch checkout cherry cherry-pick clean clone commit describe diff fetch grep init log ls-files ls-remote ls-tree merge mv pull push rebase reflog remote reset restore revert rm show stash status switch tag".split(
    " ",
  ),
);
const dotnetCommands = new Set(
  "build test restore clean pack publish format list add remove new".split(" "),
);
const cargoCommands = new Set(
  "build test check clippy fmt doc clean fetch metadata tree update generate-lockfile package publish install uninstall new init".split(
    " ",
  ),
);
const npmCommands = new Set(
  "install ci update uninstall rebuild dedupe test start stop restart pack publish audit outdated list ls view".split(
    " ",
  ),
);
const interpreters =
  /^(?:powershell|powershell_ise|pwsh|cmd|command|sh|bash|dash|zsh|fish|ksh|csh|tcsh|ash|busybox|env|xargs|node|nodejs|npx|pnpx|python\d*|py|perl|ruby|php|java|javaw|js|jsc|csi|r|rscript|wscript|cscript|mshta|msiexec|installutil|regasm|regsvcs|lua|luajit|tclsh|wish|deno|bun|tsx|ts-node|rundll32|regsvr32|runas|sudo|doas|ssh|psexec|schtasks|wmic|forfiles)$/i;
const literalKey = (args: readonly string[]): string =>
  args.map((arg) => (/\s/.test(arg) ? `'${arg}'` : arg)).join(" ");

export function permissionPath(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function literalArguments(command: string, wildcard = false): string[] | undefined {
  if (
    [...command].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /[;&|<>`$(){}[\]#@?%!]/.test(command) ||
    (!wildcard && command.includes("*"))
  )
    return undefined;
  const tokens = command.trim().match(/"[^"]*"|'[^']*'|[^\s"']+/g);
  if (
    !tokens?.length ||
    /^["']/.test(tokens[0]!) ||
    tokens.join(" ") !== command.trim().replace(/ +/g, " ") ||
    tokens.some((token) => /["']/.test(token.slice(1, -1)))
  )
    return undefined;
  const args = tokens.map((token) => (/^["']/.test(token) ? token.slice(1, -1) : token));
  return args.some((arg) => !arg.length) ? undefined : args;
}

function literalInvocation(command: string, wildcard = false): string | undefined {
  const args = literalArguments(command, wildcard);
  return args ? literalKey([args[0]!.toLowerCase(), ...args.slice(1)]) : undefined;
}

/** Anchored '*' matching with forward-only literal searches, not regex backtracking. */
function wildcardMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  const first = parts[0]!,
    last = parts.at(-1)!;
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  const end = value.length - last.length;
  let offset = first.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const next = value.indexOf(part, offset);
    if (next < 0 || next + part.length > end) return false;
    offset = next + part.length;
  }
  return offset <= end;
}

async function rulePath(path: string): Promise<string> {
  if (path === "*") return path;
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path))
    throw new Error("Rule paths must be absolute local folders or '*' patterns.");
  if (path.includes("*")) {
    if (path.split(/[\\/]/).includes(".."))
      throw new Error("Wildcard paths cannot contain '..' traversal.");
    return permissionPath(path);
  }
  const canonical = (await canonicalPath(path)).path;
  if (/^[\\/]{2}/.test(canonical))
    throw new Error("Network directory permission rules are unsupported.");
  return permissionPath(canonical);
}

function readableCommand(rule: CommandPermissionRule): string | undefined {
  if (rule.command !== undefined) return rule.command;
  return isExactScriptPermissionKey(rule.commandKey) ||
    rule.commandKey.startsWith("pattern:sha256:")
    ? undefined
    : rule.commandKey.replace(EXECUTABLE_PIN, "$1");
}

export function commandPermissionEntries(
  rules: readonly CommandPermissionRule[],
  hostId?: string,
): CommandPermissionEntry[] {
  return rules.map((rule) => {
    const command = readableCommand(rule);
    return {
      ...(command === undefined ? { legacyKey: rule.commandKey } : { command }),
      path: rule.path,
      ...(command !== undefined && rule.match && rule.match !== "command"
        ? { match: rule.match }
        : {}),
      ...(rule.hostId && rule.hostId !== hostId ? { hostId: rule.hostId } : {}),
    };
  });
}

export function recoverCommandPermissionText(
  rules: readonly CommandPermissionRule[],
  descriptors: readonly PreparedCommand[],
): CommandPermissionRule[] {
  return rules.map((rule) => {
    if (rule.command !== undefined) return rule;
    const command = readableCommand(rule);
    if (command !== undefined) return { ...rule, command };
    const source = descriptors.find(
      (descriptor) =>
        descriptor.prepared.permission?.commandKey === rule.commandKey &&
        (!rule.hostId || descriptor.hostId === rule.hostId) &&
        permissionPath(descriptor.prepared.cwd) === permissionPath(rule.path) &&
        (exactScriptIdentity(descriptor.command).commandKey === rule.commandKey ||
          EXACT_SCRIPT_PERMISSION_PREFIX +
            createHash("sha256")
              .update("fleet-exact-script-v1\0")
              .update(descriptor.command, "utf8")
              .digest("hex") ===
            rule.commandKey),
    );
    return source && isExactScriptPermissionKey(rule.commandKey)
      ? { ...rule, command: source.command, match: "exact" }
      : rule;
  });
}

export async function compileCommandPermissionEntries(
  current: readonly CommandPermissionRule[],
  input: readonly CommandPermissionEntry[],
  hostId?: string,
  resolveExecutable: PermissionExecutableResolver = resolvePermissionExecutable,
): Promise<CommandPermissionRule[]> {
  const existing = commandPermissionEntries(current, hostId);
  const used = new Set<number>();
  const mode = (entry: Extract<CommandPermissionEntry, { command: string }>) =>
    entry.match ?? (entry.command.includes("*") ? "pattern" : "command");
  const key = (entry: CommandPermissionEntry) =>
    JSON.stringify([
      "command" in entry ? entry.command : entry.legacyKey,
      permissionPath(entry.path),
      "command" in entry ? mode(entry) : "legacy",
      entry.hostId ?? hostId,
    ]);
  const rules: CommandPermissionRule[] = [];
  for (const value of input) {
    const entry = CommandPermissionEntrySchema.parse(value);
    if (entry.path.includes("*") && entry.path.split(/[\\/]/).includes(".."))
      throw new Error("Wildcard paths cannot contain '..' traversal.");
    const index = existing.findIndex(
      (prior, i) => !used.has(i) && key(prior) === key(entry),
    );
    if (index >= 0) {
      used.add(index);
      rules.push(current[index]!);
      continue;
    }
    if (!("command" in entry))
      throw new Error(
        "That legacy rule cannot be recovered. Reload it, or replace it with its actual command.",
      );
    const boundHost = entry.hostId ?? hostId;
    if (!boundHost)
      throw new Error(
        "Enroll with a current Host before adding persistent command rules.",
      );
    const match = mode(entry);
    const [rule] = await validateCommandPermissionRules(
      [
        {
          id: randomUUID(),
          commandKey: "pending",
          command: entry.command,
          path: entry.path,
          match,
          hostId: boundHost,
          builtin: false,
        },
      ],
      resolveExecutable,
    );
    rules.push(rule!);
  }
  return rules;
}

/**
 * Deliberately not a PowerShell parser: only this small, unambiguous literal
 * grammar permits command-family reuse. Everything else must match exact script text.
 * Never execute submitted code to decide whether it is eligible for a grant.
 */
export function commandPermissionIdentity(command: string): {
  commandKey?: string;
  explanation: string;
} {
  const once = (detail: string) => ({
    explanation: `${detail} Command-family matching fails closed rather than guessing PowerShell parsing; an explicit exact-script grant is required for reuse.`,
  });
  const args = literalArguments(command);
  if (!args) return once("The command is not a reliable single literal invocation.");
  // A path-qualified lookalike or expression is not a literal executable name.
  if (!isPermissionExecutableName(args[0]!))
    return once(
      "Executable paths, expressions, and unknown command identities are not reusable.",
    );
  const executable = args[0]!.toLowerCase();
  const tool = executable.replace(/\.(?:exe|com|cmd|ps1)$/, "");
  if (executable === "cd" || executable === "set-location") {
    const path = args[1];
    if (
      args.length !== 2 ||
      !path ||
      /^[-~]/.test(path) ||
      /^[\\/]{2}/.test(path) ||
      /:(?![\\/])/.test(path) ||
      (path.includes(":") && !/^[a-zA-Z]:[\\/][^:]*$/.test(path))
    )
      return once(
        "Directory navigation must have exactly one literal local filesystem path.",
      );
    return {
      commandKey: executable,
      explanation:
        "Standalone literal local directory navigation only; no following script.",
    };
  }
  if (interpreters.test(tool))
    return once(
      "Shells, code interpreters, and command-dispatch wrappers are not reusable.",
    );
  if (
    args
      .slice(1)
      .some((arg) =>
        /^(?:-c|-C|-e|-p|-P|-x|--?(?:enc(?:odedcommand)?|encodedarguments|command|file)|--(?:config(?:-env)?|git-dir|work-tree|namespace|exec(?:-path)?|upload-pack|receive-pack|ext-diff|textconv|paginate|prefix|cwd|directory|workspaces?|workspace|userconfig|globalconfig|script-shell|shell|eval|require|import|loader|open|browser))(?:=|$)/i.test(
          arg,
        ),
      )
  )
    return once(
      "Execution-, configuration-, or path-changing options cannot reuse a grant.",
    );
  let key: string;
  if (tool === "git") {
    const subcommand = args[1];
    if (!subcommand || !gitCommands.has(subcommand))
      return once(
        "A known, literal Git subcommand is required; aliases and global options are not reusable.",
      );
    if (
      args
        .slice(2)
        .some(
          (arg) =>
            arg.startsWith("-") &&
            !/^(?:--|-s|-b|-v|-q|-a|-u|--short|--branch|--verbose|--quiet|--all|--no-pager|--oneline|--stat|--numstat|--name-only|--name-status|--cached|--staged|--hard|--soft|--mixed|--dry-run|--force|--porcelain(?:=[12])?|--untracked-files(?:=(?:no|normal|all))?)$/.test(
              arg,
            ),
        )
    )
      return once(
        "Only recognized ordinary Git flags can reuse permission; option abbreviations and execution/path options are Once-only.",
      );
    // Preserve operands, including nested verbs, instead of guessing which
    // values belong to flags. Simple boolean flag variants share the key.
    key = literalKey([
      executable,
      subcommand,
      ...args.slice(2).filter((arg) => !arg.startsWith("-")),
    ]);
  } else if (tool === "npm" && ["run", "run-script"].includes(args[1] ?? "")) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(args[2] ?? "") ||
      (args.length > 3 && args[3] !== "--")
    )
      return once(
        "npm run requires one literal script identity before optional script arguments.",
      );
    key = `${executable} run ${args[2]}`;
  } else {
    const commands =
      tool === "dotnet"
        ? dotnetCommands
        : tool === "cargo"
          ? cargoCommands
          : tool === "npm"
            ? npmCommands
            : undefined;
    if (
      commands &&
      !commands.has(args[1] ?? "") &&
      !["--version", "--help", "--info"].includes(args[1] ?? "")
    )
      return once(
        "Unknown tool plugins, aliases, and code-dispatch subcommands are Once-only.",
      );
    if (
      !commands &&
      args
        .slice(1)
        .some((arg) => /^(?:exec|eval|shell|run|invoke|command|script)$/i.test(arg))
    )
      return once("Unrecognized command-dispatch forms cannot reuse permission.");
    key = literalKey([executable, ...args.slice(1)]);
  }
  if (key.length > 200) return once("The normalized command identity is too long.");
  return {
    commandKey: key,
    explanation:
      tool === "git" || (tool === "npm" && ["run", "run-script"].includes(args[1] ?? ""))
        ? "Exact named command/subcommand and canonical working directory; recognized ordinary flags are ignored. This is permission reuse, not a sandbox."
        : "Exact literal executable, subcommands, arguments and canonical working directory; unfamiliar flags remain in the key rather than guessing their meaning. This is permission reuse, not a sandbox.",
  };
}

export async function validateCommandPermissionRules(
  input: readonly CommandPermissionRule[],
  resolveExecutable: PermissionExecutableResolver = resolvePermissionExecutable,
): Promise<CommandPermissionRule[]> {
  const ids = new Set<string>();
  return Promise.all(
    input.map(async (inputRule) => {
      const rule = CommandPermissionRuleSchema.parse(inputRule);
      if (ids.has(rule.id))
        throw new Error("Command permission rule IDs must be unique.");
      ids.add(rule.id);
      if (rule.builtin) {
        if (
          !DEFAULT_COMMAND_PERMISSION_RULES.some(
            (builtin) =>
              builtin.id === rule.id &&
              builtin.commandKey === rule.commandKey &&
              rule.path === "*" &&
              !rule.hostId,
          )
        )
          throw new Error(
            "Only the literal cd and Set-Location builtin rules are supported.",
          );
        return { ...rule, command: rule.commandKey };
      }
      if (rule.match === "pattern") {
        const command = rule.command && literalInvocation(rule.command, true);
        if (!command)
          throw new Error(
            "Wildcard rules must name a simple command pattern. Use match: 'exact' for compound scripts.",
          );
        const path = await rulePath(rule.path);
        return {
          ...rule,
          command,
          path,
          commandKey: `pattern:sha256:${createHash("sha256").update(command, "utf16le").digest("hex")}`,
        };
      }
      if (rule.match === "exact" && rule.command !== undefined) {
        return {
          ...rule,
          path: await rulePath(rule.path),
          commandKey: exactScriptIdentity(rule.command).commandKey,
        };
      }
      const existingPin = EXECUTABLE_PIN.exec(rule.commandKey);
      const invocation = rule.command ?? existingPin?.[1] ?? rule.commandKey;
      const command = ["cd", "set-location"].includes(invocation)
        ? `${invocation} .`
        : invocation;
      if (
        rule.path.includes("*") &&
        rule.match === "command" &&
        rule.command !== undefined
      ) {
        const path = await rulePath(rule.path);
        const identity = commandPermissionIdentity(command);
        if (existingPin) {
          if (identity.commandKey !== existingPin[1])
            throw new Error("Rules require a normalized command identity.");
          return { ...rule, command: existingPin[1], path };
        }
        return identity.commandKey
          ? {
              ...rule,
              command: identity.commandKey,
              commandKey: identity.commandKey,
              path,
            }
          : {
              ...rule,
              command: invocation,
              commandKey: exactScriptIdentity(invocation).commandKey,
              match: "exact",
              path,
            };
      }
      if (
        !isAbsolute(rule.path) ||
        /^[\\/]{2}/.test(rule.path) ||
        rule.path.includes("*")
      )
        throw new Error("Use match: 'pattern' or 'exact' for wildcard folders.");
      if (isExactScriptPermissionKey(rule.commandKey))
        return { ...rule, path: permissionPath(rule.path) };
      if (existingPin) {
        if (commandPermissionIdentity(command).commandKey !== existingPin[1])
          throw new Error("Rules require a normalized command identity.");
        return { ...rule, command: existingPin[1], path: permissionPath(rule.path) };
      }
      const path = (await canonicalPath(rule.path)).path;
      if (/^[\\/]{2}/.test(path))
        throw new Error("Network directory permission rules are unsupported.");
      const commandKey = resolvedCommandIdentity(
        command,
        path,
        resolveExecutable,
      ).commandKey;
      return CommandPermissionRuleSchema.parse({
        ...rule,
        commandKey,
        command: isExactScriptPermissionKey(commandKey)
          ? invocation
          : commandKey.replace(EXECUTABLE_PIN, "$1"),
        match: isExactScriptPermissionKey(commandKey) ? "exact" : "command",
        path: permissionPath(path),
      });
    }),
  );
}

type Request = Pick<CommandPreparation, "hostId" | "leadSessionId" | "command">;
type RulesUpdate = (rules: readonly CommandPermissionRule[]) => CommandPermissionRule[];
const samePermission = (left: CommandPermissionMatch, right: CommandPermissionMatch) =>
  JSON.stringify(CommandPermissionMatchSchema.parse(left)) ===
  JSON.stringify(CommandPermissionMatchSchema.parse(right));

function concreteCommandIdentity(
  identity: ReturnType<typeof commandPermissionIdentity>,
  cwd: string,
  resolveExecutable: PermissionExecutableResolver,
): ReturnType<typeof commandPermissionIdentity> {
  const key = identity.commandKey;
  if (!key || ["cd", "set-location"].includes(key)) return identity;
  try {
    const name = key.split(" ")[0]!;
    const executable = resolveExecutable(name, cwd);
    if (!isAbsolute(executable.path) || !/^[a-f0-9]{64}$/.test(executable.fingerprint))
      throw new Error("Resolver did not supply a concrete executable identity.");
    if (
      !/^npm(?:\.(?:exe|com|cmd|ps1))?$/.test(name) &&
      ![".exe", ".com"].includes(extname(executable.path).toLowerCase())
    )
      throw new Error(
        "Script launchers are Once-only unless the known npm task identity is explicit.",
      );
    const commandKey = `${key} @sha256:${executable.fingerprint}`;
    if (commandKey.length > 200)
      throw new Error("Pinned command identity exceeds policy bounds.");
    return {
      commandKey,
      explanation:
        `${identity.explanation} Executable: ${executable.path}. Path, file identity and content are pinned by ${executable.fingerprint}.`.slice(
          0,
          4000,
        ),
    };
  } catch (error) {
    return {
      explanation: `Executable resolution is uncertain: ${String(error).slice(0, 1000)}. Only explicit Once is supported; policy fails closed rather than trusting a name or guessing resolution.`,
    };
  }
}

function resolvedCommandIdentity(
  command: string,
  cwd: string,
  resolveExecutable: PermissionExecutableResolver,
): { commandKey: string; explanation: string } {
  CommandTextSchema.parse(command);
  const identity = concreteCommandIdentity(
    commandPermissionIdentity(command),
    cwd,
    resolveExecutable,
  );
  if (identity.commandKey) return { ...identity, commandKey: identity.commandKey };
  return exactScriptIdentity(command);
}

function exactScriptIdentity(command: string): {
  commandKey: string;
  explanation: string;
} {
  CommandTextSchema.parse(command);
  return {
    commandKey:
      EXACT_SCRIPT_PERMISSION_PREFIX +
      createHash("sha256")
        .update("fleet-exact-script-v1\0")
        .update(command, "utf16le")
        .digest("hex"),
    explanation:
      "Only the exact full script in this folder is remembered. Any text change, including flags or whitespace, asks again. Called tools, files, and environment may change between runs; this is not executable pinning or a sandbox.",
  };
}

export class CommandPermissions {
  private readonly sessions = new Map<string, { id: string }>();
  private version = 0;
  private rulesSnapshot = "";

  constructor(
    private readonly options: {
      getRules: () => readonly CommandPermissionRule[];
      saveRules: (update: RulesUpdate) => Promise<void>;
      resolveExecutable?: PermissionExecutableResolver;
    },
  ) {}

  private sessionKey(request: Request, path: string, commandKey: string): string {
    return JSON.stringify([request.hostId, request.leadSessionId, path, commandKey]);
  }

  refreshPolicy(): void {
    const snapshot = JSON.stringify(this.options.getRules());
    if (snapshot !== this.rulesSnapshot) {
      this.rulesSnapshot = snapshot;
      this.version++;
    }
  }

  evaluate(request: Request, cwd: string): CommandPermissionMatch {
    this.refreshPolicy();
    const rules = this.options.getRules();
    const identity = resolvedCommandIdentity(
      request.command,
      cwd,
      this.options.resolveExecutable ?? resolvePermissionExecutable,
    );
    const path = permissionPath(cwd);
    let match: CommandPermissionMatch = {
      reusable: !!identity.commandKey && !/^[\\/]{2}/.test(path),
      ...identity,
      path: cwd,
      policyVersion: this.version,
    };
    if (!match.reusable || !identity.commandKey) return match;
    const logicalCommand = commandPermissionIdentity(request.command).commandKey;
    const literalCommand = literalInvocation(request.command);
    const rule = rules.find((rule) => {
      if (rule.hostId && rule.hostId !== request.hostId) return false;
      if (rule.builtin)
        return (
          rule.commandKey === identity.commandKey &&
          DEFAULT_COMMAND_PERMISSION_RULES.some(
            (builtin) =>
              builtin.id === rule.id &&
              builtin.commandKey === rule.commandKey &&
              rule.path === "*" &&
              !rule.hostId,
          )
        );
      if (rule.match) {
        if (!wildcardMatch(permissionPath(rule.path), path)) return false;
      } else if (rule.path !== path) return false;
      if (rule.match === "pattern")
        return (
          !!rule.command &&
          !!literalCommand &&
          wildcardMatch(rule.command, literalCommand)
        );
      if (rule.match === "exact" && rule.command !== undefined)
        return rule.command === request.command;
      if (
        rule.match === "command" &&
        rule.path.includes("*") &&
        rule.commandKey === rule.command
      )
        return !!logicalCommand && rule.command === logicalCommand;
      return rule.commandKey === identity.commandKey;
    });
    if (rule?.match === "exact")
      match = { ...match, ...exactScriptIdentity(request.command) };
    if (
      rule?.match === "pattern" ||
      (rule?.match === "command" &&
        rule.path.includes("*") &&
        rule.commandKey === rule.command)
    )
      match = {
        ...match,
        explanation:
          "Matched a saved wildcard rule for simple commands and local folders. This rule trusts matching command names and arguments rather than pinning executable versions; compound scripts require their own exact rule.",
      };
    if (rule)
      return {
        ...match,
        grantedBy: rule.builtin ? "builtin" : "always",
        ruleId: rule.id,
      };
    const key = this.sessionKey(request, path, identity.commandKey);
    const session = this.sessions.get(key);
    if (session) return { ...match, grantedBy: "session", ruleId: session.id };
    return match;
  }

  async authorize(
    request: Request,
    cwd: string,
    scope: CommandApprovalScope,
    automatic: boolean,
    prepared?: CommandPermissionMatch,
  ): Promise<() => void> {
    let approved = this.evaluate(request, cwd);
    const assertExecutable = () => {
      if (
        prepared?.commandKey &&
        EXECUTABLE_PIN.test(prepared.commandKey) &&
        (approved.commandKey !== prepared.commandKey || approved.path !== prepared.path)
      )
        throw new Error(
          "Prepared executable identity changed; request fresh Host approval.",
        );
    };
    assertExecutable();
    if (automatic) {
      if (
        !prepared?.grantedBy ||
        !approved.grantedBy ||
        !samePermission(prepared, approved)
      )
        throw new Error(
          "Automatic command permission changed or was revoked; request fresh Host approval.",
        );
    } else if (scope !== "once") {
      if (
        prepared &&
        (!prepared.reusable ||
          prepared.commandKey !== approved.commandKey ||
          prepared.path !== approved.path)
      )
        throw new Error(
          "Prepared reusable permission identity changed; request fresh Host approval.",
        );
      if (!approved.reusable || !approved.commandKey)
        throw new Error(
          "This script is Once-only; reusable permission cannot be granted.",
        );
      if (scope === "session") {
        if (this.sessions.size >= 2048)
          throw new Error("Node session command grant limit reached.");
        this.sessions.set(
          this.sessionKey(request, permissionPath(approved.path), approved.commandKey),
          {
            id: randomUUID(),
          },
        );
        this.version++;
      } else {
        const rule: CommandPermissionRule = {
          id: randomUUID(),
          commandKey: approved.commandKey,
          command: isExactScriptPermissionKey(approved.commandKey)
            ? request.command
            : approved.commandKey.replace(EXECUTABLE_PIN, "$1"),
          match: isExactScriptPermissionKey(approved.commandKey) ? "exact" : "command",
          path: permissionPath(approved.path),
          hostId: request.hostId,
          builtin: false,
        };
        await this.options.saveRules((rules) => [
          ...rules.filter(
            (existing) =>
              (existing.commandKey !== rule.commandKey &&
                !(
                  readableCommand(existing) === rule.command &&
                  (existing.match ??
                    (isExactScriptPermissionKey(existing.commandKey)
                      ? "exact"
                      : "command")) === rule.match
                )) ||
              existing.path !== rule.path ||
              existing.hostId !== rule.hostId,
          ),
          rule,
        ]);
      }
      approved = this.evaluate(request, cwd);
      assertExecutable();
      if (!approved.grantedBy)
        throw new Error(
          "Command permission could not be saved; process launch was refused.",
        );
    } else {
      return () => {
        if (prepared?.commandKey && EXECUTABLE_PIN.test(prepared.commandKey)) {
          approved = this.evaluate(request, cwd);
          assertExecutable();
        }
      };
    }
    return () => {
      if (!samePermission(this.evaluate(request, cwd), approved))
        throw new Error("Command permission changed or was revoked before launch.");
    };
  }

  revoke(hostId: string, leadSessionId: string): void {
    for (const key of this.sessions.keys()) {
      const [host, lead] = JSON.parse(key) as string[];
      if (host === hostId && lead === leadSessionId) this.sessions.delete(key);
    }
    this.version++;
  }

  clear(): void {
    this.sessions.clear();
    this.version++;
  }
}
