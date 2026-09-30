import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "@fleet/protocol";

export type FolderListing =
  | {
      ok: true;
      path: string;
      parent: string | null;
      folders: { name: string; path: string }[];
      unavailableLinks: number;
    }
  | { ok: false; reason: string };

/**
 * The loopback config page needs Node paths, not browser file handles. List one
 * directory asynchronously; never launch a desktop dialog or read file contents.
 */
export async function listFolders(input: string): Promise<FolderListing> {
  const requested = input.trim() || homedir();
  if (!isAbsolute(requested) || requested.includes("\0")) {
    return {
      ok: false,
      reason: "Enter an absolute folder path",
    };
  }
  const path = resolve(requested);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let unavailableLinks = 0;
    const directories = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return (await stat(join(path, entry.name))).isDirectory();
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
          ) {
            unavailableLinks++;
            return false;
          }
          throw error;
        }
      }),
    );
    const folders = entries
      .filter((_entry, index) => directories[index])
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parent = dirname(path);
    return {
      ok: true,
      path,
      parent: parent === path ? null : parent,
      folders,
      unavailableLinks,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Cannot read this folder: ${errorMessage(error)}`,
    };
  }
}
