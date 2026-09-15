import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorktreeConflict, type CheckoutIdentity } from "@fleet/protocol";

export const identityHash = (key: string): string =>
  createHash("sha256").update(key).digest("hex");
let physicalMachineId: string | undefined;

function machineIdentity(): string {
  if (physicalMachineId) return physicalMachineId;
  if (process.platform === "win32") {
    const value = execFileSync(
      "reg.exe",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    const guid = /MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i.exec(value)?.[1];
    if (!guid)
      throw new WorktreeConflict(
        "unsupported_machine_identity",
        "Windows machine identity could not be established.",
      );
    physicalMachineId = `win32:${identityHash(guid.toLowerCase())}`;
  } else {
    physicalMachineId = `${platform()}:${hostname()}`;
  }
  return physicalMachineId;
}

/** libuv's Windows stat supplies the volume serial and 64-bit file index. */
export async function canonicalPath(input: string): Promise<CheckoutIdentity> {
  if (!isAbsolute(input) || input.includes("\0")) {
    throw new WorktreeConflict(
      "ambiguous_path",
      "An absolute physical directory is required.",
    );
  }
  const path = await realpath(resolve(input));
  if (process.platform === "win32" && !/^(?:\\\\\?\\)?[A-Za-z]:\\/.test(path)) {
    throw new WorktreeConflict(
      "unsupported_identity",
      "Managed checkout admission requires a local Windows volume, not a network or device path.",
    );
  }
  const info = await stat(path, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n || info.dev === 0n) {
    throw new WorktreeConflict(
      "unsupported_identity",
      "The filesystem did not supply an unambiguous directory identity.",
    );
  }
  const volume = info.dev.toString();
  const fileId = info.ino.toString();
  const machineId = machineIdentity();
  return {
    key: `${machineId}:${volume}:${fileId}`,
    path,
    machineId,
    volume,
    fileId,
  };
}

export async function assertIdentity(
  expected: CheckoutIdentity,
): Promise<CheckoutIdentity> {
  const actual = await canonicalPath(expected.path);
  if (actual.key !== expected.key) {
    throw new WorktreeConflict(
      "identity_changed",
      "The physical directory was replaced or moved. Reconciliation is required.",
    );
  }
  return actual;
}

export function containedPath(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return (
    inside !== "" &&
    !isAbsolute(inside) &&
    inside !== ".." &&
    !inside.startsWith(`..${sep}`)
  );
}
