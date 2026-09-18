import { describe, expect, it, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import {
  CommandPermissionMatchSchema,
  PreparedCommandSchema,
  isExactScriptPermissionKey,
  type CommandPermissionRule,
} from "@fleet/protocol";
import {
  CommandPermissions,
  commandPermissionIdentity,
  DEFAULT_COMMAND_PERMISSION_RULES,
  permissionPath,
  validateCommandPermissionRules,
  commandPermissionEntries,
  compileCommandPermissionEntries,
  recoverCommandPermissionText,
} from "./command-permissions.js";
import type { PermissionExecutableResolver } from "./command-permissions-executable.js";

const cwd = process.cwd();
const request = { hostId: "host", leadSessionId: "lead", command: "git status --short" };
const fingerprint = "a".repeat(64);
function fixture(initial: CommandPermissionRule[] = []) {
  let rules = initial;
  const saveRules = vi.fn(
    async (
      update: (rules: readonly CommandPermissionRule[]) => CommandPermissionRule[],
    ) => {
      rules = update(rules);
    },
  );
  const resolveExecutable = vi.fn<PermissionExecutableResolver>((name) => ({
    path: resolve(cwd, "..", "trusted-tools", `${name}.exe`),
    fingerprint,
  }));
  const options = { getRules: () => rules, saveRules, resolveExecutable };
  return {
    permissions: new CommandPermissions(options),
    options,
    resolveExecutable,
    saveRules,
    rules: () => rules,
    remove: () => {
      rules = [];
    },
  };
}

describe("conservative command permission identity", () => {
  it.each([
    ["git status", "git status"],
    ["git status --short --branch", "git status"],
    ["git reset --hard", "git reset"],
    ["git remote add origin", "git remote add origin"],
    ["git remote remove origin", "git remote remove origin"],
    ["npm run build", "npm run build"],
    ["npm run build -- --flag", "npm run build"],
    ["npm run deploy", "npm run deploy"],
    ["npm.cmd run build -- --flag", "npm.cmd run build"],
    ["npm ci", "npm ci"],
    ["npm install package-name", "npm install package-name"],
    ["npm test", "npm test"],
    ["dotnet build", "dotnet build"],
    ["dotnet test", "dotnet test"],
    ["cargo test", "cargo test"],
    ["cargo test --lib", "cargo test --lib"],
    ["where.exe git", "where.exe git"],
    ["custom-tool.exe inspect 'literal path'", "custom-tool.exe inspect 'literal path'"],
    ["cd 'C:\\local folder'", "cd"],
    ["Set-Location .", "set-location"],
  ])("normalizes %s without collapsing subcommands", (script, commandKey) => {
    expect(commandPermissionIdentity(script).commandKey).toBe(commandKey);
  });

  it.each([
    "git status; git reset --hard",
    "cd C:\\safe; unknown",
    "Set-Location .\nunknown",
    "git status | Out-File foo",
    "git status > foo",
    "git status $(unknown)",
    "git `status",
    "$command status",
    "& git status",
    ".\\git.exe status",
    "C:\\evil\\git.exe status",
    "'git' status",
    "git -c alias.status=evil status",
    "git -C.. status",
    "git status --git-dir=elsewhere",
    "git diff --ext-diff",
    "git rebase --exec evil",
    "git status --wor=elsewhere",
    "git custom-alias",
    "git status --new-unknown-flag",
    "npm --prefix .. run build",
    "npm run build -- --script-shell=evil",
    "npm run build -- --eval=evil",
    "npm exec unknown",
    "npx arbitrary",
    "node script.js",
    "python script.py",
    "python.exe script.py",
    "node.exe script.js",
    "dotnet exec script.dll",
    "dotnet tool run custom",
    "cargo custom-alias",
    "docker.exe exec container sh",
    "custom-tool.exe --eval payload",
    "powershell -EncodedCommand deadbeef",
    "cmd /c unknown",
    "cd \\\\server\\share",
    "cd Registry::HKEY_LOCAL_MACHINE",
    "cd HKLM:\\software",
    "cd ~",
    "cd -",
    "cd",
    "cd C:\\x unknown",
    "git status # comment",
    "git status 'unclosed",
    "git status ''",
    "npm run build -- %PAYLOAD%",
    "npm run build -- --EncodedCommand payload",
  ])("does not infer command-family authority for %s", (script) => {
    expect(commandPermissionIdentity(script)).toMatchObject({
      explanation: expect.stringContaining("fails closed"),
    });
    expect(commandPermissionIdentity(script).commandKey).toBeUndefined();
  });
});

describe("Node-owned permission grants", () => {
  it("stores readable command text for Always without exposing Once/session grants in the editor", async () => {
    const f = fixture();
    const input = { ...request, command: "Write-Output '*'; Write-Output done" };
    await f.permissions.authorize(input, cwd, "once", false);
    await f.permissions.authorize(input, cwd, "session", false);
    expect(commandPermissionEntries(f.rules(), request.hostId)).toEqual([]);
    await f.permissions.authorize(input, cwd, "always", false);
    expect(f.rules()[0]).toMatchObject({
      command: input.command,
      path: permissionPath(cwd),
      match: "exact",
    });
    expect(commandPermissionEntries(f.rules(), request.hostId)).toEqual([
      { command: input.command, path: permissionPath(cwd), match: "exact" },
    ]);
  });

  it("preserves unchanged executable pins, builtins, and foreign Host scope during bulk edits", async () => {
    const f = fixture([...DEFAULT_COMMAND_PERMISSION_RULES]);
    await f.permissions.authorize(request, cwd, "always", false);
    await f.permissions.authorize(
      { ...request, hostId: "foreign" },
      cwd,
      "always",
      false,
    );
    const before = f.rules();
    const entries = commandPermissionEntries(before, request.hostId);
    expect(entries).toContainEqual({
      command: "git status",
      path: permissionPath(cwd),
      hostId: "foreign",
    });
    f.resolveExecutable.mockReturnValue({
      path: resolve(cwd, "..", "git.exe"),
      fingerprint: "b".repeat(64),
    });
    const saved = await compileCommandPermissionEntries(
      before,
      entries,
      request.hostId,
      f.resolveExecutable,
    );
    expect(saved).toEqual(before);
    await f.options.saveRules(() => saved);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    expect(f.permissions.evaluate({ ...request, command: "cd ." }, cwd).grantedBy).toBe(
      "builtin",
    );
  });

  it("treats omitted and explicit command mode as the same rule without repinning a replacement", async () => {
    const f = fixture();
    await f.permissions.authorize(request, cwd, "always", false);
    const original = f.rules();
    const entries = commandPermissionEntries(original, request.hostId).map((entry) =>
      "command" in entry ? { ...entry, match: "command" as const } : entry,
    );
    f.resolveExecutable.mockReturnValue({
      path: resolve(cwd, "..", "replacement.exe"),
      fingerprint: "b".repeat(64),
    });
    const saved = await compileCommandPermissionEntries(
      original,
      entries,
      request.hostId,
      f.resolveExecutable,
    );
    expect(saved).toEqual(original);
    await f.options.saveRules(() => saved);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
  });

  it.each([
    ["git status --*", "git status --short", "git status"],
    ["npm run build -- --target=*", "npm run build -- --target=staging", "npm run build"],
  ])(
    "matches argument-preserving pattern %s without widening it to the command family",
    async (command, allowed, denied) => {
      const f = fixture();
      const rules = await compileCommandPermissionEntries(
        [],
        [{ command, path: "*" }],
        request.hostId,
        f.resolveExecutable,
      );
      await f.options.saveRules(() => rules);
      expect(
        f.permissions.evaluate({ ...request, command: allowed }, cwd).grantedBy,
      ).toBe("always");
      expect(
        f.permissions.evaluate({ ...request, command: denied }, cwd).grantedBy,
      ).toBeUndefined();
      expect(
        f.permissions.evaluate(
          { ...request, command: `${allowed}; Write-Output injected` },
          cwd,
        ).grantedBy,
      ).toBeUndefined();
    },
  );

  it("keeps command-family matching for a plain command with a wildcard folder", async () => {
    const f = fixture();
    const rules = await compileCommandPermissionEntries(
      [],
      [{ command: "git status", path: "*" }],
      request.hostId,
      f.resolveExecutable,
    );
    expect(commandPermissionEntries(rules, request.hostId)).toEqual([
      { command: "git status", path: "*" },
    ]);
    await f.options.saveRules(() => rules);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBe("always");
    expect(
      f.permissions.evaluate(
        { ...request, command: "git status --branch" },
        resolve(cwd, ".."),
      ).grantedBy,
    ).toBe("always");
    expect(
      f.permissions.evaluate({ ...request, command: "git reset --hard" }, cwd).grantedBy,
    ).toBeUndefined();
    expect(
      f.permissions.evaluate(
        { ...request, command: "git status; Write-Output injected" },
        cwd,
      ).grantedBy,
    ).toBeUndefined();
    const explicit = await compileCommandPermissionEntries(
      rules,
      [{ command: "git status", path: "*", match: "command" }],
      request.hostId,
      f.resolveExecutable,
    );
    expect(explicit).toEqual(rules);
  });

  it("matches anchored command/path wildcards without matching appended scripts or another Host", async () => {
    const f = fixture();
    const root = resolve(cwd, "..");
    const rules = await compileCommandPermissionEntries(
      [],
      [
        { command: "git *", path: join(root, "*") },
        { command: "cd", path: "*" },
      ],
      request.hostId,
      f.resolveExecutable,
    );
    await f.options.saveRules(() => rules);
    for (const command of [
      "git status --short",
      "git reset --hard",
      "git checkout feature/branch",
    ])
      expect(f.permissions.evaluate({ ...request, command }, cwd).grantedBy).toBe(
        "always",
      );
    for (const command of [
      "git status; Write-Output injected",
      "git status | Out-File other",
      "$tool status",
      "npm run build",
    ])
      expect(
        f.permissions.evaluate({ ...request, command }, cwd).grantedBy,
      ).toBeUndefined();
    expect(
      f.permissions.evaluate({ ...request, hostId: "other" }, cwd).grantedBy,
    ).toBeUndefined();
    expect(
      f.permissions.evaluate(request, resolve(root, "..", "outside")).grantedBy,
    ).toBeUndefined();
    expect(
      f.permissions.evaluate({ ...request, command: "cd C:\\Windows" }, cwd).grantedBy,
    ).toBe("always");
    const prepared = f.permissions.evaluate(request, cwd);
    f.remove();
    await expect(
      f.permissions.authorize(request, cwd, "once", true, prepared),
    ).rejects.toThrow("revoked");
  });

  it("treats pattern punctuation literally and does not use regex backtracking", async () => {
    const f = fixture();
    await f.options.saveRules(() => []);
    const rules = await compileCommandPermissionEntries(
      [],
      [{ command: "tool.exe *a*z", path: "*" }],
      request.hostId,
      f.resolveExecutable,
    );
    await f.options.saveRules(() => rules);
    expect(
      f.permissions.evaluate({ ...request, command: "tool.exe aaaaz" }, cwd).grantedBy,
    ).toBe("always");
    for (const command of ["toolXexe aaaaz", "tool.exe aaaa", "prefix-tool.exe aaaaz"])
      expect(
        f.permissions.evaluate({ ...request, command }, cwd).grantedBy,
      ).toBeUndefined();
  });

  it("keeps wildcard characters literal for exact scripts, even across a wildcard folder rule", async () => {
    const f = fixture();
    const command = "Write-Output '*'; Write-Output done";
    const rules = await compileCommandPermissionEntries(
      [],
      [{ command, path: "*", match: "exact" }],
      request.hostId,
    );
    await f.options.saveRules(() => rules);
    expect(f.permissions.evaluate({ ...request, command }, cwd).grantedBy).toBe("always");
    expect(
      f.permissions.evaluate(
        { ...request, command: command.replace("*", "changed") },
        cwd,
      ).grantedBy,
    ).toBeUndefined();
    expect(
      f.permissions.evaluate({ ...request, command }, resolve(cwd, "..")).grantedBy,
    ).toBe("always");
  });

  it("refuses ambiguous wildcard scripts and unsafe folder patterns", async () => {
    for (const entry of [
      { command: "git *; Remove-Item file", path: "*" },
      { command: "git *", path: "relative\\*" },
      { command: "git *", path: resolve(cwd, "safe") + `${sep}*${sep}..${sep}*` },
      { command: "git *", path: "\\\\server\\share\\*" },
    ])
      await expect(
        compileCommandPermissionEntries([], [entry], request.hostId),
      ).rejects.toThrow();
  });

  it("recovers old exact-script text only from matching, hash-verified journal evidence", async () => {
    const f = fixture();
    const command = "Write-Output first; Write-Output second";
    await f.permissions.authorize({ ...request, command }, cwd, "always", false);
    const saved = f.rules()[0]!;
    const legacy = {
      id: saved.id,
      commandKey: saved.commandKey,
      path: saved.path,
      hostId: saved.hostId,
      builtin: false,
    };
    const at = new Date().toISOString();
    const identity = {
      key: "m:v:f",
      path: cwd,
      machineId: "m",
      volume: "v",
      fileId: "f",
    };
    const descriptor = PreparedCommandSchema.parse({
      ...request,
      command,
      executionId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      nodeId: "node",
      target: { placementId: "placement" },
      requestedPath: cwd,
      shell: "windows-powershell-5.1",
      reason: "fixture",
      requestKey: "fixture",
      createdAt: at,
      expiresAt: at,
      hostTime: at,
      digest: "a".repeat(64),
      prepared: {
        cwd,
        checkout: identity,
        repository: identity,
        shellPath: "powershell.exe",
        admissionVersion: 1,
        preparedAt: at,
        clockUncertaintyMs: 0,
        hostClockOffsetMs: 0,
        permission: f.permissions.evaluate({ ...request, command }, cwd),
      },
    });
    expect(recoverCommandPermissionText([legacy], [descriptor])[0]).toMatchObject({
      command,
      match: "exact",
    });
    for (const invalid of [
      { ...descriptor, command: "Write-Output injected" },
      { ...descriptor, hostId: "other" },
    ])
      expect(recoverCommandPermissionText([legacy], [invalid])).toEqual([legacy]);
    const unavailable = commandPermissionEntries([legacy], request.hostId);
    expect(unavailable).toEqual([{ legacyKey: legacy.commandKey, path: legacy.path }]);
    expect(
      await compileCommandPermissionEntries([legacy], unavailable, request.hostId),
    ).toEqual([legacy]);
    await expect(
      compileCommandPermissionEntries([], unavailable, request.hostId),
    ).rejects.toThrow("cannot be recovered");
  });

  it.each(["session", "always"] as const)(
    "compares parsed %s permission fields independently of JSON property order without ignoring authority changes",
    async (scope) => {
      const f = fixture();
      await f.permissions.authorize(request, cwd, scope, false);
      const live = f.permissions.evaluate(request, cwd);
      const parsed = CommandPermissionMatchSchema.parse(
        JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(live).reverse()))),
      );
      expect(Object.keys(parsed)).not.toEqual(Object.keys(live));
      const recheck = await f.permissions.authorize(request, cwd, scope, true, parsed);
      expect(recheck).not.toThrow();
      for (const changed of [
        { ...parsed, policyVersion: parsed.policyVersion + 1 },
        { ...parsed, ruleId: "different-rule" },
      ])
        await expect(
          f.permissions.authorize(request, cwd, scope, true, changed),
        ).rejects.toThrow("changed or was revoked");
      f.permissions.revoke("another-host", "another-lead");
      expect(recheck).toThrow("changed or was revoked");
    },
  );

  it("has no implicit permission and Once never creates a reusable grant", async () => {
    const f = fixture();
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    await f.permissions.authorize(request, cwd, "once", false);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    await expect(f.permissions.authorize(request, cwd, "once", true)).rejects.toThrow(
      "fresh Host approval",
    );
    expect(f.saveRules).not.toHaveBeenCalled();
  });

  it("session grants ignore ordinary flags but bind Host, lead, command, exact cwd and process lifetime", async () => {
    const f = fixture();
    await f.permissions.authorize(request, cwd, "session", false);
    const variant = { ...request, command: "git status --branch" };
    const approved = f.permissions.evaluate(variant, cwd);
    expect(approved.path).toBe(cwd);
    expect(approved.grantedBy).toBe("session");
    const recheck = await f.permissions.authorize(variant, cwd, "once", true, approved);
    expect(recheck).not.toThrow();
    for (const other of [
      { ...request, hostId: "other" },
      { ...request, leadSessionId: "other" },
      { ...request, command: "git reset" },
    ])
      expect(f.permissions.evaluate(other, cwd).grantedBy).toBeUndefined();
    expect(f.permissions.evaluate(request, `${cwd}\\child`).grantedBy).toBeUndefined();
    expect(
      new CommandPermissions(f.options).evaluate(request, cwd).grantedBy,
    ).toBeUndefined();
    expect(f.saveRules).not.toHaveBeenCalled();
    f.permissions.revoke("host", "lead");
    expect(recheck).toThrow("revoked");
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
  });

  it("keeps session grants for the lead lifetime, without an undisclosed wall-clock cap", async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await f.permissions.authorize(request, cwd, "session", false);
      clock.mockReturnValue(48 * 60 * 60 * 1000);
      expect(f.permissions.evaluate(request, cwd).grantedBy).toBe("session");
      f.permissions.revoke(request.hostId, request.leadSessionId);
      expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "dotnet build",
    "cargo test",
    "where.exe git",
    "custom-tool.exe inspect",
    "npm ci",
  ])(
    "pins a literal %s workflow without granting other verbs or operands",
    async (command) => {
      const f = fixture();
      const input = { ...request, command };
      await f.permissions.authorize(input, cwd, "always", false);
      const prepared = f.permissions.evaluate(input, cwd);
      expect(prepared).toMatchObject({
        reusable: true,
        grantedBy: "always",
        commandKey: `${command} @sha256:${fingerprint}`,
      });
      expect(f.resolveExecutable).toHaveBeenCalledWith(command.split(" ")[0], cwd);
      expect(
        f.permissions.evaluate({ ...input, command: `${command} extra` }, cwd).grantedBy,
      ).toBeUndefined();
      expect(new CommandPermissions(f.options).evaluate(input, cwd).grantedBy).toBe(
        "always",
      );
      await expect(
        f.permissions.authorize(input, cwd, "always", true, prepared),
      ).resolves.toBeTypeOf("function");
    },
  );

  it("does not treat unresolved Set-Path or an arbitrary script shim as a builtin or pinned executable", () => {
    const f = fixture(DEFAULT_COMMAND_PERMISSION_RULES);
    f.resolveExecutable.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(
      f.permissions.evaluate({ ...request, command: "Set-Path ." }, cwd),
    ).toMatchObject({
      reusable: true,
      commandKey: expect.stringMatching(/^exact-script:sha256:/),
    });
    f.resolveExecutable.mockReturnValue({
      path: resolve(cwd, "..", "tools", "custom.ps1"),
      fingerprint,
    });
    expect(
      f.permissions.evaluate({ ...request, command: "custom-tool inspect" }, cwd),
    ).toMatchObject({
      reusable: true,
      commandKey: expect.stringMatching(/^exact-script:sha256:/),
    });
  });

  it("persists Always host-bound and rejects removal/replacement before automatic launch", async () => {
    const f = fixture();
    await f.permissions.authorize(request, cwd, "always", false);
    expect(f.rules()).toEqual([
      expect.objectContaining({
        commandKey: `git status @sha256:${fingerprint}`,
        path: permissionPath(cwd),
        hostId: "host",
        builtin: false,
      }),
    ]);
    const restarted = new CommandPermissions(f.options);
    const prepared = restarted.evaluate(request, cwd);
    expect(prepared.path).toBe(cwd);
    expect(prepared.grantedBy).toBe("always");
    expect(
      restarted.evaluate({ ...request, hostId: "other" }, cwd).grantedBy,
    ).toBeUndefined();
    f.remove();
    await expect(
      restarted.authorize(request, cwd, "once", true, prepared),
    ).rejects.toThrow("revoked");
  });

  it("advances policy version on a removal even if the identical rule is later restored", async () => {
    const f = fixture();
    await f.permissions.authorize(request, cwd, "always", false);
    const original = [...f.rules()];
    const prepared = f.permissions.evaluate(request, cwd);
    f.remove();
    f.permissions.refreshPolicy();
    await f.options.saveRules(() => original);
    f.permissions.refreshPolicy();
    expect(f.permissions.evaluate(request, cwd).policyVersion).toBeGreaterThan(
      prepared.policyVersion,
    );
    await expect(
      f.permissions.authorize(request, cwd, "once", true, prepared),
    ).rejects.toThrow("revoked");
  });

  it("only authorizes literal standalone local builtin navigation, and removal takes effect", async () => {
    const f = fixture(DEFAULT_COMMAND_PERMISSION_RULES);
    const cd = { ...request, command: "cd C:\\local" };
    const prepared = f.permissions.evaluate(cd, cwd);
    expect(prepared).toMatchObject({ grantedBy: "builtin", ruleId: "builtin-cd" });
    expect(
      f.permissions.evaluate({ ...cd, command: `${cd.command}; unknown` }, cwd).grantedBy,
    ).toBeUndefined();
    f.remove();
    await expect(
      f.permissions.authorize(cd, cwd, "once", true, prepared),
    ).rejects.toThrow("revoked");
  });

  it("does not start or create an in-memory Always grant after persistence failure", async () => {
    const f = fixture();
    f.saveRules.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.permissions.authorize(request, cwd, "always", false)).rejects.toThrow(
      "disk full",
    );
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
  });

  it.each(["session", "always"] as const)(
    "remembers %s compound scripts exactly without authorizing another script or first-token family",
    async (scope) => {
      const f = fixture(DEFAULT_COMMAND_PERMISSION_RULES);
      const script = {
        ...request,
        command: "cd 'C:\\Windows'; Write-Output (Get-Location).Path",
      };
      const before = f.permissions.evaluate(script, cwd);
      expect(before.reusable).toBe(true);
      expect(isExactScriptPermissionKey(before.commandKey!)).toBe(true);
      expect(before.grantedBy).toBeUndefined();
      await f.permissions.authorize(script, cwd, scope, false, before);
      const approved = f.permissions.evaluate(script, cwd);
      expect(approved.grantedBy).toBe(scope);
      const recheck = await f.permissions.authorize(script, cwd, scope, true, approved);
      expect(recheck).not.toThrow();
      for (const command of [
        `${script.command} `,
        `${script.command}; Write-Output other`,
        script.command.replace("C:\\Windows", "C:\\Other"),
      ])
        expect(
          f.permissions.evaluate({ ...script, command }, cwd).grantedBy,
        ).toBeUndefined();
      expect(
        f.permissions.evaluate({ ...script, hostId: "other" }, cwd).grantedBy,
      ).toBeUndefined();
      expect(f.permissions.evaluate(script, `${cwd}\\other`).grantedBy).toBeUndefined();
      expect(new CommandPermissions(f.options).evaluate(script, cwd).grantedBy).toBe(
        scope === "always" ? "always" : undefined,
      );
      if (scope === "always") {
        expect(
          await validateCommandPermissionRules(f.rules(), f.resolveExecutable),
        ).toEqual(f.rules());
        f.remove();
      } else f.permissions.revoke(request.hostId, request.leadSessionId);
      expect(recheck).toThrow("revoked");
    },
  );

  it("accepts manual exact-script rules without granting an executable family", async () => {
    const f = fixture();
    const command = "Write-Output one; Write-Output two";
    const rules = await validateCommandPermissionRules(
      [{ id: "script", commandKey: command, path: cwd, builtin: false }],
      f.resolveExecutable,
    );
    expect(rules[0]!.commandKey).toBe(
      f.permissions.evaluate({ ...request, command }, cwd).commandKey,
    );
    expect(isExactScriptPermissionKey(rules[0]!.commandKey)).toBe(true);
    await f.options.saveRules(() => rules);
    expect(f.permissions.evaluate({ ...request, command }, cwd).grantedBy).toBe("always");
    expect(
      f.permissions.evaluate({ ...request, command: "Write-Output three" }, cwd)
        .grantedBy,
    ).toBeUndefined();
  });

  it("pins session and persisted permissions to concrete executable identity across restart", async () => {
    for (const scope of ["session", "always"] as const) {
      const f = fixture();
      await f.permissions.authorize(request, cwd, scope, false);
      const prepared = f.permissions.evaluate(request, cwd);
      f.resolveExecutable.mockReturnValue({
        path: resolve(cwd, "..", "different-tools", "git.exe"),
        fingerprint: "b".repeat(64),
      });
      expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
      await expect(
        f.permissions.authorize(request, cwd, scope, true, prepared),
      ).rejects.toThrow("executable identity changed");
      await expect(
        f.permissions.authorize(request, cwd, "once", false, prepared),
      ).rejects.toThrow("executable identity changed");
      expect(
        new CommandPermissions(f.options).evaluate(request, cwd).grantedBy,
      ).toBeUndefined();
    }
  });

  it("does not let old unpinned rules authorize a newly resolved executable", () => {
    const f = fixture([
      { id: "old", commandKey: "git status", path: permissionPath(cwd), builtin: false },
    ]);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    expect(f.permissions.evaluate(request, cwd).commandKey).toBe(
      `git status @sha256:${fingerprint}`,
    );
  });

  it("requires exact-script approval for unresolved tools rather than reusing a pinned executable grant", async () => {
    const f = fixture();
    f.resolveExecutable.mockImplementation(() => {
      throw new Error("A checkout-local shadow executable is Once-only.");
    });
    expect(f.permissions.evaluate(request, cwd)).toMatchObject({
      reusable: true,
      commandKey: expect.stringMatching(/^exact-script:sha256:/),
      explanation: expect.stringContaining("not executable pinning"),
    });
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBeUndefined();
    await f.permissions.authorize(request, cwd, "always", false);
    expect(f.permissions.evaluate(request, cwd).grantedBy).toBe("always");
    await expect(
      f.permissions.authorize(request, cwd, "once", false),
    ).resolves.toBeTypeOf("function");
  });

  it("pins newly entered rules but never silently repins existing rules during an edit", async () => {
    const f = fixture();
    const [rule] = await validateCommandPermissionRules(
      [{ id: "local", commandKey: "git status", path: cwd, builtin: false }],
      f.resolveExecutable,
    );
    expect(rule?.commandKey).toBe(`git status @sha256:${fingerprint}`);
    f.resolveExecutable.mockImplementation(() => {
      throw new Error("tool was replaced");
    });
    expect(await validateCommandPermissionRules([rule!], f.resolveExecutable)).toEqual([
      rule,
    ]);
  });
});
