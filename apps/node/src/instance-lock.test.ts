import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, shouldReconnectAfterClose } from "./instance-lock.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shouldReconnectAfterClose", () => {
  it("does not reconnect while shutting down or when superseded", () => {
    expect(shouldReconnectAfterClose(1006, true)).toBe(false);
    expect(shouldReconnectAfterClose(4001, false)).toBe(false);
    expect(shouldReconnectAfterClose(1006, false)).toBe(true);
    expect(shouldReconnectAfterClose(undefined, false)).toBe(true);
  });
});

describe("acquireInstanceLock", () => {
  it("allows only one live owner for the same credentials identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-lock-"));
    directories.push(directory);
    const first = acquireInstanceLock(directory);
    expect(first.ok).toBe(true);
    const second = acquireInstanceLock(directory);
    expect(second).toEqual({
      ok: false,
      reason: expect.stringMatching(/already running/i),
    });
    if (first.ok) first.release();
    const third = acquireInstanceLock(directory);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });
});
