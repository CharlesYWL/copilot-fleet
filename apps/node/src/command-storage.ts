import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_LIMITS } from "@fleet/protocol";

/** Native binaries and retained streams consume disk too, not just SQLite output rows. */
export async function assertCommandStorage(
  directory: string,
  options: { budgetBytes?: number; reserveBytes?: number; minFreeBytes?: number } = {},
): Promise<void> {
  const budget =
    options.budgetBytes ??
    COMMAND_LIMITS.nodeLogBytes + COMMAND_LIMITS.lifecycleReserveBytes;
  const reserve =
    options.reserveBytes ?? 4 * COMMAND_LIMITS.outputBytes + 4 * 1024 * 1024;
  const freeReserve =
    options.minFreeBytes ?? reserve + COMMAND_LIMITS.lifecycleReserveBytes;
  const capacity = await statfs(directory, { bigint: true });
  if (capacity.bavail * capacity.bsize < BigInt(freeReserve))
    throw new Error("Insufficient free space for command lifecycle evidence.");
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      let entry;
      try {
        entry = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (entry.isSymbolicLink())
        throw new Error(
          "Command storage contains a link; inspect it before admitting work.",
        );
      if (entry.isDirectory()) pending.push(path);
      else bytes += entry.size;
      if (bytes + reserve > budget)
        throw new Error(
          "Command storage limit exceeded; reclaim verified completed attempts before retrying.",
        );
    }
  }
}
