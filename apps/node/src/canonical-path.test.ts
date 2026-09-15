import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath } from "./canonical-path.js";
import { CheckoutLocks } from "./checkout-locks.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = resolve(".mwi-test-work", randomUUID());
  roots.push(root);
  const directory = join(root, "Long Directory Name");
  await mkdir(join(directory, "nested"), { recursive: true });
  return { root, directory };
}

describe("physical checkout identities", () => {
  it("normalizes junctions and dot segments into the same cross-instance lock without age-based reclamation", async () => {
    const { root, directory } = await fixture();
    const alias = join(root, "alias");
    await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const original = await canonicalPath(directory);
    const throughAlias = await canonicalPath(join(alias, "nested", ".."));
    expect(throughAlias.key).toBe(original.key);
    const locks = new CheckoutLocks(join(root, "locks"));
    const independent = new CheckoutLocks(join(root, "locks"));
    const held = locks.acquire(original, {
      owner: "session:first",
      attempt: "1",
      kind: "worker",
    });
    expect(() =>
      independent.acquire(throughAlias, {
        owner: "session:second",
        attempt: "2",
        kind: "worker",
      }),
    ).toThrow("reserved");
    await held.revalidate();
    held.release();
    independent
      .acquire(throughAlias, { owner: "session:second", attempt: "2", kind: "worker" })
      .release();
  });

  it.skipIf(process.platform !== "win32")(
    "collides Windows case, separators, short names and drive aliases, or refuses unsupported aliases",
    async () => {
      const { root, directory } = await fixture();
      const original = await canonicalPath(directory);
      expect((await canonicalPath(directory.toUpperCase())).key).toBe(original.key);
      expect((await canonicalPath(directory.replaceAll("\\", "/"))).key).toBe(
        original.key,
      );
      const escaped = directory.replaceAll("'", "''");
      const short = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class FleetShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string path, StringBuilder output, uint length); }'; $b=New-Object System.Text.StringBuilder 4096; $n=[FleetShortPath]::GetShortPathName('${escaped}',$b,4096); if($n -gt 0){$b.ToString()}else{exit 1}`,
        ],
        { windowsHide: true, timeout: 10_000 },
      );
      expect((await canonicalPath(short.stdout.trim())).key).toBe(original.key);
      const letter = ["Z", "Y", "X", "W", "V"].find(
        (value) => !existsSync(`${value}:\\`),
      );
      if (letter) {
        let mapped = false;
        try {
          const result = await execute("subst.exe", [`${letter}:`, root], {
            windowsHide: true,
            timeout: 5_000,
          });
          mapped = !result.stderr;
          if (mapped)
            expect((await canonicalPath(`${letter}:\\Long Directory Name`)).key).toBe(
              original.key,
            );
        } finally {
          if (mapped)
            await execute("subst.exe", [`${letter}:`, "/D"], {
              windowsHide: true,
              timeout: 5_000,
            });
        }
      }
      await expect(canonicalPath("C:relative")).rejects.toThrow("absolute");
    },
  );

  it("uses symlink identity when supported and fails closed when the OS refuses symlink creation", async () => {
    const { root, directory } = await fixture();
    const alias = join(root, "symlink");
    try {
      await symlink(directory, alias, "dir");
      expect((await canonicalPath(alias)).key).toBe((await canonicalPath(directory)).key);
    } catch (error) {
      expect(["EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
      await expect(canonicalPath(alias)).rejects.toThrow();
    }
  });
});
