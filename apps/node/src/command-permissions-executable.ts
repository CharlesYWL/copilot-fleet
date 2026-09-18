import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export type PermissionExecutable = { path: string; fingerprint: string };
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
 * Resolve the same bare name in a fresh, profile-free PowerShell. The only
 * name is validated and passed as environment data, not inserted into code.
 * Submitted command text never runs.
 */
export const resolvePermissionExecutable: PermissionExecutableResolver = (name, cwd) => {
  if (process.platform !== "win32" || !isPermissionExecutableName(name))
    throw new Error("Executable permission resolution requires Windows PowerShell.");
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
