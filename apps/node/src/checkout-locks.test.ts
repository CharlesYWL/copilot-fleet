import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalPath } from "./canonical-path.js";
import { CheckoutLocks } from "./checkout-locks.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = resolve(".mwi-test-work", randomUUID());
  roots.push(root);
  await mkdir(root, { recursive: true });
  const identity = await canonicalPath(root);
  const directory = join(root, "locks");
  const locks = new CheckoutLocks(directory);
  const owner = { owner: "session:live", attempt: "original", kind: "worker" as const };
  const lease = locks.acquire(identity, owner);
  const inventory = new CheckoutLocks(directory);
  return { directory, identity, locks, owner, lease, inventory };
}

describe("durable checkout lease reattachment", () => {
  it.each(["owner", "attempt"] as const)(
    "refuses a stale %s without mutating the lease or persisted holder",
    async (field) => {
      const { identity, lease, inventory, owner } = await fixture();
      const original = inventory.holder(identity.key);
      expect(() =>
        lease.reattach(
          field === "owner" ? "session:other" : owner.owner,
          field === "attempt" ? "stale" : owner.attempt,
          "new",
        ),
      ).toThrow("Checkout lease owner changed");
      expect(inventory.holder(identity.key)).toEqual(original);
      await expect(lease.revalidate()).resolves.toBeUndefined();
      lease.reattach(owner.owner, owner.attempt, "new");
      expect(inventory.holder(identity.key)).toEqual({ ...original, attempt: "new" });
      await expect(lease.revalidate()).resolves.toBeUndefined();
      lease.release();
      expect(inventory.holder(identity.key)).toBeUndefined();
    },
  );

  it.each(["writeFileSync", "renameSync"] as const)(
    "rolls back a failed %s save and removes staging files before a successful retry",
    async (method) => {
      const { directory, identity, lease, inventory, owner } = await fixture();
      const original = inventory.holder(identity.key);
      vi.spyOn(fs, method).mockImplementationOnce(() => {
        throw Object.assign(new Error("Injected lease save failure"), { code: "EACCES" });
      });
      expect(() => lease.reattach(owner.owner, owner.attempt, "new")).toThrow(
        "Injected lease save failure",
      );
      expect(inventory.holder(identity.key)).toEqual(original);
      expect(await readdir(directory)).toHaveLength(1);
      await expect(lease.revalidate()).resolves.toBeUndefined();
      lease.reattach(owner.owner, owner.attempt, "new");
      expect(inventory.holder(identity.key)).toEqual({ ...original, attempt: "new" });
      await expect(lease.revalidate()).resolves.toBeUndefined();
      lease.release();
      expect(inventory.holder(identity.key)).toBeUndefined();
    },
  );
});
