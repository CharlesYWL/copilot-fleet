import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintPermissionExecutable,
  resolvePermissionExecutable,
} from "./command-permissions-executable.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = resolve(`.command-executable-${randomUUID()}`);
  const cwd = join(directory, "checkout");
  mkdirSync(cwd, { recursive: true });
  directories.push(directory);
  const git = join(directory, "git.exe");
  writeFileSync(git, "unexecuted fixture executable bytes");
  return { directory, cwd, git };
}

describe("concrete command executable identity", () => {
  it("survives repeated reads but changes for another executable path or changed contents", () => {
    const f = fixture();
    const first = fingerprintPermissionExecutable(f.git, f.cwd);
    expect(first).toEqual(fingerprintPermissionExecutable(f.git, f.cwd));
    const another = join(f.directory, "other-git.exe");
    writeFileSync(another, "unexecuted fixture executable bytes");
    expect(fingerprintPermissionExecutable(another, f.cwd).fingerprint).not.toBe(
      first.fingerprint,
    );
    writeFileSync(f.git, "replaced unexecuted fixture executable bytes");
    expect(fingerprintPermissionExecutable(f.git, f.cwd).fingerprint).not.toBe(
      first.fingerprint,
    );
  });

  it("does not grant a familiar executable basename to a checkout-local shadow", () => {
    const f = fixture();
    const shadow = join(f.cwd, "git.exe");
    writeFileSync(shadow, "never execute this checkout file");
    expect(() => fingerprintPermissionExecutable(shadow, f.cwd)).toThrow(
      "shadow executable",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "resolves the real fixed Git command without running submitted code",
    () => {
      const f = fixture();
      const executable = resolvePermissionExecutable("git", f.cwd);
      expect(executable.path.toLowerCase()).toMatch(/git\.exe$/);
      expect(executable.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(resolvePermissionExecutable("git", f.cwd)).toEqual(executable);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "resolves an ordinary literal Windows executable beyond Git/npm",
    () => {
      const f = fixture();
      const executable = resolvePermissionExecutable("where.exe", f.cwd);
      expect(executable.path.toLowerCase()).toMatch(/where\.exe$/);
      expect(executable.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "does not auto-load code from a module while looking up an unknown tool",
    () => {
      const f = fixture();
      const modules = join(f.directory, "modules");
      const module = join(modules, "TestPermissionModule");
      const marker = join(f.cwd, "module-must-not-run");
      mkdirSync(module, { recursive: true });
      writeFileSync(
        join(module, "TestPermissionModule.psm1"),
        `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'executed'); function fleet-permission-tool {}; Export-ModuleMember -Function fleet-permission-tool`,
      );
      writeFileSync(
        join(module, "TestPermissionModule.psd1"),
        "@{RootModule='TestPermissionModule.psm1';ModuleVersion='1.0';FunctionsToExport=@('fleet-permission-tool')}",
      );
      vi.stubEnv("PSModulePath", modules);
      expect(() => resolvePermissionExecutable("fleet-permission-tool", f.cwd)).toThrow();
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "detects cwd PATH shadow scripts without executing their contents",
    () => {
      const f = fixture();
      const marker = join(f.cwd, "must-not-exist");
      writeFileSync(
        join(f.cwd, "git.ps1"),
        `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'executed')`,
      );
      const pathKey =
        Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      vi.stubEnv(pathKey, `${f.cwd}${delimiter}${process.env[pathKey] ?? ""}`);
      expect(() => resolvePermissionExecutable("git", f.cwd)).toThrow(
        "shadow executable",
      );
      expect(existsSync(marker)).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")("POSIX command executable identity", () => {
  it("resolves the real Git on PATH to a pinned compiled program", () => {
    const f = fixture();
    const executable = resolvePermissionExecutable("git", f.cwd);
    expect(executable.path).toMatch(/^\/.*\/git$/);
    expect(executable.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(executable.native).toBe(true);
    expect(resolvePermissionExecutable("git", f.cwd)).toEqual(executable);
  });

  it("marks a #! script on PATH as not a compiled program", () => {
    const f = fixture();
    const tools = join(f.directory, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "fleet-script-tool"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    vi.stubEnv("PATH", `${tools}${delimiter}${process.env.PATH ?? ""}`);
    expect(resolvePermissionExecutable("fleet-script-tool", f.cwd).native).toBe(false);
  });

  it("refuses shell builtins, which have no file to pin", () => {
    const f = fixture();
    expect(() => resolvePermissionExecutable("export", f.cwd)).toThrow(
      "Ambiguous command identity",
    );
  });

  it("detects a checkout-local PATH shadow without executing it", () => {
    const f = fixture();
    const marker = join(f.cwd, "must-not-exist");
    const shadow = join(f.cwd, "git");
    writeFileSync(shadow, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${f.cwd}${delimiter}${process.env.PATH ?? ""}`);
    expect(() => resolvePermissionExecutable("git", f.cwd)).toThrow("shadow executable");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not run shell startup files named by ENV", () => {
    const f = fixture();
    const marker = join(f.cwd, "startup-ran");
    const startup = join(f.directory, "startup.sh");
    writeFileSync(startup, `touch '${marker}'\n`);
    vi.stubEnv("ENV", startup);
    resolvePermissionExecutable("git", f.cwd);
    expect(existsSync(marker)).toBe(false);
  });
});
