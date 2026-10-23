import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { posixShellEnvironment } from "./posix-shell-environment.js";

export type PermissionExecutable = {
  path: string;
  fingerprint: string;
  /**
   * Whether the file is a compiled program rather than a script. POSIX
   * resolvers set it from the file's content; when absent the caller decides
   * by extension, as on Windows.
   */
  native?: boolean;
};
export type PermissionExecutableResolver = (
  name: string,
  cwd: string,
) => PermissionExecutable;

export const isPermissionExecutableName = (name: string): boolean =>
  /^[a-z][a-z0-9_-]*(?:\.(?:exe|com))?$/i.test(name) || /^npm\.(?:cmd|ps1)$/i.test(name);

const normalized = (path: string) =>
  process.platform === "win32"
    ? normalize(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, "")).toLowerCase()
    : normalize(path);

function inside(root: string, path: string): boolean {
  const child = relative(normalized(root), normalized(path));
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}

export function fingerprintPermissionExecutable(
  path: string,
  cwd: string,
): PermissionExecutable {
  if (
    !isAbsolute(path) ||
    (process.platform === "win32" && !/^(?:\\\\\?\\)?[a-z]:\\/i.test(path))
  )
    throw new Error("Executable identity requires an absolute local filesystem path.");
  const canonical = realpathSync(path);
  if (inside(cwd, path) || inside(cwd, canonical))
    throw new Error("A checkout-local shadow executable is Once-only.");
  const before = statSync(canonical, { bigint: true });
  if (!before.isFile() || before.size > 32n * 1024n * 1024n || before.ino === 0n)
    throw new Error(
      "Executable identity cannot be established within the metadata bound.",
    );
  const content = createHash("sha256").update(readFileSync(canonical)).digest("hex");
  const after = statSync(canonical, { bigint: true });
  if (
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
      (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
    )
  )
    throw new Error("Executable changed while its identity was being established.");
  return {
    path: canonical,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          normalized(canonical),
          String(before.dev),
          String(before.ino),
          content,
        ]),
      )
      .digest("hex"),
  };
}

/**
 * Whether a POSIX file is a compiled program (ELF or Mach-O) rather than a
 * script. A pin covers the file's bytes, but a `#!` script's behaviour lives in
 * its interpreter and everything that loads, so scripts stay Once-only.
 */
export function compiledProgram(path: string): boolean {
  const header = Buffer.alloc(4);
  const descriptor = openSync(path, "r");
  try {
    if (readSync(descriptor, header, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(descriptor);
  }
  if (header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true; // ELF
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(
    header.readUInt32BE(0),
  ); // Mach-O, 32/64-bit, either byte order, or universal
}

/**
 * Resolve the bare name the way the command's own shell would, without
 * running submitted code. The name is validated and passed as environment
 * data, never inserted into code.
 *
 * Windows asks a fresh, profile-free PowerShell. POSIX asks `/bin/sh`'s
 * `command -v` in the same sanitized environment commands run in (no startup
 * files, no imported functions): an absolute path is an executable on PATH,
 * anything else (builtin, function, alias, keyword) has no file to pin and is
 * refused.
 */
export const resolvePermissionExecutable: PermissionExecutableResolver = (name, cwd) => {
  if (!isPermissionExecutableName(name))
    throw new Error("Executable permission resolution requires a literal command name.");
  if (process.platform !== "win32") {
    const output = execFileSync(
      "/bin/sh",
      ["-c", 'command -v -- "$FLEET_PERMISSION_EXECUTABLE"'],
      {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...posixShellEnvironment(process.env), FLEET_PERMISSION_EXECUTABLE: name },
      },
    ).trim();
    if (!output.startsWith("/"))
      throw new Error("Ambiguous command identity: not an executable file on PATH.");
    const executable = fingerprintPermissionExecutable(output, cwd);
    return { ...executable, native: compiledProgram(executable.path) };
  }
  const root = process.env.SystemRoot ?? "C:\\Windows";
  if (!isAbsolute(root)) throw new Error("Windows installation path is not absolute.");
  const shell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script =
    `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; $c=Microsoft.PowerShell.Core\\Get-Command -Name $env:FLEET_PERMISSION_EXECUTABLE -ErrorAction Stop; ` +
    `if ($c.CommandType -ne 'Application' -and $c.CommandType -ne 'ExternalScript') { throw 'Ambiguous command identity' }; ` +
    `[Console]::Out.Write($c.Path)`;
  const output = execFileSync(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FLEET_PERMISSION_EXECUTABLE: name },
    },
  );
  return fingerprintPermissionExecutable(output, cwd);
};
