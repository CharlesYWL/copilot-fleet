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
