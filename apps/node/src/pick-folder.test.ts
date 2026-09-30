import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFolders } from "./pick-folder.js";

const temporaryFolders: string[] = [];
const temporaryFolder = async () => {
  const path = await mkdtemp(join(tmpdir(), "fleet-picker-"));
  temporaryFolders.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryFolders.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("listFolders", () => {
  it("lists only immediate folders, sorted, without reading file contents", async () => {
    const root = await temporaryFolder();
    await mkdir(join(root, "zebra", "nested"), { recursive: true });
    await mkdir(join(root, "Alpha & friends"));
    await writeFile(join(root, "private.txt"), "not returned to the browser");

    expect(await listFolders(` ${root} `)).toEqual({
      ok: true,
      path: root,
      parent: dirname(root),
      folders: [
        { name: "Alpha & friends", path: join(root, "Alpha & friends") },
        { name: "zebra", path: join(root, "zebra") },
      ],
      unavailableLinks: 0,
    });
  });

  it("opens home for an empty path and stops Up at a filesystem root", async () => {
    expect(await listFolders("")).toMatchObject({ ok: true, path: resolve(homedir()) });
    const root = parse(homedir()).root;
    expect(await listFolders(root)).toMatchObject({ ok: true, path: root, parent: null });
  });

  it("supports linked directories and reports broken links without hiding other folders", async () => {
    const root = await temporaryFolder();
    const destination = await temporaryFolder();
    const missing = join(destination, "missing");
    await mkdir(missing);
    await symlink(destination, join(root, "linked"), "junction");
    await symlink(missing, join(root, "broken"), "junction");
    await rm(missing, { recursive: true });

    expect(await listFolders(root)).toMatchObject({
      ok: true,
      folders: [{ name: "linked", path: join(root, "linked") }],
      unavailableLinks: 1,
    });
    expect(await listFolders(join(root, "linked"))).toMatchObject({
      ok: true,
      path: join(root, "linked"),
      parent: root,
    });
  });

  it("reports invalid, missing and non-directory paths instead of opening a desktop dialog", async () => {
    const root = await temporaryFolder();
    const file = join(root, "file.txt");
    await writeFile(file, "");
    for (const path of ["relative", "bad\0path", join(root, "missing"), file]) {
      expect(await listFolders(path)).toMatchObject({
        ok: false,
        reason: expect.any(String),
      });
    }
  });
});
