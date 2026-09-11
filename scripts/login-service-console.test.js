import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { logPosition, printNodeConfigUrl } from "./login-service-cli.mjs";

const directories = [];
const timestamp = "2026-01-01T00:00:00.000Z";
const started = `${timestamp} [login-start] Starting node as user\n`;
const ready = (port) => `${timestamp} [node]   config UI   http://127.0.0.1:${port}\n`;
function fixture(contents = "") {
  const directory = mkdtempSync(join(tmpdir(), "fleet-config-console-"));
  directories.push(directory);
  const path = join(directory, "runtime.log");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("prints current collision messages and the actual URL, not an old startup URL or other logs", async () => {
  const path = fixture(started + ready(8788));
  const cursor = logPosition(path);
  appendFileSync(
    path,
    ready(8789) +
      started +
      "unrelated sensitive log\n" +
      `${timestamp} [node] Config UI port 8788 is occupied; trying 8789.\n` +
      ready(8789),
  );
  const log = vi.fn();
  await expect(printNodeConfigUrl(path, cursor, { log, timeoutMs: 500 })).resolves.toBe(
    "http://127.0.0.1:8789",
  );
  expect(log.mock.calls.flat()).toEqual([
    "Config UI port 8788 is occupied; trying 8789.",
    "Node config UI: http://127.0.0.1:8789",
  ]);
});

it("handles the runtime rotating a previous log before startup", async () => {
  const path = fixture(started + ready(11111) + "previous log".repeat(100));
  const cursor = logPosition(path);
  renameSync(path, `${path}.previous`);
  writeFileSync(path, started + ready(8790));
  await expect(
    printNodeConfigUrl(path, cursor, { log: vi.fn(), timeoutMs: 500 }),
  ).resolves.toBe("http://127.0.0.1:8790");
});

it("waits for a complete line rather than reporting a partially written port", async () => {
  const path = fixture();
  const cursor = logPosition(path);
  writeFileSync(path, started + `${timestamp} [node]   config UI   http://127.0.0.1:87`);
  const log = vi.fn();
  const result = printNodeConfigUrl(path, cursor, { log, timeoutMs: 1000 });
  await delay(30);
  expect(log).not.toHaveBeenCalled();
  appendFileSync(path, "90\n");
  await expect(result).resolves.toBe("http://127.0.0.1:8790");
});

it("reports startup failure instead of inventing a config URL", async () => {
  const path = fixture();
  const cursor = logPosition(path);
  writeFileSync(
    path,
    started + `${timestamp} [node] Config UI unavailable: access denied\n`,
  );
  await expect(
    printNodeConfigUrl(path, cursor, { log: vi.fn(), timeoutMs: 500 }),
  ).rejects.toThrow("Config UI unavailable: access denied");
});

it("waits for the runtime to create its log on a fresh installation", async () => {
  const path = fixture();
  rmSync(path);
  const result = printNodeConfigUrl(path, logPosition(path), {
    log: vi.fn(),
    timeoutMs: 1000,
  });
  await delay(30);
  writeFileSync(path, started + ready(8788));
  await expect(result).resolves.toBe("http://127.0.0.1:8788");
});

it("times out explicitly if the task never announces its config listener", async () => {
  const path = fixture();
  await expect(
    printNodeConfigUrl(path, logPosition(path), { log: vi.fn(), timeoutMs: 10 }),
  ).rejects.toThrow("the task remains installed");
});
